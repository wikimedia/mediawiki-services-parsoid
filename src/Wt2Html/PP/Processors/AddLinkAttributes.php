<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\SiteConfig;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\UrlUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class AddLinkAttributes implements Wt2HtmlDOMProcessor {
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
			$ns = $env->getPageConfig()->getNs();
			$url = $a->getAttribute( 'href' );
			if ( $this->noFollowExternalLink( $env->getSiteConfig(), $ns, $url ) ) {
				DOMUtils::addRel( $a, 'nofollow' );
			}
			$target = $env->getSiteConfig()->getExternalLinkTarget();
			if ( $target ) {
				$a->setAttribute( 'target', $target );
				if ( !in_array( $target, [ '_self', '_parent', '_top' ], true ) ) {
					// T133507. New windows can navigate parent cross-origin.
					// Including noreferrer due to lacking browser
					// support of noopener. Eventually noreferrer should be removed.
					DOMUtils::addRel( $a, 'noreferrer' );
					DOMUtils::addRel( $a, 'noopener' );
				}
			}
		}
		// Add classes to Interwiki links
		$iwLinks = DOMCompat::querySelectorAll( $root, 'a[rel~="mw:WikiLink/Interwiki"]' );
		foreach ( $iwLinks as $a ) {
			DOMCompat::getClassList( $a )->add( 'extiw' );
		}
	}

	/**
	 * Returns true if the provided external link should have the nofollow attribute
	 * @param SiteConfig $config
	 * @param int $ns namespace of the current page
	 * @param string $url url of the external link
	 * @return bool
	 */
	private function noFollowExternalLink( SiteConfig $config, int $ns, string $url ): bool {
		$noFollowConfig = $config->getNoFollowConfig();

		return $noFollowConfig['nofollow']
			&& !in_array( $ns, $noFollowConfig['nsexceptions'], true )
			&& !UrlUtils::matchesDomainList( $url, $noFollowConfig['domainexceptions'] );
	}
}
