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
	 * @return array
	 */
	public function jsonSerialize() {
		return [
			"type" => $this->type
		];
	}
}
