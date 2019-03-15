<?php

namespace Test\Parsoid\Utils;

use Parsoid\Utils\Util;

class UtilTest extends \PHPUnit\Framework\TestCase {
	/**
	 * @covers decodeWtEntities
	 * @dataProvider provideDecodeWtEntities
	 */
	public function testDecodeWtEntities( $wt, $expected ) {
		$actual = Util::decodeWtEntities( $wt );
		$this->assertEquals( $expected, $actual );
	}

	public function provideDecodeWtEntities() {
		return [
			[ '&amp;', '&' ],
			[ '&AMP;', '&' ],
			// Ensure that HTML5 "semicolon-less" entities are not
			// decoded -- these are decoded in HTML5 but not in wikitext!
			[ '&ampamp;', '&ampamp;' ],
			[ '&prod=foo', '&prod=foo' ],
		];
	}

	/**
	 * @covers escapeWtEntities
	 * @dataProvider provideEscapeWtEntities
	 */
	public function testEscapeWtEntities( $text, $expected ) {
		$actual = Util::escapeWtEntities( $text );
		$this->assertEquals( $expected, $actual );
	}

	public function provideEscapeWtEntities() {
		return [
			[ '&amp;', '&amp;amp;' ],
			// Not all entities, just those that are valid
			[ 'hello&goodbye', 'hello&goodbye' ],
			[ 'hello&goodbye;', 'hello&goodbye;' ],
		];
	}

	/**
	 * @covers escapeHtml
	 * @dataProvider provideEscapeHtml
	 */
	public function testEscapeHtml( $text, $expected ) {
		$actual = Util::escapeHtml( $text );
		$this->assertEquals( $expected, $actual );
	}

	public function provideEscapeHtml() {
		return [
			[ 'only 5 characters escaped', 'only 5 characters escaped' ],
			[ '<>&"\'', '&lt;&gt;&amp;&quot;&apos;' ],
		];
	}

	/**
	 * @covers entityEncodeAll
	 * @dataProvider provideEntityEncodeAll
	 */
	public function testEntityEncodeAll( $text, $expected ) {
		$actual = Util::entityEncodeAll( $text );
		$this->assertEquals( $expected, $actual );
	}

	public function provideEntityEncodeAll() {
		return [
			[ 'Even ASCII', '&#x45;&#x76;&#x65;&#x6E;&#x20;&#x41;&#x53;&#x43;&#x49;&#x49;' ],
			[ 'is encoded', '&#x69;&#x73;&#x20;&#x65;&#x6E;&#x63;&#x6F;&#x64;&#x65;&#x64;' ],
			[ "&>", '&#x26;&#x3E;' ],
			// Some entities use special forms
			[ "\u{00A0}", '&nbsp;' ],
			[ "\u{000D}", '&#x0D;' ],
			// Even Unicode characters in the "Astral plane" work correctly
			[ "\u{1F4A9}", '&#x1F4A9;' ],
		];
	}

}
