<?php

namespace Test\Parsoid\Utils;

use Parsoid\Utils\PHPUtils;

class PHPUtilsTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers PHPUtils::convertOffsets()
	 * @dataProvider provideConvertOffsets
	 */
	public function testConvertOffsets( $str, $from, $to, $input, $expect ) {
		$offsets = [];
		foreach ( $input as &$v ) {
			$offsets[] = &$v;
		}
		unset( $v );

		PHPUtils::convertOffsets( $str, $from, $to, $offsets );
		$this->assertSame( $expect, $offsets, "$from → $to" );
	}

	public static function provideConvertOffsets() {
		$str = 'foo bár 💩💩 baz';
		$offsets = [
			'byte' => [ 0, 21, 4, 13, 9, 18 ],
			'char' => [ 0, 14, 4,  9, 8, 11 ],
			'ucs2' => [ 0, 16, 4, 10, 8, 13 ],
		];
		foreach ( $offsets as $from => $input ) {
			foreach ( $offsets as $to => $expect ) {
				yield "$from → $to" => [ $str, $from, $to, $input, $expect ];
			}
		}

		yield "Passing 0 offsets doesn't error" => [ $str, 'byte', 'char', [], [] ];

		yield "No error if we run out of offsets before EOS"
			=> [ $str, 'byte', 'char', [ 0, 9 ], [ 0, 8 ] ];

		foreach ( $offsets as $from => $input ) {
			foreach ( $offsets as $to => $expect ) {
				yield "Out of bounds offsets, $from → $to"
					=> [ $str, $from, $to, [ -10, 500 ], [ $expect[0], $expect[1] ] ];
			}
		}

		yield "Rounding bytes"
			=> [ "💩💩💩", 'byte', 'byte', [ 0, 1, 2, 3, 4, 5 ], [ 0, 4, 4, 4, 4, 8 ] ];
		yield "Rounding ucs2"
			=> [ "💩💩💩", 'ucs2', 'ucs2', [ 0, 1, 2, 3, 4 ], [ 0, 2, 2, 4, 4 ] ];
	}

}
