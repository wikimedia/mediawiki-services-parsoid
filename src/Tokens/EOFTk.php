<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

/**
 * Represents EOF
 */
class EOFTk extends Token {

	public function __construct() {
		parent::__construct( null, null );
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'type' => $this->getType()
		];
	}
}
