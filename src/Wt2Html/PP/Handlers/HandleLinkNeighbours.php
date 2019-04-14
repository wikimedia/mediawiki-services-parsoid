<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\PP\Handlers;

use DOMElement;
use DOMNode;

use Parsoid\Utils\Util;
use Wikimedia\Assert\Assert;

use Parsoid\Config\Env;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\WTUtils;

class HandleLinkNeighbours {
	/**
	 * Function for fetching the link prefix based on a link node.
	 * The content will be reversed, so be ready for that.
	 *
	 * @param Env $env
	 * @param DOMNode|null $node
	 * @return array|null
	 */
	private static function getLinkPrefix( Env $env, ?DOMNode $node ): ?array {
		$baseAbout = null;
		$regex = $env->getSiteConfig()->linkPrefixRegex();

		if ( !$regex ) {
			return null;
		}

		if ( $node instanceof DOMElement && WTUtils::hasParsoidAboutId( $node ) ) {
			$baseAbout = $node->getAttribute( 'about' );
		}

		if ( $node !== null ) {
			$node = $node->previousSibling;
		}
		return self::findAndHandleNeighbour( $env, false, $regex, $node, $baseAbout );
	}

	/**
	 * Function for fetching the link trail based on a link node.
	 *
	 * @param Env $env
	 * @param DOMNode|null $node
	 * @return array|null
	 */
	private static function getLinkTrail( Env $env, ?DOMNode $node ): ?array {
		$baseAbout = null;
		$regex = $env->getSiteConfig()->linkTrailRegex();

		if ( !$regex ) {
			return null;
		}

		if ( $node instanceof DOMElement && WTUtils::hasParsoidAboutId( $node ) ) {
			$baseAbout = $node->getAttribute( 'about' );
		}

		if ( $node !== null ) {
			$node = $node->nextSibling;
		}
		return self::findAndHandleNeighbour( $env, true, $regex, $node, $baseAbout );
	}

	/**
	 * Abstraction of both link-prefix and link-trail searches.
	 *
	 * @param Env $env
	 * @param bool $goForward
	 * @param string $regex
	 * @param DOMNode|null $node
	 * @param string|null $baseAbout
	 * @return array
	 */
	private static function findAndHandleNeighbour(
		Env $env, bool $goForward, string $regex, ?DOMNode $node, ?string $baseAbout
	): array {
		$value = null;
		$nextNode = $goForward ? 'nextSibling' : 'previousSibling';
		$innerNode = $goForward ? 'firstChild' : 'lastChild';
		$getInnerNeighbour = $goForward ? 'getLinkTrail' : 'getLinkPrefix';
		$result = [ 'content' => [], 'src' => '' ];

		while ( $node !== null ) {
			$nextSibling = $node->{ $nextNode };
			$document = $node->ownerDocument;

			if ( DOMUtils::isText( $node ) ) {
				$value = [ 'content' => $node, 'src' => $node->nodeValue ];
				if ( preg_match( $regex, $node->nodeValue, $matches ) ) {
					$value['src'] = $matches[ 0 ];
					if ( $value['src'] === $node->nodeValue ) {
						// entire node matches linkprefix/trail
						$node->parentNode->removeChild( $node );
					} else {
						// part of node matches linkprefix/trail
						$value['content'] = $document->createTextNode( $matches[ 0 ] );
						$tn = $document->createTextNode( preg_replace( $regex, '', $node->nodeValue ) );
						$node->parentNode->replaceChild( $tn, $node );
					}
				} else {
					break;
				}
			} elseif ( $node instanceof DOMElement &&
				WTUtils::hasParsoidAboutId( $node ) &&
				$baseAbout !== '' && $baseAbout !== null &&
				$node->getAttribute( 'about' ) === $baseAbout
			) {
				$value = self::{ $getInnerNeighbour }( $env, $node->{ $innerNode } );
			} else {
				break;
			}

			Assert::invariant( $value['content'] !== null, 'Expected array or node.' );

			if ( is_array( $value['content'] ) ) {
				$result['content'] += $value['content'];
			} else {
				$result['content'][] = $value['content'];
			}

			if ( $goForward ) {
				$result['src'] .= $value['src'];
			} else {
				$result['src'] = $value['src'] . $result['src'];
			}

			if ( $value['src'] !== $node->nodeValue ) {
				break;
			}

			$node = $nextSibling;
		}

		return $result;
	}

	/**
	 * Workhorse function for bringing linktrails and link prefixes into link content.
	 * NOTE that this function mutates the node's siblings on either side.
	 *
	 * @param DOMElement $node
	 * @param Env $env
	 * @return bool|DOMElement
	 */
	public static function handler( DOMElement $node, Env $env ) {
		$rel = $node->getAttribute( 'rel' );
		if ( !preg_match( '/^mw:WikiLink(\/Interwiki)?$/', $rel ) ) {
			return true;
		}

		$dp = DOMDataUtils::getDataParsoid( $node );
		$ix = null;
		$dataMW = null;
		$prefix = self::getLinkPrefix( $env, $node );
		$trail = self::getLinkTrail( $env, $node );

		if ( isset( $prefix['content'] ) ) {
			for ( $ix = 0;  $ix < count( $prefix['content'] );  $ix++ ) {
				$node->insertBefore( $prefix['content'][ $ix ], $node->firstChild );
			}
			if ( mb_strlen( $prefix['src'] ) > 0 ) {
				$dp->prefix = $prefix['src'];
				if ( DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ) ) {
					// only necessary if we're the first
					$dataMW = DOMDataUtils::getDataMw( $node );
					if ( $dataMW->parts ) {
						array_unshift( $dataMW->parts, $prefix['src'] );
					}
				}
				if ( Util::isValidDSR( $dp->dsr ?? null ) ) {
					$dp->dsr[ 0 ] -= mb_strlen( $prefix['src'] );
					$dp->dsr[ 2 ] += mb_strlen( $prefix['src'] );
				}
			}
		}

		if ( isset( $trail['content'] ) && count( $trail['content'] ) > 0 ) {
			for ( $ix = 0;  $ix < count( $trail['content'] );  $ix++ ) {
				$node->appendChild( $trail['content'][ $ix ] );
			}
			if ( mb_strlen( $trail['src'] ) > 0 ) {
				$dp->tail = $trail['src'];
				$about = $node->getAttribute( 'about' );
				if ( WTUtils::hasParsoidAboutId( $node )
					&& count( WTUtils::getAboutSiblings( $node, $about ) ) === 1
				) {
					// search back for the first wrapper but
					// only if we're the last. otherwise can assume
					// template encapsulation will handle it
					$wrapper = WTUtils::findFirstEncapsulationWrapperNode( $node );
					if ( $wrapper instanceof DOMElement && DOMUtils::hasTypeOf( $wrapper, 'mw:Transclusion' ) ) {
						$dataMW = DOMDataUtils::getDataMw( $wrapper );
						if ( $dataMW->parts ) {
							$dataMW->parts[] = $trail['src'];
						}
					}
				}
				if ( isset( $dp->dsr ) ) {
					$dp->dsr[ 1 ] += mb_strlen( $trail['src'] );
					$dp->dsr[ 3 ] += mb_strlen( $trail['src'] );
				}
			}
			// indicate that the node's tail siblings have been consumed
			return $node;
		} else {
			return true;
		}
	}
}
