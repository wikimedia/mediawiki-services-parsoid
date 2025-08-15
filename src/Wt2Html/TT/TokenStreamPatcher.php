<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\EmptyLineTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;
use Wikimedia\WikiPEG\SyntaxError;

/**
 * This class is an attempt to fixup the token stream to reparse strings
 * as tokens that failed to parse in the tokenizer because of SOL or
 * other constraints OR because tags were being constructed in pieces
 * or whatever.
 *
 * This is a pure hack to improve compatibility with the core parser
 * given that we dont have a preprocessor.  This will be a grab-bag of
 * heuristics and tricks to handle different scenarios.
 */
class TokenStreamPatcher extends LineBasedHandler {
	private ?int $srcOffset;
	private bool $sol;
	private array $tokenBuf;
	private int $wikiTableNesting;
	/** True only for top-level & attribute value pipelines */
	private bool $inIndependentParse;
	private ?SelfclosingTagTk $tplStartToken = null;

	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		$newOptions = [ 'tsp' => true ] + $options;
		parent::__construct( $manager, $newOptions );
		$this->reset();
	}

	/**
	 * Resets any internal state for this token handler.
	 *
	 * @param array $options
	 */
	public function resetState( array $options ): void {
		parent::resetState( $options );
		$this->inIndependentParse = $this->atTopLevel
			// Attribute expansion is effectively its own document context
			|| isset( $this->options['attrExpansion'] )
			// Ext-tag processing is effectively its own document context
			|| isset( $this->options['extTag'] );
	}

	private function reset(): void {
		$this->srcOffset = 0;
		$this->sol = true;
		$this->tokenBuf = [];
		$this->wikiTableNesting = 0;
	}

	/**
	 * @inheritDoc
	 */
	public function onNewline( NlTk $token ): ?array {
		$this->env->trace( 'tsp', $this->pipelineId,
			function () use ( $token ) {
				return "(indep=" . ( $this->inIndependentParse ? "yes" : "no " ) .
					";sol=" . ( $this->sol ? "yes" : "no " ) . ') ' .
					PHPUtils::jsonEncode( $token );
			}
		);
		$this->srcOffset = $token->dataParsoid->tsr->end ?? null;
		$this->tokenBuf[] = $token;
		$this->sol = true;
		return [];
	}

	/**
	 * @inheritDoc
	 */
	public function onEnd( EOFTk $token ): ?array {
		$res = $this->onAny( $token );
		$this->reset();
		$this->env->trace( 'tsp', $this->pipelineId, " ---> ", $res );
		return $res;
	}

	/**
	 * Clear start of line info
	 */
	private function clearSOL(): void {
		// clear tsr and sol flag
		$this->srcOffset = null;
		$this->sol = false;
	}

	/**
	 * Reprocess source to tokens as they would be entering the
	 * TokenStreamPatcher, ie. expanded to the end of stage 2
	 */
	private function reprocessTokens(
		?int $srcOffset, string $str, bool $sol, ?string $startRule = null
	): array {
		$toks = (array)PipelineUtils::processContentInPipeline(
			$this->env,
			$this->manager->getFrame(),
			$str,
			[
				'pipelineType' => 'wikitext-to-expanded-tokens',
				'pipelineOpts' => [],
				'sol' => $sol,
				'startRule' => $startRule,
				'toplevel' => $this->atTopLevel,
				'srcText' => $str,
				'srcOffsets' => new SourceRange( 0, strlen( $str ) ),
			]
		);
		TokenUtils::shiftTokenTSR( $toks, $srcOffset );
		TokenUtils::stripEOFTkFromTokens( $toks );
		return $toks;
	}

	/**
	 * @return array<string|Token>
	 */
	private function convertNonHTMLTokenToString( Token $token ): array {
		$dp = $token->dataParsoid;
		$tsr = $dp->tsr ?? null;

		if ( $tsr && $tsr->end > $tsr->start ) {
			// > will only hold if these are valid numbers
			$str = $tsr->substr( $this->manager->getFrame()->getSrcText() );
			// sol === false ensures that the pipe will not be parsed as a <td>/listItem again
			return $this->reprocessTokens( $tsr->start, $str, false );
		} elseif ( !empty( $dp->autoInsertedStart ) && !empty( $dp->autoInsertedEnd ) ) {
			return [ '' ];
		} else {
			$tokenName = ( $token instanceof XMLTagTk ) ? $token->getName() : '';
			if ( $tokenName === 'listItem' ) {
				return [ implode( '', $token->getAttributeV( 'bullets' ) ) ];
			} elseif ( !in_array( $tokenName, [ 'table', 'caption', 'tr', 'td', 'th' ], true ) ) {
				return [ $token ];
			}

			// Only table tags from here on
			$buf = $dp->startTagSrc ?? null;
			if ( !$buf ) {
				switch ( $tokenName ) {
					case 'td':
						$buf = ( $dp->stx ?? '' ) === 'row' ? '||' : '|';
						break;
					case 'th':
						$buf = ( $dp->stx ?? '' ) === 'row' ? '!!' : '!';
						break;
					case 'tr':
						$buf = '|-';
						break;
					case 'caption':
						$buf = $token instanceof TagTk ? '|+' : '';
						break;
					case 'table':
						if ( $token instanceof EndTagTk ) {
							// Won't have attributes. Bail early!
							return [ '|}' ];
						}
						$buf = '{|';
						break;
				}
			}

			// Extract attributes
			$needsRetokenization = false;
			$cellAttrSrc = $dp->getTemp()->attrSrc ?? null;
			if ( $cellAttrSrc ) {
				// Copied from TableFixups::convertAttribsToContent
				if ( preg_match( "#['[{<]#", $cellAttrSrc ) ) {
					$needsRetokenization = true;
				}
				$buf .= $cellAttrSrc;
				if ( in_array( $tokenName, [ 'caption', 'td', 'th' ], true ) ) {
					$buf .= '|';
				}
			}

			if ( $needsRetokenization ) {
				// sol === false ensures that the pipe will not be parsed as td/th/tr/table/caption
				return $this->reprocessTokens( $tsr->start ?? $this->srcOffset, $buf, false );
			} else {
				return [ $buf ];
			}
		}
	}

	/**
	 * @inheritDoc
	 */
	public function onAny( $token ): ?array {
		try {
			return $this->onAnyInternal( $token );
		} finally {
			// Ensure we always clean up tplStartToken even
			// in the presence of exceptions.
			if ( $this->tplStartToken !== $token ) {
				$this->tplStartToken = null;
			}
		}
	}

	/**
	 * @param string|Token $token
	 * @return ?array<string|Token>
	 */
	public function onAnyInternal( $token ): ?array {
		$this->env->trace( 'tsp', $this->pipelineId,
			function () use ( $token ) {
				return "(indep=" . ( $this->inIndependentParse ? "yes" : "no " ) .
					";sol=" . ( $this->sol ? "yes" : "no " ) . ') ' .
					PHPUtils::jsonEncode( $token );
			}
		);

		$tokens = [ $token ];

		switch ( true ) {
			case is_string( $token ):
				// While we are buffering newlines to suppress them
				// in case we see a category, buffer all intervening
				// white-space as well.
				if ( count( $this->tokenBuf ) > 0 && preg_match( '/^\s*$/D', $token ) ) {
					$this->tokenBuf[] = $token;
					return [];
				}

				// This is only applicable where we use Parsoid's (broken) native preprocessor.
				// This supports scenarios like "{{1x|*bar}}". When "{{{1}}}" is tokenized
				// "*bar" isn't available and so won't become a list.
				// FIXME: {{1x|1===foo==}} will still be broken. So, this fix below is somewhat
				// independent of T2529 for our broken preprocessor but we are restricting the
				// fix to T2529.
				$T2529hack = false;
				if ( $this->env->nativeTemplateExpansionEnabled() &&
					$this->tplStartToken &&
					preg_match( '/^(?:{\\||[:;#*])/', $token )
				) {
					// Add a newline & force SOL
					$T2529hack = true;
					// Remove newline insertion in the core preprocessor
					// only occurs if we weren't already at the start of
					// the line (see discussion in ::onNewline() above).
					if ( !$this->sol ) {
						$this->tokenBuf[] = new NlTk( null );
						$this->sol = true;
					}
				}

				if ( $this->sol ) {
					// Attempt to match "{|" after a newline and convert
					// it to a table token.
					if ( $this->inIndependentParse && str_starts_with( $token, '{|' ) ) {
						// Reparse string with the 'table_start_tag' rule
						// and fully reprocess them.
						try {
							$tokens = $this->reprocessTokens( $this->srcOffset, $token, true, 'table_start_tag' );
							$this->wikiTableNesting++;
						} catch ( SyntaxError ) {
							// XXX: The string begins with table start syntax,
							// we really shouldn't be here. Anything else on the
							// line would get swallowed up as attributes.
							$this->env->log( 'error', 'Failed to tokenize table start tag.' );
							$this->clearSOL();
						}
					} elseif ( $this->inIndependentParse && $T2529hack ) { // {| has been handled above
						try {
							$tokens = $this->reprocessTokens( $this->srcOffset, $token, true, 'list_item' );
						} catch ( SyntaxError ) {
							$this->env->log( 'error', 'Failed to tokenize list item.' );
							$this->clearSOL();
						}
					} elseif ( preg_match( '/^\s*$/D', $token ) ) {
						// White-space doesn't change SOL state
						// Update srcOffset
						$this->srcOffset += strlen( $token );
					} else {
						$this->clearSOL();
					}
				} else {
					$this->clearSOL();
				}
				break;

			case $token instanceof CommentTk:
			case $token instanceof EmptyLineTk:
				// Comments / EmptyLines don't change SOL state
				// Update srcOffset
				$this->srcOffset = $token->dataParsoid->tsr->end ?? null;
				break;

			case $token instanceof SelfclosingTagTk:
				if ( $token->getName() === 'meta' && ( $token->dataParsoid->stx ?? '' ) !== 'html' ) {
					if ( TokenUtils::hasTypeOf( $token, 'mw:Transclusion' ) ) {
						$this->tplStartToken = $token;
					}
					$this->srcOffset = $token->dataParsoid->tsr->end ?? null;
					if ( count( $this->tokenBuf ) > 0 &&
						TokenUtils::hasTypeOf( $token, 'mw:Transclusion' )
					) {
						// If we have buffered newlines, we might very well encounter
						// a category link, so continue buffering.
						$this->tokenBuf[] = $token;
						return [];
					}
				} elseif ( TokenUtils::isSolTransparentLinkTag( $token ) ) {
					// Replace buffered newline & whitespace tokens with EmptyLineTk tokens.
					// This tunnels them through the rest of the transformations
					// without affecting them. During HTML building, they are expanded
					// back to newlines / whitespace.
					$n = count( $this->tokenBuf );
					if ( $n > 0 ) {
						$i = 0;
						while ( $i < $n &&
							!( $this->tokenBuf[$i] instanceof SelfclosingTagTk )
						) {
							$i++;
						}

						$toks = [
							new EmptyLineTk( array_slice( $this->tokenBuf, 0, $i ) )
						];
						if ( $i < $n ) {
							$toks[] = $this->tokenBuf[$i];
							if ( $i + 1 < $n ) {
								$toks[] = new EmptyLineTk( array_slice( $this->tokenBuf, $i + 1 ) );
							}
						}
						$tokens = array_merge( $toks, $tokens );
						$this->tokenBuf = [];
					}
					$this->clearSOL();
				} else {
					$this->clearSOL();
				}
				break;

			case $token instanceof TagTk:
				if ( $this->inIndependentParse && !TokenUtils::isHTMLTag( $token ) ) {
					$tokenName = $token->getName();
					if ( $tokenName === 'listItem' && isset( $this->options['attrExpansion'] ) ) {
						// Convert list items back to bullet wikitext in attribute context
						$tokens = $this->convertNonHTMLTokenToString( $token );
					} elseif ( $tokenName === 'table' ) {
						$this->wikiTableNesting++;
					} elseif ( in_array( $tokenName, [ 'td', 'th', 'tr', 'caption' ], true ) ) {
						if ( $this->wikiTableNesting === 0 ) {
							$tokens = $this->convertNonHTMLTokenToString( $token );
						}
					}
				}
				$this->clearSOL();
				break;

			case $token instanceof EndTagTk:
				if ( $this->inIndependentParse && !TokenUtils::isHTMLTag( $token ) ) {
					if ( $this->wikiTableNesting > 0 ) {
						if ( $token->getName() === 'table' ) {
							$this->wikiTableNesting--;
						}
					} elseif ( $token->getName() === 'table' || $token->getName() === 'caption' ) {
						// Convert this to "|}"
						$tokens = $this->convertNonHTMLTokenToString( $token );
					}
				}
				$this->clearSOL();
				break;

			default:
				break;
		}

		// Emit buffered newlines (and a transclusion meta-token, if any)
		if ( count( $this->tokenBuf ) > 0 ) {
			$tokens = array_merge( $this->tokenBuf, $tokens );
			$this->tokenBuf = [];
		}

		$this->env->trace( 'tsp', $this->pipelineId, " ---> ", $tokens );
		return $tokens;
	}
}
