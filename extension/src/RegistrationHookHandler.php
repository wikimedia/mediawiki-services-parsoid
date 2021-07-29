<?php

namespace MWParsoid;

class RegistrationHookHandler {
	public static function onRegistration() {
		global $wgRestAPIAdditionalRouteFiles;
		// phpcs:ignore MediaWiki.NamingConventions.ValidGlobalName.allowedPrefix
		global $IP;
		// Use globals instead of Config.
		// Accessing it so early blows up unrelated extensions (T267146)
		global $wgParsoidEnableREST;
		if ( $wgParsoidEnableREST ) {
			$wgRestAPIAdditionalRouteFiles[] = wfRelativePath(
				__DIR__ . '/../restRoutes.json', $IP
			);
		}
		// ensure DOM implementation aliases are set up
		// FIXME: By the time this code is executed,
		// vendor/wikimedia/parsoid/DomImpl.php will have already been
		// evaluated if the 'released' version of Parsoid in mediawiki-vendor
		// has this file.  So test the global here to ensure that we
		// don't end up executing DomImpl.php twice (and generating warnings
		// about duplicate aliases).  However, if the 'unreleased' version
		// of Parsoid makes changes to the DOM mapping, it may still be
		// necessary to do some fixups here (additional mappings).
		// You can use $wgParsoidDomImplVersion to determine what version of
		// the mappings has already been set up.
		global $wgParsoidUseDodo;
		if ( !isset( $wgParsoidUseDodo ) ) {
			require_once __DIR__ . '/../../DomImpl.php';
		}
	}
}
