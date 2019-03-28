<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\PP\Processors;

use DOMElement;
use Parsoid\Config\Env;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\WTUtils;

class AddExtLinkClasses {
	/**
	 * Add class info to ExtLink information.
	 * Currently positions the class immediately after the rel attribute
	 * to keep tests stable.
	 *
	 * @param DOMElement $body
	 * @param Env $env
	 * @param array|null $options
	 */
	public function run( DOMElement $body, Env $env, array $options = null ): void {
		$extLinks = DOMCompat::querySelectorAll( $body, 'a[rel~="mw:ExtLink"]' );
		foreach ( $extLinks as $a ) {
			$classInfoText = 'external autonumber';
			if ( $a->firstChild ) {
				$classInfoText = 'external text';
				// The "external free" class is reserved for links which
				// are syntactically unbracketed; see commit
				// 65fcb7a94528ea56d461b3c7b9cb4d4fe4e99211 in core.
				if ( WTUtils::usesURLLinkSyntax( $a ) ) {
					$classInfoText = 'external free';
				} elseif ( WTUtils::usesMagicLinkSyntax( $a ) ) {
					// PHP uses specific suffixes for RFC/PMID/ISBN (the last of
					// which is an internal link, not an mw:ExtLink), but we'll
					// keep it simple since magic links are deprecated.
					$classInfoText = 'external mw-magiclink';
				}
			}

			$a->setAttribute( 'class', $classInfoText );
		}
	}
}
