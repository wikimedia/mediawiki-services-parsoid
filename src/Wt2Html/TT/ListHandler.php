<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Create list tag around list items and map wiki bullet levels to html
 * @module
 */

namespace Parsoid;

use Parsoid\JSUtils as JSUtils;
use Parsoid\TokenHandler as TokenHandler;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\Util as Util;
use Parsoid\TagTk as TagTk;
use Parsoid\EndTagTk as EndTagTk;
use Parsoid\NlTk as NlTk;

$lastItem = JSUtils::lastItem;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class ListHandler extends TokenHandler {
	public static function BULLET_CHARS_MAP() {
		return [
			'*' => [ 'list' => 'ul', 'item' => 'li' ],
			'#' => [ 'list' => 'ol', 'item' => 'li' ],
			';' => [ 'list' => 'dl', 'item' => 'dt' ],
			':' => [ 'list' => 'dl', 'item' => 'dd' ]
		];
	}

	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		$this->listFrames = [];
		$this->reset();
	}
	public $listFrames;

	public function reset() {
		$this->onAnyEnabled = false;
		$this->nestedTableCount = 0;
		$this->resetCurrListFrame();
	}

	public function resetCurrListFrame() {
		$this->currListFrame = null;
	}

	public function onTag( $token ) {
		return ( $token->name === 'listItem' ) ? $this->onListItem( $token ) : $token;
	}

	public function onAny( $token ) {
		$this->env->log( 'trace/list', $this->manager->pipelineId,
			'ANY:', function () { return json_encode( $token );
   }
		);

		$tokens = null;
		if ( !$this->currListFrame ) {
			// this.currListFrame will be null only when we are in a table
			// that in turn was seen in a list context.
			//
			// Since we are not in a list within the table, nothing to do.
			// Just send the token back unchanged.
			if ( $token->constructor === EndTagTk::class && $token->name === 'table' ) {
				if ( $this->nestedTableCount === 0 ) {
					$this->currListFrame = array_pop( $this->listFrames );
				} else {
					$this->nestedTableCount--;
				}
			} elseif ( $token->constructor === TagTk::class && $token->name === 'table' ) {
				$this->nestedTableCount++;
			}

			return [ 'tokens' => [ $token ] ];
		}

		// Keep track of open tags per list frame in order to prevent colons
		// starting lists illegally. Php's findColonNoLinks.
		if ( $token->constructor === TagTk::class
&& // Table tokens will push the frame and remain balanced.
				// They're safe to ignore in the bookkeeping.
				$token->name !== 'table'
		) {
			$this->currListFrame->numOpenTags += 1;
		} elseif ( $token->constructor === EndTagTk::class && $this->currListFrame->numOpenTags > 0 ) {
			$this->currListFrame->numOpenTags -= 1;
		}

		if ( $token->constructor === EndTagTk::class ) {
			if ( $token->name === 'table' ) {
				// close all open lists and pop a frame
				$ret = $this->closeLists( $token );
				$this->currListFrame = array_pop( $this->listFrames );
				return [ 'tokens' => $ret ];
			} elseif ( TokenUtils::isBlockTag( $token->name ) ) {
				if ( $this->currListFrame->numOpenBlockTags === 0 ) {
					// Unbalanced closing block tag in a list context ==> close all previous lists
					return [ 'tokens' => $this->closeLists( $token ) ];
				} else {
					$this->currListFrame->numOpenBlockTags--;
					return [ 'tokens' => [ $token ] ];
				}
			}

			/* Non-block tag -- fall-through to other tests below */
		}

		if ( $this->currListFrame->atEOL ) {
			if ( $token->constructor !== NlTk::class && TokenUtils::isSolTransparent( $this->env, $token ) ) {
				// Hold on to see where the token stream goes from here
				// - another list item, or
				// - end of list
				if ( $this->currListFrame->nlTk ) {
					$this->currListFrame->solTokens[] = $this->currListFrame->nlTk;
					$this->currListFrame->nlTk = null;
				}
				$this->currListFrame->solTokens[] = $token;
				return [ 'tokens' => [] ];
			} else {
				// Non-list item in newline context ==> close all previous lists
				$tokens = $this->closeLists( $token );
				return [ 'tokens' => $tokens ];
			}
		}

		if ( $token->constructor === NlTk::class ) {
			$this->currListFrame->atEOL = true;
			$this->currListFrame->nlTk = $token;
			// php's findColonNoLinks is run in doBlockLevels, which examines
			// the text line-by-line. At nltk, any open tags will cease having
			// an effect.
			$this->currListFrame->numOpenTags = 0;
			return [ 'tokens' => [] ];
		}

		if ( $token->constructor === TagTk::class ) {
			if ( $token->name === 'table' ) {
				$this->listFrames[] = $this->currListFrame;
				$this->resetCurrListFrame();
			} elseif ( TokenUtils::isBlockTag( $token->name ) ) {
				$this->currListFrame->numOpenBlockTags++;
			}
			return [ 'tokens' => [ $token ] ];
		}

		// Nothing else left to do
		return [ 'tokens' => [ $token ] ];
	}

	public function newListFrame() {
		return [
			'atEOL' => true, // flag indicating a list-less line that terminates a list block
			'nlTk' => null, // NlTk that triggered atEOL
			'solTokens' => [],
			'bstack' => [], // Bullet stack, previous element's listStyle
			'endtags' => [], // Stack of end tags
			// Partial DOM building heuristic
			// # of open block tags encountered within list context
			'numOpenBlockTags' => 0,
			// # of open tags encountered within list context
			'numOpenTags' => 0
		];
	}

	public function onEnd( $token ) {
		$this->env->log( 'trace/list', $this->manager->pipelineId,
			'END:', function () { return json_encode( $token );
   }
		);

		$this->listFrames = [];
		if ( !$this->currListFrame ) {
			// init here so we dont have to have a check in closeLists
			// That way, if we get a null frame there, we know we have a bug.
			$this->currListFrame = $this->newListFrame();
		}
		$toks = $this->closeLists( $token );
		$this->reset();
		return [ 'tokens' => $toks ];
	}

	public function closeLists( $token ) {
		// pop all open list item tokens
		$tokens = $this->popTags( count( $this ) );

		// purge all stashed sol-tokens
		$tokens = $tokens->concat( $this->currListFrame->solTokens );
		if ( $this->currListFrame->nlTk ) {
			$tokens[] = $this->currListFrame->nlTk;
		}
		$tokens[] = $token;

		// remove any transform if we dont have any stashed list frames
		if ( count( $this->listFrames ) === 0 ) {
			$this->onAnyEnabled = false;
		}

		$this->resetCurrListFrame();

		$this->env->log( 'trace/list', $this->manager->pipelineId, '----closing all lists----' );
		$this->env->log( 'trace/list', $this->manager->pipelineId, 'RET', $tokens );

		return $tokens;
	}

	public function onListItem( $token ) {
		if ( $token->constructor === TagTk::class ) {
			$this->onAnyEnabled = true;
			if ( $this->currListFrame ) {
				// Ignoring colons inside tags to prevent illegal overlapping.
				// Attempts to mimic findColonNoLinks in the php parser.
				if ( $lastItem( $token->getAttribute( 'bullets' ) ) === ':'
&& $this->currListFrame->numOpenTags > 0
				) {
					return [ 'tokens' => [ ':' ] ];
				}
			} else {
				$this->currListFrame = $this->newListFrame();
			}
			// convert listItem to list and list item tokens
			$res = $this->doListItem( $this->currListFrame->bstack, $token->getAttribute( 'bullets' ), $token );
			return [ 'tokens' => $res, 'skipOnAny' => true ];
		}

		return [ 'tokens' => [ $token ] ];
	}

	public function commonPrefixLength( $x, $y ) {
		$minLength = min( count( $x ), count( $y ) );
		$i = 0;
		for ( ;  $i < $minLength;  $i++ ) {
			if ( $x[ $i ] !== $y[ $i ] ) {
				break;
			}
		}
		return $i;
	}

	public function pushList( $container, $liTok, $dp1, $dp2 ) {
		$this->currListFrame->endtags[] = new EndTagTk( $container->list );
		$this->currListFrame->endtags[] = new EndTagTk( $container->item );

		return [
			new TagTk( $container->list, [], $dp1 ),
			new TagTk( $container->item, [], $dp2 )
		];
	}

	public function popTags( $n ) {
		$tokens = [];
		while ( $n > 0 ) {
			// push list item..
			$tokens[] = array_pop( $this->currListFrame->endtags );
			// and the list end tag
			$tokens[] = array_pop( $this->currListFrame->endtags );

			$n--;
		}
		return $tokens;
	}

	public function isDtDd( $a, $b ) {
		$ab = [ $a, $b ]->sort();
		return ( $ab[ 0 ] === ':' && $ab[ 1 ] === ';' );
	}

	public function doListItem( $bs, $bn, $token ) {
		$this->env->log( 'trace/list', $this->manager->pipelineId,
			'BEGIN:', function () { return json_encode( $token );
   }
		);

		$prefixLen = $this->commonPrefixLength( $bs, $bn );
		$prefix = array_slice( $bn, 0, $prefixLen/*CHECK THIS*/ );
		$dp = $token->dataAttribs;
		$tsr = $dp->tsr;
		$makeDP = function ( $k, $j ) use ( &$tsr, &$Util, &$dp ) {
			$newTSR = null;
			if ( $tsr ) {
				$newTSR = [ $tsr[ 0 ] + $k, $tsr[ 0 ] + $j ];
			} else {
				$newTSR = null;
			}
			$newDP = Util::clone( $dp );
			$newDP->tsr = $newTSR;
			return $newDP;
		};
		$this->currListFrame->bstack = $bn;

		$res = null;
$itemToken = null;

		// emit close tag tokens for closed lists
		$this->env->log( 'trace/list', $this->manager->pipelineId, function () {
				return '    bs: ' . json_encode( $bs ) . '; bn: ' . json_encode( $bn );
		}
		);

		if ( count( $prefix ) === count( $bs ) && count( $bn ) === count( $bs ) ) {
			$this->env->log( 'trace/list', $this->manager->pipelineId, '    -> no nesting change' );

			// same list item types and same nesting level
			$itemToken = array_pop( $this->currListFrame->endtags );
			$this->currListFrame->endtags[] = new EndTagTk( $itemToken->name );
			$res = [ $itemToken ]->concat(
				$this->currListFrame->solTokens,
				[
					// this list item gets all the bullets since this is
					// a list item at the same level
					//
					// **a
					// **b
					$this->currListFrame->nlTk || '',
					new TagTk( $itemToken->name, [], $makeDP( 0, count( $bn ) ) )
				]
			);
		} else {
			$prefixCorrection = 0;
			$tokens = [];
			if ( count( $bs ) > $prefixLen
&& count( $bn ) > $prefixLen
&& $this->isDtDd( $bs[ $prefixLen ], $bn[ $prefixLen ] )
			) {
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

				$tokens = $this->popTags( count( $bs ) - $prefixLen - 1 );
				$tokens = $this->currListFrame->solTokens->concat( $tokens );
				$newName = ListHandler\BULLET_CHARS_MAP()[ $bn[ $prefixLen ] ]->item;
				$endTag = array_pop( $this->currListFrame->endtags );
				$this->currListFrame->endtags[] = new EndTagTk( $newName );

				$newTag = null;
				if ( $dp->stx === 'row' ) {
					// stx='row' is only set for single-line dt-dd lists (see tokenizer)
					// In this scenario, the dd token we are building a token for has no prefix
					// Ex: ;a:b, *;a:b, #**;a:b, etc. Compare with *;a\n*:b, #**;a\n#**:b
					$this->env->log( 'trace/list', $this->manager->pipelineId, '    -> single-line dt->dd transition' );
					$newTag = new TagTk( $newName, [], $makeDP( 0, 1 ) );
				} else {
					$this->env->log( 'trace/list', $this->manager->pipelineId, '    -> other dt/dd transition' );
					$newTag = new TagTk( $newName, [], $makeDP( 0, $prefixLen + 1 ) );
				}

				$tokens = $tokens->concat( [ $endTag, $this->currListFrame->nlTk || '', $newTag ] );

				$prefixCorrection = 1;
			} else {
				$this->env->log( 'trace/list', $this->manager->pipelineId, '    -> reduced nesting' );
				$tokens = $tokens->concat( $this->popTags( count( $bs ) - $prefixLen ) );
				$tokens = $this->currListFrame->solTokens->concat( $tokens );
				if ( $this->currListFrame->nlTk ) {
					$tokens[] = $this->currListFrame->nlTk;
				}
				if ( $prefixLen > 0 && count( $bn ) === $prefixLen ) {
					$itemToken = array_pop( $this->currListFrame->endtags );
					$tokens[] = $itemToken;
					// this list item gets all bullets upto the shared prefix
					$tokens[] = new TagTk( $itemToken->name, [], makeDP( 0, count( $bn ) ) );
					$this->currListFrame->endtags[] = new EndTagTk( $itemToken->name );
				}
			}

			for ( $i = $prefixLen + $prefixCorrection;  $i < count( $bn );  $i++ ) {
				if ( !ListHandler\BULLET_CHARS_MAP()[ $bn[ $i ] ] ) {
					throw 'Unknown node prefix ' . $prefix[ $i ];
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

				$listDP = null;
$listItemDP = null;
				if ( $i === $prefixLen ) {
					$this->env->log( 'trace/list', $this->manager->pipelineId,
						'    -> increased nesting: first'
					);
					$listDP = $makeDP( 0, 0 );
					$listItemDP = $makeDP( 0, $i + 1 );
				} else {
					$this->env->log( 'trace/list', $this->manager->pipelineId,
						'    -> increased nesting: 2nd and higher'
					);
					$listDP = $makeDP( $i, $i );
					$listItemDP = $makeDP( $i, $i + 1 );
				}

				$tokens = $tokens->concat( $this->pushList(
						ListHandler\BULLET_CHARS_MAP()[ $bn[ $i ] ], $token, $listDP, $listItemDP
					)
				);
			}
			$res = $tokens;
		}

		// clear out sol-tokens
		$this->currListFrame->solTokens = [];
		$this->currListFrame->nlTk = null;
		$this->currListFrame->atEOL = false;

		$this->env->log( 'trace/list', $this->manager->pipelineId,
			'RET:', function () { return json_encode( $res );
   }
		);
		return $res;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->ListHandler = $ListHandler;
}
