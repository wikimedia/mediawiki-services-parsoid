<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

/**
 * Compound token representing an indent-pre
 */
class IndentPreTk extends CompoundTk {
	public function setsEOLContext(): bool {
		return true;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self( $json['nestedTokens'] ?? [] );
	}
}
