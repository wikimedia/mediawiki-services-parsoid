<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2html\TT;

use Parsoid\Config\Env;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\NlTk;
use Parsoid\Tokens\Token;
use Parsoid\Utils\PHPUtils;

class TokenHandler {
	/**
	 * @param TokenTransformManager $manager The manager for this stage of the parse.
	 * @param array $options Any options for the expander.
	 */
	public function __construct( $manager, array $options ) {
		$this->manager = $manager;
		$this->env = $manager->env;
		$this->options = $options;
		$this->atTopLevel = false;

		// This is set if the token handler is disabled for the entire pipeline.
		$this->disabled = false;

		// This is set/reset by the token handlers at various points
		// in the token stream based on what is encountered.
		// This only enables/disables the onAny handler.
		$this->onAnyEnabled = true;
	}

	/**
	 * This handler is called for EOF tokens only
	 * @param EOFTk $token EOF token to be processed
	 * @return EOFTk|array
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
	 */
	public function onEnd( EOFTk $token ) {
		return $token;
	}

	/**
	 * This handler is called for newline tokens only
	 * @param Token $token Newline token to be processed
	 * @return NlTk|array
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
	 */
	public function onNewline( NlTk $token ) {
		return $token;
	}

	/**
	 * This handler is called for tokens that are not EOFTk or NLTk tokens.
	 * The handler may choose to process only specific kinds of tokens.
	 * For example, a list handler may only process 'listitem' TagTk tokens.
	 *
	 * @param Token $token Token to be processed
	 * @return Token|array
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
	 */
	public function onTag( Token $token ) {
		return $token;
	}

	/**
	 * This handler is called for *all* tokens in the token stream except if
	 * (a) The more specific handlers above modified the token
	 * (b) the more specific handlers (onTag, onEnd, onNewline) have set
	 *     the skip flag in their return values.
	 * (c) this handlers 'active' flag is set to false (can be set by any
	 *     of the handlers).
	 *
	 * @param Token|string $token Token to be processed
	 * @return Token|array
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 */
	public function onAny( $token ) {
		return $token;
	}

	/**
	 * Resets the state based on parameter
	 *
	 * @param array $opts Any options for the expander.
	 */
	public function resetState( array $opts ): void {
		$this->atTopLevel = $opts && $opts['toplevel'];
	}

	/* -------------------------- PORT-FIXME ------------------------------
	 * We should benchmark a version of this function
	 * without any of the tracing code in it. There are upto 4 untaken branches
	 * that are executed in the hot loop for every single token. Unlike V8,
	 * this code will not be JIT-ted to eliminate that overhead.
	 *
	 * In the common case where tokens come through functions unmodified
	 * because of hitting default identity handlers, these 4 extra branches
	 * could potentially amount to something. That might be partially ameliorated
	 * by the fact that most modern processors have branch prediction and these
	 * branches will always fail and so might not be such a big deal.
	 *
	 * In any case, worth a performance test after the port.
	 * -------------------------------------------------------------------- */
	/**
	 * Push an input array of tokens through the transformer
	 * and return the transformed tokens
	 *
	 * @param Env $env Parser Environment
	 * @param array $tokens The array of tokens to process
	 * @param array|null $traceState Tracing related state
	 * @return array the array of transformed tokens
	 */
	public function processTokensSync( Env $env, array $tokens, ?array $traceState = [] ): array {
		$genFlags = $traceState['genFlags'] ?? null;
		$traceFlags = $traceState['traceFlags'] ?? null;
		$traceTime = $traceState['traceTime'] ?? false;
		$accum = [];
		foreach ( $tokens as $token ) {
			if ( $traceFlags ) {
				$traceState['tracer']( $token, $this );
			}

			$res = null;
			$resTokens = null; // Not needed but helpful for code comprehension
			$modified = false;
			if ( $traceTime ) {
				$s = PHPUtils::getStartHRTime();
				if ( $token instanceof NlTk ) {
					$res = $this->onNewline( $token );
					$traceName = $traceState['traceNames'][0];
				} elseif ( $token instanceof EOFTk ) {
					$res = $this->onEnd( $token );
					$traceName = $traceState['traceNames'][1];
				} elseif ( !is_string( $token ) ) {
					$res = $this->onTag( $token );
					$traceName = $traceState['traceNames'][2];
				} else {
					$traceName = null;
					$res = $token;
				}
				if ( $traceName ) {
					$t = PHPUtils::getHRTimeDifferential( $s );
					$env->bumpTimeUse( $traceName, $t, "TT" );
					$env->bumpCount( $traceName );
					$traceState['tokenTimes'] += $t;
				}
			} else {
				if ( $token instanceof NlTk ) {
					$res = $this->onNewline( $token );
				} elseif ( $token instanceof EOFTk ) {
					$res = $this->onEnd( $token );
				} elseif ( !is_string( $token ) ) {
					$res = $this->onTag( $token );
				} else {
					$res = $token;
				}
			}

			if ( $res !== $token &&
				( !isset( $res['tokens'] ) || count( $res['tokens'] ) !== 1 || $res['tokens'][0] !== $token )
			) {
				$resTokens = $res['tokens'] ?? null;
				$modified = true;
			}

			if ( !$modified && ( !is_array( $res ) || empty( $res['skipOnAny'] ) ) && $this->onAnyEnabled ) {
				if ( $traceTime ) {
					$s = PHPUtils::getStartHRTime();
					$traceName = $traceState['traceNames'][3];
					$res = $this->onAny( $token );
					$t = PHPUtils::getHRTimeDifferential( $s );
					$env->bumpTimeUse( $traceName, $t, "TT" );
					$env->bumpCount( $traceName );
					$traceState['tokenTimes'] += $t;
				} else {
					$res = $this->onAny( $token );
				}
				if ( $res !== $token &&
					( !isset( $res['tokens'] ) || count( $res['tokens'] ) !== 1 || $res['tokens'][0] !== $token )
				) {
					$resTokens = $res['tokens'] ?? null;
					$modified = true;
				}
			}

			if ( $genFlags && isset( $genFlags['handler'] ) ) {
				// No matter whether token changed or not, emit a test line.
				// This makes for more reliable verification of ported code.
				$traceState['genTest']( $this, $token, $res );
			}

			if ( !$modified ) {
				$accum[] = $token;
			} elseif ( $resTokens && count( $resTokens ) > 0 ) {
				$accum = array_merge( $accum, $resTokens );
			}
		}

		return $accum;
	}
}
