<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class AddLinkClasses implements Wt2HtmlDOMProcessor {
	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		'@phan-var Element|DocumentFragment $root';  // @var Element|DocumentFragment $root
		// Add class info to ExtLink information.
		// Currently positions the class immediately after the rel attribute
		// to keep tests stable.
		$extLinks = DOMCompat::querySelectorAll( $root, 'a[rel~="mw:ExtLink"]' );
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
		// Add classes to Interwiki links
		$iwLinks = DOMCompat::querySelectorAll( $root, 'a[rel~="mw:WikiLink/Interwiki"]' );
		foreach ( $iwLinks as $a ) {
			DOMCompat::getClassList( $a )->add( 'extiw' );
		}
	}
}
