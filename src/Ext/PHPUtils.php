<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

/**
 * This class contains sundry helpers unrelated to core Parsoid
 */
class PHPUtils {
	/**
	 * Convert an array to an object. Workaround for https://bugs.php.net/bug.php?id=78379
	 *
	 * PHP 7 introduced "efficient" casting of arrays to objects by taking a
	 * reference instead of duplicating the array. However, this was not
	 * properly accounted for in the garbage collector. The garbage collector
	 * would free the array while it was still referred to by live objects.
	 *
	 * The workaround here is to manually duplicate the array. It's not
	 * necessary to do a deep copy since only the top-level array is referenced
	 * by the new object.
	 *
	 * It's only necessary to call this for potentially shared arrays, such as
	 * compile-time constants. Arrays that have a reference count of 1 can be
	 * cast to objects in the usual way. For example, array literals containing
	 * variables are typically unshared.
	 *
	 * @param array $array
	 * @return \stdClass
	 */
	public static function arrayToObject( $array ): \stdClass {
		return (object)array_combine( array_keys( $array ), array_values( $array ) );
	}

	/**
	 * Convert an iterable to an array.
	 *
	 * This function is similar to *but not the same as* the built-in
	 * iterator_to_array, because arrays are iterable but not Traversable!
	 *
	 * This function is also present in the wmde/iterable-functions library,
	 * but it's short enough that we don't need to pull in an entire new
	 * dependency here.
	 *
	 * @see https://stackoverflow.com/questions/44587973/php-iterable-to-array-or-traversable
	 * @see https://github.com/wmde/iterable-functions/blob/master/src/functions.php
	 *
	 * @phan-template T
	 * @param iterable<T> $iterable
	 * @return array<T>
	 */
	public static function iterable_to_array( iterable $iterable ): array { // phpcs:ignore MediaWiki.NamingConventions.LowerCamelFunctionsName.FunctionName,Generic.Files.LineLength.TooLong
		return \Wikimedia\Parsoid\Utils\PHPUtils::iterable_to_array( $iterable );
	}

	/**
	 * json_encode wrapper function
	 * - unscapes slashes and unicode
	 *
	 * @param mixed $o
	 * @return string
	 */
	public static function jsonEncode( $o ): string {
		return \Wikimedia\Parsoid\Utils\PHPUtils::jsonEncode( $o );
	}
}
