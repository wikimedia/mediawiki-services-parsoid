<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;

/**
 * A serialization part.
 *
 * @property stdClass $target
 * @property stdClass $params
 * @property int $i
 */
#[\AllowDynamicProperties]
class DataMwPart implements \JsonSerializable {
	/** Type of this part: template, templatearg, extension, or parserfunction */
	public string $type;

	public function __construct( array $initialVals = [] ) {
		if ( isset( $initialVals['template'] ) ) {
			$type = 'template';
		} elseif ( isset( $initialVals['templatearg'] ) ) {
			$type = 'templatearg';
		} else {
			// Once upon a time the type could also include "extension" or
			// "parserfunction".  Parser functions now have $type=="template"
			// but they are distinguished by having target.function instead
			// of target.href.
			throw new \InvalidArgumentException( "bad type for data-mw.part" );
		}
		$this->type = $type;
		foreach ( $initialVals[$type] as $k => $v ) {
			// @phan-suppress-next-line PhanNoopSwitchCases
			switch ( $k ) {
				// Add more cases here if needed for special properties
				default:
					$this->$k = $v;
					break;
			}
		}
	}

	public function jsonSerialize(): stdClass {
		$inner = [];
		if ( isset( $this->target ) ) {
			$inner['target'] = $this->target;
		}
		if ( isset( $this->params ) ) {
			$inner['params'] = $this->params;
		}
		if ( isset( $this->i ) ) {
			$inner['i'] = $this->i;
		}
		$result = [];
		$result[$this->type] = $inner;
		return (object)$result;
	}
}
