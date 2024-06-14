<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Assert\Assert;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

/**
 * Rich attribute data for a DOM Element.  Both the key and the value
 * can be strings or more complex values.
 */
class DataMwAttrib implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * The attribute name.
	 * @var array{txt?:string,html?:string}|string
	 */
	public $key;

	/**
	 * The attribute value.
	 * @var array|string
	 */
	public $value;

	/**
	 * @param array{txt?:string,html?:string}|string $key Attribute name
	 * @param array|string $value Attribute value
	 */
	public function __construct( $key, $value ) {
		$this->key = $key;
		$this->value = $value;
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		// No hints necessary, both $key and $value are arrays
		return null;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		return [ $this->key, $this->value ];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): DataMwAttrib {
		Assert::invariant(
			array_is_list( $json ) && count( $json ) === 2,
			"bad data-mw.attrib"
		);
		return new DataMwAttrib( $json[0], $json[1] );
	}
}
