<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Assert\UnreachableException;
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
	 * Process the compound token in a handler-specific way.
	 * - Some handlers might ignore it and pass it through
	 * - Some handlers might process its nested tokens and update it
	 * - Some handlers might process its nested tokens and flatten it
	 *
	 * To ensure that handlers that encounter compound tokens always
	 * have explicit handling for them, the default implementation
	 * here will throw an exception!
	 *
	 * NOTE: The only reason we are processing a handler here is because
	 * of needing to support profiling. For the profiling use case,
	 * we will be passing a TraceProxy instead of the handler itself.
	 *
	 * @return ?array<string|Token>
	 */
	public function onCompoundTk( CompoundTk $ctk, TokenHandler $tokensHandler ): ?array {
		throw new UnreachableException(
			get_class( $this ) . ": Unsupported compound token."
		);
	}

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
				$res = $this->onCompoundTk( $token, $this );
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
