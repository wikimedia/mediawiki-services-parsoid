<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

class Grammar extends \Wikimedia\WikiPEG\PEGParserBase {
	/**
	 * @param string $filename
	 * @return array
	 */
	public static function load( string $filename ) {
		return [];
	}

	/**
	 * @param string $input Input string
	 * @param array $options Parse options
	 * @return mixed Result of the parse
	 */
	public function parse( $input, $options = [] ) {
		return null;
	}
}
