<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Wt2Html\PegTokenizer;
use Wikimedia\Parsoid\Wt2Html\TokenTransformManager;

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
class TokenStreamPatcher extends TokenHandler {
	/** @var PegTokenizer */
	private $tokenizer;

	/** @var int */
	private $srcOffset;

	/** @var bool */
	private $sol;

	/** @var array */
	private $tokenBuf;

	/** @var int */
	private $wikiTableNesting;

	/** @var Token|null */
	private $lastConvertedTableCellToken;

	/**
	 * @var TemplateHandler
	 * A local instance needed to process magic words
	 */
	private $templateHandler;

	/**
	 * @param TokenTransformManager $manager
	 * @param array $options
	 */
	public function __construct( TokenTransformManager $manager, array $options ) {
		$newOptions = [ 'tsp' => true ] + $options;
		parent::__construct( $manager, $newOptions );
		$this->tokenizer = new PegTokenizer( $this->env );
		$this->templateHandler = new TemplateHandler( $manager, $options );
		$this->reset();
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
	public function onNewline( NlTk $token ): ?TokenHandlerResult {
		$this->env->log( 'trace/tsp', $this->pipelineId,
			static function () use ( $token ) {
				return PHPUtils::jsonEncode( $token );
			}
		);
		$this->srcOffset = $token->dataAttribs->tsr->end ?? null;
		$this->sol = true;
		$this->tokenBuf[] = $token;
		return new TokenHandlerResult( [] );
	}

	/**
	 * @inheritDoc
	 */
	public function onEnd( EOFTk $token ): ?TokenHandlerResult {
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
	 * @param int $srcOffset
	 * @param array $toks
	 * @return array
	 */
	private function reprocessTokens( int $srcOffset, array $toks ): array {
		// Update tsr
		TokenUtils::shiftTokenTSR( $toks, $srcOffset );
		$pipe = $this->env->getPipelineFactory()->getPipeline( "tokens/x-mediawiki" );
		$pipe->init( [
			'frame' => $this->manager->getFrame(),
			'toplevel' => $this->atTopLevel,
			// FIXME: What of the inTemplate/expandTemplate options here?
		] );
		return (array)$pipe->parse( $toks, [] );
	}

	/**
	 * @param Token $token
	 * @return array
	 */
	private function convertTokenToString( Token $token ): array {
		$da = $token->dataAttribs;
		$tsr = $da->tsr ?? null;

		if ( $tsr && $tsr->end > $tsr->start ) {
			// > will only hold if these are valid numbers
			$str = $tsr->substr( $this->manager->getFrame()->getSrcText() );
			// sol === false ensures that the pipe will not be parsed as a <td> again
			$toks = $this->tokenizer->tokenizeSync( $str, [ 'sol' => false ] );
			array_pop( $toks ); // pop EOFTk
			return $this->reprocessTokens( $tsr->start, $toks );
		} elseif ( !empty( $da->autoInsertedStart ) && !empty( $da->autoInsertedEnd ) ) {
			return [ '' ];
		} else {
			// SSS FIXME: What about "!!" and "||"??
			switch ( $token->getName() ) {
				case 'td':
					return [ '|' ];
				case 'th':
					return [ '!' ];
				case 'tr':
					return [ '|-' ];
				case 'caption':
					return [ $token instanceof TagTk ? '|+' : '' ];
				case 'table':
					if ( $token instanceof EndTagTk ) {
						return [ '|}' ];
					}
			}

			// No conversion if we get here
			return [ $token ];
		}
	}

	/**
	 * @inheritDoc
	 */
	public function onAny( $token ): ?TokenHandlerResult {
		$this->env->log( 'trace/tsp', $this->pipelineId,
			static function () use ( $token ) {
				return PHPUtils::jsonEncode( $token );
			} );

		$tokens = [ $token ];
		$tc = TokenUtils::getTokenType( $token );
		switch ( $tc ) {
			case 'string':
				// While we are buffering newlines to suppress them
				// in case we see a category, buffer all intervening
				// white-space as well.
				if ( count( $this->tokenBuf ) > 0 && preg_match( '/^\s*$/D', $token ) ) {
					$this->tokenBuf[] = $token;
					return new TokenHandlerResult( [] );
				}

				// TRICK #1:
				// Attempt to match "{|" after a newline and convert
				// it to a table token.
				if ( $this->sol ) {
					if ( $this->atTopLevel && str_starts_with( $token, '{|' ) ) {
						// Reparse string with the 'table_start_tag' rule
						// and fully reprocess them.
						$retoks = $this->tokenizer->tokenizeAs( $token, 'table_start_tag', /* sol */true );
						if ( $retoks === false ) {
							// XXX: The string begins with table start syntax,
							// we really shouldn't be here.  Anything else on the
							// line would get swallowed up as attributes.
							$this->env->log( 'error', 'Failed to tokenize table start tag.' );
							$this->clearSOL();
						} else {
							$tokens = $this->reprocessTokens( $this->srcOffset, $retoks );
							$this->wikiTableNesting++;
							$this->lastConvertedTableCellToken = null;
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

			case 'CommentTk':
				// Comments don't change SOL state
				// Update srcOffset
				$this->srcOffset = $token->dataAttribs->tsr->end ?? null;
				break;

			case 'SelfclosingTagTk':
				if ( $token->getName() === 'meta' && ( $token->dataAttribs->stx ?? '' ) !== 'html' ) {
					$this->srcOffset = $token->dataAttribs->tsr->end ?? null;
					if (
						count( $this->tokenBuf ) > 0 &&
						TokenUtils::hasTypeOf( $token, 'mw:Transclusion' )
					) {
						// If we have buffered newlines, we might very well encounter
						// a category link, so continue buffering.
						$this->tokenBuf[] = $token;
						return new TokenHandlerResult( [] );
					}
				} elseif ( $token->getName() === 'link' &&
					$token->getAttribute( 'rel' ) === 'mw:PageProp/Category'
				) {
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

			case 'TagTk':
				if ( $this->atTopLevel && !TokenUtils::isHTMLTag( $token ) ) {
					if ( $token->getName() === 'table' ) {
						$this->lastConvertedTableCellToken = null;
						$this->wikiTableNesting++;
					} elseif (
						in_array(
							$token->getName(),
							[ 'td', 'th', 'tr', 'caption' ],
							true
						)
					) {
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

			case 'EndTagTk':
				if ( $this->atTopLevel && !TokenUtils::isHTMLTag( $token ) ) {
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
		return new TokenHandlerResult( $tokens );
	}
}
