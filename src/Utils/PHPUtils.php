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

	/**
	 * Convert string offsets
	 *
	 * Offset types are:
	 *  - 'byte': Bytes (UTF-8 encoding), e.g. PHP `substr()` or `strlen()`.
	 *  - 'char': Unicode code points (encoding irrelevant), e.g. PHP `mb_substr()` or `mb_strlen()`.
	 *  - 'ucs2': 16-bit code units (UTF-16 encoding), e.g. JavaScript `.substring()` or `.length`.
	 *
	 * Offsets that are mid-Unicode character are "rounded" up to the next full
	 * character, i.e. the output offset will always point to the start of a
	 * Unicode code point (or just past the end of the string). Offsets outside
	 * the string are "rounded" to 0 or just-past-the-end.
	 *
	 * @note When constructing the array of offsets to pass to this method,
	 *  populate it with references as `$offsets[] = &$var;`.
	 *
	 * @param string $s Unicode string the offsets are offsets into, UTF-8 encoded.
	 * @param string $from Offset type to convert from.
	 * @param string $to Offset type to convert to.
	 * @param int[] $offsets References to the offsets to convert.
	 */
	public static function convertOffsets(
		string $s, string $from, string $to, array $offsets
	): void {
		static $valid = [ 'byte', 'char', 'ucs2' ];
		if ( !in_array( $from, $valid, true ) ) {
			throw new \InvalidArgumentException( 'Invalid $from' );
		}
		if ( !in_array( $to, $valid, true ) ) {
			throw new \InvalidArgumentException( 'Invalid $to' );
		}

		$i = 0;
		$offsetCt = count( $offsets );
		if ( $offsetCt === 0 ) { // Nothing to do
			return;
		}
		sort( $offsets, SORT_NUMERIC );

		$bytePos = 0;
		$ucs2Pos = 0;
		$charPos = 0;
		$fromPos = &${$from . 'Pos'};
		$toPos = &${$to . 'Pos'};

		$byteLen = strlen( $s );
		while ( $bytePos < $byteLen ) {
			// Update offsets that we've reached
			while ( $offsets[$i] <= $fromPos ) {
				$offsets[$i] = $toPos;
				if ( ++$i >= $offsetCt ) {
					return;
				}
			}

			// Update positions
			++$charPos;
			$c = ord( $s[$bytePos] ) & 0xf8;
			switch ( $c ) {
				case 0x00: case 0x08: case 0x10: case 0x18:
				case 0x20: case 0x28: case 0x30: case 0x38:
				case 0x40: case 0x48: case 0x50: case 0x58:
				case 0x60: case 0x68: case 0x70: case 0x78:
					++$bytePos;
					++$ucs2Pos;
					break;

				case 0xc0: case 0xc8: case 0xd0: case 0xd8:
					$bytePos += 2;
					++$ucs2Pos;
					break;

				case 0xe0: case 0xe8:
					$bytePos += 3;
					++$ucs2Pos;
					break;

				case 0xf0:
					$bytePos += 4;
					$ucs2Pos += 2;
					break;

				default:
					throw new \InvalidArgumentException( '$s is not UTF-8' );
			}
		}

		// Convert any offsets past the end of the string to the length of the
		// string.
		while ( $i < $offsetCt ) {
			$offsets[$i] = $toPos;
			++$i;
		}
	}

}
