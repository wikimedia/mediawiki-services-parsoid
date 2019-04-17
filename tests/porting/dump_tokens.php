<?php

namespace Parsoid\Tests\Porting;

use Parsoid\Utils\TokenUtils;
use Parsoid\Wt2Html\PegTokenizer;
use Parsoid\Utils\PHPUtils;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * Parse the input wikitext and return parsed tokens
 * @param TokenizerMockEnv $env
 * @param string $input
 * @return array
 */
function parse( TokenizerMockEnv $env, string $input ): array {
	$tokenizer = new PegTokenizer( $env );
	$tokens = [];
	$ret = $tokenizer->tokenizeSync( $input, [
		'cb' => function ( $t ) use ( &$tokens ) {
			PHPUtils::pushArray( $tokens, $t );
		},
		'pegTokenizer' => $tokenizer,
		'pipelineOffset' => 0,
		'env' => $env,
		'startRule' => 'start'
	] );
	if ( $ret === false ) {
		fwrite( STDERR, $tokenizer->getLastErrorLogMessage() . "\n" );
		exit( 1 );
	}
	return $tokens;
}

$opts = [];
$env = new TokenizerMockEnv( [
	"siteConfig" => new TokenizerMockSiteConfig( $opts )
] );

if ( isset( $argv[1] ) ) {
	$inputFile = $argv[1];
} else {
	$inputFile = '-';
}
if ( $inputFile === '-' ) {
	$input = stream_get_contents( STDIN );
} else {
	$input = file_get_contents( $inputFile );
}
if ( $input === false ) {
	fwrite( STDERR, "Unable to open input file \"$inputFile\"\n" );
	exit( 1 );
}
$tokens = parse( $env, $input );

// Dump tokens with both byte offsets as well as JS offsets
// $file.php.jsoffset.tokens will be compared with $file.js.tokens
// and where they differ, it would be useful to look at the original
// tokens as emitted by the PHP tokenizer
if ( $inputFile !== '-' ) {
	$fp_byte = fopen( $inputFile . '.php.byteoffset.tokens', 'w' );
} else {
	$fp_byte = null;
}

foreach ( $tokens as $t ) {
	if ( $fp_byte ) {
		fwrite( $fp_byte, PHPUtils::jsonEncode( $t ) . "\n" );
	}
}
TokenUtils::convertTokenOffsets( $input, 'byte', 'ucs2', $tokens );

if ( $inputFile === '-' ) {
	$fp_ucs = STDOUT;
} else {
	$fp_ucs = fopen( $inputFile . '.php.jsoffset.tokens', 'w' );
}

foreach ( $tokens as $t ) {
	fwrite( $fp_ucs, PHPUtils::jsonEncode( $t ) . "\n" );
}
