<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

/**
 * Parameter map.
 */
#[\AllowDynamicProperties]
class ParamMap implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * @param array<string,stdClass> $vals
	 */
	public function __construct( array $vals ) {
		foreach ( $vals as $k => $v ) {
			$this->$k = $v;
		}
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): ParamMap {
		return new ParamMap( $json );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		static $hint;
		if ( $hint === null ) {
			// The most deeply nested stdClass structure is "wt" inside
			// "key" inside a parameter:
			//     "params":{"1":{"key":{"wt":"..."}}}
			$hint = Hint::build(
				stdClass::class, Hint::ALLOW_OBJECT,
				Hint::STDCLASS, Hint::ALLOW_OBJECT
			);
		}
		return $hint;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		return (array)$this;
	}
}
