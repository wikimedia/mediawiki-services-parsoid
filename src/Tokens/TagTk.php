<?php

namespace Parsoid\Tokens;

/**
 * HTML tag token
 */
class TagTk extends Token {
	protected $type = "TagTk";

	/** @var string Name of the end tag */
	public $name;

	/**
	 * @param string $name
	 * @param KV[] $attribs
	 * @param array $dataAttribs data-parsoid object
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
