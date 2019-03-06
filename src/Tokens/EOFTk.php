<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

/**
 * Represents EOF
 */
class EOFTk extends Token {
	protected $type = 'EOFTk';

	public function __construct() {
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'type' => $this->type
		];
	}
}
