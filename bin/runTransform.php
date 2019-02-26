<?php

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../tests/MockEnv.php';

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

if ( $argc < 2 ) {
	throw new \Exception( "Provide the transformer name as the first arg." );
}

/**
 * Read pipeline options + tokens from STDIN
 */
$input_file = 'php://stdin';
$transformerName = $argv[1];
$lines = explode( "\n", file_get_contents( $input_file ) );
$optsString = array_shift( $lines );
$pipelineOpts = PHPUtils::jsonDecode( $optsString );
if ( !$pipelineOpts ) {
	throw new \Exception( "Missing pipeline opts in first line of stdin" );
}
// fwrite(STDERR, $optsString . "\n");

/**
 * Decode the json-encoded strings to build tokens
 */
$tokens = [];
foreach ( $lines as $line ) {
	$tokens[] = Token::getToken( PHPUtils::jsonDecode( $line ) );
}

/**
 * Build the requested transformer
 */
$transformer = null;
$manager = (object)[];
$manager->env = new MockEnv( [] );
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
 * Write serialized tokens to STDOUT
 */
// fwrite(STDERR, "RET: $output\n");
print $output;
