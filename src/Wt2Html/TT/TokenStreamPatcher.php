<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * This class is an attempt to fixup the token stream to reparse strings
 * as tokens that failed to parse in the tokenizer because of sol or
 * other constraints OR because tags were being constructed in pieces
 * or whatever.
 *
 * This is a pure hack to improve compatibility with the PHP parser
 * given that we dont have a preprocessor.  This will be a grab-bag of
 * heuristics and tricks to handle different scenarios.
 * @module
 */

namespace Parsoid;

use Parsoid\PegTokenizer as PegTokenizer;
use Parsoid\TemplateHandler as TemplateHandler;
use Parsoid\TokenUtils as TokenUtils;

use Parsoid\KV as KV;
use Parsoid\TagTk as TagTk;
use Parsoid\EndTagTk as EndTagTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;
use Parsoid\CommentTk as CommentTk;

/**
 * @class
 * @extends module:wt2html/tt/TemplateHandler~TemplateHandler
 */
class TokenStreamPatcher extends TemplateHandler {

	public function __construct( $manager, $options ) {
		parent::__construct( $manager, Object::assign( [ 'tsp' => true ], $options ) );
		$this->tokenizer = new PegTokenizer( $this->env );
		$this->reset();
	}
	public $tokenizer;

	public function reset() {
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

	public function onNewline( $token ) {
		$this->manager->env->log( 'trace/tsp', $this->manager->pipelineId, function () { return json_encode( $token );
  } );
		$this->srcOffset = ( $token->dataAttribs->tsr || [ null, null ] )[ 1 ];
		$this->sol = true;
		$this->tokenBuf[] = $token;
		return [ 'tokens' => [] ];
	}

	public function onEnd( $token ) {
		$res = $this->onAny( $token );
		$this->reset();
		return $res;
	}

	public function clearSOL() {
		// clear tsr and sol flag
		$this->srcOffset = null;
		$this->sol = false;
	}

	public function _convertTokenToString( $token ) {
		$da = $token->dataAttribs;
		$tsr = ( $da ) ? $da->tsr : null;

		if ( $tsr && $tsr[ 1 ] > $tsr[ 0 ] ) {
			// > will only hold if these are valid numbers
			$str = substr( $this->manager->env->page->src, $tsr[ 0 ], $tsr[ 1 ]/*CHECK THIS*/ );
			// sol === false ensures that the pipe will not be parsed as a <td> again
			$toks = $this->tokenizer->tokenizeSync( $str, [ 'sol' => false ] );
			array_pop( $toks ); // pop EOFTk
			// Update tsr
			TokenUtils::shiftTokenTSR( $toks, $tsr[ 0 ] );

			$ret = [];
			for ( $i = 0;  $i < count( $toks );  $i++ ) {
				$t = $toks[ $i ];
				if ( !$t ) {
					continue;
				}

				// Reprocess magic words to completion.
				// FIXME: This doesn't handle any templates that got retokenized.
				// That requires processing this whole thing in a tokens/x-mediawiki
				// pipeline which is not possible right now because TSP runs in the
				// synchronous 3rd phase. So, not tackling that in this patch.
				// This has been broken for the longest time and feels similar to
				// https://gerrit.wikimedia.org/r/#/c/105018/
				// All of these need uniform handling. To be addressed separately
				// if this proves to be a real problem on production pages.
				if ( $t->constructor === SelfclosingTagTk::class && $t->name === 'template' ) {
					$t = call_user_func( [ TemplateHandler::prototype, 'processSpecialMagicWord' ], $t ) || $t;
				}
				$ret = $ret->concat( $t );
			}
			return $ret;
		} elseif ( $da->autoInsertedStart && $da->autoInsertedEnd ) {
			return [ '' ];
		} else {
			// SSS FIXME: What about "!!" and "||"??
			switch ( $token->name ) {
				case 'td':
				return [ '|' ];
				case 'th':
				return [ '!' ];
				case 'tr':
				return [ '|-' ];
				case 'caption':
				return [ ( $token->constructor === TagTk::class ) ? '|+' : '' ];
				case 'table':
				if ( $token->constructor === EndTagTk::class ) {
					return [ '|}' ];
				}
			}

			// No conversion if we get here
			return [ $token ];
		}
	}

	public function onAny( $token ) {
		$this->manager->env->log( 'trace/tsp', $this->manager->pipelineId, function () { return json_encode( $token );
  } );

		$tokens = [ $token ];
		switch ( $token->constructor ) {
			case $String:
			// While we are buffering newlines to suppress them
			// in case we see a category, buffer all intervening
			// white-space as well.
			if ( count( $this->tokenBuf ) > 0 && preg_match( '/^\s*$/', $token ) ) {
				$this->tokenBuf[] = $token;
				return [ 'tokens' => [] ];
			}

			// TRICK #1:
			// Attempt to match "{|" after a newline and convert
			// it to a table token.
			if ( $this->sol ) {
				if ( $this->atTopLevel && preg_match( '/^\{\|/', $token ) ) {
					// Reparse string with the 'table_start_tag' rule
					// and shift tsr of result tokens by source offset
					$retoks = $this->tokenizer->tokenizeAs( $token, 'table_start_tag', /* sol */true );
					if ( $retoks instanceof $Error ) {
						// XXX: The string begins with table start syntax,
						// we really shouldn't be here.  Anything else on the
						// line would get swallowed up as attributes.
						$this->manager->env->log( 'error', 'Failed to tokenize table start tag.' );
						$this->clearSOL();
					} else {
						TokenUtils::shiftTokenTSR( $retoks, $this->srcOffset, true );
						$tokens = $retoks;
						$this->wikiTableNesting++;
						$this->lastConvertedTableCellToken = null;
					}
				} elseif ( preg_match( '/^\s*$/', $token ) ) {
					// White-space doesn't change SOL state
					// Update srcOffset
					$this->srcOffset += count( $token );
				} else {
					$this->clearSOL();
				}
			} else {
				$this->clearSOL();
			}
			break;

			case CommentTk::class:
			// Comments don't change SOL state
			// Update srcOffset
			$this->srcOffset = ( $token->dataAttribs->tsr || [ null, null ] )[ 1 ];
			break;

			case SelfclosingTagTk::class:
			if ( $token->name === 'meta' && $token->dataAttribs->stx !== 'html' ) {
				$this->srcOffset = ( $token->dataAttribs->tsr || [ null, null ] )[ 1 ];
				$typeOf = $token->getAttribute( 'typeof' );
				if ( $typeOf === 'mw:TSRMarker' && $this->lastConvertedTableCellToken !== null
&& $this->lastConvertedTableCellToken->name === $token->getAttribute( 'data-etag' )
				) {
					// Swallow the token and clear the marker
					$this->lastConvertedTableCellToken = null;
					return [ 'tokens' => [] ];
				} elseif ( count( $this->tokenBuf ) > 0 && $typeOf === 'mw:Transclusion' ) {
					// If we have buffered newlines, we might very well encounter
					// a category link, so continue buffering.
					$this->tokenBuf[] = $token;
					return [ 'tokens' => [] ];
				}
			} elseif ( $token->name === 'link'
&& $token->getAttribute( 'rel' ) === 'mw:PageProp/Category'
			) {
				// Replace buffered newline & whitespace tokens with mw:EmptyLine
				// meta-tokens. This tunnels them through the rest of the transformations
				// without affecting them. During HTML building, they are expanded
				// back to newlines / whitespace.
				$n = count( $this->tokenBuf );
				if ( $n > 0 ) {
					$i = 0;
					while ( $i < $n && $this->tokenBuf[ $i ]->constructor !== SelfclosingTagTk::class ) {
						$i++;
					}

					$toks = [
						new SelfclosingTagTk( 'meta',
							[ new KV( 'typeof', 'mw:EmptyLine' ) ], [
								'tokens' => array_slice( $this->tokenBuf, 0, $i/*CHECK THIS*/ )
							]
						)
					];
					if ( $i < $n ) {
						$toks[] = $this->tokenBuf[ $i ];
						if ( $i + 1 < $n ) {
							$toks[] = new SelfclosingTagTk( 'meta',
								[ new KV( 'typeof', 'mw:EmptyLine' ) ], [
									'tokens' => array_slice( $this->tokenBuf, $i + 1 )
								]
							);
						}
					}
					$tokens = $toks->concat( $tokens );
					$this->tokenBuf = [];
				}
				$this->clearSOL();
			} else {
				$this->clearSOL();
			}
			break;

			case TagTk::class:
			if ( $this->atTopLevel && !TokenUtils::isHTMLTag( $token ) ) {
				if ( $token->name === 'table' ) {
					$this->lastConvertedTableCellToken = null;
					$this->wikiTableNesting++;
				} elseif ( array_search( $token->name, [ 'td', 'th', 'tr', 'caption' ] ) !== -1 ) {
					if ( $this->wikiTableNesting === 0 ) {
						if ( $token->name === 'td' || $token->name === 'th' ) {
							$this->lastConvertedTableCellToken = $token;
						}
						$tokens = $this->_convertTokenToString( $token );
					} else {
						$this->lastConvertedTableCellToken = null;
					}
				}
			}
			$this->clearSOL();
			break;

			case EndTagTk::class:
			if ( $this->atTopLevel && !TokenUtils::isHTMLTag( $token ) ) {
				if ( $this->wikiTableNesting > 0 ) {
					if ( $token->name === 'table' ) {
						$this->lastConvertedTableCellToken = null;
						$this->wikiTableNesting--;
					}
				} elseif ( $token->name === 'table' || $token->name === 'caption' ) {
					// Convert this to "|}"
					$tokens = $this->_convertTokenToString( $token );
				}
			}
			$this->clearSOL();
			break;

			default:
			break;
		}

		// Emit buffered newlines (and a transclusion meta-token, if any)
		if ( count( $this->tokenBuf ) > 0 ) {
			$tokens = $this->tokenBuf->concat( $tokens );
			$this->tokenBuf = [];
		}
		return [ 'tokens' => $tokens ];
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->TokenStreamPatcher = $TokenStreamPatcher;
}
