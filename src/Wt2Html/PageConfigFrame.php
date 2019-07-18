<?php

namespace Parsoid\Wt2Html;

use Parsoid\Config\Env;
use Parsoid\Config\PageConfig;
use Parsoid\Config\SiteConfig;
use Parsoid\Utils\Title;

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
	 */
	public function __construct( Env $env, PageConfig $pageConfig, SiteConfig $siteConfig ) {
		parent::__construct(
			// It would be nicer to have the Title object directly available
			// from PageConfig, but we're trying to keep Parsoid's Title
			// object separate from MediaWiki's Title object.  When/if they
			// are unified, we could get use the PageConfig's Title directly
			// when constructing the Frame.
			Title::newFromText( $pageConfig->getTitle(), $siteConfig ),
			$env,
			[],
			$pageConfig->getRevisionContent()->getContent( 'main' ),
			null
		);
	}
	// XXX: override getSrcText() to mirror $pageConfig, if the $pageConfig
	// is mutable?
}
