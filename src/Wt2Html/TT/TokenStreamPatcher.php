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
	/**
	 * This buffers whitespace, nls, and rendering-transparent tokens
	 * like category link tags.
	 */
	private array $nlWsMetaTokenBuf;
	private int $wikiTableNesting;
	/** True only for top-level & attribute value pipelines */
	private bool $inIndependentParse;
	private ?array $tplInfo;
	private ?array $trReparseBuf;

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
		$this->nlWsMetaTokenBuf = [];
		$this->wikiTableNesting = 0;
		$this->tplInfo = null;
		$this->trReparseBuf = null;
	}

	private function getResultTokens( array $ret ): array {
		// Emit buffered newlines (and a transclusion meta-token, if any)
		if ( count( $this->nlWsMetaTokenBuf ) > 0 ) {
			$ret = array_merge( $this->nlWsMetaTokenBuf, $ret );
			$this->nlWsMetaTokenBuf = [];
		}
		return $ret;
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
		if ( $this->trReparseBuf ) {
			$ret = $this->processTrReparseBuf( $token );
			$this->trReparseBuf = null;
		} else {
			$ret = [];
		}
		// These need to be after reprocessing to ensure
		// we always end up in the correct state after.
		$this->srcOffset = $token->dataParsoid->tsr->end ?? null;
		$this->sol = true;
		$this->nlWsMetaTokenBuf[] = $token;
		$this->env->trace( 'tsp', $this->pipelineId, " ---> ", $ret );
		return $ret;
	}

	/**
	 * @inheritDoc
	 */
	public function onEnd( EOFTk $token ): ?array {
		if ( $this->trReparseBuf ) {
			$ret = $this->processTrReparseBuf();
			$this->trReparseBuf = null;
		} else {
			$ret = [];
		}
		PHPUtils::pushArray( $ret, $this->onAny( $token ) );
		$this->reset();
		$this->env->trace( 'tsp', $this->pipelineId, " ---> ", $ret );
		return $ret;
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
		?int $srcOffset, string $str, bool $sol, ?string $startRule = null, ?array $pipelineOpts = []
	): array {
		$toks = (array)PipelineUtils::processContentInPipeline(
			$this->env,
			$this->manager->getFrame(),
			$str,
			[
				'pipelineType' => 'wikitext-to-expanded-tokens',
				'pipelineOpts' => $pipelineOpts,
				'sol' => $sol,
				'startRule' => $startRule,
				// processTrReparseBuf gets us here from a top-level content pipeline,
				// but the content itself came from a template. In that situation, the
				// pipeline isn't processing top-level content, and isn't at 'toplevel'.
				'toplevel' => $this->atTopLevel && !isset( $pipelineOpts['inTemplate'] ),
				'srcText' => $str,
				'srcOffsets' => new SourceRange( 0, strlen( $str ) ),
			]
		);
		TokenUtils::shiftTokenTSR( $toks, $srcOffset );
		TokenUtils::stripEOFTkFromTokens( $toks );
		return $toks;
	}

	private function reprocessTrReparseBufViaOnAny(): array {
		// Reset state for reprocessing
		$this->tplInfo = $this->trReparseBuf['trTplInfo'];
		$this->clearSOL();
		// Pop tr & reset trReparseBuf -- we don't want to repopulate trReparseBuf!
		$tokens = $this->trReparseBuf['tokens'];
		$ret = $this->nlWsMetaTokenBuf;
		$ret[] = array_shift( $tokens );
		$this->nlWsMetaTokenBuf = [];
		$this->trReparseBuf = null;

		// Reprocess the rest
		$this->env->trace( 'tsp', $this->pipelineId, "*** START REPROCESSING BUFFER VIA ONANY ***" );
		// @phan-suppress-next-line PhanTypeSuspiciousNonTraversableForeach
		foreach ( $tokens as $tok ) {
			$res = $this->onAnyInternal( $tok );
			if ( $res ) {
				PHPUtils::pushArray( $ret, $res );
			}
		}
		$this->env->trace( 'tsp', $this->pipelineId, "*** END REPROCESSING BUFFER ***" );
		return $ret;
	}

	/**
	 * If $nlTk is null, this is EOF scenario
	 */
	private function processTrReparseBuf( ?NlTk $nlTk = null ): array {
		if ( !isset( $this->trReparseBuf['endMeta'] ) ) {
			return $this->reprocessTrReparseBufViaOnAny();
		}

		// We have to parse these buffered tokens as attribute of the <tr>
		if ( $this->tplInfo !== null ) {
			// FIXME: Cannot reliably support this when we need to
			// glue part of this unclosed template's content into
			// the <tr>'s attributes that came from a different template.
			//
			// So, bail and let things be as is.
			return $this->reprocessTrReparseBufViaOnAny();
		}

		$frameSrc = $this->manager->getFrame()->getSrcText();

		// Both these TSR properties will exist because they come from
		// the top-level content and the tokenizer sets TSR offsets.
		$tr = $this->trReparseBuf['tr'];
		$endMeta = $this->trReparseBuf['endMeta'];
		$metaEndTSR = $endMeta->dataParsoid->tsr->end;
		$lineEndTSR = $nlTk ? $nlTk->dataParsoid->tsr->start : strlen( $frameSrc );

		// Stitch new wikitext to include content found after template-end-meta
		$extraAttrSrc = substr( $frameSrc, $metaEndTSR, $lineEndTSR - $metaEndTSR );
		if ( !$extraAttrSrc ) {
			return $this->reprocessTrReparseBufViaOnAny();
		}

		$toks = $this->trReparseBuf['tokens'];
		$this->env->trace( 'tsp', $this->pipelineId,
			static function () use ( $toks ) {
				return "*** REPROCESSING TR WITH TOKENS ***" .
					PHPUtils::jsonEncode( $toks );
			}
		);

		$freshSrc = ( $tr->dataParsoid->startTagSrc ?? '|-' ) .
			( $tr->dataParsoid->getTemp()->attrSrc ?? '' ) .
			$extraAttrSrc;

		// This string effectively came from a template, so tag it as 'inTemplate'
		$newTRTokens = $this->reprocessTokens(
			null, $freshSrc, true, "table_row_tag", [ 'inTemplate' => true ]
		);
		// Remove mw:ExpandedAttributes info since this is already
		// embedded inside an outer template wrapper.
		$newTR = $newTRTokens[0];
		$newTR->removeAttribute( 'typeof' );
		$newTR->removeAttribute( 'about' );
		$newTR->dataMw = null;

		// Drop the original TR from the buffered tokens
		array_shift( $this->trReparseBuf['tokens'] );

		// * Tokens between tr & endMeta have to be trailing comments or WS
		//   because anything else would have been tokenized by the grammar
		//   as the tr's attributes.
		// * All tokens after this have been absorbed into $tr's attributes
		$newTRTokens[] = $endMeta;

		// Update endMeta TSR since it now wraps the entire line
		$endMeta->dataParsoid->tsr->end = $lineEndTSR;
		return $this->getResultTokens( $newTRTokens );
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
			// Ensure we always clean up 'atStart' even
			// in the presence of exceptions.
			if ( $this->tplInfo && $this->tplInfo['startMeta'] !== $token ) {
				$this->tplInfo['atStart'] = false;
			}
		}
	}

	/**
	 * @param string|Token $token
	 * @return ?array<string|Token>
	 */
	public function onAnyInternal( $token ): ?array {
		$abortedTrReparse = false;
		if ( $this->trReparseBuf !== null ) {
			if ( $token instanceof XMLTagTk &&
				in_array( $token->getName(), [ 'td', 'th', 'tr', 'caption', 'table' ], true )
			) {
				// Abort token gluing if we encounter a table tag. This effectively
				// implies that we are missing a newline in the token stream.
				// This can happen because we lost a newline during preprocessing.
				// Ex: {{1x|1=\nx\n}} strips the newlines.
				$tokens = $this->reprocessTrReparseBufViaOnAny();
				$abortedTrReparse = true;
			} elseif ( $token instanceof SelfclosingTagTk &&
				TokenUtils::hasTypeOf( $token, 'mw:Includes/IncludeOnly' )
			) {
				// includeonly directives should be entirely skipped and
				// make everything messy if they include "\n" internally.
				// So, we abort tr-reprocessing support if we encounter them.
				$tokens = $this->reprocessTrReparseBufViaOnAny();
				$abortedTrReparse = true;
			} else {
				if ( $token instanceof SelfclosingTagTk ) {
					if ( TokenUtils::hasTypeOf( $token, 'mw:Transclusion/End' ) ) {
						if ( !isset( $this->trReparseBuf['endMeta'] ) ) {
							$this->trReparseBuf['endMeta'] = $token;
						}
						$this->tplInfo = null;
					} elseif ( TokenUtils::hasTypeOf( $token, 'mw:Transclusion' ) ) {
						$this->tplInfo = [ 'startMeta' => $token, 'atStart' => true ];
					}
				}
				// Buffer and return.
				// The buffer will be reprocessed when a NlTk is encountered.
				$this->trReparseBuf['tokens'][] = $token;
				return [];
			}
		} else {
			$tokens = [];
		}

		$this->env->trace( 'tsp', $this->pipelineId,
			function () use ( $token ) {
				return "(indep=" . ( $this->inIndependentParse ? "yes" : "no " ) .
					";sol=" . ( $this->sol ? "yes" : "no " ) . ') ' .
					PHPUtils::jsonEncode( $token );
			}
		);

		$tokens[] = $token;
		switch ( true ) {
			case is_string( $token ):
				// While we are buffering newlines to suppress them
				// in case we see a category, buffer all intervening
				// white-space as well.
				if ( count( $this->nlWsMetaTokenBuf ) > 0 && preg_match( '/^\s*$/D', $token ) ) {
					$this->nlWsMetaTokenBuf[] = $token;
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
					( $this->tplInfo['atStart'] ?? false ) &&
					preg_match( '/^(?:{\\||[:;#*])/', $token )
				) {
					// Add a newline & force SOL
					$T2529hack = true;
					// Remove newline insertion in the core preprocessor
					// only occurs if we weren't already at the start of
					// the line (see discussion in ::onNewline() above).
					if ( !$this->sol ) {
						$this->nlWsMetaTokenBuf[] = new NlTk( null );
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
					$this->srcOffset = $token->dataParsoid->tsr->end ?? null;
					if ( TokenUtils::hasTypeOf( $token, 'mw:Transclusion' ) ) {
						$this->tplInfo = [ 'startMeta' => $token, 'atStart' => true ];
						if ( count( $this->nlWsMetaTokenBuf ) > 0 ) {
							// If we have buffered newlines, we might very well encounter
							// a category link, so continue buffering.
							$this->nlWsMetaTokenBuf[] = $token;
							return [];
						}
					} elseif ( TokenUtils::hasTypeOf( $token, 'mw:Transclusion/End' ) ) {
						$this->tplInfo = null;
					}
				} elseif ( TokenUtils::isSolTransparentLinkTag( $token ) ) {
					// Replace buffered newline & whitespace tokens with EmptyLineTk tokens.
					// This tunnels them through the rest of the transformations
					// without affecting them. During HTML building, they are expanded
					// back to newlines / whitespace.
					$n = count( $this->nlWsMetaTokenBuf );
					if ( $n > 0 ) {
						$i = 0;
						while ( $i < $n &&
							!( $this->nlWsMetaTokenBuf[$i] instanceof SelfclosingTagTk )
						) {
							$i++;
						}

						$toks = [
							new EmptyLineTk( array_slice( $this->nlWsMetaTokenBuf, 0, $i ) )
						];
						if ( $i < $n ) {
							$toks[] = $this->nlWsMetaTokenBuf[$i];
							if ( $i + 1 < $n ) {
								$toks[] = new EmptyLineTk( array_slice( $this->nlWsMetaTokenBuf, $i + 1 ) );
							}
						}
						$tokens = array_merge( $toks, $tokens );
						$this->nlWsMetaTokenBuf = [];
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
						} elseif ( $this->tplInfo && $tokenName === 'tr' ) {
							// We may have to reparse attributes of this <tr>.
							// So, track relevant info.
							$this->trReparseBuf = [
								'tr' => $token,
								'trTplInfo' => $this->tplInfo,
								'tokens' => [ $token ]
							];
							if ( $abortedTrReparse ) {
								// If we have tokens from a previous trReparseBuf that was
								// aborted and reprocessed above, we need to emit them now.
								// So, dont return []. But, pop the $tr we are buffering above.
								array_pop( $tokens );
							} else {
								return [];
							}
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
						$tokens = $this->convertNonHTMLTokenToString( $token );
					}
				}
				$this->clearSOL();
				break;

			default:
				break;
		}

		$tokens = $this->getResultTokens( $tokens );
		$this->env->trace( 'tsp', $this->pipelineId, " ---> ", $tokens );
		return $tokens;
	}
}
