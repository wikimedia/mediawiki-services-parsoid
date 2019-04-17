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
		// Easy cases...
		yield "Lowercase &" => [ '&amp;', '&' ];
		yield "Uppercase &" => [ '&AMP;', '&' ];
		// Ensure that HTML5 "semicolon-less" entities are not
		// decoded -- these are decoded in HTML5 but not in wikitext!
		yield "Semicolon-less &" => [ '&ampamp;', '&ampamp;' ];
		yield "Semicolon-less query" => [ '&prod=foo', '&prod=foo' ];
		// Exhaustive test against Sanitizer::validateCodePoint()
		$checkEntity = function ( int $cp, string $s ) {
			$expected = self::validateCodePoint( $cp ) ?
					  mb_chr( $cp, "utf-8" ) : $s;
			yield $s => [ $s, $expected ];
		};
		$check = function ( int $cp ) use ( $checkEntity ) {
			yield from $checkEntity( $cp, "&#$cp;" );
			yield from $checkEntity( $cp, strtolower( "&#x" . dechex( $cp ) . ";" ) );
			yield from $checkEntity( $cp, strtoupper( "&#x" . dechex( $cp ) . ";" ) );
		};
		for ( $cp = 0; $cp < 0x100; $cp++ ) {
			yield from $check( $cp );
		}
		for ( $cp = 0xD700; $cp < 0xE010; $cp++ ) {
			yield from $check( $cp );
		}
		for ( $cp = 0xFFF0; $cp < 0x10010; $cp++ ) {
			yield from $check( $cp );
		}
		for ( $cp = 0x10FFF0; $cp < 0x110010; $cp++ ) {
			yield from $check( $cp );
		}
	}

	/**
	 * This is a direct copy of Sanitizer::validateCodepoint; when/if
	 * Parsoid is integrated into MediaWiki we could replace this with
	 * a direct call.
	 */
	private static function validateCodePoint( int $codepoint ):bool {
		# U+000C is valid in HTML5 but not allowed in XML.
		# U+000D is valid in XML but not allowed in HTML5.
		# U+007F - U+009F are disallowed in HTML5 (control characters).
		return $codepoint == 0x09
			|| $codepoint == 0x0a
			|| ( $codepoint >= 0x20 && $codepoint <= 0x7e )
			|| ( $codepoint >= 0xa0 && $codepoint <= 0xd7ff )
			|| ( $codepoint >= 0xe000 && $codepoint <= 0xfffd )
			|| ( $codepoint >= 0x10000 && $codepoint <= 0x10ffff );
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
