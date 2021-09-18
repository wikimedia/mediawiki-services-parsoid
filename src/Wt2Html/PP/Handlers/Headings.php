<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Handlers;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\TitleException;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;

class Headings {
	/**
	 * Generate anchor ids that the PHP parser assigns to headings.
	 * This is to ensure that links that are out there in the wild
	 * continue to be valid links into Parsoid HTML.
	 * @param Node $node
	 * @param Env $env
	 * @return bool
	 */
	public static function genAnchors( Node $node, Env $env ): bool {
		if ( !preg_match( '/^h[1-6]$/D', DOMCompat::nodeName( $node ) ) ) {
			return true;
		}
		'@phan-var Element $node';  /** @var Element $node */

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

		$anchorText = Sanitizer::normalizeSectionIdWhiteSpace( self::textContentOf( $node ) );
		$anchorText = self::normalizeSectionName( $anchorText, $env );

		// Create an anchor with a sanitized id
		$anchorId = Sanitizer::escapeIdForAttribute( $anchorText );
		$fallbackId = Sanitizer::escapeIdForAttribute( $anchorText, Sanitizer::ID_FALLBACK );
		if ( $anchorId === $fallbackId ) {
			$fallbackId = null; /* not needed */
		}

		// The ids need to be unique, but we'll enforce this in a post-processing
		// step.

		$node->setAttribute( 'id', $anchorId );
		if ( $fallbackId ) {
			$span = $node->ownerDocument->createElement( 'span' );
			$span->setAttribute( 'id', $fallbackId );
			DOMUtils::addTypeOf( $span, 'mw:FallbackId' );
			$nodeDsr = DOMDataUtils::getDataParsoid( $node )->dsr ?? null;
			// Set a zero-width dsr range for the fallback id
			if ( Utils::isValidDSR( $nodeDsr ) ) {
				$offset = $nodeDsr->innerStart();
				DOMDataUtils::getDataParsoid( $span )->dsr = new DomSourceRange( $offset, $offset, null, null );
			}
			$node->insertBefore( $span, $node->firstChild );
		}

		return true;
	}

	/**
	 * Our own version of node.textContent which handles LanguageVariant
	 * markup the same way PHP does (ie, uses the source wikitext), and
	 * handles <style>/<script> tags the same way PHP does (ie, ignores
	 * the contents)
	 * @param Node $node
	 * @return string
	 */
	private static function textContentOf( Node $node ): string {
		$str = '';
		if ( $node->hasChildNodes() ) {
			foreach ( $node->childNodes as $n ) {
				if ( $n instanceof Text ) {
					$str .= $n->nodeValue;
				} elseif ( DOMUtils::hasTypeOf( $n, 'mw:LanguageVariant' ) ) {
					// Special case for -{...}-
					// @phan-suppress-next-line PhanTypeMismatchArgumentSuperType
					$dp = DOMDataUtils::getDataParsoid( $n );
					$str .= $dp->src ?? '';
				} elseif ( DOMCompat::nodeName( $n ) === 'style' || DOMCompat::nodeName( $n ) === 'script' ) {
					/* ignore children */
				} else {
					$str .= self::textContentOf( $n );
				}
			}
		}
		return $str;
	}

	/**
	 * see Parser::normalizeSectionName in Parser.php and T90902
	 * @param string $text
	 * @param Env $env
	 * @return string
	 */
	private static function normalizeSectionName( string $text, Env $env ): string {
		try {
			$title = $env->makeTitleFromURLDecodedStr( "#{$text}" );
			return $title->getFragment();
		} catch ( TitleException $e ) {
			return $text;
		}
	}

	/**
	 * @param array &$seenIds
	 * @param Node $node
	 * @return bool
	 */
	public static function dedupeHeadingIds( array &$seenIds, Node $node ): bool {
		// NOTE: This is not completely compliant with how PHP parser does it.
		// If there is an id in the doc elsewhere, this will assign
		// the heading a suffixed id, whereas the PHP parser processes
		// headings in textual order and can introduce duplicate ids
		// in a document in the process.
		//
		// However, we believe this implementation behavior is more
		// consistent when handling this edge case, and in the common
		// case (where heading ids won't conflict with ids elsewhere),
		// matches PHP parser behavior.
		if ( !$node instanceof Element ) {
			// Not an Element
			return true;
		}

		if ( !$node->hasAttribute( 'id' ) ) {
			return true;
		}
		$key = $node->getAttribute( 'id' );
		// IE 7 required attributes to be case-insensitively unique (T12721)
		// but it did not support non-ASCII IDs. We don't support IE 7 anymore,
		// but changing the algorithm would change the relevant fragment URLs.
		// This case folding and matching algorithm has to stay exactly the
		// same to preserve external links to the page.
		$key = strtolower( $key );
		if ( !isset( $seenIds[$key] ) ) {
			$seenIds[$key] = 1;
			return true;
		}
		// Only update headings and legacy links (first children of heading)
		if ( preg_match( '/^h\d$/D', DOMCompat::nodeName( $node ) ) ||
			WTUtils::isFallbackIdSpan( $node )
		) {
			$suffix = ++$seenIds[$key];
			while ( !empty( $seenIds[$key . '_' . $suffix] ) ) {
				$suffix++;
				$seenIds[$key]++;
			}
			$node->setAttribute( 'id', $node->getAttribute( 'id' ) . '_' . $suffix );
			$seenIds[$key . '_' . $suffix] = 1;
		}
		return true;
	}
}
