<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\WikitextConstants as WikitextConstants;

$isRenderingTransparentNode = function ( $n ) use ( &$DOMUtils, &$WikitextConstants ) {return ( DOMUtils::isText( $n ) && preg_match( '/^\s*$/', $n->nodeValue ) )
|| WikitextConstants\HTML\MetaTags::has( $n->nodeName ) || DOMUtils::isComment( $n );
};

class PWrap {
	public function isSplittableTag( $n ) {
		// Seems safe to split span, sub, sup, cite tags
		//
		// These are the only 4 tags that are in HTML5Depurate's
		// list of inline tags that are not self-closing and that
		// can embed tags inside them.
		//
		// However, if we want to mimic Parsoid and HTML5 spec
		// precisely, we should only use isFormattingElt(n)
		return DOMUtils::isFormattingElt( $n );
	}

	// Flattens an array with other arrays for elements into
	// an array without nested arrays
	public function flatten( $a ) {
		$ret = [];
		for ( $i = 0;  $i < count( $a );  $i++ ) {
			$ret = $ret->concat( $a[ $i ] );
		}
		return $ret;
	}

	// Does the subtree rooted at 'n' have a block tag in it?
	public function hasBlockTag( $n ) {
		$c = $n->firstChild;
		while ( $c ) {
			if ( DOMUtils::isBlockNode( $n ) || $this->hasBlockTag( $c ) ) {
				return true;
			}
			$c = $c->nextSibling;
		}
		return false;
	}

	// mergeRuns merges split subtrees that
	// have identical PWrap properties
	public function mergeRuns( $n, $a ) {
		$curr = null;
		$ret = [];
		// This flag should be transferred to the rightmost
		// clone of this node in the loop below.
		$origAIEnd = DOMDataUtils::getDataParsoid( $n )->autoInsertedEnd;
		$a->forEach( function ( $v ) use ( &$curr, &$n, &$ret, &$DOMDataUtils ) {
				if ( !$curr ) {
					$curr = [ 'PWrap' => $v::PWrap, 'node' => $n ];
					$ret[] = $curr;
				} elseif ( $curr::PWrap === null ) {
					$curr::PWrap = $v::PWrap;
				} elseif ( $curr::PWrap !== $v::PWrap && $v::PWrap !== null ) {
					DOMDataUtils::getDataParsoid( $curr->node )->autoInsertedEnd = true;
					$curr = [ 'PWrap' => $v::PWrap, 'node' => $n->clone() ];
					DOMDataUtils::getDataParsoid( $curr->node )->autoInsertedStart = true;
					$ret[] = $curr;
				}
				$curr->node->appendChild( $v->node );
		}
		);
		if ( $curr ) {
			DOMDataUtils::getDataParsoid( $curr->node )->autoInsertedEnd = $origAIEnd;
		}
		return $ret;
	}

	// split does the split operation described in the outline of
	// the algorithm below.
	public function split( $n ) {
		if ( $isRenderingTransparentNode( $n ) ) {
			// The null stuff here is mainly to support mw:EndTag metas getting in
			// the way of runs and causing unnecessary wrapping.
			return [ [ 'PWrap' => null, 'node' => $n ] ];
		} elseif ( DOMUtils::isText( $n ) ) {
			return [ [ 'PWrap' => true, 'node' => $n ] ];
		} elseif ( !$this->isSplittableTag( $n ) || !count( $n->childNodes ) ) {
			// block tag OR non-splittable inline tag
			return [ [ 'PWrap' => !DOMUtils::isBlockNode( $n ) && !$this->hasBlockTag( $n ), 'node' => $n ] ];
		} else {
			// splittable inline tag
			// split for each child and merge runs
			return $this->mergeRuns( $n, $this->flatten( array_map( $n->childNodes, function ( $c ) {return explode( $c, $this );
   } ) ) );
		}
	}

	// Wrap children of 'root' with paragraph tags while
	// so that the final output has the following properties:
	//
	// 1. A paragraph will have at least one non-whitespace text
	// node or an non-block element node in its subtree.
	//
	// 2. Two paragraph nodes aren't siblings of each other.
	//
	// 3. If a child of root is not a paragraph node, it is one of:
	// - a white-space only text node
	// - a comment node
	// - a block element
	// - a splittable inline element which has some block node
	// on *all* paths from it to all leaves in its subtree.
	// - a non-splittable inline element which has some block node
	// on *some* path from it to a leaf in its subtree.
	//
	//
	// This output is generated with the following algorithm
	//
	// 1. Block nodes are skipped over
	// 2. Non-splittable inline nodes that have a block tag
	// in its subtree are skipped over.
	// 3. A splittable inline node, I, that has at least one block tag
	// in its subtree is split into multiple tree such that
	// * each new tree is rooted in I
	// * the trees alternate between two kinds
	// (a) it has no block node inside
	// => PWrap is true
	// (b) all paths from I to its leaves have some block node inside
	// => PWrap is false
	// 4. A paragraph tag is wrapped around adjacent runs of comment nodes,
	// text nodes, and an inline node that has no block node embedded inside.
	// This paragraph tag does not start with a white-space-only text node
	// or a comment node. The current algorithm does not ensure that it doesn't
	// end with one of those either, but that is a potential future enhancement.

	public function pWrap( $root ) {
		$p = null;
		$c = $root->firstChild;
		while ( $c ) {
			$next = $c->nextSibling;
			if ( DOMUtils::isBlockNode( $c ) ) {
				$p = null;
			} else {
				explode( $c, $this )->forEach( function ( $v ) use ( &$root, &$next, &$isRenderingTransparentNode ) {
						$n = $v->node;
						if ( $v::PWrap === false ) {
							$p = null;
							$root->insertBefore( $n, $next );
						} elseif ( $isRenderingTransparentNode( $n ) ) {
							if ( $p ) {
								$p->appendChild( $n );
							} else {
								$root->insertBefore( $n, $next );
							}
						} else {
							if ( !$p ) {
								$p = $root->ownerDocument->createElement( 'P' );
								$root->insertBefore( $p, $next );
							}
							$p->appendChild( $n );
						}
				}
				);
			}
			$c = $next;
		}
	}

	// This function walks the DOM tree rooted at 'root'
	// and uses pWrap to add appropriate paragraph wrapper
	// tags around children of nodes with tag name 'tagName'.
	public function pWrapInsideTag( $root, $tagName ) {
		$c = $root->firstChild;
		while ( $c ) {
			$next = $c->nextSibling;
			if ( $c->nodeName === $tagName ) {
				$this->pWrap( $c );
			} elseif ( DOMUtils::isElt( $c ) ) {
				$this->pWrapInsideTag( $c, $tagName );
			}
			$c = $next;
		}
	}

	// Wrap children of <body> as well as children of
	// <blockquote> found anywhere in the DOM tree.
	public function run( $root, $env, $options ) {
		$this->pWrap( $root );
		$this->pWrapInsideTag( $root, 'BLOCKQUOTE' );
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->PWrap = $PWrap;
}
