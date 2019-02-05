<?php

namespace Parsoid\Tokens;

/**
 * Token for a self-closing tag (HTML or otherwise)
 */
class SelfclosingTagTk extends Token {
	protected $type = "SelfclosingTagTk";

	/** @var string Name of the end tag */
	public $name;

	/**
	 * @param string $name
	 * @param KV[] $attribs
	 * @param array $dataAttribs
	 */
	public function __construct( $name, array $attribs = [], array $dataAttribs = [] ) {
		$this->name = $name;
		$this->attribs = $attribs;
		$this->dataAttribs = $dataAttribs;
	}

	/**
	 * @return array
	 */
	public function jsonSerialize() {
		return [
			"type" => $this->type,
			"name" => $this->name,
			"attribs" => $this->attribs,
			"dataAttribs" => $this->dataAttribs
		];
	}
}
