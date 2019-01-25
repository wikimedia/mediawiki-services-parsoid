<?php

/*
DOM transform unit test system

Purpose:
 During the porting of Parsoid to PHP, we need a system to capture and
 replay Javascript Parsoid generated DOM transformers behavior and performance
 so we can duplicate the functionality and verify adequate performance.

 The domTests.js program works in concert with Parsoid and special
 capabilities added to the DOMPostProcessor.js file which
 now has DOM transformer test generation capabilities that produce test
 files pairs from existing wiki pages or any wikitext to properly
 validate the transformers input and output.

Technical details:
 The test validator and handler runtime emulates the normal
 Parsoid DOMPostProcessoer behavior.

 To create a test from an existing wikitext page, run the following
 commands, for example:
 $ node bin/parse.js --genTest dom:dsr --genDirectory ../tests --pageName Hampi

 For command line options and required parameters, type:
 $ node bin/domTest.js --help

 An example command line to validate and performance test the 'Hampi'
 wikipage created as a dom:dsr test:
 $ node bin/domTests.php --timingMode --iterationCount 99 --transformer dsr --inputFile Hampi

 Optional command line options to aid in debugging are:
 --log --trace dsr   (causes the computeDSR.php code to emit execution trace output)
 --debug_dump        (causes the Pre and Post transform DOM to be serialized and written
					 (to temporaryPrePhp.txt and temporaryPostPhp.txt files)

 There are a number of tests in tests/transform directory.  To regenerate
 these, use:
 $ tools/regen-transformTests.sh

 To run these pregenerated tests, use:
 $ npm run transformTests
*/

namespace Parsoid\Bin;

require_once __DIR__ . '/../vendor/autoload.php';

use RemexHtml\DOM;
use RemexHtml\Tokenizer;
use RemexHtml\TreeBuilder;
use RemexHtml\Serializer;

use Parsoid\Tests\MockEnv;
use Parsoid\Config\WikitextConstants;
use Parsoid\PHPUtils\PHPUtils;
use Parsoid\Utils\DU;

$wgCachedState = false;
$wgCachedFilePre = '';
$wgCachedFilePost = '';
$wgLogFlag = false;

WikitextConstants::init();
DU::init();

/**
 * Log message to output
 * @param string $msg
 */
function wfLog( $msg ) {
	print $msg;
}

/**
 * Get a token from some HTML text
 *
 * @param object $domBuilder
 * @param string $text
 * @return object
 */
function buildDOM( $domBuilder, $text ) {
	$treeBuilder = new TreeBuilder\TreeBuilder( $domBuilder, [ 'ignoreErrors' => true ] );
	$dispatcher = new TreeBuilder\Dispatcher( $treeBuilder );
	$tokenizer = new Tokenizer\Tokenizer( $dispatcher, $text, [] );
	$tokenizer->execute( [] );
	return $domBuilder->getFragment();
}

class DOMPassTester {
	public $t;
	public $env;

	/**
	 * Constructor
	 *
	 * @param object $env
	 * @param object $options
	 */
	public function __construct( $env, $options ) {
		$this->env = $env;
		$this->pipelineId = 0;
		$this->options = $options;
		$this->domTransforms = [];
		$this->transformTime = 0;
	}

	/**
	 * Process wiki test file
	 *
	 * @param object $opts
	 * @return number
	 */
	public function processWikitextFile( $opts ) {
		global $wgCachedState;
		global $wgCachedFilePre;
		global $wgCachedFilePost;
		$numFailures = 0;

		if ( $wgCachedState == false ) {
			$wgCachedState = true;
			$testFilePre = file_get_contents( $opts->inputFile . '-' .
				$opts->transformer . '-pre.txt' );
			$testFilePost = file_get_contents( $opts->inputFile . '-' .
				$opts->transformer . '-post.txt' );

			$testFilePre = mb_convert_encoding( $testFilePre, 'UTF-8',
				mb_detect_encoding( $testFilePre, 'UTF-8, ISO-8859-1', true ) );
			$testFilePost = mb_convert_encoding( $testFilePost, 'UTF-8',
				mb_detect_encoding( $testFilePost, 'UTF-8, ISO-8859-1', true ) );

			$wgCachedFilePre = $testFilePre;
			$wgCachedFilePost = $testFilePost;
		} else {
			$testFilePre = $wgCachedFilePre;
			$testFilePost = $wgCachedFilePost;
		}

		$domBuilder = new DOM\DOMBuilder;
		$serializer = new DOM\DOMSerializer( $domBuilder, new Serializer\HtmlFormatter );

		$dom = buildDOM( $domBuilder, $testFilePre );

		if ( $opts->firstRun ) {
			$domPre = $serializer->getResult();

			// hack to add html and head tags and adjust closing /body and add /html tag and newline
			$testFilePre = "<html><head></head>" . substr( $testFilePre, 0, -8 ) . "\n</body></html>";

			if ( $testFilePre === $domPre ) {
				wfLog( "DOM pre output matches genTest Pre output\n" );
			} else {
				wfLog( "DOM pre output DOES NOT match genTest Pre output\n" );
			}

			if ( $opts->debug_dump ) {
				file_put_contents( 'temporaryPrePhp.txt', $domPre );
				wfLog( "temporaryPrePhp.txt saved!\n" );
			}
		}

		$startTime = PHPUtils::getStartHRTime();

		switch ( $opts->transformer ) {
			case 'dsr':
				$body = $dom->getElementsByTagName( 'body' )->item( 0 );
				// genTest must specify dsr sourceOffsets as data-parsoid info
				$dp = DU::getDataParsoid( $body );
				if ( $dp['dsr'] ) {
					$options = [ 'sourceOffsets' => $dp['dsr'], 'attrExpansion' => false ];
				} else {
					$options = [ 'attrExpansion' => false ];
				}
				computeDSR( $body, $this->env, $options );
				break;
			case 'cleanupFormattingTagFixup':
				cleanupFormattingTagFixup( $dom->getElementsByTagName( 'body' )->item( 0 ), $this->env );
				break;
			case 'sections' :
				wrapSections( $dom->getElementsByTagName( 'body' )->item( 0 ), $this->env, null );
				break;
			case 'pwrap' :
				pwrapDOM( $dom->getElementsByTagName( 'body' )->item( 0 ), $this->env, null );
				break;
		}

		$this->transformTime += PHPUtils::getHRTimeDifferential( $startTime );

		if ( $opts->firstRun ) {
			$opts->firstRun = false;

			$domPost = $serializer->getResult();

			// hack to add html and head tags and adjust closing /body and add /html tag and newline
			$testFilePost = "<html><head></head>" . substr( $testFilePost, 0, -8 ) . "\n</body></html>";

			if ( $testFilePost === $domPost ) {
				wfLog( "DOM post transform output matches genTest Post output\n" );
			} else {
				wfLog( "DOM post transform output DOES NOT match genTest Post output\n" );
				$numFailures++;
			}

			if ( $opts->debug_dump ) {
				file_put_contents( 'temporaryPostPhp.txt', $domPost );
				wfLog( "temporaryPostPhp.txt saved!\n" );
			}
		}

		return $numFailures;
	}

	/**
	 * Process test file timing and iteration
	 *
	 * @param object $opts
	 * @return number
	 */
	public function wikitextFile( $opts ) {
		$numFailures = 0;
		$iterator = 1;

		if ( isset( $opts->timingMode ) ) {
			$opts->firstRun = true;
			if ( isset( $opts->iterationCount ) ) {
				$iterator = $opts->iterationCount;
			} else {
				$iterator = 50;  // defaults to 50 interations
			}
		}

		if ( !isset( $commandLine->timingMode ) ) {
			wfLog( "Starting wikitext dom test, file = " . $opts->inputFile .
				"-" . $opts->transformer . "-pre.txt and -post.txt\n\n" );
		}

		while ( $iterator-- ) {
			$numFailures += $this->processWikitextFile( $opts );
		}

		if ( !isset( $commandLine->timingMode ) ) {
			wfLog( "Ending wikitext dom test, file = " . $opts->inputFile . "-" .
				$opts->transformer . "-pre.txt and -post.txt\n\n" );
		}
		return $numFailures;
	}
}

/**
 * processArguments handles a subset of javascript yargs like processing for command line
 * parameters setting object elements to the key name. If no value follows the key,
 * it is set to true, otherwise it is set to the value. The key can be followed by a
 * space then value, or an equals symbol then the value. Parameters that are not
 * preceded with -- are stored in the element _array at their argv index as text.
 * There is no security checking for the text being processed by the dangerous eval() function.
 *
 * @param number $argc
 * @param array $argv
 * @return object
 */
function processArguments( $argc, $argv ) {
	$opts = (object)[];
	$last = false;
	for ( $index = 1; $index < $argc; $index++ ) {
		$text = $argv[$index];
		if ( '--' === substr( $text, 0, 2 ) ) {
			$assignOffset = strpos( $text, '=', 3 );
			if ( $assignOffset === false ) {
				$key = substr( $text, 2 );
				$last = $key;
				eval( '$opts->' . $key . '=true;' );
			} else {
				$value = substr( $text, $assignOffset + 1 );
				$key = substr( $text, 2, $assignOffset - 2 );
				$last = false;
				eval( '$opts->' . $key . '=\'' . $value . '\';' );
			}
		} elseif ( $last === false ) {
				eval( '$opts->_array[' . ( $index - 1 ) . ']=\'' . $text . '\';' );
		} else {
				eval( '$opts->' . $last . '=\'' . $text . '\';' );
		}
	}
	return $opts;
}

/**
 * Run tests as specified by commmand line arguments
 *
 * @param number $argc
 * @param array $argv
 * @return number
 */
function runTests( $argc, $argv ) {
	$numFailures = 0;

	$opts = processArguments( $argc, $argv );
	if ( !isset( $opts->debug_dump ) ) {
		$opts->debug_dump = false;
	}
	$opts->firstRun = true;

	if ( isset( $opts->help ) ) {
		wfLog( "must specify [--timingMode] [--iterationCount=XXX]" .
			" --transformer NAME --inputFile path/wikiName\n" );
		wfLog( "Default iteration count is 50 if not specified\n" );
		wfLog( "use --debug_dump to create pre and post dom serialized" .
			" output to temporaryPrePhp.txt and ...PostPhp.txt\n" );
		return;
	}

	if ( !isset( $opts->inputFile ) ) {
		wfLog( "must specify --transformer NAME --inputFile /path/wikiName\n" );
		wfLog( "Run node bin/domTests.php --help for more information\n" );
		return;
	}

	$mockEnv = new MockEnv( $opts );
	$manager = new DOMPassTester( $mockEnv, [] );

	if ( isset( $opts->timingMode ) ) {
		wfLog( "Timing Mode enabled, no console output expected till test completes\n" );
	}

	wfLog( "Selected dom transformer = " . $opts->transformer . "\n" );

	$startTime = PHPUtils::getStartHRTime();

	$numFailures = $manager->wikitextFile( $opts );

	$totalTime = PHPUtils::getHRTimeDifferential( $startTime );

	wfLog( "Total DOM test execution time        = " . $totalTime . " milliseconds\n" );
	wfLog( "Total time processing DOM transforms = " . round( $manager->transformTime, 3 ) .
		" milliseconds\n" );

	if ( $numFailures ) {
		wfLog( 'Total failures: ' . $numFailures );
		exit( 1 );
	}
}

runTests( $argc, $argv );
