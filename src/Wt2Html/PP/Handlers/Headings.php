<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\Util as Util;
use Parsoid\Sanitizer as Sanitizer;
use Parsoid\WTUtils as WTUtils;

class Headings {
	/**
	 * Generate anchor ids that the PHP parser assigns to headings.
	 * This is to ensure that links that are out there in the wild
	 * continue to be valid links into Parsoid HTML.
	 */
	public static function genAnchors( $node, $env ) {
		if ( !preg_match( '/^H[1-6]$/', $node->nodeName ) ) {
			return true;
		}

		// Cannot generate an anchor id if the heading already has an id!
		//
		// NOTE: Divergence from PHP parser behavior.
		//
		// The PHP parser generates a <h*><span id="anchor-id-here-">..</span><h*>
		// So, it can preserve the existing id if any. However, in Parsoid, we are
		// generating a <h* id="anchor-id-here"> ..</h*> => we either overwrite or
		// preserve the existing id and use it for TOC, etc. We choose to preserve it.
		if ( $node->hasAttribute( 'id' ) ) {
			DOMDataUtils::getDataParsoid( $node )->reusedId = true;
			return true;
		}

		// Our own version of node.textContent which handles LanguageVariant
		// markup the same way PHP does (ie, uses the source wikitext), and
		// handles <style>/<script> tags the same way PHP does (ie, ignores
		// the contents)
		$textContentOf = function ( $node, $r ) use ( &$node, &$DOMDataUtils, &$textContentOf ) {
			::from[ $node->childNodes || [] ]->forEach( function ( $n ) use ( &$r, &$DOMDataUtils, &$textContentOf ) {
					if ( $n->nodeType === $n::TEXT_NODE ) {
						$r[] = $n->nodeValue;
					} elseif ( DOMDataUtils::hasTypeOf( $n, 'mw:LanguageVariant' ) ) {
						// Special case for -{...}-
						$dp = DOMDataUtils::getDataParsoid( $n );
						$r[] = $dp->src || '';
					} elseif ( DOMDataUtils::hasTypeOf( $n, 'mw:DisplaySpace' ) ) {
						$r[] = ' ';
					} elseif ( $n->nodeName === 'STYLE' || $n->nodeName === 'SCRIPT' ) {

						/* ignore children */
					} else {
						$textContentOf( $n, $r );
					}
			}
			);
			return $r;
		};

		// see Parser::normalizeSectionName in Parser.php and T90902
		$normalizeSectionName = function ( $text ) use ( &$env ) {
			try {
				$title = $env->makeTitleFromURLDecodedStr( "#{$text}" );
				return $title->getFragment();
			} catch ( Exception $e ) {
				return $text;
			}
		};

		$anchorText = Sanitizer::normalizeSectionIdWhiteSpace(
			implode( '', textContentOf( $node, [] ) )
		);
		$anchorText = $normalizeSectionName( $anchorText );

		// Create an anchor with a sanitized id
		$anchorId = Sanitizer::escapeIdForAttribute( $anchorText );
		$fallbackId = Sanitizer::escapeIdForAttribute( $anchorText, [
				'fallback' => true
			]
		);
		if ( $anchorId === $fallbackId ) { $fallbackId = null; /* not needed */
  }

		// The ids need to be unique, but we'll enforce this in a post-processing
		// step.

		$node->setAttribute( 'id', $anchorId );
		if ( $fallbackId ) {
			$span = $node->ownerDocument->createElement( 'span' );
			$span->setAttribute( 'id', $fallbackId );
			$span->setAttribute( 'typeof', 'mw:FallbackId' );
			$nodeDsr = DOMDataUtils::getDataParsoid( $node )->dsr;
			// Set a zero-width dsr range for the fallback id
			if ( Util::isValidDSR( $nodeDsr ) ) {
				$offset = $nodeDsr[ 0 ] + ( $nodeDsr[ 3 ] || 0 );
				DOMDataUtils::getDataParsoid( $span )->dsr = [ $offset, $offset ];
			}
			$node->insertBefore( $span, $node->firstChild );
		}

		return true;
	}

	// FIXME: Why do we need global 'seenIds' state?
	// Can't we make it local to DOMPostProcessor for
	// the top-level document?
	public static function dedupeHeadingIds( $seenIds, $node, $env ) {
		// NOTE: This is not completely compliant with how PHP parser does it.
		// If there is an id in the doc elsewhere, this will assign
		// the heading a suffixed id, whereas the PHP parser processes
		// headings in textual order and can introduce duplicate ids
		// in a document in the process.
		//
		// However, we believe this implemention behavior is more
		// consistent when handling this edge case, and in the common
		// case (where heading ids won't conflict with ids elsewhere),
		// matches PHP parser behavior.
		if ( !$node->hasAttribute ) { return true; /* not an Element */
  }
		if ( !$node->hasAttribute( 'id' ) ) { return true;
  }
		// Must be case-insensitively unique (T12721)
		// ...but note that PHP uses strtolower, which only does A-Z :(
		$key = $node->getAttribute( 'id' );
		$key = preg_replace( '/[A-Z]+/', function ( $s ) { return strtolower( $s );
  }, $key );
		if ( !$seenIds->has( $key ) ) {
			$seenIds->add( $key );
			return true;
		}
		// Only update headings and legacy links (first children of heading)
		if (
			preg_match( '/^H\d$/', $node->nodeName )
|| WTUtils::isFallbackIdSpan( $node )
		) {
			$suffix = 2;
			while ( $seenIds->has( $key . '_' . $suffix ) ) {
				$suffix++;
			}
			$node->setAttribute( 'id', $node->getAttribute( 'id' ) . '_' . $suffix );
			$seenIds->add( $key . '_' . $suffix );
		}
		return true;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->Headings = $Headings;
}
