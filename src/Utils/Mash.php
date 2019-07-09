<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

/**
 * This is a helper class which just takes a bunch of mixed seed content
 * and smushes it together to create a single numeric seed.
 */
class Mash {

	/** @var int */
	private $n;

	public function __construct() {
		$this->n = 0xefc8249d;
	}

	/**
	 * Mash in some more data.
	 * @param mixed $data Anything that can be an argument to `strval`.
	 * @return float The current mash
	 */
	public function mash( $data ): float {
		$data = strval( $data );
		$data = mb_convert_encoding( $data, 'ucs-2' );
		$n = $this->n;
		for ( $i = 0;  $i < strlen( $data );  $i += 2 ) {
			$charCode = ord( $data[$i] ) * 256 + ord( $data[$i + 1] );
			$n += $charCode;
			$h = 0.02519603282416938 * $n;
			$n = intval( $h );
			$h -= $n;
			$h *= $n;
			$n = intval( $h );
			$h -= $n;
			$n += $h * 0x100000000; // 2^32
		}
		$this->n = $n;
		return intval( $n ) * 2.3283064365386963e-10; // 2^-32
	}

	public static function version(): string {
		return 'Mash 0.9';
	}
}
