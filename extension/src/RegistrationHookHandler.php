<?php

namespace MWParsoid;

use MediaWiki\MediaWikiServices;

class RegistrationHookHandler {
	public static function onRegistration() {
		global $wgRestAPIAdditionalRouteFiles;
		// phpcs:ignore MediaWiki.NamingConventions.ValidGlobalName.allowedPrefix
		global $IP;

		$config = MediaWikiServices::getInstance()->getMainConfig();
		if ( $config->get( 'ParsoidEnableREST' ) ) {
			$wgRestAPIAdditionalRouteFiles[] = wfRelativePath(
				__DIR__ . '/../restRoutes.json', $IP
			);
		}
	}
}
