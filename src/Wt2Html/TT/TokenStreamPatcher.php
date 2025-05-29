<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Wt2Html\PegTokenizer;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

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
	private PegTokenizer $tokenizer;
	private ?int $srcOffset;
	private bool $sol;
	private array $tokenBuf;
	private int $wikiTableNesting;
	/** True only for top-level & attribute value pipelines */
	private bool $inIndependentParse;
	private ?Token $lastConvertedTableCellToken;
	private ?SelfclosingTagTk $tplStartToken = null;

	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		$newOptions = [ 'tsp' => true ] + $options;
		parent::__construct( $manager, $newOptions );
		$this->tokenizer = new PegTokenizer( $this->env );
		$this->reset();
	}

	/**
	 * Resets any internal state for this token handler.
	 *
	 * @param array $options
	 */
	public function resetState( array $options ): void {
		parent::resetState( $options );
		$this->inIndependentParse = $this->atTopLevel || isset( $this->options['attrExpansion'] );
	}

	private function reset() {
		$this->srcOffset = 0;
		$this->sol = true;
		$this->tokenBuf = [];
		$this->wikiTableNesting = 0;
		// This marker tries to track the most recent table-cell token (td/th)
		// that was converted to string. For those, we want to get rid
		// of their corresponding mw:TSRMarker meta tag.
		//
		// This marker is set when we convert a td/th token to string
		//
		// This marker is cleared in one of the following scenarios:
		// 1. When we clear a mw:TSRMarker corresponding to the token set earlier
		// 2. When we change table nesting
		// 3. When we hit a tr/td/th/caption token that wasn't converted to string
		$this->lastConvertedTableCellToken = null;
	}

	/**
	 * @inheritDoc
	 */
	public function onNewline( NlTk $token ): ?array {
		$self = $this;
		$this->env->trace( 'tsp', $this->pipelineId,
			static function () use ( $self, $token ) {
				return "(indep=" . ( $self->inIndependentParse ? "yes" : "no " ) .
					";sol=" . ( $self->sol ? "yes" : "no " ) . ') ' .
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
		return $res;
	}

	/**
	 * Clear start of line info
	 */
	private function clearSOL() {
		// clear tsr and sol flag
		$this->srcOffset = null;
		$this->sol = false;
	}

	/**
	 * Fully reprocess the output tokens from the tokenizer through
	 * all the other handlers in stage 2.
	 *
	 * @param int|false $srcOffset See TokenUtils::shiftTokenTSR, which has b/c for null
	 * @param array $toks
	 * @param bool $popEOF
	 * @return array<string|Token>
	 */
	private function reprocessTokens( $srcOffset, array $toks, bool $popEOF = false ): array {
		// Update tsr
		TokenUtils::shiftTokenTSR( $toks, $srcOffset );

		$toks = (array)PipelineUtils::processContentInPipeline(
			$this->env,
			$this->manager->getFrame(),
			$toks,
			[
				'pipelineType' => 'peg-tokens-to-expanded-tokens',
				'pipelineOpts' => [],
				'sol' => true,
				'toplevel' => $this->atTopLevel,
			]
		);

		if ( $popEOF ) {
			array_pop( $toks ); // pop EOFTk
		}
		return $toks;
	}

	/**
	 * @return array<string|Token>
	 */
	private function convertTokenToString( Token $token ): array {
		$da = $token->dataParsoid;
		$tsr = $da->tsr ?? null;

		if ( $tsr && $tsr->end > $tsr->start ) {
			// > will only hold if these are valid numbers
			$str = $tsr->substr( $this->manager->getFrame()->getSrcText() );
			// sol === false ensures that the pipe will not be parsed as a <td>/listItem again
			$toks = $this->tokenizer->tokenizeSync( $str, [ 'sol' => false ] );
			return $this->reprocessTokens( $tsr->start, $toks, true );
		} elseif ( !empty( $da->autoInsertedStart ) && !empty( $da->autoInsertedEnd ) ) {
			return [ '' ];
		} else {
			$tokenName = ( $token instanceof XMLTagTk ) ? $token->getName() : '';
			switch ( $tokenName ) {
				case 'td':
					return [ ( $token->dataParsoid->stx ?? '' ) === 'row' ? '||' : '|' ];
				case 'th':
					return [ ( $token->dataParsoid->stx ?? '' ) === 'row' ? '!!' : '!' ];
				case 'tr':
					return [ '|-' ];
				case 'caption':
					return [ $token instanceof TagTk ? '|+' : '' ];
				case 'table':
					return [ $token instanceof EndTagTk ? '|}' : $token ];
				case 'listItem':
					return [ implode( '', $token->getAttributeV( 'bullets' ) ) ];
			}

			return [ $token ];
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
		$self = $this;
		$this->env->trace( 'tsp', $this->pipelineId,
			static function () use ( $self, $token ) {
				return "(indep=" . ( $self->inIndependentParse ? "yes" : "no " ) .
					";sol=" . ( $self->sol ? "yes" : "no " ) . ') ' .
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
						$retoks = $this->tokenizer->tokenizeAs( $token, 'table_start_tag', /* sol */true );
						if ( $retoks === false ) {
							// XXX: The string begins with table start syntax,
							// we really shouldn't be here. Anything else on the
							// line would get swallowed up as attributes.
							$this->env->log( 'error', 'Failed to tokenize table start tag.' );
							$this->clearSOL();
						} else {
							$tokens = $this->reprocessTokens( $this->srcOffset, $retoks );
							$this->wikiTableNesting++;
							$this->lastConvertedTableCellToken = null;
						}
					} elseif ( $this->inIndependentParse && $T2529hack ) { // {| has been handled above
						$retoks = $this->tokenizer->tokenizeAs( $token, 'list_item', /* sol */true );
						if ( $retoks === false ) {
							$this->env->log( 'error', 'Failed to tokenize list item.' );
							$this->clearSOL();
						} else {
							$tokens = $this->reprocessTokens( $this->srcOffset, $retoks );
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
				// Comments don't change SOL state
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
					// Replace buffered newline & whitespace tokens with mw:EmptyLine
					// meta-tokens. This tunnels them through the rest of the transformations
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

						$dp = new DataParsoid;
						$dp->tokens = array_slice( $this->tokenBuf, 0, $i );
						$toks = [
							new SelfclosingTagTk( 'meta',
								[ new KV( 'typeof', 'mw:EmptyLine' ) ],
								$dp
							)
						];
						if ( $i < $n ) {
							$toks[] = $this->tokenBuf[$i];
							if ( $i + 1 < $n ) {
								$dp = new DataParsoid;
								$dp->tokens = array_slice( $this->tokenBuf, $i + 1 );
								$toks[] = new SelfclosingTagTk( 'meta',
									[ new KV( 'typeof', 'mw:EmptyLine' ) ],
									$dp
								);
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
						$tokens = $this->convertTokenToString( $token );
					} elseif ( $tokenName === 'table' ) {
						$this->lastConvertedTableCellToken = null;
						$this->wikiTableNesting++;
					} elseif ( in_array( $tokenName, [ 'td', 'th', 'tr', 'caption' ], true ) ) {
						if ( $this->wikiTableNesting === 0 ) {
							if ( $token->getName() === 'td' || $token->getName() === 'th' ) {
								$this->lastConvertedTableCellToken = $token;
							}
							$tokens = $this->convertTokenToString( $token );
						} else {
							$this->lastConvertedTableCellToken = null;
						}
					}
				}
				$this->clearSOL();
				break;

			case $token instanceof EndTagTk:
				if ( $this->inIndependentParse && !TokenUtils::isHTMLTag( $token ) ) {
					if ( $this->wikiTableNesting > 0 ) {
						if ( $token->getName() === 'table' ) {
							$this->lastConvertedTableCellToken = null;
							$this->wikiTableNesting--;
						}
					} elseif ( $token->getName() === 'table' || $token->getName() === 'caption' ) {
						// Convert this to "|}"
						$tokens = $this->convertTokenToString( $token );
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

		return $tokens;
	}
}
