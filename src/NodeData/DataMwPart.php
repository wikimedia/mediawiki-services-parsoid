<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

/**
 * A serialization part.
 *
 * @property stdClass $target
 * @property ParamMap $params
 * @property int $i
 */
#[\AllowDynamicProperties]
class DataMwPart implements JsonCodecable {
	use JsonCodecableTrait;

	/** Type of this part: template, templatearg, extension, or parserfunction */
	public string $type;

	public function __construct( string $type, DataMwPartInner $inner ) {
		$this->type = $type;
		foreach ( $inner->toJsonArray() as $k => $v ) {
			$this->$k = $v;
		}
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): DataMwPart {
		if ( isset( $json['template'] ) ) {
			$type = 'template';
		} elseif ( isset( $json['templatearg'] ) ) {
			$type = 'templatearg';
		} else {
			// Once upon a time the type could also include "extension" or
			// "parserfunction".  Parser functions now have $type=="template"
			// but they are distinguished by having target.function instead
			// of target.href.
			throw new \InvalidArgumentException( "bad type for data-mw.part" );
		}
		return new DataMwPart( $type, $json[$type] );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		return DataMwPartInner::class;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		$inner = new DataMwPartInner(
			$this->target ?? null,
			$this->params ?? null,
			$this->i ?? null
		);
		$result = [];
		$result[$this->type] = $inner;
		return $result;
	}
}
