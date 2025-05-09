<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;

/**
 * These handlers process wikitext constructs that are line-based.
 * They are interesed in all tokens and on encountering a newline,
 * they process the "line" in some fashion. In somes cases, the
 * handler is only triggered on seeing a specific tag/token.
 * Till that time, they ignore all tokens. (ex: list, indent-pre, quote)
 *
 * Ex: indent-pre, quote, paragraph, lists, token-stream-patcher
 *
 * They always implement onEnd, at least one of onNewline or onAny handler,
 * and sometimes the onTag handler as well. Some implement all four.
 *
 * FIXME: Ideally, they would all implement the onNewline handler,
 * but it looks like the ListHandler processes newlines in onAny.
 * In a future refactoring, it might be cleaner to extract newline
 * processing into the onNewline handler.
 */
abstract class LineBasedHandler extends TokenHandler {
	protected bool $onAnyEnabled = true;

	/**
	 * The handler may choose to process only specific kinds of tokens.
	 * For example, a list handler may only process 'listitem' TagTk tokens.
	 *
	 * @param XMLTagTk $token tag to be processed
	 * @return ?array<string|Token>
	 *   - null indicates that the token was passed-through
	 *     and it will be dispatched to the onAny handler
	 *   - an array indicates the token was transformed
	 *     and it will skip the onAny handler. The result array
	 *     may be the cumulative transformation of this token
	 *     and other previous tokens before this.
	 */
	public function onTag( XMLTagTk $token ): ?array {
		return null;
	}

	/**
	 * This handler is called for *all* tokens in the token stream except if:
	 * (a) the more specific handlers (onTag, onEnd, onNewline) returned
	 *     a non-null array which means the token was modified and
	 *     shouldn't be processed by the onAny handler.
	 * (b) onAnyEnabled is set to false (can be set by any of the above
	 *     specific handlers).
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

	/**
	 * This handler is called for EOF tokens only
	 * @param EOFTk $token EOF token to be processed
	 * @return ?array<string|Token>
	 *   - null indicates that the token was passed-through
	 *     and it will be dispatched to the onAny handler
	 *   - an array indicates the token was transformed
	 *     and it will skip the onAny handler. The result array
	 *     may be the cumulative transformation of this token
	 *     and other previous tokens before this.
	 */
	public function onEnd( EOFTk $token ): ?array {
		return null;
	}

	/**
	 * This handler is called for newline tokens only
	 * @param NlTk $token Newline token to be processed
	 * @return ?array<string|Token>
	 *   - null indicates that the token was passed-through
	 *     and it will be dispatched to the onAny handler
	 *   - an array indicates the token was transformed
	 *     and it will skip the onAny handler. The result array
	 *     may be the cumulative transformation of this token
	 *     and other previous tokens before this.
	 */
	public function onNewline( NlTk $token ): ?array {
		return null;
	}

	/** @inheritDoc */
	public function process( array $tokens ): array {
		$accum = [];
		foreach ( $tokens as $token ) {
			switch ( true ) {
				case $token instanceof XMLTagTk:
					$res = $this->onTag( $token );
					break;

				case is_string( $token ):
				case $token instanceof CommentTk:
					$res = null;
					break;

				case $token instanceof NlTk:
					$res = $this->onNewline( $token );
					break;

				case $token instanceof CompoundTk:
					$res = $this->onCompoundTk( $token, $this );
					break;

				case $token instanceof EOFTk:
					$res = $this->onEnd( $token );
					break;

				default:
					$res = null;
			}

			if ( $res === null && $this->onAnyEnabled ) {
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
