<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

/**
 * Represents a comment
 */
class CommentTk extends Token {
	protected $type = 'CommentTk';

	/** @var string Comment text */
	public $value;

	/** @var object Data attributes for this token
	 * TODO: Expand on this.
	 */
	public $dataAttribs;

	/**
	 * @param string $value
	 * @param object|null $dataAttribs
	 */
	public function __construct( string $value, $dataAttribs = null ) {
		$this->value = $value;

		// Won't survive in the DOM, but still useful for token serialization
		// FIXME: verify if this is still required given that html->wt doesn't
		// use tokens anymore. That was circa 2012 serializer code.
		$this->dataAttribs = $dataAttribs ?? (object)[];
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize() {
		return [
			'type' => $this->type,
			'value' => $this->value,
			'dataAttribs' => $this->dataAttribs
		];
	}
}
