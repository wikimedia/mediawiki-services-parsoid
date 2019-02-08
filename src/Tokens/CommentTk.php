<?php

namespace Parsoid\Tokens;

/**
 * Represents a comment
 */
class CommentTk extends Token {
	protected $type = 'CommentTk';

	/** @var string Comment text */
	public $value;

	/** @var array Data attributes for this token
	 * This is represented an associative key-value array
	 * TODO: Expand on this.
	 */
	public $dataAttribs = [];

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

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize() {
		return [
			"type" => $this->type,
			"value" => $this->value,
			"dataAttribs" => $this->dataAttribs
		];
	}
}
