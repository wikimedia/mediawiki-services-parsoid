<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

/**
 * Represents EOF
 */
class EOFTk extends Token {
	public function __construct() {
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
