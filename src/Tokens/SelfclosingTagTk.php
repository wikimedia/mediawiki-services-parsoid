<?php

namespace Parsoid\Tokens;

/**
 * Token for a self-closing tag (HTML or otherwise)
 */
class SelfclosingTagTk extends Token {
	protected $type = "SelfclosingTagTk";

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
	 * return object
	 */
	public function toJSON() {
		throw new \BadMethodCallException( 'Not yet ported' );
	}
}
