<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Parsoid\NodeData\DataParsoid;

/**
 * Token for a self-closing tag (HTML or otherwise)
 */
class SelfclosingTagTk extends Token {
	/** @var string Name of the end tag */
	private $name;

	/**
	 * @param string $name
	 * @param KV[] $attribs
	 * @param ?DataParsoid $dataAttribs
	 */
	public function __construct(
		string $name, array $attribs = [], ?DataParsoid $dataAttribs = null
	) {
		$this->name = $name;
		$this->attribs = $attribs;
		$this->dataAttribs = $dataAttribs ?? new DataParsoid;
	}

	/**
	 * @return string
	 */
	public function getName(): string {
		return $this->name;
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'type' => $this->getType(),
			'name' => $this->name,
			'attribs' => $this->attribs,
			'dataAttribs' => $this->dataAttribs
		];
	}
}
