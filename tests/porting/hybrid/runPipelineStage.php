<?php

namespace Parsoid\Tests\Porting\Hybrid;

require_once __DIR__ . '/../../../vendor/autoload.php';

use Parsoid\Tests\MockEnv;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\Token;
use Parsoid\Wt2Html\TokenTransformManager;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\TokenUtils;
use Parsoid\Wt2Html\PegTokenizer;
use Parsoid\Wt2Html\HTML5TreeBuilder;

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
function serializeTokens( $tokens ) {
	$output = "";
	foreach ( $tokens as $t ) {
		$output .= PHPUtils::jsonEncode( $t );
		if ( !( $t instanceof EOFTk ) ) {
			$output .= "\n";
		}
	}
	// fwrite(STDERR, "OUT: " . $output. "\n");
	return $output;
}

/**
 * Parse the input wikitext and return parsed tokens
 * @param MockEnv $env
 * @param string $input
 * @param array $opts
 * @return array
 */
function parse( MockEnv $env, string $input, array $opts ): array {
	// fwrite(STDERR, "IN: " . $input. "\n");
	// fwrite(STDERR, "SRC: " . $env->getPageMainContent()."\n");
	// fwrite(STDERR, "OFFSET: " . ($opts['offsets'][0] ?? 0)."\n");
	$tokens = [];
	$tokenizer = new PegTokenizer( $env );
	$tokenizer->setSourceOffsets( $opts['offsets'][0] ?? 0, $opts['offsets'][1] ?? 0 );
	$ret = $tokenizer->tokenizeSync( $input, [
		'cb' => function ( $t ) use ( &$tokens ) {
			PHPUtils::pushArray( $tokens, $t );
		},
		'sol' => $opts['sol']
	] );
	if ( $ret === false ) {
		fwrite( STDERR, $tokenizer->getLastErrorLogMessage() . "\n" );
		exit( 1 );
	}
	TokenUtils::convertTokenOffsets( $env->getPageMainContent(), 'byte', 'ucs2', $tokens );
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
$env = new MockEnv( [ "pageContent" => $opts['pageContent'] ?? null ] );
$input = file_get_contents( $inputFileName );
switch ( $stageName ) {
	case "PegTokenizer":
		$out = serializeTokens( parse( $env, $input, $opts ) );
		break;

	case "SyncTokenTransformManager":
	case "AsyncTokenTransformManager":
		/* Construct TTM and its transformers */
		$phaseEndRank = $opts['phaseEndRank'];
		$ttm = new TokenTransformManager( $env,
			$opts['pipeline'], null, $phaseEndRank, "Sync $phaseEndRank" );
		$ttm->setPipelineId( $opts['pipelineId'] );
		foreach ( $opts['transformers'] as $t ) {
			$t = "Parsoid\Wt2Html\TT\\" . $t;
			$ttm->addTransformer( new $t( $ttm, $opts['pipeline'] ) );
		}
		$out = '';

		/* Add listener */
		$ttm->addListener( 'chunk', function ( $tokens ) use ( &$out ) {
			$out = serializeTokens( $tokens );
		} );

		/* Process tokens */
		$toks = readTokens( $input );
		$ttm->process( $toks );
		break;

	case "HTML5TreeBuilder":
		$toks = readTokens( $input );
		$tb = new HTML5TreeBuilder( $env );
		$tb->onChunk( $toks );
		$doc = $tb->onEnd();
		$body = DOMCompat::getBody( $doc );
		$out = ContentUtils::ppToXML( $body, [
			'keepTmp' => true,
			'tunnelFosteredContent' => true,
			'storeDiffMark' => true
		] );
		break;

	case "DOMPostProcessor":
		throw new \Exception( "Unsupported!" );
		// $dom = ContentUtils::ppToDOM( $env, $input, [ 'reinsertFosterableContent' => true ] );
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
