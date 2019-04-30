<?php

namespace Test\Parsoid\Utils;

use Parsoid\Utils\PHPUtils;
use PHPUnit\Framework\TestCase;

class PHPUtilsTest extends TestCase {
	/**
	 * @covers \Parsoid\Utils\PHPUtils::reStrip
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

	/**
	 * @covers \Parsoid\Utils\PHPUtils::coalesce
	 * @dataProvider provideCoalesce
	 */
	public function testCoalesce( array $args, $expectedResult ) {
		$this->assertSame( $expectedResult, PHPUtils::coalesce( ...$args ) );
	}

	public function provideCoalesce() {
		return [
			[ [ 1, 2 ], 1 ],
			[ [ 1, null ], 1 ],
			[ [ null, 1 ], 1 ],
			[ [ false, 1 ], 1 ],
			[ [ 0, 1 ], 1 ],
			[ [ 0.0, 1 ], 1 ],
			[ [ '', 1 ], 1 ],
			[ [ '0', 1 ], '0' ],
			[ [ ' ', 1 ], ' ' ],
			[ [ [], 1 ], [] ],
			[ [ 0 ], 0 ],
			[ [ 0, 0, 1, 0 ], 1 ],
		];
	}
}
