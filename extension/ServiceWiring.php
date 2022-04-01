<?php
/**
 * Copyright (C) 2011-2020 Wikimedia Foundation and others.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

use MediaWiki\Config\ServiceOptions;
use MediaWiki\MediaWikiServices;
use MWParsoid\Config\DataAccess as MWDataAccess;
use MWParsoid\Config\PageConfigFactory as MWPageConfigFactory;
use MWParsoid\Config\SiteConfig as MWSiteConfig;
use Wikimedia\Parsoid\Config\Api\DataAccess as ApiDataAccess;
use Wikimedia\Parsoid\Config\Api\SiteConfig as ApiSiteConfig;
use Wikimedia\Parsoid\Config\DataAccess;
use Wikimedia\Parsoid\Config\PageConfigFactory;
use Wikimedia\Parsoid\Config\SiteConfig;

// Compatibility: we're going to move this code to core eventually; this
// ensures we yield gracefully to core's implementation when it exists.
if ( class_exists( '\MediaWiki\Parser\Parsoid\ParsoidServices' ) ) {
	return [];
}

return [

	'ParsoidSiteConfig' => static function ( MediaWikiServices $services ): SiteConfig {
		$mainConfig = $services->getMainConfig();
		$parsoidSettings = $mainConfig->get( 'ParsoidSettings' );
		if ( !empty( $parsoidSettings['debugApi'] ) ) {
			return ApiSiteConfig::fromSettings( $parsoidSettings );
		}
		return new MWSiteConfig(
			new ServiceOptions( MWSiteConfig::CONSTRUCTOR_OPTIONS, $mainConfig ),
			$parsoidSettings,
			$services->getObjectFactory(),
			$services->getContentLanguage(),
			$services->getStatsdDataFactory(),
			$services->getMagicWordFactory(),
			$services->getNamespaceInfo(),
			$services->getSpecialPageFactory(),
			$services->getInterwikiLookup(),
			$services->getUserOptionsLookup(),
			$services->getLanguageFactory(),
			$services->getLanguageConverterFactory(),
			$services->getLanguageNameUtils(),
			// These arguments are temporary and will be removed once
			// better solutions are found.
			$services->getParser(), // T268776
			$mainConfig // T268777
		);
	},

	'ParsoidPageConfigFactory' => static function ( MediaWikiServices $services ): PageConfigFactory {
		return new MWPageConfigFactory( $services->getRevisionStore(),
			$services->getSlotRoleRegistry() );
	},

	'ParsoidDataAccess' => static function ( MediaWikiServices $services ): DataAccess {
		$parsoidSettings = $services->getMainConfig()->get( 'ParsoidSettings' );
		if ( !empty( $parsoidSettings['debugApi'] ) ) {
			return ApiDataAccess::fromSettings( $parsoidSettings );
		}
		return new MWDataAccess(
			$services->getRepoGroup(),
			$services->getBadFileLookup(),
			$services->getHookContainer(),
			$services->getContentTransformer(),
			$services->getParserFactory() // *legacy* parser factory
		);
	},
];
