<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\WTUtils as WTUtils;

class LiFixups {
	/**
	 * For the following wikitext (called the "LI hack"):
	 * ```
	 *     * <li class="..."> foo
	 * ```
	 * the Parsoid parser, pre-post processing generates something like
	 * ```
	 *     <li></li><li class="...">foo</li>
	 * ```
	 * This visitor deletes such spurious `<li>`s to match the output of
	 * the PHP parser.
	 *
	 * However, note that the wikitext `<li></li>`, any preceding wikitext
	 * asterisk `*` absent, should indeed expand into two nodes in the
	 * DOM.
	 */
	public static function handleLIHack( $node, $env ) {
		$prevNode = $node->previousSibling;

		if ( WTUtils::isLiteralHTMLNode( $node )
&& $prevNode !== null
&& $prevNode->nodeName === 'LI'
&& !WTUtils::isLiteralHTMLNode( $prevNode )
&& DOMUtils::nodeEssentiallyEmpty( $prevNode )
		) {

			$dp = DOMDataUtils::getDataParsoid( $node );
			$typeOf = $node->getAttribute( 'typeof' ) || '';
			$liHackSrc = WTUtils::getWTSource( $env, $prevNode );

			if ( preg_match( '/(?:^|\s)mw:Transclusion(?=$|\s)/', $typeOf ) ) {
				$dataMW = DOMDataUtils::getDataMw( $node );
				if ( $dataMW->parts ) { array_unshift( $dataMW->parts, $liHackSrc );
	   }
			} else {
				// We have to store the extra information in order to
				// reconstruct the original source for roundtripping.
				$dp->liHackSrc = $liHackSrc;
			}

			// Update the dsr. Since we are coalescing the first
			// node with the second (or, more precisely, deleting
			// the first node), we have to update the second DSR's
			// starting point and start tag width.
			$nodeDSR = $dp->dsr;
			$prevNodeDSR = DOMDataUtils::getDataParsoid( $prevNode )->dsr;

			if ( $nodeDSR && $prevNodeDSR ) {
				$dp->dsr = [
					$prevNodeDSR[ 0 ],
					$nodeDSR[ 1 ],
					$nodeDSR[ 2 ] + $prevNodeDSR[ 1 ] - $prevNodeDSR[ 0 ],
					$nodeDSR[ 3 ]
				];
			}

			// Delete the duplicated <li> node.
			$prevNode->parentNode->removeChild( $prevNode );
		}

		return true;
	}

	public static function getMigrationInfo( $c ) {
		$tplRoot = WTUtils::findFirstEncapsulationWrapperNode( $c );
		if ( $tplRoot !== null ) {
			// Check if everything between tplRoot and c is migratable.
			$prev = $tplRoot->previousSibling;
			while ( $c !== $prev ) {
				if ( !WTUtils::isCategoryLink( $c )
&& !( $c->nodeName === 'SPAN' && preg_match( '/^\s*$/', $c->textContent ) )
				) {
					return [ 'tplRoot' => $tplRoot, 'migratable' => false ];
				}

				$c = $c->previousSibling;
			}
		}

		return [ 'tplRoot' => $tplRoot, 'migratable' => true ];
	}

	public static function findLastMigratableNode( $li ) {
		$sentinel = null;
		$c = DOMUtils::lastNonSepChild( $li );
		// c is known to be a category link.
		// fail fast in parser tests if something changes.
		Assert::invariant( WTUtils::isCategoryLink( $c ) );
		while ( $c ) {
			// Handle template units first
			$info = self::getMigrationInfo( $c );
			if ( !$info->migratable ) {
				break;
			} elseif ( $info->tplRoot !== null ) {
				$c = $info->tplRoot;
			}

			if ( DOMUtils::isText( $c ) ) {
				// Update sentinel if we hit a newline.
				// We want to migrate these newlines and
				// everything following them out of 'li'.
				if ( preg_match( '/\n\s*$/', $c->nodeValue ) ) {
					$sentinel = $c;
				}

				// If we didn't hit pure whitespace, we are done!
				if ( !preg_match( '/^\s*$/', $c->nodeValue ) ) {
					break;
				}
			} elseif ( DOMUtils::isComment( $c ) ) {
				$sentinel = $c;
			} elseif ( !WTUtils::isCategoryLink( $c ) ) {
				// We are done if we hit anything but text
				// or category links.
				break;
			}

			$c = $c->previousSibling;
		}

		return $sentinel;
	}

	/**
	 * Earlier in the parsing pipeline, we suppress all newlines
	 * and other whitespace before categories which causes category
	 * links to be swallowed into preceding paragraphs and list items.
	 *
	 * However, with wikitext like this: `*a\n\n[[Category:Foo]]`, this
	 * could prevent proper roundtripping (because we suppress newlines
	 * when serializing list items). This needs addressing because
	 * this pattern is extremely common (some list at the end of the page
	 * followed by a list of categories for the page).
	 */
	public static function migrateTrailingCategories( $li, $env, $unused, $tplInfo ) {
		// * Don't bother fixing up template content when processing the full page
		if ( $tplInfo ) {
			return true;
		}

		// If there is migratable content inside a list item
		// (categories preceded by newlines),
		// * migrate it out of the outermost list
		// * and fix up the DSR of list items and list along the rightmost path.
		if ( $li->nextSibling === null && DOMUtils::isList( $li->parentNode )
&& WTUtils::isCategoryLink( DOMUtils::lastNonSepChild( $li ) )
		) {

			// Find the outermost list -- content will be moved after it
			$outerList = $li->parentNode;
			while ( DOMUtils::isListItem( $outerList->parentNode ) ) {
				$p = $outerList->parentNode;
				// Bail if we find ourself on a path that is not the rightmost path.
				if ( $p->nextSibling !== null ) {
					return true;
				}
				$outerList = $p->parentNode;
			}

			// Find last migratable node
			$sentinel = self::findLastMigratableNode( $li );
			if ( !$sentinel ) {
				return true;
			}

			// Migrate (and update DSR)
			$c = $li->lastChild;
			$liDsr = DOMDataUtils::getDataParsoid( $li )->dsr;
			$newEndDsr = -1; // dummy to eliminate useless null checks
			while ( true ) { // eslint-disable-line
				if ( DOMUtils::isElt( $c ) ) {
					$dsr = DOMDataUtils::getDataParsoid( $c )->dsr;
					$newEndDsr = ( $dsr ) ? $dsr[ 0 ] : -1;
					$outerList->parentNode->insertBefore( $c, $outerList->nextSibling );
				} elseif ( DOMUtils::isText( $c ) ) {
					if ( preg_match( '/^\s*$/', $c->nodeValue ) ) {
						$newEndDsr -= count( $c->data );
						$outerList->parentNode->insertBefore( $c, $outerList->nextSibling );
					} else {
						// Split off the newlines into its own node and migrate it
						$nls = $c->data;
						$c->data = preg_replace( '/\s+$/', '', $c->data, 1 );
						$nls = substr( $nls, count( $c->data ) );
						$nlNode = $c->ownerDocument->createTextNode( $nls );
						$outerList->parentNode->insertBefore( $nlNode, $outerList->nextSibling );
						$newEndDsr -= count( $nls );
					}
				} elseif ( DOMUtils::isComment( $c ) ) {
					$newEndDsr -= WTUtils::decodedCommentLength( $c );
					$outerList->parentNode->insertBefore( $c, $outerList->nextSibling );
				}

				if ( $c === $sentinel ) {
					break;
				}

				$c = $li->lastChild;
			}

			// Update DSR of all listitem & list nodes till
			// we hit the outermost list we started with.
			$delta = null;
			if ( $liDsr && $newEndDsr >= 0 ) {
				$delta = $liDsr[ 1 ] - $newEndDsr;
			}

			// If there is no delta to adjust dsr by, we are done
			if ( !$delta ) {
				return true;
			}

			// Fix DSR along the rightmost path to outerList
			$list = null;
			while ( $outerList !== $list ) {
				$list = $li->parentNode;
				$liDsr = DOMDataUtils::getDataParsoid( $li )->dsr;
				if ( $liDsr ) {
					$liDsr[ 1 ] -= $delta;
				}

				$listDsr = DOMDataUtils::getDataParsoid( $list )->dsr;
				if ( $listDsr ) {
					$listDsr[ 1 ] -= $delta;
				}
				$li = $list->parentNode;
			}
		}

		return true;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->LiFixups = $LiFixups;
}
