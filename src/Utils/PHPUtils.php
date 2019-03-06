<?php

namespace Parsoid\Utils;

/**
* This file contains Parsoid-independent PHP helper functions.
* Over time, more functions can be migrated out of various other files here.
* @module
*/

class PHPUtils {
	/**
	 * Convert a counter to a Base64 encoded string.
	 * Padding is stripped. \,+ are replaced with _,- respectively.
	 * Warning: Max integer is 2^31 - 1 for bitwise operations.
	 * @param int $n
	 * @return string
	 */
	public static function counterToBase64( int $n ): string {
		$str = '';
		do {
			$str = chr( $n & 0xff ) . $str;
			$n = $n >> 8;
		} while ( $n > 0 );
		return rtrim( strtr( base64_encode( $str ), '+/', '-_' ), '=' );
	}

	/**
	 * Return accurate system time
	 * @return float time in seconds since Jan 1 1970 GMT accurate to the microsecond
	 */
	public static function getStartHRTime(): float {
		return microtime( true );
	}

	/**
	 * Return millisecond accurate system time differential
	 * @param float $previousTime
	 * @return float milliseconds
	 */
	public static function getHRTimeDifferential( float $previousTime ): float {
		return ( microtime( true ) - $previousTime ) * 1000;
	}

	/**
	 * json_encode wrapper function
	 * - unscapes slashes and unicode
	 *
	 * @param mixed $o
	 * @return string
	 */
	public static function jsonEncode( $o ): string {
		return json_encode( $o, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	}

	/**
	 * json_decode wrapper function
	 * @param string $str String to decode into the json object
	 * @param bool $assoc Controls whether to parse as an an associative array - defaults to true
	 * @return mixed
	 */
	public static function jsonDecode( string $str, bool $assoc = true ) {
		return json_decode( $str, $assoc );
	}

	/**
	 * Convert array to associative array usable as a read-only Set.
	 *
	 * @param array $a
	 * @return array
	 */
	public static function makeSet( array $a ): array {
		return array_fill_keys( $a, true );
	}

	/**
	 * PORT-FIXME: To be removed once all uses of this have disappeared
	 * Convert array to associative array usable as a key-value Map
	 *
	 * Instead of
	 *
	 *     $var = PHPUtils::makeMap( [
	 *         [ 'key1', 'value1' ],
	 *         [ 'key2', 'value2' ],
	 *     ] );
	 *
	 * just do
	 *
	 *     $var = [
	 *         'key1' => 'value1',
	 *         'key2' => 'value2',
	 *     ];
	 *
	 * Unlike JS objects, PHP's associative arrays already preserve order.
	 *
	 * @param array $a
	 * @return array
	 */
	public static function makeMap( array $a ) {
		throw new \BadMethodCallException(
			'Don\'t use this, just declare your associative array directly'
		);
	}

	/**
	 * PORT-FIXME: To be removed once all uses of this have disappeared
	 * Helper to get last item of the array
	 * @param mixed[] $a
	 * @return mixed
	 */
	public static function lastItem( array $a ) {
		throw new \BadMethodCallException( 'Use end( $a ) instead' );
	}
}
