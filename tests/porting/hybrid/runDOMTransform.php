<?php

require_once __DIR__ . '/../../../vendor/autoload.php';

use Parsoid\Tests\MockEnv;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\PHPUtils;
// use Parsoid\Utils\DOMTraverser;
use Parsoid\Wt2Html\PP\Processors\AddExtLinkClasses;
use Parsoid\Wt2Html\PP\Processors\ComputeDSR;
use Parsoid\Wt2Html\PP\Processors\HandlePres;
use Parsoid\Wt2Html\PP\Processors\PWrap;
use Parsoid\Wt2Html\PP\Processors\WrapSections;

if ( PHP_SAPI !== 'cli' ) {
	die( 'CLI only' );
}

if ( $argc < 3 ) {
	fwrite( STDERR, "Usage: php runDOMTransform.php <transformerName> <fileName>\n" );
	throw new \Exception( "Missing command-line arguments: 3 expected, $argc provided" );
}

$transformerName = $argv[1];
$htmlFileName = $argv[2];

/**
 * Read HTML from STDIN and build DOM
 */
$input = file_get_contents( 'php://stdin' );
$json = PHPUtils::jsonDecode( $input );

$hackyEnvOpts = $json['hackyEnvOpts'];
$atTopLevel = $json['atTopLevel'];
$runOptions = $json['runOptions'];

// Build a mock env with the bare mininum info that we know
// DOM processors are currently using.
$env = new MockEnv( [
	"wrapSections" => !empty( $hackyEnvOpts['wrapSections' ] ),
	"rtTestMode" => $hackyEnvOpts['rtTestMode'] ?? false,
	"pageContent" => $hackyEnvOpts['pageContent'] ?? null,
] );

$html = file_get_contents( $htmlFileName );
$html = mb_convert_encoding( $html, 'UTF-8',
	mb_detect_encoding( $html, 'UTF-8, ISO-8859-1', true ) );
$body = ContentUtils::ppToDOM( $env, $html, [ 'reinsertFosterableContent' => true ] );

// fwrite(STDERR,
// "---REHYDRATED DOM---\n" .
// ContentUtils::ppToXML( $body, [ 'keepTmp' => true ] ) . "\n------");

$manager = new stdclass();
$manager->env = $env;
$manager->options = [];

/**
 * Build the requested transformer
 */
$transformer = null;
$isTraverser = false;
switch ( $transformerName ) {
	case 'PWrap':
		$transformer = new PWrap();
		break;
	case 'ComputeDSR':
		$transformer = new ComputeDSR();
		break;
	case 'HandlePres':
		$transformer = new HandlePres();
		break;
	case 'WrapSections':
		$transformer = new WrapSections();
		break;
	case 'AddExtLinkClasses':
		$transformer = new AddExtLinkClasses();
		break;
	default:
		throw new \Exception( "Unsupported!" );
}

/**
 * Transform the input DOM
 */
if ( $isTraverser ) {
	$transformer->traverse( $body, $manager->env, $runOptions, $atTopLevel, null );
} else {
	$transformer->run( $body, $manager->env, $runOptions, $atTopLevel );
}

/**
 * Serialize output to DOM while tunneling fosterable content
 * to prevent it from getting fostered on parse to DOM
 */
$out = ContentUtils::ppToXML( $body, [ 'keepTmp' => true, 'tunnelFosteredContent' => true ] );

/**
 * Remove the input DOM file to eliminate clutter
 */
unlink( $htmlFileName );

/**
 * Write DOM to file
 */
// fwrite( STDERR, "OUT DOM:$out\n" );
print $out;
