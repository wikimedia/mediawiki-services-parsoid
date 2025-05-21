<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\Token;

/**
 * These handlers process *all* tags or *all* tokens even.
 *
 * Ex: OnlyInclude, AttributeExpander, SanitizerHandler
 *
 * They only need to support onAny handlers.
 */
abstract class UniversalTokenHandler extends TokenHandler {
	/**
	 * This handler is called for *all* tokens in the token stream.
	 *
	 * @param Token|string $token Token to be processed
	 * @return ?array<string|Token>
	 *   - null indicates that the token was untransformed
	 *     and it will be added to this handler's output array.
	 *   - an array indicates the token was transformed
	 *     and the contents of the array will be added to this
	 *     handler's output array.
	 */
	public function onAny( $token ): ?array {
		return null;
	}

	/** @inheritDoc */
	public function process( array $tokens ): array {
		$accum = [];
		foreach ( $tokens as $token ) {
			if ( $token instanceof CompoundTk ) {
				$token->setNestedTokens( $this->process( $token->getNestedTokens() ) );
				$res = null;
			} else {
				$res = $this->onAny( $token );
			}
			if ( $res === null ) {
				$accum[] = $token;
			} else {
				// Avoid array_merge() -- see https://w.wiki/3zvE
				foreach ( $res as $t ) {
					$accum[] = $t;
				}
			}
		}
		return $accum;
	}
}
