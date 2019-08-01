<?php

namespace Parsoid\Tests\Porting\Hybrid;

require_once __DIR__ . '/../../../vendor/autoload.php';

use Parsoid\Config\Api\Env as ApiEnv;
use Parsoid\Config\Env;
use Parsoid\Tokens\SourceRange;
use Parsoid\Tokens\Token;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\TokenUtils;
use Parsoid\Wt2Html\DOMPostProcessor;
use Parsoid\Wt2Html\HTML5TreeBuilder;
use Parsoid\Wt2Html\PegTokenizer;
use Parsoid\Wt2Html\TokenTransformManager;

/**
 * Decode the json-encoded strings to build tokens
 * @param string $input
 * return array
 */
function readTokens( string $input ): array {
	$lines = explode( "\n", $input );
	$tokens = [];
	foreach ( $lines as $line ) {
		$tokens[] = Token::getToken( PHPUtils::jsonDecode( $line ) );
	}
	return $tokens;
}

/**
 * Serialize output tokens to JSON
 */
function serializeTokens( $env, $tokens ) {
	// First line will be the new UID for env
	$output = (string)$env->getUID() . "\n";
	foreach ( $tokens as $t ) {
		if ( is_array( $t ) ) {
			# chunk boundary
			$output .= '--';
		} else {
			$output .= PHPUtils::jsonEncode( $t );
		}
		$output .= "\n";
	}
	// fwrite(STDERR, "OUT: " . $output. "\n");
	return $output;
}

/**
 * Parse the input wikitext and return parsed tokens
 * @param Env $env
 * @param string $input
 * @param array $opts
 * @return array
 */
function parse( Env $env, string $input, array $opts ): array {
	// fwrite(STDERR, "IN: " . $input. "\n");
	// fwrite(STDERR, "SRC: " . $env->topFrame->getSrcText()."\n");
	// fwrite(STDERR, "OFFSET: " . ($opts['sourceOffsets'][0] ?? 0)."\n");
	$tokens = [];
	$so = new SourceRange(
		$opts['sourceOffsets'][0] ?? null, $opts['sourceOffsets'][1] ?? null
	);
	$tokenizer = new PegTokenizer( $env );
	$tokenizer->setSourceOffsets( $so );

	// Use the streaming-generator-version of the tokenizer
	// because the hybrid testing code that consumes these tokens
	// seems to be expecting chunks and chunk boundaries.
	// The synchronous parsing version no longer supports callbacks
	// that was previously used to implement chunk boundaries here.
	try {
		$opts = [ 'sol' => $opts['sol'] ];
		foreach ( $tokenizer->processChunkily( $input, $opts ) as $toks ) {
			PHPUtils::pushArray( $tokens, $toks );
			# chunk boundary
			$tokens[] = [];
		}
	} catch ( \WikiPEG\SyntaxError $err ) {
		fwrite( STDERR, $tokenizer->getLastErrorLogMessage() . "\n" );
		exit( 1 );
	}
	TokenUtils::convertTokenOffsets( $env->topFrame->getSrcText(), 'byte', 'ucs2', $tokens );
	return $tokens;
}

if ( PHP_SAPI !== 'cli' ) {
	die( 'CLI only' );
}

if ( $argc < 3 ) {
	fwrite( STDERR, "Usage: php runPipelineStage.php <stageName> <fileName>\n" );
	throw new \Exception( "Provide the pipeline stage name as the first arg." );
}

$stageName = $argv[1];
$inputFileName = $argv[2];

/**
 * Read pipeline options from STDIN
 */
$opts = PHPUtils::jsonDecode( file_get_contents( 'php://stdin' ) );
$input = file_get_contents( $inputFileName );

$envOpts = $opts['envOpts'];

$env = new ApiEnv( [
	"uid" => $envOpts['currentUid'] ?? -1,
	"fid" => $envOpts['currentFid'] ?? -1,
	"apiEndpoint" => $envOpts['apiURI'],
	"pageContent" => $envOpts['pageContent'] ?? $input,
	"pageLanguage" => $envOpts['pagelanguage'] ?? null,
	"pageLanguageDir" => $envOpts['pagelanguagedir'] ?? null,
	"debugFlags" => $envOpts['debugFlags'] ?? null,
	"dumpFlags" => $envOpts['dumpFlags'] ?? null,
	"traceFlags" => $envOpts['traceFlags'] ?? null,
	"title" => $envOpts['pagetitle'] ?? "Main_Page",
	"pageId" => $envOpts['pageId'] ?? null,
	"scrubWikitext" => $envOpts['scrubWikitext'] ?? false,
	"wrapSections" => !empty( $envOpts['wrapSections' ] ),
	'tidyWhitespaceBugMaxLength' => $envOpts['tidyWhitespaceBugMaxLength'] ?? null,
	# This directory used to contain synthetic data which didn't exactly match
	# enwiki, but matched what parserTests expects
	# "cacheDir" => __DIR__ . '/data',
	"writeToCache" => 'pretty',
] );
foreach ( $envOpts['tags'] ?? [] as $tag ) {
	$env->getSiteConfig()->ensureExtensionTag( $tag );
}
foreach ( $envOpts['fragmentMap'] ?? [] as $entry ) {
	$env->setFragment( $entry[0], array_map( function ( $v ) {
		return DOMCompat::getBody( DOMUtils::parseHTML( $v ) )->firstChild;
	}, $entry[1] ) );
}

switch ( $stageName ) {
	case "PegTokenizer":
		$out = serializeTokens( $env, parse( $env, $input, $opts ) );
		break;

	case "SyncTokenTransformManager":
	case "AsyncTokenTransformManager":
		/* Construct TTM and its transformers */
		$phaseEndRank = $opts['phaseEndRank'];
		$pipelineOpts = $opts['pipelineOpts'];
		$ttm = new TokenTransformManager( $env, $pipelineOpts, $phaseEndRank );
		$ttm->setPipelineId( $opts['pipelineId'] );
		foreach ( $opts['transformers'] as $t ) {
			if ( $t === 'SanitizerHandler' ) {
				$t = 'Sanitizer';
			}
			$t = "Parsoid\Wt2Html\TT\\" . $t;
			$ttm->addTransformer( new $t( $ttm, $pipelineOpts ) );
		}
		$ttm->resetState( $opts );
		$out = '';

		/* Process tokens */
		$toks = readTokens( $input );
		TokenUtils::convertTokenOffsets( $env->getPageMainContent(), 'ucs2', 'byte', $toks );
		$toks = $ttm->process( $toks );
		TokenUtils::convertTokenOffsets( $env->getPageMainContent(), 'byte', 'ucs2', $toks );
		$out = serializeTokens( $env, $toks );
		break;

	case "HTML5TreeBuilder":
		$toks = readTokens( $input );
		TokenUtils::convertTokenOffsets( $env->getPageMainContent(), 'ucs2', 'byte', $toks );
		$tb = new HTML5TreeBuilder( $env );
		$doc = $tb->process( $toks );
		$body = DOMCompat::getBody( $doc );
		// HACK: Piggyback new uid/fid for env on <body>
		$body->setAttribute( "data-env-newuid", $env->getUID() );
		$body->setAttribute( "data-env-newfid", $env->getFID() );
		$out = ContentUtils::ppToXML( $body, [
			'keepTmp' => true,
			'tunnelFosteredContent' => true,
			'storeDiffMark' => true
		] );
		break;

	case "DOMPostProcessor":
		$dom = ContentUtils::ppToDOM( $env, $input, [ 'reinsertFosterableContent' => true ] );
		$dpp = new DOMPostProcessor( $env );
		$dpp->registerProcessors( [] ); // Use default processors
		$dpp->resetState( $opts );
		$doc = $dpp->process( $dom->ownerDocument );
		$body = DOMCompat::getBody( $doc );
		// HACK: Piggyback new uid/fid for env on <body>
		$body->setAttribute( "data-env-newuid", $env->getUID() );
		$body->setAttribute( "data-env-newfid", $env->getFID() );
		if ( empty( $opts['toplevel'] ) ) {
			$out = ContentUtils::ppToXML( $body, [
				'keepTmp' => true,
				'tunnelFosteredContent' => true,
			] );
		} else {
			$out = ContentUtils::toXML( $body );
		}
		break;

	default:
		throw new \Exception( "Unsupported!" );
}

/**
 * Remove the input file to eliminate clutter
 */
unlink( $inputFileName );

/**
 * Write serialized tokens to STDOUT
 */
// fwrite(STDERR, "RET:----\n$out\n----");
print $out;
