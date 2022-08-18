<?php
declare( strict_types=1 );

/**
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 * http://www.gnu.org/copyleft/gpl.html
 *
 * @file
 */
namespace Wikimedia\Parsoid\Utils;

use Psr\Container\ContainerInterface;
use stdClass;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonClassCodec;
use Wikimedia\JsonCodec\JsonCodecInterface;
use Wikimedia\Parsoid\DOM\DocumentFragment;

/**
 * This is an implementation of JsonCodecableTrait which passes the
 * JsonCodec along to the class.  This allows us to implement
 * custom encodings for properties with DocumentFragment types
 * by manually encoding the property.
 */
trait JsonCodecableWithCodecTrait {
	/**
	 * Implements JsonCodecable by providing an implementation of
	 * ::jsonClassCodec() which does not use the provided $serviceContainer
	 * nor does it maintain any state; it just calls the ::toJsonArray()
	 * and ::newFromJsonArray() methods of this instance, passing along
	 * the JsonCodecInterface to allow custom encodings.
	 * @param JsonCodecInterface $codec
	 * @param ContainerInterface $serviceContainer
	 * @return JsonClassCodec
	 */
	public static function jsonClassCodec(
		JsonCodecInterface $codec, ContainerInterface $serviceContainer
	): JsonClassCodec {
		return new class( $codec ) implements JsonClassCodec {

			public function __construct( private JsonCodecInterface $codec ) {
			}

			/** @inheritDoc */
			public function toJsonArray( $obj ): array {
				return $obj->toJsonArray( $this->codec );
			}

			/** @inheritDoc */
			public function newFromJsonArray( string $className, array $json ) {
				return $className::newFromJsonArray( $this->codec, $json );
			}

			/** @inheritDoc */
			public function jsonClassHintFor( string $className, string $keyName ) {
				return $className::jsonClassHintFor( $keyName );
			}
		};
	}

	/**
	 * Return an associative array representing the contents of this object,
	 * which can be passed to ::newFromJsonArray() to deserialize it.
	 * @param JsonCodecInterface $codec For custom encodings
	 * @return array
	 */
	abstract public function toJsonArray( JsonCodecInterface $codec ): array;

	/**
	 * Return an instance of this object representing the deserialization
	 * from the array passed in $json.
	 * @param JsonCodecInterface $codec For custom encodings
	 * @param array $json
	 * @return stdClass
	 */
	abstract public static function newFromJsonArray( JsonCodecInterface $codec, array $json );

	/**
	 * Return an optional type hint for the given array key in the result of
	 * ::toJsonArray() / input to ::newFromJsonArray.  If a class name is
	 * returned here and it matches the runtime type of the value of that
	 * array key, then type information will be omitted from the generated
	 * JSON which can save space.  The class name can be suffixed with `[]`
	 * to indicate an array or list containing objects of the given class
	 * name.
	 *
	 * Default implementation of ::jsonClassHintFor() provides no hints.
	 * Implementer can override.
	 *
	 * @param string $keyName
	 * @return class-string|string|Hint|null A class string, Hint, or null.
	 *   For backward compatibility, a class string suffixed with `[]` can
	 *   also be returned, but that is deprecated.
	 */
	public static function jsonClassHintFor( string $keyName ) {
		return null;
	}

	// Helper methods specific to Parsoid.

	/**
	 * Helper function for deserializing DocumentFragments which
	 * could be encoded as strings.
	 * @param JsonCodecInterface $codec
	 * @param string|array|DocumentFragment $v
	 * @return DocumentFragment
	 */
	private static function decodeDocumentFragment( JsonCodecInterface $codec, $v ): DocumentFragment {
		// Usually '_h' or '_t' is used as a marker for caption/html, but
		// allow a bare string as well.
		// If v is a string, rewrite it to match the 'expected'
		// [ _h => '...' ] serialization of a DocumentFragment.
		$v = is_string( $v ) ? [ '_h' => $v ] : $v;
		if ( is_array( $v ) ) {
			$v = $codec->newFromJsonArray( $v, DocumentFragment::class );
		}
		return $v;
	}

	/**
	 * Helper function for serializing DocumentFragments as strings,
	 * for compatibility w/ existing MediaWiki DOM Spec 2.8.0.
	 * @param JsonCodecInterface $codec
	 * @param DocumentFragment $df
	 * @return string|array
	 */
	private static function encodeDocumentFragment( JsonCodecInterface $codec, DocumentFragment $df ) {
		// compatibility with MediaWiki DOM Spec 2.8.0
		// See [[mw:Parsoid/MediaWiki DOM spec/Rich Attributes]] Phase 3
		// for discussion about alternate _h/_t marking for DocumentFragments
		$c = $codec->toJsonArray( $df, DocumentFragment::class );
		if ( is_string( $c['_h'] ?? null ) ) {
			return $c['_h'];
		}
		return $c;
	}
}
