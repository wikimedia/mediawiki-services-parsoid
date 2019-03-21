<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

use \stdClass as StdClass;

/**
 * Represents a comment
 */
class CommentTk extends Token {
	/** @var string Comment text */
	public $value;

	/** @var object Data attributes for this token
	 * TODO: Expand on this.
	 */
	public $dataAttribs;

	/**
	 * @param string $value
	 * @param StdClass|null $dataAttribs
	 */
	public function __construct( string $value, ?StdClass $dataAttribs = null ) {
		$this->value = $value;

		// Won't survive in the DOM, but still useful for token serialization
		// FIXME: verify if this is still required given that html->wt doesn't
		// use tokens anymore. That was circa 2012 serializer code.
		$this->dataAttribs = $dataAttribs ?? (object)[];
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'type' => $this->getType(),
			'value' => $this->value,
			'dataAttribs' => $this->dataAttribs
		];
	}
}
