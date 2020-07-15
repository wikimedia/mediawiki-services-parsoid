<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

class TestFileReader {
	/** @var int */
	public $testFormat;

	/** @var Test[] */
	public $testCases = [];

	/** @var Article[] */
	public $articles = [];

	/** @var array */
	public $requirements = [];

	/**
	 * Read and parse a parserTest file.
	 * @param string $testFilePath The parserTest file to read
	 * @param ?callable(string) $warnFunc An optional function to use to
	 *   report the use of deprecated test section names
	 * @param ?callable(string):string $normalizeFunc An optional function
	 *   to use to normalize article titles for uniqueness testing
	 * @return TestFileReader
	 */
	public static function read(
		string $testFilePath,
		?callable $warnFunc = null,
		?callable $normalizeFunc = null
	): TestFileReader {
		$reader = new self( $testFilePath, $warnFunc, $normalizeFunc );
		return $reader;
	}

	/**
	 * @param string $testFilePath The parserTest file to read
	 * @param ?callable(string) $warnFunc An optional function to use to
	 *   report the use of deprecated test section names
	 * @param ?callable(string):string $normalizeFunc An optional function
	 *   to use to normalize article titles for uniqueness testing
	 */
	private function __construct( string $testFilePath, ?callable $warnFunc = null, ?callable $normalizeFunc = null ) {
		$parsedTests = Grammar::load( $testFilePath );
		$testFormat = $parsedTests[0];
		$rawTestItems = $parsedTests[1];
		if ( $testFormat === null ) {
			$this->testFormat = 1;
		} else {
			$this->testFormat = intval( $testFormat['text'] );
		}

		$testNames = [];
		$articleTitles = [];

		$lastComment = '';
		foreach ( $rawTestItems as $item ) {
			if ( $item['type'] === 'article' ) {
				$art = new Article( $item, $lastComment );
				$key = $normalizeFunc ? $normalizeFunc( $art->title ) : $art->title;
				if ( isset( $articleTitles[$key] ) ) {
					$art->error( 'Duplicate article', $art->title );
				}
				$articleTitles[$key] = true;
				$this->articles[] = $art;
				$lastComment = '';
			} elseif ( $item['type'] === 'test' ) {
				$test = new Test( $item, $lastComment, $warnFunc );
				if ( isset( $testNames[$test->testName] ) ) {
					$test->error( 'Duplicate test name', $test->testName );
				}
				$testNames[$test->testName] = true;
				$this->testCases[] = $test;
				$lastComment = '';
			} elseif ( $item['type'] === 'comment' ) {
				$lastComment .= $item['text'];
			} elseif ( $item['type'] === 'hooks' ) {
				foreach ( explode( "\n", $item['text'] ) as $line ) {
					$this->requirements[] = [
						'type' => 'hook',
						'name' => trim( $line ),
					];
				}
				$lastComment = '';
			} elseif ( $item['type'] === 'functionhooks' ) {
				foreach ( explode( "\n", $item['text'] ) as $line ) {
					$this->requirements[] = [
						'type' => 'functionHook',
						'name' => trim( $line ),
					];
				}
				$lastComment = '';
			} elseif ( $item['type'] === 'line' ) {
				if ( !empty( trim( $item['text'] ) ) ) {
					( new Item( $item ) )->error( 'Invalid line', $item['text'] );
				}
			} else {
				( new Item( $item ) )->error( 'Unknown item type', $item['type'] );
			}
		}
	}
}
