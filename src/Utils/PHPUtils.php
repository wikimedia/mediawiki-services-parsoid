<?php

namespace Parsoid\Utils;

use Wikimedia\Assert\Assert;

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
	 * Append an array to an accumulator using the most efficient method
	 * available. Makes sure that accumulation is O(n).
	 *
	 * @param array &$dest Destination array
	 * @param array $source Array to merge
	 */
	public static function pushArray( array &$dest, array $source ): void {
		if ( count( $dest ) < count( $source ) ) {
			$dest = array_merge( $dest, $source );
		} else {
			foreach ( $source as $item ) {
				$dest[] = $item;
			}
		}
	}

	/**
	 * Helper for joining pieces of regular expressions together.  This
	 * safely strips delimiters from regular expression strings, while
	 * ensuring that the result is safely escaped for the new delimiter
	 * you plan to use (see the `$delimiter` argument to `preg_quote`).
	 *
	 * @param string $re The regular expression to strip
	 * @param string|null $newDelimiter Optional delimiter which will be
	 *   used when recomposing this stripped regular expression into a
	 *   new regular expression.
	 * @return string The regular expression without delimiters or flags
	 */
	public static function reStrip( string $re, ?string $newDelimiter = null ): string {
		// Believe it or not, PHP allows leading whitespace in the $re
		// tested with C's "isspace", which is [ \f\n\r\t\v]
		$re = preg_replace( '/^[ \f\n\r\t\v]+/', '', $re );
		Assert::invariant( strlen( $re ) > 0, "empty regexp" );
		$startDelimiter = $re[0];
		// PHP actually supports balanced delimiters (ie open paren on left
		// and close paren on right).
		switch ( $startDelimiter ) {
			case '(':
				$endDelimiter = ')';
				break;
			case '[':
				$endDelimiter = ']';
				break;
			case '{':
				$endDelimiter = '}';
				break;
			case '<':
				$endDelimiter = '>';
				break;
			default:
				$endDelimiter = $startDelimiter;
				break;
		}
		$endDelimiterPos = strrpos( $re, $endDelimiter );
		Assert::invariant(
			$endDelimiterPos !== false && $endDelimiterPos > 0,
			"can't find end delimiter"
		);
		$flags = substr( $re, $endDelimiterPos + 1 );
		Assert::invariant(
			preg_match( '/^[imsxADSUXJu \n]*$/', $flags ) === 1,
			"unexpected flags"
		);
		$stripped = substr( $re, 1, $endDelimiterPos - 1 );
		if (
			$newDelimiter === null ||
			$startDelimiter === $newDelimiter ||
			$endDelimiter === $newDelimiter
		) {
			return $stripped; // done!
		}
		// escape the new delimiter
		preg_match_all( '/[^\\\\]|\\\\./s', $stripped, $matches );
		return implode( '', array_map( function ( $c ) use ( $newDelimiter ) {
			return ( $c === $newDelimiter ) ? ( '\\' . $c ) : $c;
		}, $matches[0] ) );
	}

	/**
	 * encodeURIComponent (JS compatible) function form stack overflow post
	 * @param string $str
	 * @return string
	 */
	public static function encodeURIComponent( $str ) {
		$revert = [ '%21' => '!', '%2A' => '*', '%27' => "'", '%28' => '(', '%29' => ')' ];
		return strtr( rawurlencode( $str ), $revert );
	}
}
