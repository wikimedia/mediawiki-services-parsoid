<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

/**
 * Helpful inner object to guide serialization of DataMwPart.
 */
class DataMwPartInner implements JsonCodecable {
	use JsonCodecableTrait;

	public ?stdClass $target;
	public ?ParamMap $params;
	public ?int $i;

	public function __construct( ?stdClass $target, ?ParamMap $params, ?int $i ) {
		$this->target = $target;
		$this->params = $params;
		$this->i = $i;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): DataMwPartInner {
		return new DataMwPartInner(
			$json['target'] ?? null,
			$json['params'] ?? null,
			$json['i'] ?? null
		);
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		static $hints = null;
		if ( $hints === null ) {
			$hints = [
				'target' => stdClass::class,
				'params' => new Hint( ParamMap::class, Hint::ALLOW_OBJECT ),
			];
		}
		return $hints[$keyname] ?? null;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		$result = [];
		if ( $this->target !== null ) {
			$result['target'] = $this->target;
		}
		if ( $this->params !== null ) {
			$result['params'] = $this->params;
		}
		if ( $this->i !== null ) {
			$result['i'] = $this->i;
		}
		return $result;
	}
}
