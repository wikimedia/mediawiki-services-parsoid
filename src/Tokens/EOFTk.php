<?php

namespace Parsoid\Tokens;

/**
 * Represents EOF
 */
class EOFTk extends Token {
	protected $type = 'EOFTk';

	public function __construct() {
	}

	public function toJSON() {
		throw new \BadMethodCallException( 'Not yet ported' );
	}
}
