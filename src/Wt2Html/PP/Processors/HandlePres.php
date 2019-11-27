<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\PP\Processors;

use DOMNode;
use DOMElement;

use Parsoid\Config\Env;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\TokenUtils;
use Parsoid\Utils\WTUtils;

class HandlePres {
	/**
	 * @param string $str
	 * @param bool $isLastChild
	 * @return string
	 */
	public function fixedIndentPreText( string $str, bool $isLastChild ): string {
		if ( $isLastChild ) {
			return preg_replace( '/\n(?!$)/', "\n ", $str );
		} else {
			return preg_replace( '/\n/', "\n ", $str );
		}
	}

	/**
	 * @param DOMElement $elt
	 * @param bool $isLastChild
	 */
	public function reinsertLeadingSpace( DOMElement $elt, bool $isLastChild ): void {
		for ( $c = $elt->firstChild; $c; $c = $c->nextSibling ) {
			$last = ( $c->nextSibling === null );
			if ( DOMUtils::isText( $c ) ) {
				$c->nodeValue = $this->fixedIndentPreText( $c->nodeValue, $isLastChild && $last );
			} elseif ( $c instanceof DOMElement ) {
				// recurse
				$this->reinsertLeadingSpace( $c, $isLastChild && $last );
			}
		}
	}

	/**
	 * @param DOMNode $elt
	 * @param bool $indentPresHandled
	 */
	public function findAndHandlePres( DOMNode $elt, bool $indentPresHandled ): void {
		$nextChild = null;
		$blocklevel = false;
		for ( $n = $elt->firstChild; $n; $n = $nextChild ) {
			$processed = false;
			$nextChild = $n->nextSibling; // store this before n is possibly deleted
			if ( !$indentPresHandled && ( $n instanceof DOMElement ) ) {
				if ( TokenUtils::tagOpensBlockScope( $n->nodeName )
					&& ( WTUtils::matchTplType( $n )
						|| WTUtils::isLiteralHTMLNode( $n ) )
				) {
					// This is a special case in the legacy parser for $inBlockquote
					$blocklevel = ( $n->nodeName === 'blockquote' );
					$this->deleteIndentPreFromDOM( $n, $blocklevel );
					$processed = true;
				}
			}
			$this->findAndHandlePres( $n, $indentPresHandled || $processed );
		}
	}

	/**
	 * Block tags change the behaviour of indent-pres.  This behaviour
	 * cannot be emulated till the DOM is built if we are to avoid
	 * having to deal with unclosed/mis-nested tags in the token stream.
	 *
	 * This goes through the DOM looking for special kinds of
	 * block tags (as determined by the legacy parser behavior -- which
	 * has its own notion of block-tag which overlaps with, but is
	 * different from, the HTML block tag notion.
	 *
	 * Wherever such a block tag is found, any Parsoid-inserted
	 * pre-tags are removed.
	 *
	 * @param DOMNode $node
	 * @param bool $blocklevel
	 */
	public function deleteIndentPreFromDOM( DOMNode $node, bool $blocklevel ): void {
		$document = $node->ownerDocument;
		$c = $node->firstChild;
		while ( $c ) {
			// get sibling before DOM is modified
			$cSibling = $c->nextSibling;

			if ( $c->nodeName === 'pre' && !WTUtils::isLiteralHTMLNode( $c ) ) {
				$f = $document->createDocumentFragment();

				// space corresponding to the 'pre'
				$f->appendChild( $document->createTextNode( ' ' ) );

				// transfer children over
				$cChild = $c->firstChild;
				while ( $cChild ) {
					$next = $cChild->nextSibling;
					if ( DOMUtils::isText( $cChild ) ) {
						// new child with fixed up text
						$fixed = $this->fixedIndentPreText( $cChild->nodeValue, $next === null );
						$cChild = $document->createTextNode( $fixed );
					} elseif ( $cChild instanceof DOMElement ) {
						// recursively process all text nodes to make
						// sure every new line gets a space char added back.
						$this->reinsertLeadingSpace( $cChild, $next === null );
					}
					$f->appendChild( $cChild );
					$cChild = $next;
				}

				if ( $blocklevel ) {
					$p = $document->createElement( 'p' );
					$p->appendChild( $f );
					$f = $p;
				}

				$node->insertBefore( $f, $c );
				// delete the pre
				$c->parentNode->removeChild( $c );
			} elseif ( !TokenUtils::tagClosesBlockScope( $c->nodeName ) ) {
				$this->deleteIndentPreFromDOM( $c, $blocklevel );
			}

			$c = $cSibling;
		}
	}

	/**
	 * @param DOMNode $body
	 * @param Env $env
	 */
	public function run( DOMNode $body, Env $env ): void {
		$this->findAndHandlePres( $body, false );
	}
}
