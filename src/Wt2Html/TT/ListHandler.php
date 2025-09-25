<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\EmptyLineTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\IndentPreTk;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

/**
 * Create list tag around list items and map wiki bullet levels to html.
 */
class ListHandler extends LineBasedHandler {
	/**
	 * Debug string output of bullet character mappings.
	 * @var array<string,array<string,string>>
	 */
	private static $bullet_chars_map = [
		'*' => [ 'list' => 'ul', 'item' => 'li' ],
		'#' => [ 'list' => 'ol', 'item' => 'li' ],
		';' => [ 'list' => 'dl', 'item' => 'dt' ],
		':' => [ 'list' => 'dl', 'item' => 'dd' ]
	];

	/** @var array<ListFrame> */
	private array $listFrameStack;
	private int $nestedTableCount;
	private bool $inT2529Mode = false;

	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
		$this->reset();
	}

	private bool $haveActiveListFrame = false;

	private function getListFrame(): ListFrame {
		return $this->listFrameStack[count( $this->listFrameStack ) - 1];
	}

	/**
	 * The HTML5 parsing spec says that when encountering a closing tag for a
	 * certain set of open tags we should generate implied ends to list items,
	 * https://html.spec.whatwg.org/multipage/parsing.html#parsing-main-inbody:generate-implied-end-tags-5
	 *
	 * So, in order to roundtrip accurately, we should follow suit.  However,
	 * we choose an ostensible superset of those tags, our wikitext blocks, to
	 * have this behaviour.  Hopefully the differences aren't relevant.
	 *
	 * @param string $tagName
	 * @return bool
	 */
	private function generateImpliedEndTags( string $tagName ): bool {
		return TokenUtils::isWikitextBlockTag( $tagName );
	}

	/**
	 * Resets the list handler
	 */
	private function reset(): void {
		$this->listFrameStack = [];
		$this->onAnyEnabled = false;
		$this->nestedTableCount = 0;
		$this->haveActiveListFrame = false;
	}

	/**
	 * @inheritDoc
	 */
	public function onTag( XMLTagTk $token ): ?array {
		if ( $token->getName() === 'listItem' ) {
			'@phan-var TagTk $token'; // @var TagTk $token
			return $this->onListItem( $token );
		} else {
			return null;
		}
	}

	/**
	 * @inheritDoc
	 */
	public function onCompoundTk( CompoundTk $ctk, TokenHandler $tokensHandler ): ?array {
		if ( $ctk instanceof EmptyLineTk || $ctk instanceof IndentPreTk ) {
			// Nothing to do!
			// IndentPre content / empty lines are of no interest to us
			return null;
		} else {
			throw new UnreachableException(
				"ListHandler: Unsupported compound token."
			);
		}
	}

	/**
	 * @inheritDoc
	 */
	public function onNewline( $token ): ?array {
		$this->env->trace( 'list', $this->pipelineId, 'NEWLINE:', $token );

		if ( !$this->onAnyEnabled ) {
			return null;
		}

		// onAny handler is only active when there's at least one list frame
		// on the stack, even if it is not active
		$listFrame = $this->getListFrame();

		if ( !$this->haveActiveListFrame ) {
			$listFrame->listTk->addToken( $token );
			$this->env->trace( 'list', $this->pipelineId, 'RET[LIST]:', $token );
			return [];
		}

		if ( $listFrame->atEOL ) {
			// Non-list item in newline context
			// ==> close all previous lists and reset frame to null
			return $this->closeLists( $listFrame, $token );
		} else {
			$listFrame->atEOL = true;
			$listFrame->nlTk = $token;
			$listFrame->haveDD = false;
			// php's findColonNoLinks is run in doBlockLevels, which examines
			// the text line-by-line. At nltk, any open tags will cease having
			// an effect.
			$listFrame->numOpenTags = 0;
			return [];
		}
	}

	/**
	 * @inheritDoc
	 */
	public function onAny( $token ): ?array {
		$this->env->trace( 'list', $this->pipelineId, 'ANY:', $token );

		if ( $token instanceof Token && TokenUtils::matchTypeOf( $token, '#^mw:Transclusion$#' ) ) {
			// We are now in T2529 scenario where legacy would have added a newline
			// if it had encountered a list-start character. So, if we encounter
			// a listItem token next, we should first execute the same actions
			// as if we had run onAny on a NlTk (see below).
			$this->inT2529Mode = true;
		} elseif ( !TokenUtils::isSolTransparent( $this->env, $token ) ) {
			$this->inT2529Mode = false;
		}

		// onAny handler is only active when there's at least one list frame
		// on the stack, even if it is not active
		$listFrame = $this->getListFrame();

		if ( !$this->haveActiveListFrame ) {
			// haveActiveListFrame will be false in the onAny handler only when
			// we are in a table that in turn was seen in a list context.
			//
			// Since we are not in a list within the table, nothing to do.
			// Just stuff it in the list token.
			if ( $token instanceof EndTagTk && $token->getName() === 'table' ) {
				if ( $this->nestedTableCount === 0 ) {
					$this->haveActiveListFrame = true;
				} else {
					$this->nestedTableCount--;
				}
			} elseif ( $token instanceof TagTk && $token->getName() === 'table' ) {
				$this->nestedTableCount++;
			}

			$listFrame->listTk->addToken( $token );
			$this->env->trace( 'list', $this->pipelineId, 'RET[LIST]:', $token );
			return [];
		}

		// Keep track of open tags per list frame in order to prevent colons
		// starting lists illegally. Php's findColonNoLinks.
		if ( $token instanceof TagTk
			// Table tokens will push the frame and remain balanced.
			// They're safe to ignore in the bookkeeping.
			&& $token->getName() !== 'table'
		) {
			$listFrame->numOpenTags += 1;
		} elseif ( $token instanceof EndTagTk ) {
			if ( $listFrame->numOpenTags > 0 ) {
				$listFrame->numOpenTags -= 1;
			}

			if ( $token->getName() === 'table' ) {
				// close all open lists and pop a frame
				$ret = $this->closeLists( $listFrame, $token );
				if ( count( $this->listFrameStack ) > 0 ) {
					$this->haveActiveListFrame = true;
				}
				return $ret;
			} elseif ( $this->generateImpliedEndTags( $token->getName() ) ) {
				if ( $listFrame->numOpenBlockTags === 0 ) {
					// Unbalanced closing block tag in a list context
					// ==> close all previous lists and reset frame to null
					return $this->closeLists( $listFrame, $token );
				} else {
					$listFrame->numOpenBlockTags--;
					if ( $listFrame->atEOL ) {
						// Non-list item in newline context
						// ==> close all previous lists and reset frame to null
						return $this->closeLists( $listFrame, $token );
					} else {
						$listFrame->listTk->addToken( $token );
						$this->env->trace( 'list', $this->pipelineId, 'RET[LIST]:', $token );
						return [];
					}
				}
			}

		/* Non-block tag -- fall-through to other tests below */
		}

		if ( $listFrame->atEOL ) {
			if ( TokenUtils::isSolTransparent( $this->env, $token ) ) {
				// Hold on to see where the token stream goes from here
				// - another list item, or
				// - end of list
				if ( $listFrame->nlTk ) {
					$listFrame->solTokens[] = $listFrame->nlTk;
					$listFrame->nlTk = null;
				}
				$listFrame->solTokens[] = $token;
				return [];
			} else {
				// Non-list item in newline context
				// ==> close all previous lists and reset frame to null
				return $this->closeLists( $listFrame, $token );
			}
		}

		if ( $token instanceof TagTk ) {
			if ( $token->getName() === 'table' ) {
				$this->haveActiveListFrame = false;
			} elseif ( $this->generateImpliedEndTags( $token->getName() ) ) {
				$listFrame->numOpenBlockTags++;
			}
		}

		// Nothing else left to do
		$listFrame->listTk->addToken( $token );
		$this->env->trace( 'list', $this->pipelineId, 'RET[LIST]:', $token );
		return [];
	}

	/**
	 * @param array<string|Token> $ret
	 * @return array<string|Token>
	 */
	private function popListFrame( array $ret ): array {
		array_pop( $this->listFrameStack );
		$this->haveActiveListFrame = false;

		if ( count( $this->listFrameStack ) > 0 ) {
			$this->getListFrame()->listTk->addTokens( $ret );
			$this->env->trace( 'list', $this->pipelineId, 'RET[LIST]:', $ret );
			$ret = [];
		} else {
			// Remove onAny transform if we dont have any stashed list frames
			$this->onAnyEnabled = false;
			$this->env->trace( 'list', $this->pipelineId, 'RET:', $ret );
		}

		return $ret;
	}

	/**
	 * @inheritDoc
	 */
	public function onEnd( EOFTk $token ): ?array {
		$this->env->trace( 'list', $this->pipelineId, 'END:', $token );

		if ( $this->haveActiveListFrame ) {
			// EOF goes at the end outside all compound tokens
			// So, don't pass in the token into closeLists
			$toks = $this->closeLists( $this->getListFrame() );
		} else {
			// all lists have been closed and nothing to do on that front
			$toks = [];
		}

		while ( count( $this->listFrameStack ) > 0 ) {
			// $toks should be [] here
			$toks = $this->popListFrame( [ $this->getListFrame()->listTk ] );
		}
		$this->reset();

		$toks[] = $token;
		$this->env->trace( 'list', $this->pipelineId, 'RET: ', $toks );
		return $toks;
	}

	/**
	 * Handle close list processing
	 *
	 * @param ListFrame $listFrame
	 * @param Token|string|null $token
	 * @return array<string|Token>
	 */
	private function closeLists( ListFrame $listFrame, $token = null ): array {
		$this->env->trace( 'list', $this->pipelineId, '----closing all lists----' );

		// pop all open list item tokens onto $listFrame->listTk
		$ret = $listFrame->popTags( count( $listFrame->bstack ) );
		$listFrame->listTk->addTokens( $ret );
		$this->env->trace( 'list', $this->pipelineId, 'RET[LIST]: ', $ret );

		$ret = [ $listFrame->listTk ];
		PHPUtils::pushArray( $ret, $listFrame->solTokens );
		if ( $listFrame->nlTk ) {
			$ret[] = $listFrame->nlTk;
		}
		if ( $token ) {
			$ret[] = $token;
		}

		return $this->popListFrame( $ret );
	}

	/**
	 * Handle a list item
	 * @return ?array<string|Token>
	 */
	private function onListItem( TagTk $token ): ?array {
		if ( $this->inT2529Mode ) {
			// See comment in onAny where this property is set to true
			// The only relevant change is to 'haveDD'.
			if ( $this->haveActiveListFrame ) {
				$this->getListFrame()->haveDD = false;
			}
			$this->inT2529Mode = false;

			// 'atEOL' and NlTk changes don't apply.
			//
			// This might be a divergence, but, I don't think we should
			// close open tags here as in the NlTk case. So, this means that
			// this wikitext ";term: def=foo<b>{{1x|:bar}}</b>"
			// will generate different output in Parsoid & legacy..
			// I believe Parsoid's output is better, but we can comply
			// if we see a real regression for this.
		}

		$this->onAnyEnabled = true;
		$bullets = $token->getAttributeV( 'bullets' );
		if ( $this->haveActiveListFrame ) {
			$listFrame = $this->getListFrame();
			// Ignoring colons inside tags to prevent illegal overlapping.
			// Attempts to mimic findColonNoLinks in the php parser.
			if (
				PHPUtils::lastItem( $bullets ) === ':' &&
				( $listFrame->haveDD || $listFrame->numOpenTags > 0 )
			) {
				$this->env->trace( 'list', $this->pipelineId, 'ANY:', $token );
				$this->env->trace( 'list', $this->pipelineId, 'RET[LIST]: ', ':' );
				$listFrame->listTk->addToken( ':' );
				return [];
			}
		} else {
			$listFrame = new ListFrame;
			$this->listFrameStack[] = $listFrame;
			$this->haveActiveListFrame = true;
		}
		// convert listItem to list and list item tokens
		return $this->doListItem( $listFrame, $bullets, $token );
	}

	/**
	 * Determine the minimum common prefix length
	 */
	private function commonPrefixLength( array $x, array $y ): int {
		$minLength = min( count( $x ), count( $y ) );
		$i = 0;
		for ( ; $i < $minLength; $i++ ) {
			if ( $x[$i] !== $y[$i] ) {
				break;
			}
		}
		return $i;
	}

	/** Check for Dt Dd sequence */
	private static function isDtDd( string $a, string $b ): bool {
		$ab = [ $a, $b ];
		sort( $ab );
		return ( $ab[0] === ':' && $ab[1] === ';' );
	}

	/** Make a new DP that is a slice of a source DP */
	private function makeDP( DataParsoid $sourceDP, int $startOffset, int $endOffset ): DataParsoid {
		$newDP = clone $sourceDP;
		$tsr = $sourceDP->tsr ?? null;
		if ( $tsr ) {
			$newDP->tsr = new SourceRange( $tsr->start + $startOffset, $tsr->start + $endOffset, $tsr->source );
		}
		return $newDP;
	}

	/**
	 * Handle list item processing
	 *
	 * @param ListFrame $listFrame
	 * @param array $bn
	 * @param Token $token
	 * @return array<string|Token>
	 */
	private function doListItem( ListFrame $listFrame, array $bn, Token $token ): array {
		$this->env->trace( 'list', $this->pipelineId, 'BEGIN:', $token );

		$bs = $listFrame->bstack;
		$prefixLen = $this->commonPrefixLength( $bs, $bn );
		$prefix = array_slice( $bn, 0, $prefixLen/*CHECK THIS*/ );
		$tokenDP = $token->dataParsoid;
		$listFrame->bstack = $bn;

		// emit close tag tokens for closed lists
		$this->env->trace(
			'list', $this->pipelineId,
			static function () use ( $bs, $bn ) {
				return '    bs: ' . PHPUtils::jsonEncode( $bs ) . '; bn: ' . PHPUtils::jsonEncode( $bn );
			}
		);

		if ( count( $prefix ) === count( $bs ) && count( $bn ) === count( $bs ) ) {
			$this->env->trace( 'list', $this->pipelineId, '    -> no nesting change' );

			// same list item types and same nesting level
			$itemToken = array_pop( $listFrame->endtags );
			$listFrame->endtags[] = new EndTagTk( $itemToken->getName() );
			$res = array_merge( [ $itemToken ],
				$listFrame->solTokens,
				[
					// this list item gets all the bullets since this is
					// a list item at the same level
					//
					// **a
					// **b
					$listFrame->nlTk ?: '',
					new TagTk( $itemToken->getName(), [], $this->makeDP( $tokenDP, 0, count( $bn ) ) )
				]
			);
		} else {
			$prefixCorrection = 0;
			$tokens = [];
			if ( count( $bs ) > $prefixLen
				&& count( $bn ) > $prefixLen
				&& self::isDtDd( $bs[$prefixLen], $bn[$prefixLen] ) ) {
				/* ------------------------------------------------
				 * Handle dd/dt transitions
				 *
				 * Example:
				 *
				 * **;:: foo
				 * **::: bar
				 *
				 * the 3rd bullet is the dt-dd transition
				 * ------------------------------------------------ */

				$tokens = $listFrame->popTags( count( $bs ) - $prefixLen - 1 );
				$tokens = array_merge( $listFrame->solTokens, $tokens );
				$newName = self::$bullet_chars_map[$bn[$prefixLen]]['item'];
				$endTag = array_pop( $listFrame->endtags );
				if ( $newName === 'dd' ) {
					$listFrame->haveDD = true;
				} elseif ( $newName === 'dt' ) {
					$listFrame->haveDD = false; // reset
				}
				$listFrame->endtags[] = new EndTagTk( $newName );

				if ( isset( $tokenDP->stx ) && $tokenDP->stx === 'row' ) {
					// stx='row' is only set for single-line dt-dd lists (see tokenizer)
					// In this scenario, the dd token we are building a token for has no prefix
					// Ex: ;a:b, *;a:b, #**;a:b, etc. Compare with *;a\n*:b, #**;a\n#**:b
					$this->env->trace( 'list', $this->pipelineId,
						'    -> single-line dt->dd transition' );
					$newTag = new TagTk( $newName, [], $this->makeDP( $tokenDP, 0, 1 ) );
				} else {
					$this->env->trace( 'list', $this->pipelineId, '    -> other dt/dd transition' );
					$newTag = new TagTk( $newName, [], $this->makeDP( $tokenDP, 0, $prefixLen + 1 ) );
				}

				$tokens[] = $endTag;
				$tokens[] = $listFrame->nlTk ?: '';
				$tokens[] = $newTag;

				$prefixCorrection = 1;
			} else {
				$this->env->trace( 'list', $this->pipelineId, '    -> reduced nesting' );
				$tokens = array_merge(
					$listFrame->solTokens,
					$tokens,
					$listFrame->popTags( count( $bs ) - $prefixLen )
				);
				if ( $listFrame->nlTk ) {
					$tokens[] = $listFrame->nlTk;
				}
				if ( $prefixLen > 0 && count( $bn ) === $prefixLen ) {
					$itemToken = array_pop( $listFrame->endtags );
					$tokens[] = $itemToken;
					// this list item gets all bullets upto the shared prefix
					$tokens[] = new TagTk( $itemToken->getName(), [], $this->makeDP( $tokenDP, 0, count( $bn ) ) );
					$listFrame->endtags[] = new EndTagTk( $itemToken->getName() );
				}
			}

			for ( $i = $prefixLen + $prefixCorrection; $i < count( $bn ); $i++ ) {
				if ( !self::$bullet_chars_map[$bn[$i]] ) {
					throw new \InvalidArgumentException( 'Unknown node prefix ' . $prefix[$i] );
				}

				// Each list item in the chain gets one bullet.
				// However, the first item also includes the shared prefix.
				//
				// Example:
				//
				// **a
				// ****b
				//
				// Yields:
				//
				// <ul><li-*>
				// <ul><li-*>a
				// <ul><li-FIRST-ONE-gets-***>
				// <ul><li-*>b</li></ul>
				// </li></ul>
				// </li></ul>
				// </li></ul>
				//
				// Unless prefixCorrection is > 0, in which case we've
				// already accounted for the initial bullets.
				//
				// prefixCorrection is for handling dl-dts like this
				//
				// ;a:b
				// ;;c:d
				//
				// ";c:d" is embedded within a dt that is 1 char wide(;)

				if ( $i === $prefixLen ) {
					$this->env->trace( 'list', $this->pipelineId,
						'    -> increased nesting: first'
					);
					$listDP = $this->makeDP( $tokenDP, 0, 0 );
					$listItemDP = $this->makeDP( $tokenDP, 0, $i + 1 );
				} else {
					$this->env->trace( 'list', $this->pipelineId,
						'    -> increased nesting: 2nd and higher'
					);
					$listDP = $this->makeDP( $tokenDP, $i, $i );
					$listItemDP = $this->makeDP( $tokenDP, $i, $i + 1 );
				}

				PHPUtils::pushArray( $tokens, $listFrame->pushList(
					self::$bullet_chars_map[$bn[$i]], $listDP, $listItemDP
				) );
			}
			$res = $tokens;
		}

		// clear out sol-tokens
		$listFrame->solTokens = [];
		$listFrame->nlTk = null;
		$listFrame->atEOL = false;
		$listFrame->listTk->addTokens( $res );

		$this->env->trace( 'list', $this->pipelineId, 'RET[LIST]:', $res );
		return [];
	}
}
