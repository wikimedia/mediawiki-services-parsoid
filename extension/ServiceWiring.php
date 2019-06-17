<?php

use MediaWiki\MediaWikiServices;
use MWParsoid\Config\DataAccess as MWDataAccess;
use MWParsoid\Config\PageConfigFactory;
use MWParsoid\Config\SiteConfig as MWSiteConfig;
use Parsoid\Config\DataAccess;
use Parsoid\Config\SiteConfig;

return [

	'ParsoidSiteConfig' => function ( MediaWikiServices $services ): SiteConfig {
		return new MWSiteConfig();
	},

	'ParsoidPageConfigFactory' => function ( MediaWikiServices $services ): PageConfigFactory {
		return new PageConfigFactory( $services->getRevisionStore(), $services->getParser(),
			$services->get( '_ParsoidParserOptions' ), $services->getSlotRoleRegistry() );
	},

	'ParsoidDataAccess' => function ( MediaWikiServices $services ): DataAccess {
		return new MWDataAccess( $services->getRevisionStore(), $services->getParser(),
			$services->get( '_ParsoidParserOptions' ) );
	},

	'_ParsoidParserOptions' => function ( MediaWikiServices $services ): ParserOptions {
		// FIXME /transform/ endpoints should probably use the current user?
		return ParserOptions::newCanonical();
	},

];
