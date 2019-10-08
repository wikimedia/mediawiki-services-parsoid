<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\TT;

use Parsoid\Tokens\CommentTk;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\EndTagTk;
use Parsoid\Tokens\NlTk;
use Parsoid\Tokens\SelfclosingTagTk;
use Parsoid\Tokens\TagTk;
use Parsoid\Tokens\Token;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\TokenUtils;
use Parsoid\Wt2Html\TokenTransformManager;

/**
 * Insert paragraph tags where needed -- smartly and carefully
 * -- there is much fun to be had mimicking "wikitext visual newlines"
 * behavior as implemented by the PHP parser.
 */
class ParagraphWrapper extends TokenHandler {
	/** @var bool */
	private $inPre;

	/** @var bool */
	private $hasOpenPTag;

	/** @var bool */
	private $inBlockElem;

	/** @var array */
	private $tokenBuffer;

	/** @var array */
	private $nlWsTokens;

	/** @var int */
	private $newLineCount;

	/** @var array */
	private $currLine;

	/** @var array */
	private static $wgBlockElems = null;

	/** @var array */
	private static $wgAntiBlockElems = null;

	/** @var array */
	private static $wgAlwaysSuppress = null;

	/** @var array */
	private static $wgNeverSuppress = null;

	/**
	 * Constructor for paragraph wrapper.
	 * @param TokenTransformManager $manager manager enviroment
	 * @param array $options various configuration options
	 */
	public function __construct( TokenTransformManager $manager, array $options ) {
		parent::__construct( $manager, $options );
		$this->inPre = false;
		$this->hasOpenPTag = false;
		$this->inBlockElem = false;
		$this->tokenBuffer = [];
		$this->nlWsTokens = [];
		$this->newLineCount = 0;
		$this->currLine = null;

		// These are defined in the php parser's `BlockLevelPass`
		if ( is_null( self::$wgBlockElems ) ) {
			self::$wgBlockElems = PHPUtils::makeSet( [ 'table', 'h1', 'h2', 'h3', 'h4',
			'h5', 'h6', 'pre', 'p', 'ul', 'ol', 'dl' ] );
			self::$wgAntiBlockElems = PHPUtils::makeSet( [ 'td', 'th' ] );
			self::$wgAlwaysSuppress = PHPUtils::makeSet( [ 'tr', 'dt', 'dd', 'li' ] );
			self::$wgNeverSuppress = PHPUtils::makeSet( [ 'center', 'blockquote', 'div', 'hr', 'figure' ] );
		}

		// Disable p-wrapper
		$this->disabled = !empty( $this->options['inlineContext'] )
			|| !empty( $this->options['inPHPBlock'] );
		$this->reset();
	}

	/**
	 * @inheritDoc
	 */
	public function onNewline( NlTk $token ) {
		return $this->inPre ? $token : $this->onNewLineOrEOF( $token );
	}

	/**
	 * @inheritDoc
	 */
	public function onEnd( EOFTk $token ) {
		return $this->onNewLineOrEOF( $token );
	}

	/**
	 * Reset the token buffer and related info
	 * This is the ordering of buffered tokens and how they should get emitted:
	 *
	 * token-buffer         (from previous lines if newLineCount > 0)
	 * newline-ws-tokens    (buffered nl+sol-transparent tokens since last non-nl-token)
	 * current-line-tokens  (all tokens after newline-ws-tokens)
	 *
	 * newline-token-count is > 0 only when we encounter multiple "empty lines".
	 *
	 * Periodically, when it is clear where an open/close p-tag is required, the buffers
	 * are collapsed and emitted. Wherever tokens are buffered/emitted, verify that this
	 *  order is preserved.
	 */
	private function reset(): void {
		$this->resetBuffers();
		$this->resetCurrLine();
		$this->hasOpenPTag = false;
		$this->inPre = false;
		// NOTE: This flag is the local equivalent of what we're mimicking with
		// the inPHPBlock pipeline option.
		$this->inBlockElem = false;
	}

	/**
	 * Reset the token buffer and new line info
	 *
	 */
	private function resetBuffers(): void {
		$this->tokenBuffer = [];
		$this->nlWsTokens = [];
		$this->newLineCount = 0;
	}

	/**
	 * Reset the current line info
	 *
	 */
	private function resetCurrLine(): void {
		if ( $this->currLine && ( $this->currLine['openMatch'] || $this->currLine['closeMatch'] ) ) {
			$this->inBlockElem = !$this->currLine['closeMatch'];
		}
		$this->currLine = [
			'tokens' => [],
			'hasWrappableTokens' => false,
			// These flags, along with `inBlockElem` are concepts from the
			// php parser's `BlockLevelPass`.
			'openMatch' => false,
			'closeMatch' => false
		];
	}

	/**
	 * Process the current buffer contents and token provided
	 *
	 * @param Token|string $token token
	 * @param bool $flushCurrentLine option to flush current line or preserve it
	 * @return array
	 */
	private function processBuffers( $token, bool $flushCurrentLine ): array {
		$res = $this->processPendingNLs();
		$this->currLine['tokens'][] = $token;
		if ( $flushCurrentLine ) {
			$res = array_merge( $res, $this->currLine['tokens'] );
			$this->resetCurrLine();
		}
		$this->env->log( 'trace/p-wrap', $this->manager->pipelineId, '---->  ', function () use( $res ) {
			return PHPUtils::jsonEncode( $res );
		} );
		return $res;
	}

	/**
	 * Process and flush existing buffer contents
	 *
	 * @return array
	 */
	private function flushBuffers(): array {
		// Assertion to catch bugs in p-wrapping; both cannot be true.
		if ( $this->newLineCount > 0 ) {
			$this->manager->env->log( 'error/p-wrap', 'Failed assertion in flushBuffers: newline-count:',
			$this->newLineCount, '; buffered tokens: ', PHPUtils::jsonEncode( $this->nlWsTokens ) );
		}
		$resToks = array_merge( $this->tokenBuffer, $this->nlWsTokens );
		$this->resetBuffers();
		$this->env->log( 'trace/p-wrap', $this->manager->pipelineId, '---->  ',
			function () use( $resToks ) {
			return PHPUtils::jsonEncode( $resToks );
		 } );
		return $resToks;
	}

	/**
	 * Discare a newline token from buffer
	 *
	 * @param array &$out array to process and update
	 * @return Token|string
	 */
	public function discardOneNlTk( array &$out ) {
		$i = 0;
		$n = count( $this->nlWsTokens );
		while ( $i < $n ) {
			$t = array_shift( $this->nlWsTokens );
			if ( $t instanceof NlTk ) {
				return $t;
			} else {
				$out[] = $t;
			}
			$i++;
		}

		// FIXME: We should return null and fix callers
		return "";
	}

	/**
	 * Search for the opening paragraph tag
	 *
	 * @param array &$out array to process and update
	 */
	private function openPTag( array &$out ): void {
		if ( !$this->hasOpenPTag ) {
			$tplStartIndex = -1;
			// Be careful not to expand template ranges unnecessarily.
			// Look for open markers before starting a p-tag.
			$countOut = count( $out );
			for ( $i = 0; $i < $countOut; $i++ ) {
				$t = $out[$i];
				if ( !is_string( $t ) && $t->getName() === 'meta' ) {
					$typeOf = $t->getAttribute( 'typeof' ) ?? '';
					if ( preg_match( '/^mw:Transclusion$/D', $typeOf ) ) {
						// We hit a start tag and everything before it is sol-transparent.
						$tplStartIndex = $i;
						continue;
					} elseif ( preg_match( '/^mw:Transclusion/', $typeOf ) ) {
						// End tag. All tokens before this are sol-transparent.
						// Let us leave them all out of the p-wrapping.
						$tplStartIndex = -1;
						continue;
					}
				}
				// Not a transclusion meta; Check for nl/sol-transparent tokens
				// and leave them out of the p-wrapping.
				if ( !TokenUtils::isSolTransparent( $this->env, $t ) && !$t instanceof NlTk ) {
					break;
				}
			}
			if ( $tplStartIndex > -1 ) {
				$i = $tplStartIndex;
			}
			array_splice( $out, $i, 0, [ new TagTk( 'p' ) ] );
			$this->hasOpenPTag = true;
		}
	}

	/**
	 * Search for the closing paragraph tag
	 *
	 * @param array &$out array to process and update
	 */
	private function closeOpenPTag( array &$out ): void {
		if ( $this->hasOpenPTag ) {
			$tplEndIndex = -1;
			// Be careful not to expand template ranges unnecessarily.
			// Look for open markers before closing.
			for ( $i = count( $out ) - 1; $i > -1; $i-- ) {
				$t = $out[$i];
				if ( !is_string( $t ) && $t->getName() === 'meta' ) {
					$typeOf = $t->getAttribute( 'typeof' ) ?? '';
					if ( preg_match( '/^mw:Transclusion$/D', $typeOf ) ) {
						// We hit a start tag and everything after it is sol-transparent.
						// Don't include the sol-transparent tags OR the start tag.
						$tplEndIndex = -1;
						continue;
					} elseif ( preg_match( '/^mw:Transclusion/', $typeOf ) ) {
						// End tag. The rest of the tags past this are sol-transparent.
						// Let us leave them all out of the p-wrapping.
						$tplEndIndex = $i;
						continue;
					}
				}
				// Not a transclusion meta; Check for nl/sol-transparent tokens
				// and leave them out of the p-wrapping.
				if ( !TokenUtils::isSolTransparent( $this->env, $t ) && !$t instanceof NlTk ) {
					break;
				}
			}
			if ( $tplEndIndex > -1 ) {
				$i = $tplEndIndex;
			}
			array_splice( $out, $i + 1, 0, [ new EndTagTk( 'p' ) ] );
			$this->hasOpenPTag = false;
		}
	}

	/**
	 * Handle newline tokens
	 *
	 * @param Token $token token
	 * @return array
	 */
	private function onNewLineOrEOF( Token $token ): array {
		$this->manager->env->log( 'trace/p-wrap', $this->manager->pipelineId, 'NL    |',
			function () use( $token ) {
			return PHPUtils::jsonEncode( $token );
		 } );
		$l = $this->currLine;
		if ( $this->currLine['openMatch'] || $this->currLine['closeMatch'] ) {
			$this->closeOpenPTag( $l['tokens'] );
		} elseif ( !$this->inBlockElem && !$this->hasOpenPTag && $l['hasWrappableTokens'] ) {;
			$this->openPTag( $l['tokens'] );
		}

		// Assertion to catch bugs in p-wrapping; both cannot be true.
		if ( $this->newLineCount > 0 && count( $l['tokens'] ) > 0 ) {
			$this->env->log( 'error/p-wrap', 'Failed assertion in onNewLineOrEOF: newline-count:',
			$this->newLineCount, '; current line tokens: ', PHPUtils::jsonEncode( $l['tokens'] ) );
		}

		$this->tokenBuffer = array_merge( $this->tokenBuffer, $l['tokens'] );

		if ( $token instanceof EOFTk ) {
			$this->nlWsTokens[] = $token;
			$this->closeOpenPTag( $this->tokenBuffer );
			$res = $this->processPendingNLs();
			$this->reset();
			$this->env->log( 'trace/p-wrap', $this->manager->pipelineId, '---->  ', function () use( $res ) {
				return PHPUtils::jsonEncode( $res );
			} );
			return [ 'tokens' => $res, 'skipOnAny' => true ];
		} else {
			$this->resetCurrLine();
			$this->newLineCount++;
			$this->nlWsTokens[] = $token;
			return [ 'tokens' => [] ];
		}
	}

	/**
	 * Process pending newlines
	 *
	 * @return array
	 */
	private function processPendingNLs(): array {
		$resToks = $this->tokenBuffer;
		$newLineCount = $this->newLineCount;
		$nlTk = null;

		$this->manager->env->log( 'trace/p-wrap', $this->manager->pipelineId, '        NL-count: ',
			$newLineCount );

		if ( $newLineCount >= 2 && !$this->inBlockElem ) {
			$this->closeOpenPTag( $resToks );

			// First is emitted as a literal newline
			$resToks[] = $this->discardOneNlTk( $resToks );
			$newLineCount -= 1;

			$remainder = $newLineCount % 2;

			while ( $newLineCount > 0 ) {
				$nlTk = $this->discardOneNlTk( $resToks );
				if ( $newLineCount % 2 === $remainder ) {
					if ( $this->hasOpenPTag ) {
						$resToks[] = new EndTagTk( 'p' );
						$this->hasOpenPTag = false;
					}
					if ( $newLineCount > 1 ) {
						$resToks[] = new TagTk( 'p' );
						$this->hasOpenPTag = true;
					}
				} else {
					$resToks[] = new SelfclosingTagTk( 'br' );
				}
				$resToks[] = $nlTk;
				$newLineCount -= 1;
			}
		}

		if ( $this->currLine['openMatch'] || $this->currLine['closeMatch'] ) {
			$this->closeOpenPTag( $resToks );
			if ( $newLineCount === 1 ) {
				$resToks[] = $this->discardOneNlTk( $resToks );
			}
		}

		// Gather remaining ws and nl tokens

		$resToks = array_merge( $resToks, $this->nlWsTokens );

		// reset buffers
		$this->resetBuffers();

		return $resToks;
	}

	/**
	 * @inheritDoc
	 */
	public function onAny( $token ): array {
		$this->manager->env->log( 'trace/p-wrap', $this->manager->pipelineId, 'ANY   |',
			function () use( $token ) {
			return PHPUtils::jsonEncode( $token );
		 } );
		$res = null;
		if ( $token instanceof TagTk && $token->getName() === 'pre'
			 && !TokenUtils::isHTMLTag( $token )
		) {
			if ( $this->inBlockElem ) {
				$this->currLine['tokens'][] = ' ';
				return [ 'tokens' => [] ];
			} else {
				$this->inPre = true;
				// This will put us `inBlockElem`, so we need the extra `!inPre`
				// condition below.  Presumably, we couldn't have entered
				// `inBlockElem` while being `inPre`.  Alternatively, we could say
				// that index-pre is "never suppressing" and set the `closeMatch`
				// flag.  The point of all this is that we want to close any open
				// p-tags.
				$this->currLine['openMatch'] = true;
				// skip ensures this doesn't hit the AnyHandler
				return [ 'tokens' => $this->processBuffers( $token, true ), 'skipOnAny' => true ];
			}
		} elseif ( $token instanceof EndTagTk && $token->getName() === 'pre' &&
			!TokenUtils::isHTMLTag( $token )
		) {
			if ( $this->inBlockElem && !$this->inPre ) {
				// No pre-tokens inside block tags -- swallow it.
				return [ 'tokens' => [] ];
			} else {
				if ( $this->inPre ) {
					$this->inPre = false;
				}
				$this->currLine['closeMatch'] = true;
				$this->env->log( 'trace/p-wrap', $this->manager->pipelineId, '---->  ',
					function () use( $token ) {
					return PHPUtils::jsonEncode( $token );
				 } );
				$res = [ $token ];
				// skip ensures this doesn't hit the AnyHandler
				return [ 'tokens' => $res, 'skipOnAny' => true ];
			}
		} elseif ( $token instanceof EOFTk || $this->inPre ) {
			$this->env->log( 'trace/p-wrap', $this->manager->pipelineId, '---->  ',
				function () use( $token ) {
					return PHPUtils::jsonEncode( $token );
				}
			 );
			$res = [ $token ];
			// skip ensures this doesn't hit the AnyHandler
			return [ 'tokens' => $res, 'skipOnAny' => true ];
		} elseif ( $token instanceof CommentTk
			|| is_string( $token ) && preg_match( '/^[\t ]*$/D', $token )
			|| TokenUtils::isEmptyLineMetaToken( $token )
		) {
			if ( $this->newLineCount === 0 ) {
				$this->currLine['tokens'][] = $token;
				// Since we have no pending newlines to trip us up,
				// no need to buffer -- just flush everything
				return [ 'tokens' => $this->flushBuffers(), 'skipOnAny' => true ];
			} else {
				// We are in buffering mode waiting till we are ready to
				// process pending newlines.
				$this->nlWsTokens[] = $token;
				return [ 'tokens' => [] ];
			}
		} elseif ( !is_string( $token ) &&
			// T186965: <style> behaves similarly to sol transparent tokens in
			// that it doesn't open/close paragraphs, but also doesn't induce
			// a new paragraph by itself.
			( TokenUtils::isSolTransparent( $this->env, $token ) || $token->getName() === 'style' )
		) {
			if ( $this->newLineCount === 0 ) {
				$this->currLine['tokens'][] = $token;
				// Since we have no pending newlines to trip us up,
				// no need to buffer -- just flush everything
				return [ 'tokens' => $this->flushBuffers(), 'skipOnAny' => true ];
			} elseif ( $this->newLineCount === 1 ) {
				// Swallow newline, whitespace, comments, and the current line
				$this->tokenBuffer = array_merge( $this->tokenBuffer, $this->nlWsTokens );
				$this->tokenBuffer = array_merge( $this->tokenBuffer, $this->currLine['tokens'] );
				$this->newLineCount = 0;
				$this->nlWsTokens = [];
				$this->resetCurrLine();

				// But, don't process the new token yet.
				$this->currLine['tokens'][] = $token;
				return [ 'tokens' => [] ];
			} else {
				return [ 'tokens' => $this->processBuffers( $token, false ), 'skipOnAny' => true ];
			}
		} else {
			if ( !is_string( $token ) ) {
				$name = $token->getName();
				if ( ( isset( self::$wgBlockElems[$name] ) && !$token instanceof EndTagTk ) ||
					( isset( self::$wgAntiBlockElems[$name] ) && $token instanceof EndTagTk ) ||
					isset( self::$wgAlwaysSuppress[$name] ) ) {
					$this->currLine['openMatch'] = true;
				}
				if ( ( isset( self::$wgBlockElems[$name] ) && $token instanceof EndTagTk ) ||
					( isset( self::$wgAntiBlockElems[$name] ) && !$token instanceof EndTagTk ) ||
					isset( self::$wgNeverSuppress[$name] ) ) {
					$this->currLine['closeMatch'] = true;
				}
			}
			$this->currLine['hasWrappableTokens'] = true;
			return [ 'tokens' => $this->processBuffers( $token, false ), 'skipOnAny' => true ];
		}
	}
}
