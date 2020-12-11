<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

class TestFileReader {
	/**
	 * @var int
	 * @deprecated Use $this->fileOptions['version'] instead.
	 */
	public $testFormat;

	/** @var array File-level options and requirements for these parser tests */
	public $fileOptions = [];

	/** @var Test[] */
	public $testCases = [];

	/** @var Article[] */
	public $articles = [];

	/**
	 * @var array
	 * @deprecated Use $this->fileOptions['requirements'] instead.
	 */
	public $requirements = [];

	/**
	 * @var ?string Path to known failures file, or null if does not exist
	 *   or is not readable.
	 */
	public $knownFailuresPath;

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
		$info = pathinfo( $testFilePath );
		$knownFailuresPath = $info['dirname'] . '/' . $info['filename'] .
			'-knownFailures.json';
		$reader = new self(
			$testFilePath,
			$knownFailuresPath,
			$warnFunc,
			$normalizeFunc
		);
		return $reader;
	}

	/**
	 * @param string $testFilePath The parserTest file to read
	 * @param ?string $knownFailuresPath The known failures file to read
	 *   (or null, if there is no readable known failures file)
	 * @param ?callable(string) $warnFunc An optional function to use to
	 *   report the use of deprecated test section names
	 * @param ?callable(string):string $normalizeFunc An optional function
	 *   to use to normalize article titles for uniqueness testing
	 */
	private function __construct(
		string $testFilePath, ?string $knownFailuresPath,
		?callable $warnFunc = null, ?callable $normalizeFunc = null
	) {
		$this->knownFailuresPath = $knownFailuresPath;
		$parsedTests = Grammar::load( $testFilePath );
		$testFormat = $parsedTests[0];
		$this->fileOptions = $parsedTests[1] ?? [];
		$rawTestItems = $parsedTests[2];
		if ( $testFormat === null ) {
			$this->testFormat = 1;
		} else {
			$this->testFormat = intval( $testFormat['text'] );
			$this->fileOptions['version'] = strval( $this->testFormat );
		}
		$knownFailures = $knownFailuresPath && is_readable( $knownFailuresPath ) ?
			json_decode( file_get_contents( $knownFailuresPath ), true ) :
			null;

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
				$test = new Test(
					$item,
					$knownFailures[$item['testName']] ?? [],
					$lastComment,
					$warnFunc
				);
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
					$this->fileOptions['requirements'][] = [
						'type' => 'hook',
						'name' => trim( $line ),
					];
				}
				$lastComment = '';
			} elseif ( $item['type'] === 'functionhooks' ) {
				foreach ( explode( "\n", $item['text'] ) as $line ) {
					$this->fileOptions['requirements'][] = [
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
		// Convenience function to expand 'requirements'
		if ( isset( $this->fileOptions['requirements'] ) ) {
			if ( !is_array( $this->fileOptions['requirements'] ) ) {
				$this->fileOptions['requirements'] = [
					$this->fileOptions['requirements']
				];
			}
			foreach ( $this->fileOptions['requirements'] as &$item ) {
				if ( is_string( $item ) ) {
					$item = [
						'type' => 'hook',
						'name' => "$item",
					];
				}
			}
			unset( $item );
		}
		// Backward compatibility for core
		if ( isset( $this->fileOptions['version'] ) ) {
			$this->testFormat = intval( $this->fileOptions['version'] );
		}
		$this->requirements = $this->fileOptions['requirements'] ?? [];
	}
}
