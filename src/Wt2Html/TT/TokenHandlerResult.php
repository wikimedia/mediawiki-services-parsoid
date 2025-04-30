<?php

declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

class TokenHandlerResult {
	public ?array $tokens;

	/**
	 * @param array|null $tokens The new array of tokens, or null to retain the
	 *   current token
	 */
	public function __construct( ?array $tokens = null ) {
		$this->tokens = $tokens;
	}
}
