<?php

namespace Parsoid\Tests\Porting\Hybrid;

require_once __DIR__ . '/../../../vendor/autoload.php';

use Parsoid\Html2Wt\DOMDiff;
use Parsoid\Html2Wt\DOMNormalizer;
use Parsoid\Tests\MockEnv;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMTraverser;
use Parsoid\Utils\PHPUtils;
use Parsoid\Wt2Html\PP\Handlers\CleanUp;
use Parsoid\Wt2Html\PP\Handlers\DedupeStyles;
use Parsoid\Wt2Html\PP\Handlers\HandleLinkNeighbours;
use Parsoid\Wt2Html\PP\Handlers\Headings;
use Parsoid\Wt2Html\PP\Handlers\LiFixups;
use Parsoid\Wt2Html\PP\Handlers\TableFixups;
use Parsoid\Wt2Html\PP\Processors\AddExtLinkClasses;
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
	return ContentUtils::ppToDOM( $env, $html, [ 'reinsertFosterableContent' => true,
		'markNew' => true
	] );
}

function serializeDOM( $body ) {
	/**
	 * Serialize output to DOM while tunneling fosterable content
	 * to prevent it from getting fostered on parse to DOM
	 */
	return ContentUtils::ppToXML( $body, [ 'keepTmp' => true,
		'tunnelFosteredContent' => true,
		'storeDiffMark' => true
	] );
}

function runTransform( $transformer, $argv, $opts, $isTraverser = false, $env = null ) {
	$atTopLevel = $opts['atTopLevel'];
	$runOptions = $opts['runOptions'];

	if ( !$env ) {
		// Build a mock env with the bare mininum info that we know
		// DOM processors are currently using.
		$hackyEnvOpts = $opts['hackyEnvOpts'];
		$env = new MockEnv( [
			"wrapSections" => !empty( $hackyEnvOpts['wrapSections' ] ),
			"rtTestMode" => $hackyEnvOpts['rtTestMode'] ?? false,
			"pageContent" => $hackyEnvOpts['pageContent'] ?? null,
			'tidyWhitespaceBugMaxLength' => $hackyEnvOpts['tidyWhitespaceBugMaxLength'] ?? null,
		] );
	}

	$htmlFileName = $argv[2];
	$body = buildDOM( $env, $htmlFileName );

	// fwrite(STDERR,
	// "---REHYDRATED DOM---\n" .
	// ContentUtils::ppToXML( $body, [ 'keepTmp' => true ] ) . "\n------");

	if ( $isTraverser ) {
		$transformer->traverse( $body, $env, $runOptions, $atTopLevel, null );
	} else {
		$transformer->run( $body, $env, $runOptions, $atTopLevel );
	}

	// Shove Linter output (if any) into the body node's tmp data
	$dp = DOMDataUtils::getDataParsoid( $body );
	$dp->tmp->phpDOMLints = $env->getLints();

	$out = serializeDOM( $body );

	/**
	 * Remove the input DOM file to eliminate clutter
	 */
	unlink( $htmlFileName );
	return $out;
}

function runDOMHandlers( $argv, $opts, $addHandlersCB ) {
	$transformer = new DOMTraverser();
	$hackyEnvOpts = $opts['hackyEnvOpts'];
	$env = new MockEnv( [
		"rtTestMode" => $hackyEnvOpts['rtTestMode'] ?? false,
		"pageContent" => $hackyEnvOpts['pageContent'] ?? null
	] );
	$addHandlersCB( $transformer, $env );
	return runTransform( $transformer, $argv, $opts, true, $env );
}

function runDOMDiff( $argv, $opts ) {
	$hackyEnvOpts = $opts['hackyEnvOpts'];

	$env = new MockEnv( [
		"rtTestMode" => $hackyEnvOpts['rtTestMode'] ?? false,
		"pageContent" => $hackyEnvOpts['pageContent'] ?? null,
		"pageId" => $hackyEnvOpts['pageId'] ?? null
	] );

	$htmlFileName1 = $argv[2];
	$htmlFileName2 = $argv[3];
	$oldBody = buildDOM( $env, $htmlFileName1 );
	$newBody = buildDOM( $env, $htmlFileName2 );

	$dd = new DOMDiff( $env );
	$diff = $dd->diff( $oldBody, $newBody );
	$out = serializeDOM( $newBody );

	unlink( $htmlFileName1 );
	unlink( $htmlFileName2 );
	return PHPUtils::jsonEncode( [ "diff" => $diff, "html" => $out ] );
}

function runDOMNormalizer( $argv, $opts ) {
	$hackyEnvOpts = $opts['hackyEnvOpts'];

	$env = new MockEnv( [
		"rtTestMode" => $hackyEnvOpts['rtTestMode'] ?? false,
		"pageContent" => $hackyEnvOpts['pageContent'] ?? null,
		"scrubWikitext" => $hackyEnvOpts['scrubWikitext'] ?? false
	] );

	$htmlFileName = $argv[2];
	$body = buildDOM( $env, $htmlFileName );

	$normalizer = new DOMNormalizer( (object)[
		"env" => $env,
		"rtTestMode" => $hackyEnvOpts["rtTestMode"] ?? false,
		"selserMode" => $hackyEnvOpts["selserMode"] ?? false
	] );
	$normalizer->normalize( $body );

	$out = serializeDOM( $body );
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
$allOpts = PHPUtils::jsonDecode( $input );

/**
 * Build the requested transformer
 */
$transformer = null;
switch ( $argv[1] ) {
	// DOM Processors
	case 'PWrap':
		$out = runTransform( new PWrap(), $argv, $allOpts );
		break;
	case 'ProcessTreeBuilderFixups':
		$out = runTransform( new ProcessTreeBuilderFixups(), $argv, $allOpts );
		break;
	case 'MarkFosteredContent':
		$out = runTransform( new MarkFosteredContent(), $argv, $allOpts );
		break;
	case 'ComputeDSR':
		$out = runTransform( new ComputeDSR(), $argv, $allOpts );
		break;
	case 'HandlePres':
		$out = runTransform( new HandlePres(), $argv, $allOpts );
		break;
	case 'Linter':
		$out = runTransform( new Linter(), $argv, $allOpts );
		break;
	case 'WrapSections':
		$out = runTransform( new WrapSections(), $argv, $allOpts );
		break;
	case 'WrapTemplates':
		$out = runTransform( new WrapTemplates(), $argv, $allOpts );
		break;
	case 'AddExtLinkClasses':
		$out = runTransform( new AddExtLinkClasses(), $argv, $allOpts );
		break;
	case 'MigrateTemplateMarkerMetas':
		$out = runTransform( new MigrateTemplateMarkerMetas(), $argv, $allOpts );
		break;
	case 'MigrateTrailingNLs':
		$out = runTransform( new MigrateTrailingNLs(), $argv, $allOpts );
		break;
	case 'DOMDiff':
		$out = runDOMDiff( $argv, $allOpts );
		break;
	case 'DOMNormalizer':
		$out = runDOMNormalizer( $argv, $allOpts );
		break;
	// Handlers
	case 'LiFixups':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$liFixer = new LiFixups( $env );
			$transformer->addHandler( 'li', function ( ...$args ) use ( $liFixer ) {
				return $liFixer->handleLIHack( ...$args );
			} );
			$transformer->addHandler( 'li', function ( ...$args ) use ( $liFixer ) {
				return $liFixer->migrateTrailingCategories( ...$args );
			} );
			$transformer->addHandler( 'dt', function ( ...$args ) use ( $liFixer ) {
				return $liFixer->migrateTrailingCategories( ...$args );
			} );
			$transformer->addHandler( 'dd', function ( ...$args ) use ( $liFixer ) {
				return $liFixer->migrateTrailingCategories( ...$args );
			} );
		} );
		break;
	case 'TableFixups':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$tdFixer = new TableFixups( $env );
			$transformer->addHandler( 'td', function ( ...$args ) use ( $tdFixer ) {
				return $tdFixer->stripDoubleTDs( ...$args );
			} );
			$transformer->addHandler( 'td', function ( ...$args ) use ( $tdFixer ) {
				return $tdFixer->handleTableCellTemplates( ...$args );
			} );
			$transformer->addHandler( 'th', function ( ...$args ) use ( $tdFixer ) {
				return $tdFixer->handleTableCellTemplates( ...$args );
			} );
		} );
		break;
	case 'CleanUp-cleanupAndSaveDataParsoid':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$transformer->addHandler( null, function ( ...$args ) {
				return CleanUp::cleanupAndSaveDataParsoid( ...$args );
			} );
		} );
		break;
	case 'CleanUp-handleEmptyElts':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$transformer->addHandler( null, function ( ...$args ) {
				return CleanUp::handleEmptyElements( ...$args );
			} );
		} );
		break;
	case 'CleanUp-stripMarkerMetas':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$transformer->addHandler( 'meta', function ( ...$args ) {
				return CleanUp::stripMarkerMetas( ...$args );
			} );
		} );
		break;
	case 'DedupeStyles':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$transformer->addHandler( 'style', function ( ...$args ) {
				return DedupeStyles::dedupe( ...$args );
			} );
		} );
		break;
	case 'HandleLinkNeighbours':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$transformer->addHandler( 'a', function ( ...$args ) {
				return HandleLinkNeighbours::handler( ...$args );
			} );
		} );
		break;
	case 'Headings-dedupeHeadingIds':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$transformer->addHandler( null, function ( ...$args ) {
				return Headings::dedupeHeadingIds( ...$args );
			} );
		} );
		break;
	case 'Headings-genAnchors':
		$out = runDOMHandlers( $argv, $allOpts, function ( $transformer, $env ) {
			$transformer->addHandler( null, function ( ...$args ) {
				return Headings::genAnchors( ...$args );
			} );
		} );
		break;

	default:
		throw new \Exception( "Unsupported!" );
}

/**
 * Write DOM to file
 */
// fwrite( STDERR, "OUT DOM:$out\n" );
print $out;
