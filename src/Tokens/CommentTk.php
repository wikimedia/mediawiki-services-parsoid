<?php

namespace Parsoid\Tokens;

/**
 * Represents a comment
 */
class CommentTk extends Token {
	protected $type = 'CommentTk';

	/** @var string Comment text */
	public $value;

	/**
	 * @param string $value
	 * @param array $dataAttribs
	 */
	public function __construct( $value, array $dataAttribs = [] ) {
		$this->value = $value;

		// Won't survive in the DOM, but still useful for token serialization
		// FIXME: verify if this is still required given that html->wt doesn't
		// use tokens anymore. That was circa 2012 serializer code.
		$this->dataAttribs = $dataAttribs;
	}

	public function toJSON() {
		throw new \BadMethodCallException( 'Not yet ported' );
	}
}
