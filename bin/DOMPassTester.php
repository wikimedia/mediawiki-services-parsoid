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
 Parsoid DOMPostProcessor behavior.

 To create a test from an existing wikitext page, run the following
 commands, for example:
 $ node bin/parse.js --genTest dom:dsr --genDirectory ../tests --pageName Hampi

 For command line options and required parameters, type:
 $ node bin/domTest.js --help

 An example command line to validate and performance test the 'Hampi'
 wikipage created as a dom:dsr test:
 $ node bin/domTests.php --timingMode --iterationCount 99 --transformer dsr --inputFilePrefix Hampi

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

require_once __DIR__ . '/../vendor/autoload.php';

use Parsoid\Tests\MockEnv;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Wt2Html\PP\Processors\ComputeDSR;
use Parsoid\Wt2Html\PP\Processors\HandlePres;
use Parsoid\Wt2Html\PP\Processors\PWrap;
use Parsoid\Wt2Html\PP\Processors\WrapSections;
use Parsoid\Wt2Html\PP\Processors\MigrateTrailingNLs;

$wgCachedState = false;
$wgCachedFilePre = '';
$wgCachedFilePost = '';

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
			$testFilePre = file_get_contents( $opts['inputFilePrefix'] . '-' .
				$opts['transformer'] . '-pre.txt' );
			$testFilePost = file_get_contents( $opts['inputFilePrefix'] . '-' .
				$opts['transformer'] . '-post.txt' );

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

		$dom = $this->env->createDocument( $testFilePre );
		$body = $dom->body;
		DOMDataUtils::visitAndLoadDataAttribs( $body );
		$dumpOpts = [];

		if ( $opts['firstRun'] ) {
			// REMEX BUG? Remove extra newline
			$body->lastChild->parentNode->removeChild( $body->lastChild );
			$dumpOpts = [
				'quiet' => true,
				'dumpFragmentMap' => false,
				'keepTmp' => true,
				'outBuffer' => ''
			];
			ContentUtils::dumpDOM( $body, '', $dumpOpts );

			// Ignore trailing newline diffs
			if ( preg_replace( '/\n$/D', '', $testFilePre ) ===
				preg_replace( '/\n$/D', '', $dumpOpts['outBuffer'] ) ) {
				print "DOM pre output matches genTest Pre output\n";
			} else {
				print "DOM pre output DOES NOT match genTest Pre output\n";
			}

			if ( $opts['debug_dump'] ) {
				file_put_contents( 'temporaryPrePhp.txt', $dumpOpts['outBuffer'] );
				print "temporaryPrePhp.txt saved!\n";
			}
		}

		$startTime = PHPUtils::getStartHRTime();
		switch ( $opts['transformer'] ) {
			case 'dsr':
				// genTest must specify dsr sourceOffsets as data-parsoid info
				$dp = DOMDataUtils::getDataParsoid( $body );
				if ( isset( $dp->dsr ) ) {
					$options = [ 'sourceOffsets' => $dp->dsr, 'attrExpansion' => false ];
				} else {
					$options = [ 'attrExpansion' => false ];
				}
				( new ComputeDSR() )->run( $body, $this->env, $options );
				break;
			case 'pres':
				( new HandlePres() )->run( $body, $this->env, $options );
				break;
			case 'cleanupFormattingTagFixup':
				cleanupFormattingTagFixup( $body, $this->env );
				break;
			case 'sections' :
				( new WrapSections() )->run( $body, $this->env );
				break;
			case 'pwrap' :
				( new PWrap() )->run( $body, $this->env );
				break;
			case 'migrate-nls' :
				( new MigrateTrailingNLs() )->run( $body, $this->env, $opts );
				break;
		}

		$this->transformTime += PHPUtils::getHRTimeDifferential( $startTime );

		if ( $opts['firstRun'] ) {
			$opts['firstRun'] = false;

			$dumpOpts['outBuffer'] = '';
			ContentUtils::dumpDOM( $body, '', $dumpOpts );

			// Ignore trailing newline diffs
			if ( preg_replace( '/\n$/D', '', $testFilePost ) ===
				preg_replace( '/\n$/D', '', $dumpOpts['outBuffer'] ) ) {
				print "DOM post transform output matches genTest Post output\n";
			} else {
				print "DOM post transform output DOES NOT match genTest Post output\n";
				$numFailures++;
			}

			if ( $opts['debug_dump'] ) {
				file_put_contents( 'temporaryPostPhp.txt', $dumpOpts['outBuffer'] );
				print "temporaryPostPhp.txt saved!\n";
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

		if ( isset( $opts['timingMode'] ) ) {
			$opts['firstRun'] = true;
			if ( isset( $opts['iterationCount'] ) ) {
				$iterator = $opts['iterationCount'];
			} else {
				$iterator = 50;  // defaults to 50 interations
			}
		}

		if ( !isset( $opts['timingMode'] ) ) {
			print "Starting wikitext dom test, file = " . $opts['inputFilePrefix'] .
				"-" . $opts['transformer'] . "-pre.txt and -post.txt\n\n";
		}

		while ( $iterator-- ) {
			$numFailures += $this->processWikitextFile( $opts );
		}

		if ( !isset( $opts['timingMode'] ) ) {
			print "Ending wikitext dom test, file = " . $opts['inputFilePrefix'] . "-" .
				$opts['transformer'] . "-pre.txt and -post.txt\n\n";
		}
		return $numFailures;
	}
}

/**
 * ProcessArguments handles a subset of javascript yargs like processing for command line
 * parameters setting object elements to the key name. If no value follows the key,
 * it is set to true, otherwise it is set to the value. The key can be followed by a
 * space then value, or an equals symbol then the value.
 *
 * @param number $argc
 * @param array $argv
 * @return array
 */
function wfProcessArguments( int $argc, array $argv ): array {
	$opts = [];
	$last = false;
	for ( $i = 1; $i < $argc; $i++ ) {
		$text = $argv[$i];
		if ( '--' === substr( $text, 0, 2 ) ) {
			$assignOffset = strpos( $text, '=', 3 );
			if ( $assignOffset === false ) {
				$key = substr( $text, 2 );
				$last = $key;
				$opts[$key] = true;
			} else {
				$value = substr( $text, $assignOffset + 1 );
				$key = substr( $text, 2, $assignOffset - 2 );
				$last = false;
				$opts[$key] = $value;
			}
		} elseif ( $last ) {
			$opts[$last] = $text;
			$last = false;
		} else {
			// There are no free args supported right now
			// So, keep things simple
			print "Unknown arg " . $argv[$i] . "\n";
			exit( 1 );
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
function wfRunTests( $argc, $argv ) {
	$numFailures = 0;

	$opts = wfProcessArguments( $argc, $argv );
	if ( !isset( $opts['debug_dump'] ) ) {
		$opts['debug_dump'] = false;
	}
	$opts['firstRun'] = true;

	if ( isset( $opts['help'] ) ) {
		print "must specify [--timingMode] [--iterationCount=XXX]" .
			" --transformer NAME --inputFilePrefix path/pageNamePrefix\n";
		print "Default iteration count is 50 if not specified\n";
		print "use --debug_dump to create pre and post dom serialized" .
			" output to temporaryPrePhp.txt and ...PostPhp.txt\n";
		return;
	}

	if ( !isset( $opts['inputFilePrefix'] ) ) {
		print "must specify --transformer NAME --inputFilePrefix path/pageNamePrefix\n";
		print "Run node bin/domTests.php --help for more information\n";
		return;
	}

	$mockEnv = new MockEnv( [ "wrapSections" => true ] );
	$manager = new DOMPassTester( $mockEnv, [] );

	if ( isset( $opts['timingMode'] ) ) {
		print "Timing Mode enabled, no console output expected till test completes\n";
	}

	print "Selected dom transformer = " . $opts['transformer'] . "\n";

	$startTime = PHPUtils::getStartHRTime();

	$numFailures = $manager->wikitextFile( $opts );

	$totalTime = PHPUtils::getHRTimeDifferential( $startTime );

	print "Total DOM test execution time        = " . $totalTime . " milliseconds\n";
	print "Total time processing DOM transforms = " . round( $manager->transformTime, 3 ) .
		" milliseconds\n";

	if ( $numFailures ) {
		print 'Total failures: ' . $numFailures;
		exit( 1 );
	}
}

wfRunTests( $argc, $argv );
