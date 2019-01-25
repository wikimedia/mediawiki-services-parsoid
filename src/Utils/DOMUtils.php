<?php

// Changes synced with commit 4772f44c
// Initial porting, partially complete
// Not fully tested, though many functions moved from DU.php were tested by domTests.php

namespace Parsoid\Utils;

use DOMDocument;
use DOMNode;
use Parsoid\Config\WikitextConstants;

/**
* DOM utilities for querying the DOM. This is largely independent of Parsoid
* although some Parsoid details (diff markers, TokenUtils, inline content version)
* have snuck in.
*/
class DOMUtils {
	const TPL_META_TYPE_REGEXP = '/(?:^|\s)(mw:(?:Transclusion|Param)(?:\/End)?)(?=$|\s)/';
	const FIRST_ENCAP_REGEXP =
		 '/(?:^|\s)(mw:(?:Transclusion|Param|LanguageVariant|Extension(\/[^\s]+)))(?=$|\s)/';

	/**
	 * Parse HTML, return the tree.
	 *
	 * @param string $html
	 * @return DOMDocument
	 */
	public static function parseHTML( $html ) {
		throw new \BadMethodCallException( "Not yet ported" );
/*		if (!html.match(/^<(?:!doctype|html|body)/i)) {
			// Make sure that we parse fragments in the body. Otherwise comments,
			// link and meta tags end up outside the html element or in the head
			// element.s
			html = '<body>' + html;
		}
		return domino.createDocument(html); */
	}

	/**
	 * This is a simplified version of the DOMTraverser.
	 * Consider using that before making this more complex.
	 *
	 * FIXME: Move to DOMTraverser OR create a new class?
	 * @param DOMNode $node
	 * @param callable $handler
	 * @param mixed ...$args
	 */
	public static function visitDOM( DOMNode $node, callable $handler, ...$args ) {
		// PORT-FIXME determine how to call a function passed as parameter recursively
		$handler( $node, ...$args );
		$node = $node->firstChild;
		while ( $node ) {
			self::visitDOM( $node, $handler, ...$args );
			$node = $node->nextSibling;
		}
	}

	/**
	 * Move 'from'.childNodes to 'to' adding them before 'beforeNode'
	 * If 'beforeNode' is null, the nodes are appended at the end.
	 * @param DOMNode $from Source node. Children will be removed.
	 * @param DOMNode $to Destination node. Children of $from will be added here
	 * @param DOMNode|null $beforeNode Add the children before this node.
	 */
	public static function migrateChildren( DOMNode $from, DOMNode $to, DOMNode $beforeNode = null ) {
		while ( $from->firstChild ) {
			$to->insertBefore( $from->firstChild, $beforeNode );
		}
	}

	/**
	 * Copy 'from'.childNodes to 'to' adding them before 'beforeNode'
	 * 'from' and 'to' belong to different documents.
	 *
	 * If 'beforeNode' is null, the nodes are appended at the end.
	 * @param DOMNode $from
	 * @param DOMNode $to
	 * @param bool|null $beforeNode
	 */
	public static function migrateChildrenBetweenDocs( DOMNode $from,
		DOMNode $to, DOMNode $beforeNode = null
	) {
		$n = $from->firstChild;
		$destDoc = $to->ownerDocument;
		while ( $n ) {
			$to->insertBefore( $destDoc->importNode( $n, true ), $beforeNode );
			$n = $n->nextSibling;
		}
	}

	/**
	 * Check whether this is a DOM element node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isElt( $node ) {
		return $node && $node->nodeType === XML_ELEMENT_NODE;
	}

	/**
	 * Check whether this is a DOM text node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isText( $node ) {
		return $node && $node->nodeType === XML_TEXT_NODE;
	}

	/**
	 * Check whether this is a DOM comment node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isComment( $node ) {
		return $node && $node->nodeType === XML_COMMENT_NODE;
	}

	/**
	 * Determine whether this is a block-level DOM element.
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isBlockNode( $node ) {
		return $node && TokenUtils::isBlockTag( $node->nodeName );
	}

	/**
	 * Determine whether this is a formatting DOM element.
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isFormattingElt( $node ) {
		return $node && isset( WikitextConstants::$HTML['FormattingTags'][$node->nodeName] );
	}

	/**
	 * Determine whether this is a quote DOM element.
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isQuoteElt( $node ) {
		return $node && isset( WikitextConstants::$WTQuoteTags[$node->nodeName] );
	}

	/**
	 * Determine whether this is a body DOM element.
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isBody( $node ) {
		return $node && $node->nodeName === 'body';
	}

	/**
	 * PORT-FIXME: Is this necessary with PHP DOM unlike Domino in JS?
	 *
	 * Test the number of children this node has without using
	 * `Node#childNodes.length`.  This walks the sibling list and so
	 * takes O(`nchildren`) time -- so `nchildren` is expected to be small
	 * (say: 0, 1, or 2).
	 *
	 * Skips all diff markers by default.
	 * @param DOMNode $node
	 * @param int $nchildren
	 * @param bool $countDiffMarkers
	 * @return bool
	 */
	public static function hasNChildren( DOMNode $node, $nchildren, $countDiffMarkers = false ) {
		for ( $child = $node->firstChild; $child; $child = $child->nextSibling ) {
			if ( !$countDiffMarkers && self::isDiffMarker( $child ) ) {
				continue;
			}
			if ( $nchildren <= 0 ) {
				return false;
			}
			$nchildren -= 1;
		}
		return ( $nchildren === 0 );
	}

	/**
	 * Build path from a node to its passed-in ancestor.
	 * Doesn't include the ancestor in the returned path.
	 *
	 * @param DOMNode $node
	 * @param DOMNode|null $ancestor
	 *   $ancestor should be an ancestor of $node.
	 *   If null, we'll walk to the document root.
	 * @return DOMNode
	 */
	public static function pathToAncestor( DOMNode $node, DOMNode $ancestor = null ) {
		$path = [];
		while ( $node && $node !== $ancestor ) {
			$path[] = $node;
			$node = $node->parentNode;
		}
		return $path;
	}

	/**
	 * Build path from a node to the root of the document.
	 *
	 * @param DOMNode $node
	 * @return DOMNode[]
	 */
	public static function pathToRoot( DOMNode $node ) {
		return self::pathToAncestor( $node, null );
	}

	/**
	 * Build path from a node to its passed-in sibling.
	 * Return will not include the passed-in sibling.
	 *
	 * @param DOMNode $node
	 * @param DOMNode $sibling
	 * @param bool $left indicates whether to go backwards, use previousSibling instead of nextSibling.
	 * @return DOMNode[]
	 */
	public static function pathToSibling( DOMNode $node, DOMNode $sibling, $left ) {
		$path = [];
		while ( $node && $node !== $sibling ) {
			$path[] = $node;
			$node = $left ? $node->previousSibling : $node->nextSibling;
		}
		return $path;
	}

	/**
	 * Check whether a node `n1` comes before another node `n2` in
	 * their parent's children list.
	 *
	 * @param DOMNode $n1 The node you expect to come first.
	 * @param DOMNode $n2 Expected later sibling.
	 * @return bool
	 */
	public static function inSiblingOrder( DOMNode $n1, DOMNode $n2 ) {
		while ( $n1 && $n1 !== $n2 ) {
			$n1 = $n1->nextSibling;
		}
		return $n1 !== null;
	}

	/**
	 * Check that a node 'n1' is an ancestor of another node 'n2' in
	 * the DOM. Returns true if n1 === n2.
	 * $n1 is the suspected ancestor.
	 * $n2 The suspected descendant.
	 *
	 * @param DOMNode $n1
	 * @param DOMNode $n2
	 * @return bool
	 */
	public static function isAncestorOf( DOMNode $n1, DOMNode $n2 ) {
		while ( $n2 && $n2 !== $n1 ) {
			$n2 = $n2->parentNode;
		}
		return $n2 !== null;
	}

	/**
	 * Check whether `node` has an ancestor named `name`.
	 *
	 * @param DOMNode $node
	 * @param string $name
	 * @return bool
	 */
	public static function hasAncestorOfName( DOMNode $node, $name ) {
		while ( $node && $node->nodeName !== $name ) {
			$node = $node->parentNode;
		}
		return $node !== null;
	}

	/**
	 * Determine whether the node matches the given nodeName and attribute value.
	 * Returns true if node name matches and the attribute equals "typeof"
	 *
	 * @param DOMNode $n
	 * @param string $name
	 * @param string $type
	 * @return bool
	 */
	public static function isNodeOfType( DOMNode $n, $name, $type ) {
		return $n->nodeName === $name && $n->getAttribute( 'typeof' ) === $type;
	}

	/**
	 * Check whether `node` is in a fosterable position.
	 *
	 * @param DOMNode|null $n
	 * @return bool
	 */
	public static function isFosterablePosition( $n ) {
		return $n && isset( WikitextConstants::$HTML['FosterablePosition'][$n->parentNode->nodeName] );
	}

	/**
	 * Check whether `node` is a list.
	 *
	 * @param DOMNode|null $n
	 * @return bool
	 */
	public static function isList( $n ) {
		return $n && isset( WikitextConstants::$HTML['ListTags'][$n->nodeName] );
	}

	/**
	 * Check whether `node` is a list item.
	 *
	 * @param DOMNode|null $n
	 * @return bool
	 */
	public static function isListItem( $n ) {
		return $n && isset( WikitextConstants::$HTML['ListItemTags'][$n->nodeName] );
	}

	/**
	 * Check whether `node` is a list or list item.
	 *
	 * @param DOMNode|null $n
	 * @return bool
	 */
	public static function isListOrListItem( $n ) {
		return self::isList( $n ) || self::isListItem( $n );
	}

	/**
	 * Check whether `node` is nestee in a list item.
	 *
	 * @param DOMNode|null $n
	 * @return bool
	 */
	public static function isNestedInListItem( $n ) {
		$parentNode = $n->parentNode;
		while ( $parentNode ) {
			if ( self::isListItem( $parentNode ) ) {
				return true;
			}
			$parentNode = $parentNode->parentNode;
		}
		return false;
	}

	/**
	 * Check whether `node` is a nested list or a list item.
	 *
	 * @param DOMNode|null $n
	 * @return bool
	 */
	public static function isNestedListOrListItem( $n ) {
		return self::isListOrListItem( $n ) && self::isNestedInListItem( $n );
	}

	/**
	 * Check a node to see whether it's a meta with some typeof.
	 *
	 * @param DOMNode $n
	 * @param string $type
	 * @return bool
	 */
	public static function isMarkerMeta( DOMNode $n, $type ) {
		return self::isNodeOfType( $n, 'meta', $type );
	}

	// FIXME: This would ideally belong in DiffUtils.js
	// but that would introduce circular dependencies.
	/**
	 * Check a node to see whether it's a diff marker.
	 *
	 * @param DOMNode|null $node
	 * @param string $mark
	 * @return bool
	 */
	public static function isDiffMarker( $node, $mark ) {
		if ( !$node ) {
			return false;
		}

		if ( $mark ) {
			return self::isMarkerMeta( $node, 'mw:DiffMarker/' . $mark );
		} else {
			return $node->nodeName === 'meta' &&
				preg_match( '#\bmw:DiffMarker/\w*\b#', $node->getAttribute( 'typeof' ) );
		}
	}

	/**
	 * Check whether a node has any children that are elements.
	 *
	 * @param DOMNode $node
	 * @return bool
	 */
	public static function hasElementChild( DOMNode $node ) {
		for ( $child = $node->firstChild; $child; $child = $child->nextSibling ) {
			if ( self::isElt( $child ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Check if a node has a block-level element descendant.
	 *
	 * @param DOMNode $node
	 * @return bool
	 */
	public static function hasBlockElementDescendant( DOMNode $node ) {
		for ( $child = $node->firstChild; $child; $child = $child->nextSibling ) {
			if ( self::isElt( $child ) &&
				( self::isBlockNode( $child ) || // Is a block-level node
				self::hasBlockElementDescendant( $child ) ) // or has a block-level child or grandchild or..
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Is a node representing inter-element whitespace?
	 *
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isIEW( $node ) {
		// ws-only
		return self::isText( $node ) && preg_match( '/^\s*$/', $node->nodeValue );
	}

	/**
	 * Is a node a document fragment?
	 *
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isDocumentFragment( $node ) {
		return $node && $node->nodeType === XML_DOCUMENT_FRAG_NODE;
	}

	/**
	 * Is a node at the top?
	 *
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function atTheTop( $node ) {
		return self::isDocumentFragment( $node ) || self::isBody( $node );
	}

	/**
	 * Is a node a content node?
	 *
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isContentNode( $node ) {
		return !self::isComment( $node ) &&
			!self::isIEW( $node ) &&
			!self::isDiffMarker( $node );
	}

	/**
	 * Get the first child element or non-IEW text node, ignoring
	 * whitespace-only text nodes, comments, and deleted nodes.
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function firstNonSepChild( DOMNode $node ) {
		$child = $node->firstChild;
		while ( $child && !self::isContentNode( $child ) ) {
			$child = $child->nextSibling;
		}
		return $child;
	}

	/**
	 * Get the last child element or non-IEW text node, ignoring
	 * whitespace-only text nodes, comments, and deleted nodes.
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function lastNonSepChild( DOMNode $node ) {
		$child = $node->lastChild;
		while ( $child && !self::isContentNode( $child ) ) {
			$child = $child->previousSibling;
		}
		return $child;
	}

	/**
	 * Get the previous non seperator sibling node.
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function previousNonSepSibling( DOMNode $node ) {
		$prev = $node->previousSibling;
		while ( $prev && !self::isContentNode( $prev ) ) {
			$prev = $prev->previousSibling;
		}
		return $prev;
	}

	/**
	 * Get the next non seperator sibling node.
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function nextNonSepSibling( DOMNode $node ) {
		$next = $node->nextSibling;
		while ( $next && !self::isContentNode( $next ) ) {
			$next = $next->nextSibling;
		}
		return $next;
	}

	/**
	 * Return the numbler of non deleted child nodes.
	 *
	 * @param DOMNode $node
	 * @return int
	 */
	public static function numNonDeletedChildNodes( DOMNode $node ) {
		$n = 0;
		$child = $node->firstChild;
		while ( $child ) {
			if ( !self::isDiffMarker( $child ) ) { // FIXME: This is ignoring both inserted/deleted
				$n++;
			}
			$child = $child->nextSibling;
		}
		return $n;
	}

	/**
	 * Get the first non-deleted child of node.
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function firstNonDeletedChild( DOMNode $node ) {
		$child = $node->firstChild;
		// FIXME: This is ignoring both inserted/deleted
		while ( $child && self::isDiffMarker( $child ) ) {
			$child = $child->nextSibling;
		}
		return $child;
	}

	/**
	 * Get the last non-deleted child of node.
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function lastNonDeletedChild( DOMNode $node ) {
		$child = $node->lastChild;
		// FIXME: This is ignoring both inserted/deleted
		while ( $child && self::isDiffMarker( $child ) ) {
			$child = $child->previousSibling;
		}
		return $child;
	}

	/**
	 * Get the next non deleted sibling.
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function nextNonDeletedSibling( DOMNode $node ) {
		$node = $node->nextSibling;
		while ( $node && self::isDiffMarker( $node ) ) { // FIXME: This is ignoring both inserted/deleted
			$node = $node->nextSibling;
		}
		return $node;
	}

	/**
	 * Get the previous non deleted sibling.
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function previousNonDeletedSibling( DOMNode $node ) {
		$node = $node->previousSibling;
		while ( $node && self::isDiffMarker( $node ) ) { // FIXME: This is ignoring both inserted/deleted
			$node = $node->previousSibling;
		}
		return $node;
	}

	/**
	 * Are all children of this node text or comment nodes?
	 *
	 * @param DOMNode $node
	 * @return bool
	 */
	public static function allChildrenAreTextOrComments( DOMNode $node ) {
		$child = $node->firstChild;
		while ( $child ) {
			if ( !self::isDiffMarker( $child )
				&& !self::isText( $child )
				&& !self::isComment( $child )
			) {
				return false;
			}
			$child = $child->nextSibling;
		}
		return true;
	}

	/**
	 * Are all children of this node text nodes?
	 *
	 * @param DOMNode $node
	 * @return bool
	 */
	public static function allChildrenAreText( DOMNode $node ) {
		$child = $node->firstChild;
		while ( $child ) {
			if ( !self::isDiffMarker( $child ) && !self::isText( $child ) ) {
				return false;
			}
			$child = $child->nextSibling;
		}
		return true;
	}

	/**
	 * Does `node` contain nothing or just non-newline whitespace?
	 * `strict` adds the condition that all whitespace is forbidden.
	 *
	 * @param DOMNode $node
	 * @param bool $strict
	 * @return bool
	 */
	public static function nodeEssentiallyEmpty( DOMNode $node, $strict = false ) {
		$n = $node->firstChild;
		while ( $n ) {
			if ( self::isElt( $n ) && !self::isDiffMarker( $n ) ) {
				return false;
			} elseif ( self::isText( $n ) &&
				( $strict || !preg_match( '/^[ \t]*$/',  $n->nodeValue ) )
			) {
				return false;
			} elseif ( self::isComment( $n ) ) {
				return false;
			}
			$n = $n->nextSibling;
		}
		return true;
	}

	/**
	 * Check if the dom-subtree rooted at node has an element with tag name 'tagName'
	 * The root node is not checked.
	 *
	 * @param DOMNode $node
	 * @param string $tagName
	 * @return bool
	 */
	public static function treeHasElement( DOMNode $node, $tagName ) {
		$node = $node->firstChild;
		while ( $node ) {
			if ( self::isElt( $node ) ) {
				if ( $node->nodeName === tagName || self::treeHasElement( $node, $tagName ) ) {
					return true;
				}
			}
			$node = $node->nextSibling;
		}
		return false;
	}

	/**
	 * Is node a table tag (table, tbody, td, tr, etc.)?
	 *
	 * @param DOMNode $node
	 * @return bool
	 */
	public static function isTableTag( DOMNode $node ) {
		return isset( WikitextConstants::$HTML['TableTags'][$n->nodeName] );
	}

	/**
	 * Returns a media element nested in `node`
	 *
	 * @param DOMNode $node
	 * @return DOMNode|null
	 */
	public static function selectMediaElt( DOMNode $node ) {
		throw new \BadMethodCallException( "Not yet ported" );
/*
From Brad:
https://secure.php.net/manual/en/book.dom.php doesn't have querySelector()
You could use DOMXPath[1] instead, or just recurse like treeHasElement() does.
[1]: https://secure.php.net/manual/en/class.domxpath.php
*/
// return node.querySelector( 'img, video, audio' );
	}

	/**
	 * Extract http-equiv headers from the HTML, including content-language and
	 * vary headers, if present
	 *
	 * @param DOMDocument $doc
	 * @return DOMNode|null
	 */
	public static function findHttpEquivHeaders( DOMDocument $doc ) {
		throw new \BadMethodCallException( "Not yet ported" );
/*
From Brad:
https://secure.php.net/manual/en/book.dom.php doesn't have querySelector()
You could use DOMXPath[1] instead, or just recurse like treeHasElement() does.
[1]: https://secure.php.net/manual/en/class.domxpath.php
*/
/*		return Array.from(doc.querySelectorAll('meta[http-equiv][content]'))
			.reduce((r,el) => {
			r[el.getAttribute('http-equiv').toLowerCase()] =
				el.getAttribute('content');
			return r;
		}, {}); */
	}

	/**
	 * @param DOMDocument $doc
	 * @return string|null
	 */
	public static function extractInlinedContentVersion( DOMDocument $doc ) {
		throw new \BadMethodCallException( "Not yet ported" );
/*
From Brad:
https://secure.php.net/manual/en/book.dom.php doesn't have querySelector()
You could use DOMXPath[1] instead, or just recurse like treeHasElement() does.
[1]: https://secure.php.net/manual/en/class.domxpath.php
*/
/*		var el = doc.querySelector('meta[property="mw:html:version"]');
		return el ? el.getAttribute('content') : null; */
	}

}
