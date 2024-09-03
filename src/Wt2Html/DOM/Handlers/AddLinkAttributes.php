<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Handlers;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\DTState;
use Wikimedia\Parsoid\Utils\WTUtils;

class AddLinkAttributes {

	/**
	 * Adds classes to external links and interwiki links
	 */
	public static function handler( Element $a, DTState $state ): bool {
		if ( DOMUtils::hasRel( $a, "mw:ExtLink" ) ) {
			if ( $a->firstChild ) {
				// The "external free" class is reserved for links which
				// are syntactically unbracketed; see commit
				// 65fcb7a94528ea56d461b3c7b9cb4d4fe4e99211 in core.
				if ( WTUtils::isATagFromURLLinkSyntax( $a ) ) {
					$classInfoText = 'external free';
				} elseif ( WTUtils::isATagFromMagicLinkSyntax( $a ) ) {
					// PHP uses specific suffixes for RFC/PMID/ISBN (the last of
					// which is an internal link, not an mw:ExtLink), but we'll
					// keep it simple since magic links are deprecated.
					$classInfoText = 'external mw-magiclink';
				} else {
					$classInfoText = 'external text';
				}
			} else {
				$classInfoText = 'external autonumber';
			}
			$a->setAttribute( 'class', $classInfoText );
			$href = DOMCompat::getAttribute( $a, 'href' ) ?? '';
			$attribs = $state->env->getExternalLinkAttribs( $href );
			foreach ( $attribs as $key => $val ) {
				if ( $key === 'rel' ) {
					foreach ( $val as $v ) {
						DOMUtils::addRel( $a, $v );
					}
				} else {
					$a->setAttribute( $key, $val );
				}
			}
		} elseif ( DOMUtils::hasRel( $a, 'mw:WikiLink/Interwiki' ) ) {
			DOMCompat::getClassList( $a )->add( 'extiw' );
		}
		return true;
	}
}
