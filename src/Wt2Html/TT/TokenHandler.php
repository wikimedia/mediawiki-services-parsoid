<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Wt2Html\TokenTransformManager;

abstract class TokenHandler {
	/** @var Env */
	protected $env;
	/** @var TokenTransformManager */
	protected $manager;
	/** @var int|null */
	protected $pipelineId;
	/** @var array */
	protected $options;
	/** @var bool */
	protected $disabled;
	/** @var bool */
	protected $onAnyEnabled;
	/** @var bool */
	protected $atTopLevel = false;

	/**
	 * @param TokenTransformManager $manager The manager for this stage of the parse.
	 * @param array $options Any options for the expander.
	 */
	public function __construct( TokenTransformManager $manager, array $options ) {
		$this->manager = $manager;
		$this->env = $manager->getEnv();
		$this->options = $options;

		// Initialize a few options to simplify checks elsewhere
		$this->options['inTemplate'] = !empty( $this->options['inTemplate'] );
		$this->options['expandTemplates'] = !empty( $this->options['expandTemplates'] );

		// This is set if the token handler is disabled for the entire pipeline.
		$this->disabled = false;

		// This is set/reset by the token handlers at various points
		// in the token stream based on what is encountered.
		// This only enables/disables the onAny handler.
		$this->onAnyEnabled = true;
	}

	/**
	 * @param int $id
	 */
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
	 * @param NlTk $token Newline token to be processed
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
	 *       if 'skip' is set, onAny handler is skipped
	 *    or { tokens: [..], retry: .. }
	 *       if 'retry' is set, result 'tokens' (OR input token if the handler was a no-op)
	 *       are retried in the transform loop again.
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
	 *    or { tokens: [..], retry: .. }
	 *       if 'retry' is set, result 'tokens' (OR input token if the handler was a no-op)
	 *       are retried in the transform loop again.
	 */
	public function onAny( $token ) {
		return $token;
	}

	/**
	 * @param mixed $token
	 * @param mixed $res
	 * @return bool
	 */
	private function isModified( $token, $res ): bool {
		return $res !== $token && (
			!isset( $res['tokens'] ) || count( $res['tokens'] ) !== 1 || $res['tokens'][0] !== $token
		);
	}

	/**
	 * Push an input array of tokens through the transformer
	 * and return the transformed tokens
	 * @param array $tokens
	 * @param array|null $opts
	 * @return array
	 */
	public function process( $tokens, array $opts = null ) {
		$traceState = $this->manager->getTraceState();
		$profile = $traceState['profile'] ?? null;
		$accum = [];
		$i = 0;
		$n = count( $tokens );
		while ( $i < $n ) {
			$token = $tokens[$i];
			if ( $traceState ) {
				$traceState['tracer']( $token, $this );
			}

			$res = null;
			$resTokens = null; // Not needed but helpful for code comprehension
			$modified = false;
			if ( $profile ) {
				$s = PHPUtils::getStartHRTime();
				if ( $token instanceof NlTk ) {
					$res = $this->onNewline( $token );
					$traceName = $traceState['transformer'] . '.onNewLine';
				} elseif ( $token instanceof EOFTk ) {
					$res = $this->onEnd( $token );
					$traceName = $traceState['transformer'] . '.onEnd';
				} elseif ( !is_string( $token ) ) {
					$res = $this->onTag( $token );
					$traceName = $traceState['transformer'] . '.onTag';
				} else {
					$traceName = null;
					$res = $token;
				}
				if ( $traceName ) {
					$t = PHPUtils::getHRTimeDifferential( $s );
					$profile->bumpTimeUse( $traceName, $t, "TT" );
					$profile->bumpCount( $traceName );
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

			// onTag handler might return a retry signal
			if ( is_array( $res ) && !empty( $res['retry'] ) ) {
				if ( isset( $res['tokens'] ) ) {
					array_splice( $tokens, $i, 1, $res['tokens'] );
					$n = count( $tokens );
				}
				continue;
			}

			$modified = $this->isModified( $token, $res );
			if ( $modified ) {
				$resTokens = $res['tokens'] ?? null;
			} elseif ( $this->onAnyEnabled && ( !is_array( $res ) || empty( $res['skipOnAny'] ) ) ) {
				if ( $profile ) {
					$s = PHPUtils::getStartHRTime();
					$traceName = $traceState['transformer'] . '.onAny';
					$res = $this->onAny( $token );
					$t = PHPUtils::getHRTimeDifferential( $s );
					$profile->bumpTimeUse( $traceName, $t, "TT" );
					$profile->bumpCount( $traceName );
					$traceState['tokenTimes'] += $t;
				} else {
					$res = $this->onAny( $token );
				}

				// onAny handler might return a retry signal
				if ( is_array( $res ) && !empty( $res['retry'] ) ) {
					if ( isset( $res['tokens'] ) ) {
						array_splice( $tokens, $i, 1, $res['tokens'] );
						$n = count( $tokens );
					}
					continue;
				}

				$modified = $this->isModified( $token, $res );
				if ( $modified ) {
					$resTokens = $res['tokens'] ?? null;
				}
			}

			if ( !$modified ) {
				$accum[] = $token;
			} elseif ( $resTokens ) {
				// Avoid array_merge() -- see https://w.wiki/3zvE
				PHPUtils::pushArray( $accum, $resTokens );
			}

			$i++;
		}

		return $accum;
	}
}
