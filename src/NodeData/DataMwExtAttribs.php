<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Tokens\Token;

/**
 * Attributes for an extension tag or annotation.
 */
class DataMwExtAttribs implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * Attribute values.
	 * @var array<string|int,string|array<Token|string>>
	 */
	private array $values = [];

	/**
	 * @param array<string|int,string|array<Token|string>>|object|null $values
	 */
	public function __construct( $values = null ) {
		if ( $values !== null ) {
			$this->values = (array)$values;
		}
	}

	/**
	 * @note that numeric key values will be converted from string
	 *   to int by PHP when they are used as array keys
	 * @return array<string|int,string|array<Token|string>>
	 */
	public function getValues(): array {
		return $this->values;
	}

	/**
	 * @param string $name
	 * @return string|array<Token|string>|null
	 */
	public function get( string $name ) {
		return $this->values[$name] ?? null;
	}

	/**
	 * @param string $name
	 * @param string|array<Token|string>|null $value
	 *  Setting to null will unset it from the values array
	 */
	public function set( string $name, $value ): void {
		if ( $value === null ) {
			unset( $this->values[$name] );
		} else {
			$this->values[$name] = $value;
		}
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		return null;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		return $this->values;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): self {
		return new self( $json );
	}
}
