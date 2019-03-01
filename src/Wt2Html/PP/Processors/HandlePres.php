<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\WTUtils as WTUtils;

class HandlePres {
	public function fixedIndentPreText( $str, $isLastChild ) {
		if ( $isLastChild ) {
			return preg_replace( '/\n(?!$)/', "\n ", $str );
		} else {
			return preg_replace( '/\n/', "\n ", $str );
		}
	}

	public function reinsertLeadingSpace( $elt, $isLastChild ) {
		for ( $c = $elt->firstChild;  $c;  $c = $c->nextSibling ) {
			$last = ( $c->nextSibling === null );
			if ( DOMUtils::isText( $c ) ) {
				$c->data = $this->fixedIndentPreText( $c->data, $isLastChild && $last );
			} else {
				// recurse
				$this->reinsertLeadingSpace( $c, $isLastChild && $last );
			}
		}
	}

	public function findAndHandlePres( $elt, $indentPresHandled ) {
		$nextChild = null;
		$blocklevel = false;
		for ( $n = $elt->firstChild;  $n;  $n = $nextChild ) {
			$processed = false;
			$nextChild = $n->nextSibling; // store this before n is possibly deleted
			if ( !$indentPresHandled && DOMUtils::isElt( $n )
&& TokenUtils::tagOpensBlockScope( $n->nodeName )
&& ( WTUtils::isTplMetaType( $n->getAttribute( 'typeof' ) || '' )
|| WTUtils::isLiteralHTMLNode( $n ) )
			) {
				// This is a special case in the php parser for $inBlockquote
				$blocklevel = ( $n->nodeName === 'BLOCKQUOTE' );
				$this->deleteIndentPreFromDOM( $n, $blocklevel );
				$processed = true;
			}
			$this->findAndHandlePres( $n, $indentPresHandled || $processed );
		}
	}

	/* --------------------------------------------------------------
	 * Block tags change the behaviour of indent-pres.  This behaviour
	 * cannot be emulated till the DOM is built if we are to avoid
	 * having to deal with unclosed/mis-nested tags in the token stream.
	 *
	 * This goes through the DOM looking for special kinds of
	 * block tags (as determined by the PHP parser behavior -- which
	 * has its own notion of block-tag which overlaps with, but is
	 * different from, the HTML block tag notion.
	 *
	 * Wherever such a block tag is found, any Parsoid-inserted
	 * pre-tags are removed.
	 * -------------------------------------------------------------- */
	public function deleteIndentPreFromDOM( $node, $blocklevel ) {
		$document = $node->ownerDocument;
		$c = $node->firstChild;
		while ( $c ) {
			// get sibling before DOM is modified
			$cSibling = $c->nextSibling;

			if ( $c->nodeName === 'PRE' && !WTUtils::isLiteralHTMLNode( $c ) ) {
				$f = $document->createDocumentFragment();

				// space corresponding to the 'pre'
				$f->appendChild( $document->createTextNode( ' ' ) );

				// transfer children over
				$cChild = $c->firstChild;
				while ( $cChild ) {
					$next = $cChild->nextSibling;
					if ( DOMUtils::isText( $cChild ) ) {
						// new child with fixed up text
						$cChild = $document->createTextNode( $this->fixedIndentPreText( $cChild->data, $next === null ) );
					} elseif ( DOMUtils::isElt( $cChild ) ) {
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
			} elseif ( !TokenUtils::tagClosesBlockScope( strtolower( $c->nodeName ) ) ) {
				$this->deleteIndentPreFromDOM( $c, $blocklevel );
			}

			$c = $cSibling;
		}
	}

	public function run( $body, $env ) {
		$this->findAndHandlePres( $body, false );
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->HandlePres = $HandlePres;
}
