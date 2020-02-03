<?php

use MediaWiki\MediaWikiServices;
use MWParsoid\Config\DataAccess as MWDataAccess;
use MWParsoid\Config\PageConfigFactory;
use MWParsoid\Config\SiteConfig as MWSiteConfig;
use Wikimedia\Parsoid\Config\Api\DataAccess as ApiDataAccess;
use Wikimedia\Parsoid\Config\Api\SiteConfig as ApiSiteConfig;
use Wikimedia\Parsoid\Config\DataAccess;
use Wikimedia\Parsoid\Config\SiteConfig;

return [

	'ParsoidSiteConfig' => function ( MediaWikiServices $services ): SiteConfig {
		$parsoidSettings = $services->getMainConfig()->get( 'ParsoidSettings' );
		if ( !empty( $parsoidSettings['debugApi'] ) ) {
			return ApiSiteConfig::fromSettings( $parsoidSettings );
		}
		return new MWSiteConfig();
	},

	'ParsoidPageConfigFactory' => function ( MediaWikiServices $services ): PageConfigFactory {
		return new PageConfigFactory( $services->getRevisionStore(), $services->getParser(),
			$services->get( '_ParsoidParserOptions' ), $services->getSlotRoleRegistry() );
	},

	'ParsoidDataAccess' => function ( MediaWikiServices $services ): DataAccess {
		$parsoidSettings = $services->getMainConfig()->get( 'ParsoidSettings' );
		if ( !empty( $parsoidSettings['debugApi'] ) ) {
			return ApiDataAccess::fromSettings( $parsoidSettings );
		}
		return new MWDataAccess( $services->getRevisionStore(), $services->getParser(),
			$services->get( '_ParsoidParserOptions' ) );
	},

	'_ParsoidParserOptions' => function ( MediaWikiServices $services ): ParserOptions {
		// FIXME /transform/ endpoints should probably use the current user?
		return ParserOptions::newCanonical();
	},

];
