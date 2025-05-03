<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

abstract class TokenHandler {
	protected Env $env;
	protected TokenHandlerPipeline $manager;
	protected ?int $pipelineId;
	protected array $options;
	/** This is set if the token handler is disabled for the entire pipeline. */
	protected bool $disabled = false;
	/**
	 * This is set/reset by the token handlers at various points in the token stream based on what
	 * is encountered. This only enables/disables the onAny handler.
	 */
	protected bool $onAnyEnabled = true;
	protected bool $atTopLevel = false;

	/**
	 * @param TokenHandlerPipeline $manager The manager for this stage of the parse.
	 * @param array $options Any options for the expander.
	 */
	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		$this->manager = $manager;
		$this->env = $manager->getEnv();
		$this->options = $options;
	}

	public function setPipelineId( int $id ): void {
		$this->pipelineId = $id;
	}

	/**
	 * Resets any internal state for this token handler.
	 *
	 * @param array $options
	 */
	public function resetState( array $options ): void {
		$this->atTopLevel = $options['toplevel'] ?? false;
	}

	/**
	 * Is this transformer disabled?
	 * @return bool
	 */
	public function isDisabled(): bool {
		return $this->disabled;
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

	/**
	 * This handler is called for tokens that are not EOFTk or NLTk tokens.
	 * The handler may choose to process only specific kinds of tokens.
	 * For example, a list handler may only process 'listitem' TagTk tokens.
	 *
	 * @param Token $token Token to be processed
	 * @return ?array<string|Token>
	 *   - null indicates that the token was passed-through
	 *     and it will be dispatched to the onAny handler
	 *   - an array indicates the token was transformed
	 *     and it will skip the onAny handler. The result array
	 *     may be the cumulative transformation of this token
	 *     and other previous tokens before this.
	 */
	public function onTag( Token $token ): ?array {
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
	 * Push an input array of tokens through the handler
	 * and return a new array of transformed tokens.
	 */
	public function process( array $tokens ): array {
		$accum = [];
		foreach ( $tokens as $token ) {
			if ( $token instanceof NlTk ) {
				$res = $this->onNewline( $token );
			} elseif ( $token instanceof EOFTk ) {
				$res = $this->onEnd( $token );
			} elseif ( !is_string( $token ) ) {
				$res = $this->onTag( $token );
			} else {
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
