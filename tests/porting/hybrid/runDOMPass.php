<?php

namespace Parsoid\Tests\Porting\Hybrid;

require_once __DIR__ . '/../../../vendor/autoload.php';

use Parsoid\Config\Api\Env as ApiEnv;

use Parsoid\Html2Wt\DOMDiff;
use Parsoid\Html2Wt\DOMNormalizer;
use Parsoid\Html2Wt\SelectiveSerializer;
use Parsoid\Html2Wt\WikitextSerializer;

use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\PHPUtils;

use Parsoid\Wt2Html\DOMPostProcessor;

use Parsoid\Wt2Html\PP\Handlers\CleanUp;
use Parsoid\Wt2Html\PP\Handlers\DedupeStyles;
use Parsoid\Wt2Html\PP\Handlers\HandleLinkNeighbours;
use Parsoid\Wt2Html\PP\Handlers\LiFixups;
use Parsoid\Wt2Html\PP\Handlers\TableFixups;

use Parsoid\Wt2Html\PP\Processors\AddExtLinkClasses;
use Parsoid\Wt2Html\PP\Processors\AddRedLinks;
use Parsoid\Wt2Html\PP\Processors\ComputeDSR;
use Parsoid\Wt2Html\PP\Processors\HandlePres;
use Parsoid\Wt2Html\PP\Processors\Linter;
use Parsoid\Wt2Html\PP\Processors\MarkFosteredContent;
use Parsoid\Wt2Html\PP\Processors\ProcessTreeBuilderFixups;
use Parsoid\Wt2Html\PP\Processors\PWrap;
use Parsoid\Wt2Html\PP\Processors\WrapSections;
use Parsoid\Wt2Html\PP\Processors\WrapTemplates;
use Parsoid\Wt2Html\PP\Processors\MigrateTemplateMarkerMetas;
use Parsoid\Wt2Html\PP\Processors\MigrateTrailingNLs;

function buildDOM( $env, $fileName ) {
	$html = file_get_contents( $fileName );
	return ContentUtils::ppToDOM( $env, $html, [
		'reinsertFosterableContent' => true,
		'markNew' => true
	] );
}

function serializeDOM( $transformer, $env, $body ) {
	// HACK: Piggyback new uid/fid for env on <body>
	$body->setAttribute( "data-env-newuid", $env->getUID() );
	$body->setAttribute( "data-env-newfid", $env->getFID() );
	if ( $env->pageBundle ) {
		return ContentUtils::extractDpAndSerialize( $body );
	} elseif ( $transformer === 'CleanUp-cleanupAndSaveDataParsoid' ) {
		/* Data-attributes have already been stored */
		return ContentUtils::toXML( $body );
	} else {
		/**
		 * Serialize output to DOM while tunneling fosterable content
		 * to prevent it from getting fostered on parse to DOM
		 */
		return ContentUtils::ppToXML( $body, [
			'keepTmp' => true,
			'tunnelFosteredContent' => true,
			'storeDiffMark' => true
		] );
	}
}

function runDOMPostProcessor( $env, $argv, $opts, $processors ) {
	$htmlFileName = $argv[2];
	$body = buildDOM( $env, $htmlFileName );

	$dpp = new DOMPostProcessor( $env, $opts['runOptions'] );
	$dpp->registerProcessors( $processors );
	$options = [
		'toplevel' => $opts['toplevel']
	];
	$dpp->resetState( $options );
	$dpp->doPostProcess( $body->ownerDocument );

	if ( $argv[1] === 'Linter' ) {
		// Shove Linter output (if any) into the body node's tmp data
		$out = PHPUtils::jsonEncode( $env->getLints() );
	} else {
		$out = serializeDOM( $argv[1], $env, $body );
	}

	/**
	 * Remove the input DOM file to eliminate clutter
	 */
	unlink( $htmlFileName );
	return $out;
}

function runDOMDiff( $env, $argv, $opts ) {
	$htmlFileName1 = $argv[2];
	$htmlFileName2 = $argv[3];
	$oldBody = buildDOM( $env, $htmlFileName1 );
	$newBody = buildDOM( $env, $htmlFileName2 );

	$dd = new DOMDiff( $env );
	$diff = $dd->diff( $oldBody, $newBody );
	$out = serializeDOM( null, $env, $newBody );

	unlink( $htmlFileName1 );
	unlink( $htmlFileName2 );
	return PHPUtils::jsonEncode( [ "diff" => $diff, "html" => $out ] );
}

function runHtml2Wt( $env, $argv, $opts ) {
	$useSelser = $argv[2] === "true";
	$htmlFileName1 = $argv[3];
	$editedBody = buildDOM( $env, $htmlFileName1 );
	$env->getPageConfig()->editedDoc = $editedBody->ownerDocument;

	if ( $useSelser ) {
		$htmlFileName2 = $argv[4];
		$origBody = buildDOM( $env, $htmlFileName2 );
		$env->setOrigDOM( $origBody );
		$serializer = new SelectiveSerializer( [ "env" => $env ] );
	} else {
		$serializer = new WikitextSerializer( [ "env" => $env ] );
	}

	$wt = $serializer->serializeDOM( $editedBody );

	unlink( $htmlFileName1 );
	if ( $useSelser ) {
		unlink( $htmlFileName2 );
	}
	return $wt;
}

function runDOMNormalizer( $env, $argv, $opts ) {
	$htmlFileName = $argv[2];
	$body = buildDOM( $env, $htmlFileName );

	$normalizer = new DOMNormalizer( (object)[
		"env" => $env,
		"rtTestMode" => $opts["rtTestMode"] ?? false,
		"selserMode" => $opts["selserMode"] ?? false
	] );
	$normalizer->normalize( $body );
	$out = serializeDOM( null, $env, $body );
	unlink( $htmlFileName );
	return $out;
}

if ( PHP_SAPI !== 'cli' ) {
	die( 'CLI only' );
}

if ( $argc < 3 ) {
	fwrite( STDERR, "Usage: php runDOMTransform.php <transformerName> <fileName-1> ... \n" );
	throw new \Exception( "Missing command-line arguments: >= 3 expected, $argc provided" );
}

/**
 * Read opts from stdin
 */
$input = file_get_contents( 'php://stdin' );
$opts = PHPUtils::jsonDecode( $input );
$envOpts = $opts['envOpts'];

/**
 * Build the requested transformer
 */
$test = $argv[1];
$apiEndpoint = preg_match( '/^(.*)wiki$/', $envOpts['prefix'] ?? '', $m ) === 1 ?
	( "https://" . $m[1] . ".wikipedia.org/w/api.php" ) : $envOpts['apiURI'];
$env = new ApiEnv( [
	"uid" => $envOpts['currentUid'] ?? -1,
	"fid" => $envOpts['currentFid'] ?? -1,
	"apiEndpoint" => $apiEndpoint,
	"pageContent" => $envOpts['pageContent'] ?? $input,
	"pageLanguage" => $envOpts['pagelanguage'] ?? null,
	"pageLanguageDir" => $envOpts['pagelanguagedir'] ?? null,
	"title" => $envOpts['pagetitle'] ?? "Main_Page",
	"rtTestMode" => $envOpts['rtTestMode'] ?? false,
	"pageId" => $envOpts['pageId'] ?? null,
	"scrubWikitext" => $envOpts['scrubWikitext'] ?? false,
	"wrapSections" => !empty( $envOpts['wrapSections' ] ),
	'tidyWhitespaceBugMaxLength' => $envOpts['tidyWhitespaceBugMaxLength'] ?? null,
	# This directory contains synthetic data which doesn't exactly match
	# enwiki, but matches what parserTests expects
	"cacheDir" => __DIR__ . '/data',
	"writeToCache" => 'pretty',
] );

switch ( $test ) {
	case 'DOMDiff':
		$out = runDOMDiff( $env, $argv, $opts );
		break;
	case 'DOMNormalizer':
		$out = runDOMNormalizer( $env, $argv, $opts );
		break;
	case "HTML2WT":
		$out = runHtml2Wt( $env, $argv, $opts );
		break;
	default:
		$tableFixer = new TableFixups( $env );
		$processors = [
			[
				'Processor' => MarkFosteredContent::class,
				'shortcut' => 'fostered',
				'omit' => ( $test !== 'MarkFosteredContent' )
			],
			[
				'Processor' => ProcessTreeBuilderFixups::class,
				'shortcut' => 'process-fixups',
				'omit' => ( $test !== 'ProcessTreeBuilderFixups' )
			],
			[
				'Processor' => Normalize::class,
				'omit' => ( $test !== 'Normalize' )
			],
			[
				'Processor' => PWrap::class,
				'shortcut' => 'pwrap',
				'skipNested' => true,
				'omit' => ( $test !== 'PWrap' )
			],
			[
				'Processor' => MigrateTemplateMarkerMetas::class,
				'shortcut' => 'migrate-metas',
				'omit' => ( $test !== 'MigrateTemplateMarkerMetas' )
			],
			[
				'Processor' => HandlePres::class,
				'shortcut' => 'pres',
				'omit' => ( $test !== 'HandlePres' )
			],
			[
				'Processor' => MigrateTrailingNLs::class,
				'shortcut' => 'migrate-nls',
				'omit' => ( $test !== 'MigrateTrailingNLs' )
			],
			[
				'Processor' => ComputeDSR::class,
				'shortcut' => 'dsr',
				'omit' => ( $test !== 'ComputeDSR' )
			],
			[
				'Processor' => WrapTemplates::class,
				'shortcut' => 'tplwrap',
				'omit' => ( $test !== 'WrapTemplates' )
			],
			[
				'name' => 'HandleLinkNeighbours',
				'shortcut' => 'dom-unpack',
				'isTraverser' => true,
				'handlers' => [
					[
						'nodeName' => 'a',
						'action' => [ HandleLinkNeighbours::class, 'handler' ]
					]
				],
				'omit' => ( $test !== 'HandleLinkNeighbours' )
			],
			/*
			[
				'name' => 'UnpackDOMFragments',
				'shortcut' => 'dom-unpack',
				'isTraverser' => true,
				'handlers' => [
					[
						'nodeName' => null,
						'action' => [ UnpackDOMFragments::class, 'unpackDOMFragments' ]
					]
				],
				'omit' => ( $test !== 'UnpackDOMFragments' )
			],
			*/
			[
				'name' => 'LiFixups',
				'shortcut' => 'fixups',
				'isTraverser' => true,
				'skipNested' => true,
				'handlers' => [
					[
						'nodeName' => 'li',
						'action' => [ LiFixups::class, 'handleLIHack' ]
					],
					[
						'nodeName' => 'li',
						'action' => [ LiFixups::class, 'migrateTrailingCategories' ]
					],
					[
						'nodeName' => 'dt',
						'action' => [ LiFixups::class, 'migrateTrailingCategories' ]
					],
					[
						'nodeName' => 'dd',
						'action' => [ LiFixups::class, 'migrateTrailingCategories' ]
					]
				],
				'omit' => ( $test !== 'LiFixups' )
			],
			[
				'name' => 'TableFixups',
				'shortcut' => 'fixups',
				'isTraverser' => true,
				'skipNested' => true,
				'handlers' => [
					[
						'nodeName' => 'td',
						'action' => function ( $node, $env ) use ( &$tableFixer ) {
							return $tableFixer->stripDoubleTDs( $node, $env );
						}
					],
					[
						'nodeName' => 'td',
						'action' => function ( $node, $env ) use ( &$tableFixer ) {
							return $tableFixer->handleTableCellTemplates( $node, $env );
						}
					],
					[
						'nodeName' => 'th',
						'action' => function ( $node, $env ) use ( &$tableFixer ) {
							return $tableFixer->handleTableCellTemplates( $node, $env );
						}
					]
				],
				'omit' => ( $test !== 'TableFixups' )
			],
			[
				'name' => 'DedupeStyles',
				'shortcut' => 'fixups',
				'isTraverser' => true,
				'skipNested' => true,
				'handlers' => [
					[
						'nodeName' => 'style',
						'action' => [ DedupeStyles::class, 'dedupe' ]
					]
				],
				'omit' => ( $test !== 'DedupeStyles' )
			],
			/*
			[
				'Processor' => AddMediaInfo::class,
				'shortcut' => 'media',
				'omit' => ( $test !== 'AddMediaInfo' )
			],
			[
				'name' => 'Headings-genAnchors',
				'shortcut' => 'headings',
				'isTraverser' => true,
				'skipNested' => true,
				'handlers' => [
					[
						'nodeName' => null,
						'action' => [ Headings::class, 'genAnchors' ]
					]
				],
				'omit' => ( $test !== 'Headings-genAnchors' )
			],
			*/
			[
				'Processor' => WrapSections::class,
				'shortcut' => 'sections',
				'skipNested' => true,
				'omit' => ( $test !== 'WrapSections' )
			],
			/*
			[
				'name' => 'Headings-dedupeHeadingIds',
				'shortcut' => 'heading-ids',
				'isTraverser' => true,
				'skipNested' => true,
				'handlers' => [
					[
						'nodeName' => null,
						'action' => function ( $node, $env ) use ( &$seenIds ) {
							return Headings::dedupeHeadingIds( $seenIds, $node, $env );
						}
					]
				],
				'omit' => ( $test !== 'Headings-dedupeHeadingIds' )
			],
			[
				'Processor' => LangConverter::class,
				'shortcut' => 'lang-converter',
				'skipNested' => true,
				'omit' => ( $test !== 'LangConverter' )
			],
			*/
			[
				'Processor' => Linter::class,
				'omit' => !$env->getSiteConfig()->linting(),
				'skipNested' => true,
				'omit' => ( $test !== 'Linter' )
			],
			[
				'name' => 'CleanUp-stripMarkerMetas',
				'shortcut' => 'strip-metas',
				'isTraverser' => true,
				'handlers' => [
					[
						'nodeName' => 'meta',
						'action' => [ CleanUp::class, 'stripMarkerMetas' ]
					]
				],
				'omit' => ( $test !== 'CleanUp-stripMarkerMetas' )
			],
			[
				'Processor' => AddExtLinkClasses::class,
				'shortcut' => 'linkclasses',
				'skipNested' => true,
				'omit' => ( $test !== 'AddExtLinkClasses' )
			],
			[
				'name' => 'CleanUp-handleEmptyElts',
				'shortcut' => 'cleanup',
				'isTraverser' => true,
				'handlers' => [
					[
						'nodeName' => null,
						'action' => [ CleanUp::class, 'handleEmptyElements' ]
					]
				],
				'omit' => ( $test !== 'CleanUp-handleEmptyElts' )
			],
			[
				'name' => 'CleanUp-cleanupAndSaveDataParsoid',
				'shortcut' => 'cleanup',
				'isTraverser' => true,
				'handlers' => [
					[
						'nodeName' => null,
						'action' => [ CleanUp::class, 'cleanupAndSaveDataParsoid' ]
					]
				],
				'omit' => ( $test !== 'CleanUp-cleanupAndSaveDataParsoid' )
			],
			[
				'Processor' => AddRedLinks::class,
				'shortcut' => 'redlinks',
				'skipNested' => true,
				'omit' => ( $test !== 'AddRedLinks' )
			],
		];
		$out = runDOMPostProcessor( $env, $argv, $opts, $processors );
		break;
}

/**
 * Write DOM to file
 */
// fwrite( STDERR, "OUT :$out\n" );
print $out;
