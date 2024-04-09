<?php

namespace MWParsoid;

class RegistrationHookHandler {
	public static function onRegistration() {
		// Use globals instead of Config.
		// Accessing Config so early blows up unrelated extensions (T267146)
		global $wgRestAPIAdditionalRouteFiles, $wgParsoidEnableREST;
		if ( $wgParsoidEnableREST ) {
			$wgRestAPIAdditionalRouteFiles[] = __DIR__ . '/../restRoutes.json';
		}
	}
}
