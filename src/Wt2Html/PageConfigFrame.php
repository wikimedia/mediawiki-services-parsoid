<?php

namespace Parsoid\Wt2Html;

use Parsoid\Config\Env;
use Parsoid\Config\PageConfig;

/**
 * A special subclass of frame used for the topmost frame in the environment;
 * gets most of its actual data from a PageConfig object.
 */
class PageConfigFrame extends Frame {

	/**
	 * Create a top-level frame.
	 * @param Env $env
	 * @param PageConfig $pageConfig
	 */
	public function __construct( Env $env, PageConfig $pageConfig ) {
		parent::__construct(
			$pageConfig->getTitle(),
			$env,
			[],
			$pageConfig->getRevisionContent()->getContent( 'main' ),
			null
		);
	}
	// XXX: override getSrcText() to mirror $pageConfig, if the $pageConfig
	// is mutable?
}
