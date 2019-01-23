<?php

namespace Parsoid\Tokens;

/**
 * Represents an HTML end tag token
 */
class EndTagTk extends Token {
	protected $type = 'EndTagTk';

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
