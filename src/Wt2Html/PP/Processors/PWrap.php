<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Comment;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Wikitext\Consts;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class PWrap implements Wt2HtmlDOMProcessor {
	/**
	 * Flattens an array with other arrays for elements into
	 * an array without nested arrays.
	 *
	 * @param array[] $a
	 * @return array
	 */
	private function flatten( array $a ): array {
		return $a === [] ? [] : array_merge( ...$a );
	}

	/**
	 * This is equivalent to DOMUtils.emitsSolTransparentSingleLineWT except
	 * for the single line constraint.
	 *
	 * @param Node $n
	 * @return bool
	 */
	private function emitsSolTransparentWT( Node $n ): bool {
		return ( $n instanceof Text && preg_match( '/^\s*$/D', $n->nodeValue ) ) ||
			$n instanceof Comment ||
			isset( Consts::$HTML['MetaTags'][DOMCompat::nodeName( $n )] );
	}

	/**
	 * Can we split the subtree rooted at $n into multiple adjacent
	 * subtrees rooted in a clone of $n where each of those subtrees
	 * get a contiguous subset of $n's children?
	 *
	 * This is probably equivalent to asking if this node supports the
	 * adoption agency algorithm in the HTML5 spec.
	 *
	 * @param Node $n
	 * @return bool
	 */
	private function isSplittableTag( Node $n ): bool {
		// Seems safe to split span, sub, sup, cite tags
		//
		// However, if we want to mimic Parsoid and HTML5 spec
		// precisely, we should only use isFormattingElt(n)
		return DOMUtils::isFormattingElt( $n );
	}

	/**
	 * Is 'n' a block tag, or does the subtree rooted at 'n' have a block tag
	 * in it?
	 *
	 * @param Node $n
	 * @return bool
	 */
	private function hasBlockTag( Node $n ): bool {
		if ( DOMUtils::isRemexBlockNode( $n ) ) {
			return true;
		}
		$c = $n->firstChild;
		while ( $c ) {
			if ( $this->hasBlockTag( $c ) ) {
				return true;
			}
			$c = $c->nextSibling;
		}
		return false;
	}

	/**
	 * Merge a contiguous run of split subtrees that have identical pwrap properties
	 *
	 * @param Element $n
	 * @param array $a
	 * @return array
	 */
	private function mergeRuns( Element $n, array $a ): array {
		$ret = [];
		// This flag should be transferred to the rightmost
		// clone of this node in the loop below.
		$ndp = DOMDataUtils::getDataParsoid( $n );
		$origAIEnd = $ndp->autoInsertedEnd ?? null;
		$origEndTSR = $ndp->tmp->endTSR ?? null;
		$i = -1;
		foreach ( $a as $v ) {
			if ( $i < 0 ) {
				$ret[] = [ 'pwrap' => $v['pwrap'], 'node' => $n ];
				$i++;
			} elseif ( $ret[$i]['pwrap'] === null ) {
				// @phan-suppress-previous-line PhanTypeInvalidDimOffset
				$ret[$i]['pwrap'] = $v['pwrap'];
			} elseif ( $ret[$i]['pwrap'] !== $v['pwrap'] && $v['pwrap'] !== null ) {
				// @phan-suppress-previous-line PhanTypeInvalidDimOffset
				// @phan-suppress-next-line PhanTypeInvalidDimOffset
				$dp = DOMDataUtils::getDataParsoid( $ret[$i]['node'] );
				$dp->autoInsertedEnd = true;
				unset( $dp->tmp->endTSR );
				$cnode = $n->cloneNode();
				'@phan-var Element $cnode'; // @var Element $cnode
				if ( $n->hasAttribute( DOMDataUtils::DATA_OBJECT_ATTR_NAME ) ) {
					DOMDataUtils::setNodeData( $cnode, DOMDataUtils::getNodeData( $n )->clone() );
				}
				$ret[] = [ 'pwrap' => $v['pwrap'], 'node' => $cnode ];
				$i++;
				DOMDataUtils::getDataParsoid( $ret[$i]['node'] )->autoInsertedStart = true;
			}
			$ret[$i]['node']->appendChild( $v['node'] );
		}
		if ( $i >= 0 ) {
			$dp = DOMDataUtils::getDataParsoid( $ret[$i]['node'] );
			if ( $origAIEnd ) {
				$dp->autoInsertedEnd = true;
				unset( $dp->tmp->endTSR );
			} else {
				unset( $dp->autoInsertedEnd );
				if ( $origEndTSR ) {
					$dp->getTemp()->endTSR = $origEndTSR;
				}
			}
		}

		return $ret;
	}

	/**
	 * Implements the split operation described in the algorithm below.
	 *
	 * @param Node $n
	 * @return array
	 */
	private function split( Node $n ): array {
		if ( $this->emitsSolTransparentWT( $n ) ) {
			// The null stuff here is mainly to support mw:EndTag metas getting in
			// the way of runs and causing unnecessary wrapping.
			// FIXME: mw:EndTag metas no longer exist
			return [ [ 'pwrap' => null, 'node' => $n ] ];
		} elseif ( $n instanceof Text ) {
			return [ [ 'pwrap' => true, 'node' => $n ] ];
		} elseif ( !$this->isSplittableTag( $n ) || count( $n->childNodes ) === 0 ) {
			// block tag OR non-splittable inline tag
			return [
				[ 'pwrap' => !$this->hasBlockTag( $n ), 'node' => $n ]
			];
		} else {
			DOMUtils::assertElt( $n );
			// splittable inline tag
			// split for each child and merge runs
			$children = $n->childNodes;
			$splits = [];
			foreach ( $children as $child ) {
				$splits[] = $this->split( $child );
			}
			return $this->mergeRuns( $n, $this->flatten( $splits ) );
		}
	}

	/**
	 * Wrap children of '$root' with paragraph tags while
	 * so that the final output has the following properties:
	 *
	 * 1. A paragraph will have at least one non-whitespace text
	 *    node or an non-block element node in its subtree.
	 *
	 * 2. Two paragraph nodes aren't siblings of each other.
	 *
	 * 3. If a child of $root is not a paragraph node, it is one of:
	 * - a white-space only text node
	 * - a comment node
	 * - a block element
	 * - a splittable inline element which has some block node
	 *   on *all* paths from it to all leaves in its subtree.
	 * - a non-splittable inline element which has some block node
	 *   on *some* path from it to a leaf in its subtree.
	 *
	 * This output is generated with the following algorithm
	 *
	 * 1. Block nodes are skipped over
	 * 2. Non-splittable inline nodes that have a block tag
	 *    in its subtree are skipped over.
	 * 3. A splittable inline node, I, that has at least one block tag
	 *    in its subtree is split into multiple tree such that
	 *    - each new tree is $rooted in I
	 *    - the trees alternate between two kinds
	 *    (a) it has no block node inside
	 *        => pwrap is true
	 *    (b) all paths from I to its leaves have some block node inside
	 *        => pwrap is false
	 * 4. A paragraph tag is wrapped around adjacent runs of comment nodes,
	 *    text nodes, and an inline node that has no block node embedded inside.
	 *    This paragraph tag does not start with a white-space-only text node
	 *    or a comment node. The current algorithm does not ensure that it doesn't
	 *    end with one of those either, but that is a potential future enhancement.
	 *
	 * @param Element|DocumentFragment $root
	 */
	private function pWrapDOM( Node $root ) {
		$p = null;
		$c = $root->firstChild;
		while ( $c ) {
			$next = $c->nextSibling;
			if ( DOMUtils::isRemexBlockNode( $c ) ) {
				$p = null;
			} else {
				$vs = $this->split( $c );
				foreach ( $vs as $v ) {
					$n = $v['node'];
					if ( $v['pwrap'] === false ) {
						$p = null;
						$root->insertBefore( $n, $next );
					} elseif ( $this->emitsSolTransparentWT( $n ) ) {
						if ( $p ) {
							$p->appendChild( $n );
						} else {
							$root->insertBefore( $n, $next );
						}
					} else {
						if ( !$p ) {
							$p = $root->ownerDocument->createElement( 'p' );
							$root->insertBefore( $p, $next );
						}
						$p->appendChild( $n );
					}
				}
			}
			$c = $next;
		}
	}

	/**
	 * This function walks the DOM tree $rooted at '$root'
	 * and uses pWrapDOM to add appropriate paragraph wrapper
	 * tags around children of nodes with tag name '$tagName'.
	 *
	 * @param Element|DocumentFragment $root
	 * @param string $tagName
	 */
	private function pWrapInsideTag( Node $root, string $tagName ) {
		$c = $root->firstChild;
		while ( $c ) {
			$next = $c->nextSibling;
			if ( $c instanceof Element ) {
				if ( DOMCompat::nodeName( $c ) === $tagName ) {
					$this->pWrapDOM( $c );
				} else {
					$this->pWrapInsideTag( $c, $tagName );
				}
			}
			$c = $next;
		}
	}

	/**
	 * Wrap children of <body> as well as children of
	 * <blockquote> found anywhere in the DOM tree.
	 *
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		'@phan-var Element|DocumentFragment $root';  // @var Element|DocumentFragment $root
		$this->pWrapDOM( $root );
		$this->pWrapInsideTag( $root, 'blockquote' );
	}
}
