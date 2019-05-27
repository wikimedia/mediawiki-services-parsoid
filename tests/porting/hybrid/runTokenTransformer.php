<?php

require_once __DIR__ . '/../../../vendor/autoload.php';

use Parsoid\Config\Api\Env as ApiEnv;
use Parsoid\Tokens\Token;
use Parsoid\Tokens\EOFTk;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Wt2Html\TokenTransformManager;
use Parsoid\Wt2Html\TT\QuoteTransformer;
use Parsoid\Wt2Html\TT\ParagraphWrapper;
use Parsoid\Wt2Html\TT\PreHandler;
use Parsoid\Wt2Html\TT\ListHandler;
use Parsoid\Wt2Html\TT\BehaviorSwitchHandler;
use Parsoid\Wt2Html\TT\NoInclude;
use Parsoid\Wt2Html\TT\IncludeOnly;
use Parsoid\Wt2Html\TT\OnlyInclude;
use Parsoid\Wt2Html\TT\Sanitizer;
use Parsoid\Wt2Html\TT\TokenStreamPatcher;

if ( PHP_SAPI !== 'cli' ) {
	die( 'CLI only' );
}

if ( $argc < 3 ) {
	fwrite( STDERR, "Usage: php runTransform.php <transformerName> <fileName>\n" );
	throw new \Exception( "Provide the transformer name as the first arg." );
}

$transformerName = $argv[1];
$tokenFileName = $argv[2];

/**
 * Read pipeline options from STDIN
 */
$opts = PHPUtils::jsonDecode( file_get_contents( 'php://stdin' ) );
$pipelineOpts = $opts['pipelineOpts'];

/**
 * Decode the json-encoded strings to build tokens
 */
$lines = explode( "\n", file_get_contents( $tokenFileName ) );
$tokens = [];
foreach ( $lines as $line ) {
	$tokens[] = Token::getToken( PHPUtils::jsonDecode( $line ) );
}

/**
 * Build the requested transformer
 */
$transformer = null;

$envOpts = $opts['envOpts'];
$apiEndpoint = preg_match( '/^(.*)wiki$/', $envOpts['prefix'] ?? '', $m ) === 1 ?
	( "https://" . $m[1] . ".wikipedia.org/w/api.php" ) : $envOpts['apiURI'];
$env = new ApiEnv( [
	"uid" => $envOpts['currentUid'] ?? -1,
	"fid" => $envOpts['currentFid'] ?? -1,
	"apiEndpoint" => $apiEndpoint,
	"pageContent" => $envOpts['pageContent'] ?? null,
	"pageLanguage" => $envOpts['pagelanguage'] ?? null,
	"pageLanguageDir" => $envOpts['pagelanguagedir'] ?? null,
	"debugFlags" => $envOpts['debugFlags'] ?? null,
	"dumpFlags" => $envOpts['dumpFlags'] ?? null,
	"traceFlags" => $envOpts['traceFlags'] ?? null,
	"title" => $envOpts['pagetitle'] ?? "Main_Page",
	"pageId" => $envOpts['pageId'] ?? null,
	# This directory contains synthetic data which doesn't exactly match
	# enwiki, but matches what parserTests expects
	"cacheDir" => __DIR__ . '/data',
	"writeToCache" => 'pretty',
] );
foreach ( $envOpts['tags'] ?? [] as $tag ) {
	$env->getSiteConfig()->ensureExtensionTag( $tag );
}
foreach ( $envOpts['fragmentMap'] ?? [] as $entry ) {
	$k = $entry[0];
	$env->setFragment( $entry[0], array_map( function ( $v ) {
		return DOMUtils::parseHTML( $v );
	}, $entry[1] ) );
}

$manager = new TokenTransformManager( $env, $pipelineOpts, -1 );
$manager->setPipelineId( $opts['pipelineId'] );
switch ( $transformerName ) {
	case "QuoteTransformer":
		$transformer = new QuoteTransformer( $manager, $pipelineOpts );
		break;
	case "ParagraphWrapper":
		$transformer = new ParagraphWrapper( $manager, $pipelineOpts );
		break;
	case "PreHandler":
		$transformer = new PreHandler( $manager, $pipelineOpts );
		break;
	case "BehaviorSwitchHandler":
		$transformer = new BehaviorSwitchHandler( $manager, $pipelineOpts );
		break;
	case "ListHandler":
		$transformer = new ListHandler( $manager, $pipelineOpts );
		break;
	case 'NoInclude':
		$transformer = new NoInclude( $manager, $pipelineOpts );
		break;
	case 'IncludeOnly':
		$transformer = new IncludeOnly( $manager, $pipelineOpts );
		break;
	case 'OnlyInclude':
		$transformer = new OnlyInclude( $manager, $pipelineOpts );
		break;
	case 'SanitizerHandler':
		$transformer = new Sanitizer( $manager, $pipelineOpts );
		break;
	case 'TokenStreamPatcher':
		$transformer = new TokenStreamPatcher( $manager, $pipelineOpts );
		break;	default:
		throw new \Exception( "Unsupported!" );
}

/**
 * Transform the input tokens to output tokens
 */
if ( !$transformer->isDisabled() ) {
	// fwrite(STDERR, "$transformerName running ...\n");
	$transformer->resetState( $opts );
	$tokens = $transformer->process( $tokens );
}

/**
 * Serialize output tokens to JSON
 * First line will be the new UID for env.
 */
$output = (string)$env->getUID() . "\n";
foreach ( $tokens as $t ) {
	$output .= PHPUtils::jsonEncode( $t );
	if ( !( $t instanceof EOFTk ) ) {
		$output .= "\n";
	}
}

/**
 * Remove the input token file to eliminate clutter
 */
unlink( $tokenFileName );

/**
 * Write serialized tokens to STDOUT
 */
// fwrite(STDERR, "RET:----\n$output\n----");
print $output;
