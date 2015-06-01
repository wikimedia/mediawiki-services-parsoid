/*
 * This is a sample configuration file.
 *
 * Copy this file to localsettings.js and edit that file to fit your needs.
 *
 * Also see:
 * - api/server.js for more information about passing config files via
 *   the commandline.
 * - lib/mediawiki.ParsoidConfig.js all the properties
 *   that you can configure here. Not all properties are
 *   documented here.
 */
'use strict';

exports.setup = function(parsoidConfig) {
	// Set your own user-agent string
	// Otherwise, defaults to "Parsoid/<current-version-defined-in-package.json>"
	//parsoidConfig.userAgent = "My-User-Agent-String";

	// The URL of your MediaWiki API endpoint.
	parsoidConfig.setMwApi('localhost', { uri: 'http://localhost/w/api.php' });
	// To specify a proxy (or proxy headers) specific to this prefix (which
	// overrides defaultAPIProxyURI) use:
	/*
	parsoidConfig.setMwApi('localhost', {
		uri: 'http://localhost/w/api.php',
		// set `proxy` to `null` to override and force no proxying.
		proxy: {
			uri: 'http://my.proxy:1234/',
			headers: { 'X-Forwarded-Proto': 'https' } // headers are optional
		}
	});
	*/

	// We pre-define wikipedias as 'enwiki', 'dewiki' etc. Similarly
	// for other projects: 'enwiktionary', 'enwikiquote', 'enwikibooks',
	// 'enwikivoyage' etc. (default true)
	//parsoidConfig.loadWMF = false;

	// A default proxy to connect to the API endpoints.
	// Default: undefined (no proxying).
	// Overridden by per-wiki proxy config in setMwApi.
	//parsoidConfig.defaultAPIProxyURI = 'http://proxy.example.org:8080';

	// Enable debug mode (prints extra debugging messages)
	//parsoidConfig.debug = true;

	// Use the PHP preprocessor to expand templates via the MW API (default true)
	//parsoidConfig.usePHPPreProcessor = false;

	// Use selective serialization (default false)
	parsoidConfig.useSelser = true;

	// Allow cross-domain requests to the API (default '*')
	// Sets Access-Control-Allow-Origin header
	// disable:
	//parsoidConfig.allowCORS = false;
	// restrict:
	//parsoidConfig.allowCORS = 'some.domain.org';

	// Set to true for using the default performance metrics reporting to statsd
	// If true, provide the statsd host/port values
	/*
	parsoidConfig.useDefaultPerformanceTimer = true;
	parsoidConfig.txstatsdHost = 'statsd.domain.org';
	parsoidConfig.txstatsdPort = 8125;
	*/

	// Alternatively, define performanceTimer as follows:
	/*
	parsoidConfig.performanceTimer = {
		timing: function(metricName, time) { }, // do-something-with-it
		count: function(metricName, value) { }, // do-something-with-it
	};
	*/

	// How often should we emit a heap sample? Time in ms.
	// This setting is only relevant if you have enabled
	// performance monitoring either via the default metrics
	// OR by defining your own performanceTimer properties
	//parsoidConfig.heapUsageSampleInterval = 5 * 60 * 1000;

	// Allow override of port/interface:
	//parsoidConfig.serverPort = 8000;
	//parsoidConfig.serverInterface = '127.0.0.1';

	// The URL of your LintBridge API endpoint
	//parsoidConfig.linterAPI = 'http://lintbridge.wmflabs.org/add';

	// Require SSL certificates to be valid (default true)
	// Set to false when using self-signed SSL certificates
	//parsoidConfig.strictSSL = false;

	// Use a different server for CSS style modules.
	// Set to true to use bits.wikimedia.org, or to a string with the URI.
	// Leaving it undefined (the default) will use the same URI as the MW API,
	// changing api.php for load.php.
	//parsoidConfig.modulesLoadURI = true;

	// Suppress some warnings from the Mediawiki API
	// (defaults to suppressing warnings which the Parsoid team knows to
	// be harmless)
	//parsoidConfig.suppressMwApiWarnings = /annoying warning|other warning/;
};
