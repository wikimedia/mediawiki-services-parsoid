/*
 * This is a sample configuration file.
 *
 * Copy this file to localsettings.js and edit that file to fit your needs.
 *
 * Also see the file ParserService.js for more information.
 */
"use strict";

exports.setup = function( parsoidConfig ) {
	// The URL here is supposed to be your MediaWiki installation root
	parsoidConfig.setInterwiki( 'localhost', process.env.PARSOID_MOCKAPI_URL );

	// Use the PHP preprocessor to expand templates via the MW API (default true)
	//parsoidConfig.usePHPPreProcessor = false;

	// Use selective serialization (default false)
	//parsoidConfig.useSelser = true;

	// allow cross-domain requests to the API (default disallowed)
	//parsoidConfig.allowCORS = '*';

	// Set rtTestMode to true for round-trip testing
	parsoidConfig.rtTestMode = true;

	// Fetch the wikitext for a page before doing html2wt
	parsoidConfig.fetchWT = true;
};
