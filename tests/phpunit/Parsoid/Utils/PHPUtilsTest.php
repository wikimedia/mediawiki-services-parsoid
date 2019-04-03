<?php

namespace Test\Parsoid\Utils;

use Parsoid\Utils\PHPUtils;

class PHPUtilsTest extends \PHPUnit\Framework\TestCase {
	/**
	 * @covers reStrip
	 * @dataProvider provideReStrip
	 */
	public function testReStrip( $re, $delimiter, $expected ) {
		$actual = PHPUtils::reStrip( $re, $delimiter );
		$this->assertEquals( $expected, $actual );
	}

	public function provideReStrip() {
		return [
			[ '/abc/', null, 'abc' ], // easy case
			[ ' /abc/mA', null, 'abc' ], // flags and leading whitespace
			[ '~ab/de~x', '/', 'ab\\/de' ], // new delimiter
			[ '~ab\/de~x', '/', 'ab\/de' ], // already escaped
			[ "~\\\u{1F4A9}~u", '/', "\\\u{1F4A9}" ], // unicode safe
		];
	}
}
