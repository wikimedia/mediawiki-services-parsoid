<?php

declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

class TokenHandlerResult {
	public array $tokens;

	/** The new array of tokens */
	public function __construct( array $tokens ) {
		$this->tokens = $tokens;
	}
}
