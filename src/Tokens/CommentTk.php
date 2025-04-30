<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataParsoid;

/**
 * Represents a comment
 */
class CommentTk extends Token {
	/** @var string Comment text */
	public $value;

	public function __construct(
		string $value,
		?DataParsoid $dataParsoid = null,
		?DataMw $dataMw = null
	) {
		// $dataParsoid won't survive in the DOM, but still useful for token serialization
		// FIXME: verify if this is still required given that html->wt doesn't
		// use tokens anymore. That was circa 2012 serializer code.
		parent::__construct( $dataParsoid, $dataMw );
		$this->value = $value;
	}

	public function __clone() {
		parent::__clone();
		// No new non-primitive properties to clone.
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		$ret = [
			'type' => $this->getType(),
			'value' => $this->value,
			'dataParsoid' => $this->dataParsoid,
		];
		if ( $this->dataMw !== null ) {
			$ret['dataMw'] = $this->dataMw;
		}
		return $ret;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self(
			$json['value'],
			$json['dataParsoid'] ?? null,
			$json['dataMw'] ?? null
		);
	}
}
