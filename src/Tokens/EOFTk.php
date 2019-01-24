<?php

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
	public function jsonSerialize() {
		return [
			'type' => $this->type
		];
	}
}
