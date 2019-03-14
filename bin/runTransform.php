<?php

require_once __DIR__ . '/../vendor/autoload.php';

use Parsoid\Tests\MockEnv;
use Parsoid\Tokens\Token;
use Parsoid\Utils\PHPUtils;
use Parsoid\Wt2Html\TT\QuoteTransformer;
use Parsoid\Wt2Html\TT\ParagraphWrapper;
use Parsoid\Wt2Html\TT\PreHandler;
use Parsoid\Wt2Html\TT\ListHandler;
use Parsoid\Wt2Html\TT\BehaviorSwitchHandler;

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
$pipelineOpts = $opts['pipeline'];

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
$manager = (object)[];
$manager->env = new MockEnv( [ "pageContent" => $opts['pageContent'] ?? null ] );
$manager->pipelineId = 0;
$manager->options = [];
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
	default:
		throw new \Exception( "Unsupported!" );
}

/**
 * Transform the input tokens to output tokens
 */
if ( !$transformer->disabled ) {
	// fwrite(STDERR, "$transformerName running ...\n");
	$tokens = $transformer->processTokensSync( $manager->env, $tokens, [] );
}

/**
 * Serialize output tokens to JSON
 */
$output = "";
foreach ( $tokens as $t ) {
	$output .= PHPUtils::jsonEncode( $t );
	$output .= "\n";
}

/**
 * Remove the input token file to eliminate clutter
 */
unlink( $tokenFileName );

/**
 * Write serialized tokens to STDOUT
 */
// fwrite(STDERR, "RET: $output\n");
print $output;
