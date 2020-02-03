<?php
declare( strict_types = 1 );

namespace MWParsoid;

use MediaWiki\MediaWikiServices;
use MWParsoid\Config\PageConfigFactory;
use Wikimedia\Parsoid\Config\DataAccess;
use Wikimedia\Parsoid\Config\SiteConfig;

// phpcs:disable MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic
class ParsoidServices {

	/** @var MediaWikiServices */
	private $services;

	public function __construct( MediaWikiServices $services ) {
		$this->services = $services;
	}

	public function getParsoidSiteConfig(): SiteConfig {
		return $this->services->get( 'ParsoidSiteConfig' );
	}

	public function getParsoidPageConfigFactory(): PageConfigFactory {
		return $this->services->get( 'ParsoidPageConfigFactory' );
	}

	public function getParsoidDataAccess(): DataAccess {
		return $this->services->get( 'ParsoidDataAccess' );
	}

}
