<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Assert\Assert;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecInterface;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\JsonCodecableWithCodecTrait;

/**
 * Rich attribute data for a DOM Element.  Both the key and the value
 * can be strings or more complex values.
 */
class DataMwAttrib implements JsonCodecable {
	use JsonCodecableWithCodecTrait;

	public function __construct(
		/**
		 * The attribute name.
		 * @var array{txt?:string,html?:DocumentFragment}|string
		 */
		public array|string $key,
		/**
		 * The attribute value.
		 * @var array{txt?:string,html?:DocumentFragment,rich?:array}|string
		 */
		public array|string $value ) {
		if ( isset( $key['html'] ) ) {
			Assert::invariant( $key['html'] instanceof DocumentFragment, "key check" );
		}
		if ( isset( $value['html'] ) ) {
			Assert::invariant( $value['html'] instanceof DocumentFragment, "value check" );
		}
	}

	/**
	 * Stringify the key and return it.
	 */
	public function getKeyString(): ?string {
		$key = $this->key;
		if ( is_array( $key ) ) {
			$key = $key['txt'] ?? $key['html']->textContent ?? null;
		}
		return $key;
	}

	public function __clone() {
		// Deep clone non-primitive properties
		foreach ( [ 'key', 'value' ] as $prop ) {
			if ( isset( $this->$prop['html'] ) ) {
				$this->$prop['html'] = DOMDataUtils::cloneDocumentFragment( $this->$prop['html'] );
			}
		}
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		// No hints necessary, both $key and $value are arrays
		// and we're manually encoding the DocumentFragment
		return null;
	}

	/** @inheritDoc */
	public function toJsonArray( JsonCodecInterface $codec ): array {
		$k = $this->key;
		if ( isset( $k['html'] ) ) {
			$k['html'] = self::encodeDocumentFragment( $codec, $k['html'] );
		}
		$v = $this->value;
		if ( isset( $v['html'] ) ) {
			$v['html'] = self::encodeDocumentFragment( $codec, $v['html'] );
		}
		return [ $k, $v ];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( JsonCodecInterface $codec, array $json ): DataMwAttrib {
		Assert::invariant(
			array_is_list( $json ) && count( $json ) === 2,
			"bad data-mw.attrib"
		);
		[ $k, $v ] = $json;
		if ( isset( $k['html'] ) ) {
			$k['html'] = self::decodeDocumentFragment( $codec, $k['html'] );
		}
		if ( isset( $v['html'] ) ) {
			$v['html'] = self::decodeDocumentFragment( $codec, $v['html'] );
		}
		return new DataMwAttrib( $k, $v );
	}
}
