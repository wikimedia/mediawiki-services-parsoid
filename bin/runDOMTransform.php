<?php

require_once __DIR__ . '/../vendor/autoload.php';

use Parsoid\Tests\MockEnv;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Wt2Html\PP\Processors\PWrap;
use Parsoid\Wt2Html\PP\Processors\ComputeDSR;
use Parsoid\Wt2Html\XMLSerializer;

if ( PHP_SAPI !== 'cli' ) {
	die( 'CLI only' );
}

if ( $argc < 3 ) {
	fwrite( STDERR, "Usage: php runDOMTransform.php <transformerName> <fileName>\n" );
	throw new \Exception( "Missing command-line arguments: 3 expected, $argc provided" );
}

/**
 * Read HTML from STDIN and build DOM
 */
$transformerName = $argv[1];
$optsString = file_get_contents( 'php://stdin' );
$opts = PHPUtils::jsonDecode( $optsString );

// Build a mock env with the bare mininum info that we know
// DOM processors are currently using.
$env = new MockEnv( [
	"wrapSections" => !empty( $opts['wrapSections' ] ),
	"rtTestMode" => $opts['rtTestMode'] ?? false,
	"pageContent" => $opts['pageContent'] ?? null,
] );

$html = file_get_contents( $argv[2] );
$html = mb_convert_encoding( $html, 'UTF-8',
	mb_detect_encoding( $html, 'UTF-8, ISO-8859-1', true ) );
$dom = $env->createDocument( $html );
$body = $dom->getElementsByTagName( 'body' )->item( 0 );
// fwrite( STDERR, "\nIN DOM :" . XMLSerializer::serialize( $body )['html'] . "\n" );
DOMDataUtils::visitAndLoadDataAttribs( $body );

$manager = new stdclass();
$manager->env = $env;
$manager->options = [];

/**
 * Build the requested transformer
 */
$transformer = null;
switch ( $transformerName ) {
	case 'PWrap':
		$transformer = new PWrap();
		break;
	case 'ComputeDSR':
		$transformer = new ComputeDSR();
		break;
	default:
		throw new \Exception( "Unsupported!" );
}

/**
 * Transform the input DOM
 */
$transformer->run( $body, $manager->env, $opts );

/**
 * Serialize output to DOM
 */
DOMDataUtils::visitAndStoreDataAttribs( $body, [ "keepTmp" => true ] );
$out = XMLSerializer::serialize( $body )['html'];

/**
 * Write DOM to file
 */
// fwrite( STDERR, "OUT DOM:$out\n" );
print $out;
