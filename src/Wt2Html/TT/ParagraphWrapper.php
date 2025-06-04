<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Assert\Assert;
use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\IndentPreTk;
use Wikimedia\Parsoid\Tokens\ListTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Wikitext\Consts;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

/**
 * Insert paragraph tags where needed -- smartly and carefully
 * -- there is much fun to be had mimicking "wikitext visual newlines"
 * behavior as implemented by the PHP parser.
 */
class ParagraphWrapper extends LineBasedHandler {

	private bool $hasOpenPTag = false;
	private bool $inBlockElem = false;
	private bool $inBlockquote = false;

	private array $tokenBuffer = [];
	private array $nlWsTokens = [];
	private int $newLineCount = 0;

	private array $currLineTokens = [];
	private bool $currLineHasWrappableTokens = false;
	private bool $currLineBlockTagSeen = false;
	private bool $currLineBlockTagOpen = false;

	/**
	 * Constructor for paragraph wrapper.
	 * @param TokenHandlerPipeline $manager manager enviroment
	 * @param array $options various configuration options
	 */
	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
		// Disable p-wrapper
		$this->disabled = !empty( $this->options['inlineContext'] );
		$this->reset();
	}

	/**
	 * @inheritDoc
	 */
	public function onNewline( NlTk $token ): ?array {
		return $this->onNewlineOrEOF( $token );
	}

	/**
	 * @inheritDoc
	 */
	public function onEnd( EOFTk $token ): ?array {
		return $this->onNewlineOrEOF( $token );
	}

	/**
	 * Pass through the tokens unchanged.
	 *
	 * @inheritDoc
	 */
	public function onCompoundTk( CompoundTk $ctk, TokenHandler $tokensHandler ): ?array {
		if ( $ctk instanceof ListTk || $ctk instanceof IndentPreTk ) {
			return null;
		} else {
			throw new UnreachableException(
				"ParagraphWrapper: Unsupported compound token."
			);
		}
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
		// NOTE: This flag is the local equivalent of what we're mimicking with
		// the 'inlineContext' pipeline option.
		$this->inBlockElem = false;
		$this->inBlockquote = false;
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
		if ( $this->currLineBlockTagSeen ) {
			$this->inBlockElem = $this->currLineBlockTagOpen;
		}
		$this->currLineTokens = [];
		$this->currLineHasWrappableTokens = false;
		$this->currLineBlockTagSeen = false;
		$this->currLineBlockTagOpen = false;
	}

	/**
	 * Process the current buffer contents and token provided
	 *
	 * @param Token|string $token token
	 * @param bool $flushCurrentLine option to flush current line or preserve it
	 * @return array<string|Token>
	 */
	private function processBuffers( $token, bool $flushCurrentLine ): array {
		$res = $this->processPendingNLs();
		$this->currLineTokens[] = $token;
		if ( $flushCurrentLine ) {
			PHPUtils::pushArray( $res, $this->currLineTokens );
			$this->resetCurrLine();
		}
		$this->env->trace( 'p-wrap', $this->pipelineId, '---->  ', $res );
		return $res;
	}

	/**
	 * Process and flush existing buffer contents
	 *
	 * @param Token|string $token token
	 * @return array<string|Token>
	 */
	private function flushBuffers( $token ): array {
		Assert::invariant( $this->newLineCount === 0, "PWrap: Trying to flush buffers with pending newlines" );

		$this->currLineTokens[] = $token;
		// Juggle the array reference count to allow us to append to it without
		// copying the array
		$resToks = $this->tokenBuffer;
		$nlWsTokens = $this->nlWsTokens;
		$this->resetBuffers();
		PHPUtils::pushArray( $resToks, $nlWsTokens );
		$this->env->trace( 'p-wrap', $this->pipelineId, '---->  ', $resToks );
		return $resToks;
	}

	/**
	 * Append tokens from the newline/whitespace buffer to the output array
	 * until a newline is encountered. Increment the offset reference. Return
	 * the newline token.
	 *
	 * @param array &$out array to append to
	 * @param int &$offset The offset reference to update
	 * @return NlTk
	 */
	public function processOneNlTk( array &$out, &$offset ) {
		$n = count( $this->nlWsTokens );
		while ( $offset < $n ) {
			$t = $this->nlWsTokens[$offset++];
			if ( $t instanceof NlTk ) {
				return $t;
			} else {
				$out[] = $t;
			}
		}
		throw new UnreachableException( 'nlWsTokens was expected to contain an NlTk.' );
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
				if ( ( $t instanceof XMLTagTk ) && $t->getName() === 'meta' ) {
					if ( TokenUtils::hasTypeOf( $t, 'mw:Transclusion' ) ) {
						// We hit a start tag and everything before it is sol-transparent.
						$tplStartIndex = $i;
						continue;
					} elseif ( TokenUtils::matchTypeOf( $t, '#^mw:Transclusion/#' ) ) {
						// End tag. All tokens before this are sol-transparent.
						// Let us leave them all out of the p-wrapping.
						$tplStartIndex = -1;
						continue;
					} elseif ( TokenUtils::isAnnotationStartToken( $t ) ) {
						break;
					}
				}
				// Not a transclusion meta; Check for nl/sol-transparent tokens
				// and leave them out of the p-wrapping.
				if ( !TokenUtils::isSolTransparent( $this->env, $t ) && !( $t instanceof NlTk ) ) {
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
				if ( ( $t instanceof XMLTagTk ) && $t->getName() === 'meta' ) {
					if ( TokenUtils::hasTypeOf( $t, 'mw:Transclusion' ) ) {
						// We hit a start tag and everything after it is sol-transparent.
						// Don't include the sol-transparent tags OR the start tag.
						$tplEndIndex = -1;
						continue;
					} elseif ( TokenUtils::matchTypeOf( $t, '#^mw:Transclusion/#' ) ) {
						// End tag. The rest of the tags past this are sol-transparent.
						// Let us leave them all out of the p-wrapping.
						$tplEndIndex = $i;
						continue;
					} elseif ( TokenUtils::isAnnotationEndToken( $t ) ) {
						break;
					}
				}
				// Not a transclusion meta; Check for nl/sol-transparent tokens
				// and leave them out of the p-wrapping.
				if ( !TokenUtils::isSolTransparent( $this->env, $t ) && !( $t instanceof NlTk ) ) {
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
	 * @return array<string|Token>
	 */
	private function onNewlineOrEOF( Token $token ): array {
		$this->env->trace( 'p-wrap', $this->pipelineId, 'NL    |', $token );
		if ( $this->currLineBlockTagSeen ) {
			$this->closeOpenPTag( $this->currLineTokens );
		} elseif ( !$this->inBlockElem && !$this->hasOpenPTag && $this->currLineHasWrappableTokens ) {
			$this->openPTag( $this->currLineTokens );
		}

		// Assertion to catch bugs in p-wrapping; both cannot be true.
		if ( $this->newLineCount > 0 && count( $this->currLineTokens ) > 0 ) {
			$this->env->log( 'error/p-wrap', 'Failed assertion in onNewlineOrEOF: newline-count:',
				$this->newLineCount, '; current line tokens: ', $this->currLineTokens );
		}

		PHPUtils::pushArray( $this->tokenBuffer, $this->currLineTokens );

		if ( $token instanceof EOFTk ) {
			$this->nlWsTokens[] = $token;
			$this->closeOpenPTag( $this->tokenBuffer );
			$res = $this->processPendingNLs();
			$this->reset();
			$this->env->trace( 'p-wrap', $this->pipelineId, '---->  ', $res );
			return $res;
		} else {
			$this->resetCurrLine();
			$this->newLineCount++;
			$this->nlWsTokens[] = $token;
			return [];
		}
	}

	/**
	 * Process pending newlines
	 *
	 * @return array<string|Token>
	 */
	private function processPendingNLs(): array {
		$resToks = $this->tokenBuffer;
		$newLineCount = $this->newLineCount;
		$nlOffset = 0;

		$this->env->trace( 'p-wrap', $this->pipelineId, '        NL-count:', $newLineCount );

		if ( $newLineCount >= 2 && !$this->inBlockElem ) {
			$this->closeOpenPTag( $resToks );

			// First is emitted as a literal newline
			$resToks[] = $this->processOneNlTk( $resToks, $nlOffset );
			$newLineCount -= 1;

			$remainder = $newLineCount % 2;

			while ( $newLineCount > 0 ) {
				$nlTk = $this->processOneNlTk( $resToks, $nlOffset );
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

		if ( $this->currLineBlockTagSeen ) {
			$this->closeOpenPTag( $resToks );
			if ( $newLineCount === 1 ) {
				$resToks[] = $this->processOneNlTk( $resToks, $nlOffset );
			}
		}

		// Gather remaining ws and nl tokens
		for ( $i = $nlOffset; $i < count( $this->nlWsTokens ); $i++ ) {
			$resToks[] = $this->nlWsTokens[$i];
		}

		// reset buffers
		$this->resetBuffers();

		return $resToks;
	}

	private function undoIndentPre( IndentPreTk $ipre ): array {
		$ret = $this->newLineCount === 0 ? $this->flushBuffers( '' ) : [];

		$this->env->trace( 'p-wrap', $this->pipelineId, '---- UNDOING PRE ----' );
		$nestedTokens = $ipre->getNestedTokens();
		$n = count( $nestedTokens );
		$i = 1; // skip the <pre>
		while ( $i < $n ) {
			$token = $nestedTokens[$i];
			if ( PreHandler::isIndentPreWS( $token ) ) {
				$this->nlWsTokens[] = ' ';
			} elseif ( $token instanceof NlTk ) {
				PHPUtils::pushArray( $ret, $this->onNewlineOrEOF( $token ) );
			} elseif ( $token instanceof EndTagTk && $token->getName() === 'pre' ) {
				// Skip </pre>
				// There may be other tokens after this in cases where
				// tags are unbalanced in the input.
			} else {
				PHPUtils::pushArray( $ret, $this->onAny( $token ) );
			}

			$i++;
		}

		$this->env->trace( 'p-wrap', $this->pipelineId, '---- DONE UNDOING PRE ----' );
		return $ret;
	}

	/**
	 * @inheritDoc
	 */
	public function onAny( $token ): ?array {
		$this->env->trace( 'p-wrap', $this->pipelineId, 'ANY   |', $token );

		if ( is_string( $token ) ||
			$token instanceof CommentTk || TokenUtils::isEmptyLineMetaToken( $token )
		) {
			if ( !is_string( $token ) || preg_match( '/^[\t ]*$/D', $token ) ) {
				if ( $this->newLineCount === 0 ) {
					// Since we have no pending newlines to trip us up,
					// no need to buffer -- just flush everything
					return $this->flushBuffers( $token );
				} else {
					// We are in buffering mode waiting till we are ready to
					// process pending newlines.
					$this->nlWsTokens[] = $token;
					return [];
				}
			}

			$this->currLineHasWrappableTokens = true;
			return $this->processBuffers( $token, false );
		}

		$tokenName = ( $token instanceof XMLTagTk ) ? $token->getName() : '';
		if (
			// T186965: <style> behaves similarly to sol transparent tokens in
			// that it doesn't open/close paragraphs, but also doesn't induce
			// a new paragraph by itself.
			$tokenName === 'style' ||
			TokenUtils::isSolTransparent( $this->env, $token )
		) {
			if ( $this->newLineCount === 0 ) {
				// Since we have no pending newlines to trip us up,
				// no need to buffer -- just flush everything
				return $this->flushBuffers( $token );
			} elseif ( $this->newLineCount === 1 ) {
				// Swallow newline, whitespace, comments, and the current line
				PHPUtils::pushArray( $this->tokenBuffer, $this->nlWsTokens );
				PHPUtils::pushArray( $this->tokenBuffer, $this->currLineTokens );
				$this->newLineCount = 0;
				$this->nlWsTokens = [];
				$this->resetCurrLine();

				// But, don't process the new token yet.
				$this->currLineTokens[] = $token;
				return [];
			} else {
				return $this->processBuffers( $token, false );
			}
		}

		// Skip the entire list token - dont process nested tokens
		if ( $token instanceof ListTk ) {
			$this->currLineBlockTagSeen = true;
			return $this->processBuffers( $token, true );
		}

		// Skip the entire indent-pre token - dont process nested tokens
		// But, if nested in blockquote, process specially
		if ( $token instanceof IndentPreTk ) {
			if ( $this->inBlockElem || $this->inBlockquote ) {
				// The state machine in the PreHandler is line based and only suppresses
				// indent-pres when encountering blocks on a line.  However, the legacy
				// parser's `doBlockLevels` has a concept of being "$inBlockElem", which
				// is mimicked here.  Rather than replicate that awareness in both passes,
				// we piggyback on it here to undo indent-pres when they're found to be
				// undesirable.
				return $this->undoIndentPre( $token );
			} else {
				$this->currLineBlockTagSeen = true;
				return $this->processBuffers( $token, true );
			}
		}

		if ( $token instanceof EOFTk ) {
			$this->env->log( 'trace/p-wrap', $this->pipelineId, '---->   ', $token );
			return null;
		}

		if ( isset( Consts::$wikitextBlockElems[$tokenName] ) ) {
			$this->currLineBlockTagSeen = true;
			$this->currLineBlockTagOpen = true;
			if (
				( isset( Consts::$blockElems[$tokenName] ) && $token instanceof EndTagTk ) ||
				( isset( Consts::$antiBlockElems[$tokenName] ) && !$token instanceof EndTagTk ) ||
				isset( Consts::$neverBlockElems[$tokenName] )
			) {
				$this->currLineBlockTagOpen = false;
			}
		}

		if ( $tokenName === 'blockquote' ) {
			$this->inBlockquote = !( $token instanceof EndTagTk );
		}

		$this->currLineHasWrappableTokens = true;
		return $this->processBuffers( $token, false );
	}
}
