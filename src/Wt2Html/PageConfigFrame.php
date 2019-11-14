<?php

namespace Parsoid\Wt2Html;

use Parsoid\Config\Env;
use Parsoid\Config\PageConfig;
use Parsoid\Config\SiteConfig;
use Parsoid\Utils\Title;

use Wikimedia\Assert\Assert;

/**
 * A special subclass of frame used for the topmost frame in the environment;
 * gets most of its actual data from a PageConfig object.
 */
class PageConfigFrame extends Frame {

	/**
	 * Create a top-level frame.
	 * @param Env $env
	 * @param PageConfig $pageConfig
	 * @param SiteConfig $siteConfig
	 * @param bool $titleShouldExist Do we expect title to exist?
	 *   If so, be strict about missing page content.
	 */
	public function __construct(
		Env $env, PageConfig $pageConfig, SiteConfig $siteConfig, bool $titleShouldExist = true
	) {
		$rev = $pageConfig->getRevisionContent();
		Assert::invariant(
			$rev !== null || !$titleShouldExist,
			'Missing revision for a title that should exist.'
		);
		$content = $rev ? $rev->getContent( 'main' ) : '';
		parent::__construct(
			// It would be nicer to have the Title object directly available
			// from PageConfig, but we're trying to keep Parsoid's Title
			// object separate from MediaWiki's Title object.  When/if they
			// are unified, we could get use the PageConfig's Title directly
			// when constructing the Frame.
			Title::newFromText( $pageConfig->getTitle(), $siteConfig ),
			$env,
			[],
			$content,
			null
		);
	}
	// XXX: override getSrcText() to mirror $pageConfig, if the $pageConfig
	// is mutable?
}
