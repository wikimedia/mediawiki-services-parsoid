<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\TokenTransformManager;

/**
 * PRE handling.
 *
 * PRE-handling relies on the following 5-state FSM.
 *
 * States
 * ------
 * ```
 * SOL           -- start-of-line
 *                  (white-space, comments, meta-tags are all SOL transparent)
 * PRE           -- we might need a pre-block
 *                  (if we enter the PRE_COLLECT state)
 * PRE_COLLECT   -- we will need to generate a pre-block and are collecting
 *                  content for it.
 * SOL_AFTER_PRE -- we might need to extend the pre-block to multiple lines.
 *                  (depending on whether we see a white-space tok or not)
 * IGNORE        -- nothing to do for the rest of the line.
 * ```
 *
 * Transitions
 * -----------
 *
 * In the transition table below, purge is just a shortcut for:
 * "pass on collected tokens to the callback and reset (getResultAndReset)"
 * ```
 * + --------------+-----------------+---------------+--------------------------+
 * | Start state   |     Token       | End state     |  Action                  |
 * + --------------+-----------------+---------------+--------------------------+
 * | SOL           | --- nl      --> | SOL           | purge                    |
 * | SOL           | --- eof     --> | SOL           | purge                    |
 * | SOL           | --- ws      --> | PRE           | save whitespace token(##)|
 * | SOL           | --- sol-tr  --> | SOL           | TOKS << tok              |
 * | SOL           | --- other   --> | IGNORE        | purge                    |
 * + --------------+-----------------+---------------+--------------------------+
 * | PRE           | --- nl      --> | SOL           | purge                    |
 * | PRE           |  html-blk tag   | IGNORE        | purge                    |
 * |               |  wt-table tag   |               |                          |
 * | PRE           | --- eof     --> | SOL           | purge                    |
 * | PRE           | --- sol-tr  --> | PRE           | SOL-TR-TOKS << tok       |
 * | PRE           | --- other   --> | PRE_COLLECT   | TOKS = SOL-TR-TOKS + tok |
 * + --------------+-----------------+---------------+--------------------------+
 * | PRE_COLLECT   | --- nl      --> | SOL_AFTER_PRE | save nl token            |
 * | PRE_COLLECT   | --- eof     --> | SOL           | gen-pre                  |
 * | PRE_COLLECT   | --- blk tag --> | IGNORE        | gen-prepurge (#)         |
 * | PRE_COLLECT   | --- any     --> | PRE_COLLECT   | TOKS << tok              |
 * + --------------+-----------------+---------------+--------------------------+
 * | SOL_AFTER_PRE | --- nl      --> | SOL           | gen-pre                  |
 * | SOL_AFTER_PRE | --- eof     --> | SOL           | gen-pre                  |
 * | SOL_AFTER_PRE | --- ws      --> | PRE_COLLECT   | pop saved nl token (##)  |
 * |               |                 |               | TOKS = SOL-TR-TOKS + tok |
 * | SOL_AFTER_PRE | --- sol-tr  --> | SOL_AFTER_PRE | SOL-TR-TOKS << tok       |
 * | SOL_AFTER_PRE | --- any     --> | IGNORE        | gen-pre                  |
 * + --------------+-----------------+---------------+--------------------------+
 * | IGNORE        | --- nl      --> | SOL           | purge                    |
 * | IGNORE        | --- eof     --> | SOL           | purge                    |
 * + --------------+-----------------+---------------+--------------------------+
 *
 * # If we've collected any tokens from previous lines, generate a pre. This
 * line gets purged.
 *
 * ## In these states, check if the whitespace token is a single space or has
 * additional chars (white-space or non-whitespace) -- if yes, slice it off
 * and pass it through the FSM.
 */
class PreHandler extends TokenHandler {
	// FSM states
	private const STATE_SOL = 1;
	private const STATE_PRE = 2;
	private const STATE_PRE_COLLECT = 3;
	private const STATE_SOL_AFTER_PRE = 4;
	private const STATE_IGNORE = 5;

	/** @var int */
	private $state;
	/** @var ?NlTk */
	private $lastNlTk;
	/** @var int */
	private $preTSR;
	/** @var array<Token> */
	private $tokens;
	/** @var array<Token|string> */
	private $preCollectCurrentLine;
	/** @var Token|string|null */
	private $preWSToken;
	/** @var Token|string|null */
	private $multiLinePreWSToken;
	/** @var array<Token> */
	private $solTransparentTokens;

	/**
	 * debug string output of FSM states
	 * @return array
	 */
	private static function stateStr(): array {
		return [
			1 => 'sol          ',
			2 => 'pre          ',
			3 => 'pre_collect  ',
			4 => 'sol_after_pre',
			5 => 'ignore       '
		];
	}

	/**
	 * @param TokenTransformManager $manager manager enviroment
	 * @param array $options various configuration options
	 */
	public function __construct( TokenTransformManager $manager, array $options ) {
		parent::__construct( $manager, $options );
		if ( !empty( $this->options['inlineContext'] ) ) {
			$this->disabled = true;
		} else {
			$this->disabled = false;
			$this->resetState( [] );
		}
	}

	/**
	 * @param array $opts
	 */
	public function resetState( array $opts ): void {
		$this->reset();
	}

	/**
	 * Resets the FSM state with optional any handler enabled
	 */
	private function reset(): void {
		$this->state = self::STATE_SOL;
		$this->lastNlTk = null;
		// Initialize to zero to deal with indent-pre
		// on the very first line where there is no
		// preceding newline to initialize this.
		$this->preTSR = 0;
		$this->tokens = [];
		$this->preCollectCurrentLine = [];
		$this->preWSToken = null;
		$this->multiLinePreWSToken = null;
		$this->solTransparentTokens = [];
		$this->onAnyEnabled = true;
	}

	/**
	 * Switches the FSM to STATE_IGNORE
	 */
	private function moveToIgnoreState(): void {
		$this->onAnyEnabled = false;
		$this->state = self::STATE_IGNORE;
	}

	/**
	 * Pushes the last new line onto the $ret array
	 *
	 * @param array &$ret
	 */
	private function pushLastNL( array &$ret ): void {
		if ( $this->lastNlTk ) {
			$ret[] = $this->lastNlTk;
			$this->lastNlTk = null;
		}
	}

	/**
	 * Removes multiline-pre-ws token when multi-line pre has been specified
	 */
	private function resetPreCollectCurrentLine(): void {
		if ( count( $this->preCollectCurrentLine ) > 0 ) {
			PHPUtils::pushArray( $this->tokens, $this->preCollectCurrentLine );
			$this->preCollectCurrentLine = [];
			// Since the multi-line pre materialized, the multiline-pre-ws token
			// should be discarded so that it is not emitted after <pre>..</pre>
			// is generated (see processPre).
			$this->multiLinePreWSToken = null;
		}
	}

	/**
	 * If a blocking token sequence is encountered with collecting, cleanup state
	 *
	 * @param Token $token
	 * @return array
	 */
	private function encounteredBlockWhileCollecting( Token $token ): array {
		$env = $this->env;
		$ret = [];
		$mlp = null;

		// we remove any possible multiline ws token here and save it because
		// otherwise the propressPre below would add it in the wrong place
		if ( $this->multiLinePreWSToken ) {
			$mlp = $this->multiLinePreWSToken;
			$this->multiLinePreWSToken = null;
		}

		$i = count( $this->tokens );
		if ( $i > 0 ) {
			$i--;
			while ( $i > 0 && TokenUtils::isSolTransparent( $env, $this->tokens[$i] ) ) {
				$i--;
			}
			$solToks = array_splice( $this->tokens, $i );
			$this->lastNlTk = array_shift( $solToks );
			// assert( $this->lastNlTk && get_class( $this->lastNlTk ) === NlTk::class );
			$ret = array_merge( $this->processPre( null ), $solToks );
		}

		if ( $this->preWSToken || $mlp ) {
			$ret[] = $this->preWSToken ?? $mlp;
			$this->preWSToken = null;
		}

		$this->resetPreCollectCurrentLine();
		PHPUtils::pushArray( $ret, $this->getResultAndReset( $token ) );
		return $ret;
	}

	/**
	 * Get results and cleanup state
	 *
	 * @param Token|string $token
	 * @return array
	 */
	private function getResultAndReset( $token ): array {
		$this->pushLastNL( $this->tokens );

		$ret = $this->tokens;
		if ( $this->preWSToken ) {
			$ret[] = $this->preWSToken;
			$this->preWSToken = null;
		}
		if ( count( $this->solTransparentTokens ) > 0 ) {
			PHPUtils::pushArray( $ret, $this->solTransparentTokens );
			$this->solTransparentTokens = [];
		}
		$ret[] = $token;
		$this->tokens = [];
		$this->multiLinePreWSToken = null;

		return $ret;
	}

	/**
	 * Process a pre
	 *
	 * @param Token|string|null $token
	 * @return array
	 */
	private function processPre( $token ): array {
		$ret = [];

		// pre only if we have tokens to enclose
		if ( count( $this->tokens ) > 0 ) {
			$da = null;
			if ( $this->preTSR !== -1 ) {
				$da = new DataParsoid;
				$da->tsr = new SourceRange( $this->preTSR, $this->preTSR + 1 );
			}
			$ret = array_merge( [ new TagTk( 'pre', [], $da ) ], $this->tokens, [ new EndTagTk( 'pre' ) ] );
		}

		// emit multiline-pre WS token
		if ( $this->multiLinePreWSToken ) {
			$ret[] = $this->multiLinePreWSToken;
			$this->multiLinePreWSToken = null;
		}
		$this->pushLastNL( $ret );

		// sol-transparent toks
		PHPUtils::pushArray( $ret, $this->solTransparentTokens );

		// push the current token
		if ( $token !== null ) {
			$ret[] = $token;
		}

		// reset!
		$this->solTransparentTokens = [];
		$this->tokens = [];

		return $ret;
	}

	/**
	 * Initialize a pre TSR
	 *
	 * @param NlTk $nltk
	 * @return int
	 */
	private function initPreTSR( NlTk $nltk ): int {
		$da = $nltk->dataAttribs;
		// tsr->end can never be zero, so safe to use tsr->end to check for null/undefined
		return $da->tsr->end ?? -1;
	}

	/**
	 * @inheritDoc
	 */
	public function onNewline( NlTk $token ): ?TokenHandlerResult {
		$env = $this->env;

		$env->log( 'trace/pre', $this->pipelineId, 'NL    |',
			$this->state, ':',
			self::stateStr()[$this->state], '|',
			static function () use ( $token ) {
				return PHPUtils::jsonEncode( $token );
			}
		);

		// Whenever we move into SOL-state, init preTSR to
		// the newline's tsr->end.  This will later be  used
		// to assign 'tsr' values to the <pre> token.

		// See TokenHandler's documentation for the onAny handler
		// for what this flag is about.
		switch ( $this->state ) {
			case self::STATE_SOL:
				$ret = $this->getResultAndReset( $token );
				$this->preTSR = self::initPreTSR( $token );
				break;

			case self::STATE_PRE:
				$ret = $this->getResultAndReset( $token );
				$this->preTSR = self::initPreTSR( $token );
				$this->state = self::STATE_SOL;
				break;

			case self::STATE_PRE_COLLECT:
				$ret = [];
				$this->resetPreCollectCurrentLine();
				$this->lastNlTk = $token;
				$this->state = self::STATE_SOL_AFTER_PRE;
				break;

			case self::STATE_SOL_AFTER_PRE:
				$this->preWSToken = null;
				$this->multiLinePreWSToken = null;
				$ret = $this->processPre( $token );
				$this->preTSR = self::initPreTSR( $token );
				$this->state = self::STATE_SOL;
				break;

			case self::STATE_IGNORE:
				$ret = null;
				$this->reset();
				$this->preTSR = self::initPreTSR( $token );
				break;

			default:
				// probably unreachable but makes phan happy
				$ret = [];
		}

		$env->log( 'debug/pre', $this->pipelineId, 'saved :', $this->tokens );
		$env->log( 'debug/pre', $this->pipelineId, '---->  ',
			static function () use ( $ret ) {
				return PHPUtils::jsonEncode( $ret );
			}
		);

		return new TokenHandlerResult( $ret, true );
	}

	/**
	 * @inheritDoc
	 */
	public function onEnd( EOFTk $token ): ?TokenHandlerResult {
		$this->env->log( 'trace/pre', $this->pipelineId, 'eof   |',
			$this->state, ':',
			self::stateStr()[$this->state], '|',
			static function () use ( $token ) {
				return PHPUtils::jsonEncode( $token );
			}
		);

		switch ( $this->state ) {
			case self::STATE_SOL:
			case self::STATE_PRE:
				$ret = $this->getResultAndReset( $token );
				break;

			case self::STATE_PRE_COLLECT:
			case self::STATE_SOL_AFTER_PRE:
				$this->preWSToken = null;
				$this->multiLinePreWSToken = null;
				$this->resetPreCollectCurrentLine();
				$ret = $this->processPre( $token );
				break;

			case self::STATE_IGNORE:
				$ret = null;
				break;

			default:
				// Probably unreachable but makes phan happy
				$ret = [];
		}

		$this->env->log( 'debug/pre', $this->pipelineId, 'saved :', $this->tokens );
		$this->env->log( 'debug/pre', $this->pipelineId, '---->  ',
			static function () use ( $ret ){
				return PHPUtils::jsonEncode( $ret );
			}
		);

		return new TokenHandlerResult( $ret, true );
	}

	/**
	 * Get updated pre TSR value
	 *
	 * @param int $tsr
	 * @param Token|string $token
	 * @return int
	 */
	private function getUpdatedPreTSR( int $tsr, $token ): int {
		if ( $token instanceof CommentTk ) {
			$tsr = isset( $token->dataAttribs->tsr ) ? $token->dataAttribs->tsr->end :
				( ( $tsr === -1 ) ? -1 : WTUtils::decodedCommentLength( $token ) + $tsr );
		} elseif ( $token instanceof SelfclosingTagTk ) {
			// meta-tag (cannot compute)
			$tsr = -1;
		} elseif ( $tsr !== -1 ) {
			// string
			$tsr += strlen( $token );
		}
		return $tsr;
	}

	/**
	 * Collect a token when in a known-pre state
	 * @param Token|string $token
	 */
	private function collectTokenInPreState( $token ): void {
		if ( TokenUtils::isSolTransparent( $this->env, $token ) ) { // continue watching
			$this->solTransparentTokens[] = $token;
		} else {
			$this->preCollectCurrentLine = $this->solTransparentTokens;
			$this->preCollectCurrentLine[] = $token;
			$this->solTransparentTokens = [];
			$this->state = self::STATE_PRE_COLLECT;
		}
	}

	/**
	 * @inheritDoc
	 */
	public function onAny( $token ): ?TokenHandlerResult {
		$env = $this->env;

		$env->log( 'trace/pre', $this->pipelineId, 'any   |',
			$this->state, ':',
			self::stateStr()[$this->state], '|',
			static function () use ( $token ) {
				return PHPUtils::jsonEncode( $token );
			}
		);

		if ( $this->state === self::STATE_IGNORE ) {
			$env->log( 'error', static function () use ( $token ) {
				return '!ERROR! IGNORE! Cannot get here: ' . PHPUtils::jsonEncode( $token );
			} );
			return null;
		}

		$ret = [];
		switch ( $this->state ) {
			case self::STATE_SOL:
				if ( is_string( $token ) && ( $token[0] ?? '' ) === ' ' ) {
					$ret = $this->tokens;
					$this->tokens = [];
					$this->preWSToken = $token[0];
					$this->state = self::STATE_PRE;
					if ( strlen( $token ) > 1 ) {
						// Collect the rest of the string and continue
						// (`substr` not `mb_substr` since we know space is ASCII)
						$this->collectTokenInPreState( substr( $token, 1 ) );
					}
				} elseif ( TokenUtils::isSolTransparent( $env, $token ) ) {
					// continue watching ...
					// update pre-tsr since we haven't transitioned to PRE yet
					$this->preTSR = $this->getUpdatedPreTSR( $this->preTSR, $token );
					$this->tokens[] = $token;
				} else {
					$ret = $this->getResultAndReset( $token );
					$this->moveToIgnoreState();
				}
				break;

			case self::STATE_PRE:
				if ( TokenUtils::isSolTransparent( $env, $token ) ) { // continue watching
					$this->solTransparentTokens[] = $token;
				} elseif ( TokenUtils::isTableTag( $token ) ||
					( TokenUtils::isHTMLTag( $token ) && TokenUtils::isWikitextBlockTag( $token->getName() ) )
				) {
					$ret = $this->getResultAndReset( $token );
					$this->moveToIgnoreState();
				} else {
					$this->collectTokenInPreState( $token );
				}
				break;

			case self::STATE_PRE_COLLECT:
				if ( !is_string( $token ) && TokenUtils::isWikitextBlockTag( $token->getName() ) ) {
					$ret = $this->encounteredBlockWhileCollecting( $token );
					$this->moveToIgnoreState();
				} else {
					// nothing to do .. keep collecting!
					$this->preCollectCurrentLine[] = $token;
				}
				break;

			case self::STATE_SOL_AFTER_PRE:
				if ( is_string( $token ) && preg_match( '/^ /', $token ) ) {
					$this->pushLastNL( $this->tokens );
					$this->state = self::STATE_PRE_COLLECT;
					$this->preWSToken = null;

					// Pop buffered sol-transparent tokens
					PHPUtils::pushArray( $this->tokens, $this->solTransparentTokens );
					$this->solTransparentTokens = [];

					// check if token is single-space or more
					$this->multiLinePreWSToken = $token[0];
					if ( strlen( $token ) > 1 ) {
						// Treat everything after the first space as a new token
						// (`substr` not `mb_substr` since we know space is ASCII)
						// Collect the rest of the string and continue.
						//
						// This is inlined handling of 'case self::STATE_PRE_COLLECT'
						// scenario for a string.
						$this->preCollectCurrentLine[] = substr( $token, 1 );
					}
				} elseif ( TokenUtils::isSolTransparent( $env, $token ) ) { // continue watching
					$this->solTransparentTokens[] = $token;
				} else {
					$ret = $this->processPre( $token );
					$this->moveToIgnoreState();
				}
				break;
		}

		$env->log( 'debug/pre', $this->pipelineId, 'saved :', $this->tokens );
		$env->log( 'debug/pre', $this->pipelineId, '---->  ',
			static function () use ( $ret ) {
				return PHPUtils::jsonEncode( $ret );
			}
		);

		return new TokenHandlerResult( $ret );
	}
}
