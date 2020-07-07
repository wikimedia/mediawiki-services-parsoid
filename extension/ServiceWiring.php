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

	'ParsoidSettings' => function ( MediaWikiServices $services ): array {
		# Unified location for default parsoid settings.

		$parsoidSettings = [
			# Default parsoid settings, for 'no config' install.
			'useSelser' => true,
		];
		try {
			$parsoidSettings =
				$services->getMainConfig()->get( 'ParsoidSettings' )
				+ $parsoidSettings;
		} catch ( ConfigException $e ) {
			/* Config option isn't defined, use defaults */
		}
		return $parsoidSettings;
	},

	'ParsoidSiteConfig' => function ( MediaWikiServices $services ): SiteConfig {
		$parsoidSettings = $services->get( 'ParsoidSettings' );
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
		$parsoidSettings = $services->get( 'ParsoidSettings' );
		if ( !empty( $parsoidSettings['debugApi'] ) ) {
			return ApiDataAccess::fromSettings( $parsoidSettings );
		}
		return new MWDataAccess( $services->getRevisionStore(), $services->getParser(),
			$services->get( '_ParsoidParserOptions' ) );
	},

	'_ParsoidParserOptions' => function ( MediaWikiServices $services ): ParserOptions {
		global $wgUser;

		// Pass a dummy user: Parsoid's parses don't use the user context right now
		// and all user state is expected to be introduced as a post-parse transformation
		// It is unclear if wikitext supports this model. But, given that Parsoid/JS
		// operated in this fashion, for now, Parsoid/PHP will as well with the caveat below.
		// ParserOptions used to default to $wgUser if we passed in null here (and new User()
		// if $wgUser was null as it would be in most background job parsing contexts).
		return ParserOptions::newCanonical( $wgUser ?? new User() );
	},

];
