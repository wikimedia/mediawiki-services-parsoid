<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataParsoid;

/**
 * HTML tag token
 */
class TagTk extends Token {
	/** @var string Name of the end tag */
	private $name;

	/**
	 * @param string $name
	 * @param KV[] $attribs
	 * @param ?DataParsoid $dataParsoid data-parsoid object
	 * @param ?DataMw $dataMw data-mw object
	 */
	public function __construct(
		string $name, array $attribs = [],
		?DataParsoid $dataParsoid = null,
		?DataMw $dataMw = null
	) {
		parent::__construct( $dataParsoid, $dataMw );
		$this->name = $name;
		$this->attribs = $attribs;
	}

	public function __clone() {
		parent::__clone();
		// No new non-primitive properties to clone.
	}

	public function getName(): string {
		return $this->name;
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		$ret = [
			'type' => $this->getType(),
			'name' => $this->name,
			'attribs' => $this->attribs,
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
			$json['name'],
			$json['attribs'] ?? [],
			$json['dataParsoid'] ?? null,
			$json['dataMw'] ?? null
		);
	}
}
