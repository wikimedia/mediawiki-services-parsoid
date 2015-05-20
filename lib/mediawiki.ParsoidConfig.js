/*
 * Parsoid-specific configuration. We'll use this object to configure
 * mw api regexes, mostly.
 */
'use strict';
require('./core-upgrade.js');

var url = require('url');
var Cite = require('./ext.Cite.js').Cite;
var Util = require('./mediawiki.Util.js').Util;
var JSUtils = require('./jsutils.js').JSUtils;
var sitematrix = require('./sitematrix.json').sitematrix;


/**
 * @class
 *
 * Global Parsoid configuration object. Will hold things like debug/trace
 * options, mw api map, and local settings like fetchTemplates.
 *
 * @constructor
 * @param {Object} localSettings The localSettings object, probably from a localsettings.js file.
 * @param {Function} localSettings.setup The local settings setup function, which sets up our local configuration.
 * @param {ParsoidConfig} localSettings.setup.opts The setup function is passed the object under construction so it can extend the config directly.
 * @param {Object} options Any options we want to set over the defaults. Will not overwrite things set by the localSettings.setup function. See the class properties for more information.
 */
function ParsoidConfig(localSettings, options) {
	this.mwApiMap = new Map();
	this.reverseMwApiMap = new Map();
	this.mwApiRegexp = "";

	if (localSettings && localSettings.setup) {
		localSettings.setup(this);
	}

	// Don't freak out!
	// This happily overwrites inherited properties.
	if (options) {
		Object.assign(this, options);
	}

	if (this.loadWMF) {
		this.initMwApiMap();
	}

	// SSS FIXME: Hardcoded right now, but need a generic registration mechanism
	// for native handlers
	this.nativeExtensions = {
		cite: new Cite(),
	};

	// Permissive CORS headers as Parsoid is full idempotent currently
	this.allowCORS = '*';

	// Timer that reports metrics to statsd
	if (this.useDefaultPerformanceTimer) {
		this.performanceTimer = new Util.StatsD(this.txstatsdHost, this.txstatsdPort);
	}

	// ParsoidConfig is used across requests. Freeze it to avoid mutation.
	var ignoreFields = {
		performanceTimer: true,
		loggerBackend: true,
		nativeExtensions: true,
	};
	for (var prop in this) {
		var desc = Object.getOwnPropertyDescriptor(this, prop);
		if (ignoreFields[prop] === true || (!desc) || desc.get || desc.set) {
			// Ignore getters, primitives, and explicitly ignored fields.
			return;
		}
		this[prop] = JSUtils.deepFreeze(desc.value);
	}
	Object.freeze(this.nativeExtensions); // Shallow freeze: see T93974
	Object.freeze(this);
}

/**
 * @method
 *
 * Set an mw api prefix.
 *
 * @param {string} prefix
 * @param {string|object} If a string, apiConf is the apiURI.
 * @param {string} apiConf.uri The URL to the wiki's api.php.
 * @param {string} apiConf.proxy.uri The URL of a proxy to use for API requests,
 * or null to explicitly disable API request proxying for this wiki. Will fall
 * back to ParsoidConfig.defaultAPIProxyURI if undefined (default value).
 * @param {object} apiConf.proxy.headers Headers to add when proxying.
 */
ParsoidConfig.prototype.setInterwiki =  // Alias for backwards compat.
ParsoidConfig.prototype.setMwApi = function(prefix, apiConf) {
	if (typeof apiConf === 'string') {
		apiConf = { uri: apiConf };
	}

	this.mwApiMap.set(prefix, apiConf);
	this.reverseMwApiMap.set(url.parse(apiConf.uri).host, prefix);

	if (this.mwApiRegexp.match('(^|\\|)' + prefix + '(\\||$)') === null) {
		this.mwApiRegexp += (this.mwApiRegexp ? '|' : '') + prefix;
	}
};

/**
 * @method
 *
 * Remove an mw api prefix.
 *
 * @param {string} prefix
 */
ParsoidConfig.prototype.removeInterwiki =  // Alias for backwards compat.
ParsoidConfig.prototype.removeMwApi = function(prefix) {
	if (!this.mwApiMap.has(prefix)) {
		return;
	}
	var u = url.parse(this.mwApiMap.get(prefix).uri);
	this.reverseMwApiMap.delete(u.host);
	this.mwApiMap.delete(prefix);
	this.mwApiRegexp = this.mwApiRegexp.replace(
		new RegExp('(^|\\|)' + prefix + '(\\||$)'), function() {
			return arguments[0] === ("|" + prefix + "|") ? "|" : '';
		}
	);
};

/**
 * @property {boolean} debug Whether to print debugging information.
 */
ParsoidConfig.prototype.debug = false;

/**
 * @property {Array} traceFlags Flags that tell us which tracing information to print.
 */
ParsoidConfig.prototype.traceFlags = null;

/**
 * @property {Array} debugFlags Flags that tell us which debugging information to print.
 */
ParsoidConfig.prototype.debugFlags = null;

/**
 * @property {Array} dumpFlags Flags that tell us what state to dump.
 */
ParsoidConfig.prototype.dumpFlags = null;

/**
 * @property {boolean} fetchTemplates Whether we should request templates from a wiki, or just use cached versions.
 */
ParsoidConfig.prototype.fetchTemplates = true;

/**
 * @property {boolean} expandExtensions Whether we should request extension tag expansions from a wiki.
 */
ParsoidConfig.prototype.expandExtensions = true;

/**
 * @property {number} maxDepth The maximum depth to which we should expand templates. Only applies if we would fetch templates anyway, and if we're actually expanding templates. So #fetchTemplates must be true and #usePHPPreProcessor must be false.
 */
ParsoidConfig.prototype.maxDepth = 40;

/**
 * @property {boolean} usePHPPreProcessor Whether we should use the PHP Preprocessor to expand templates, extension content, and the like. See #PHPPreProcessorRequest in lib/mediawiki.ApiRequest.js
 */
ParsoidConfig.prototype.usePHPPreProcessor = true;

/**
 * @property {string} defaultWiki The wiki we should use for template, page, and configuration requests. We set this as a default because a configuration file (e.g. the API service's localsettings) might set this, but we will still use the appropriate wiki when requests come in for a different prefix.
 */
ParsoidConfig.prototype.defaultWiki = 'enwiki';

/**
 * @property {boolean} useSelser Whether to use selective serialization when serializing a DOM to Wikitext. This amounts to not serializing bits of the page that aren't marked as having changed, and requires some way of getting the original text of the page. See #SelectiveSerializer in lib/mediawiki.SelectiveSerializer.js
 */
ParsoidConfig.prototype.useSelser = false;
ParsoidConfig.prototype.fetchConfig = true;

/**
 * @property {boolean} rtTestMode
 */
ParsoidConfig.prototype.rtTestMode = false;

/**
 * @property {number} Parsoid DOM format version
 * See https://bugzilla.wikimedia.org/show_bug.cgi?id=52937
 */
ParsoidConfig.prototype.version = 0;

/**
 * @property {boolean} storeDataParsoid
 */
ParsoidConfig.prototype.storeDataParsoid = false;

/**
 * @property {boolean} addHTMLTemplateParameters
 * When processing template parameters, parse them to HTML and add it to the
 * template parameters data.
 */
ParsoidConfig.prototype.addHTMLTemplateParameters = false;

/**
 * @property {boolean} linting Whether to enable linter Backend.
 */
ParsoidConfig.prototype.linting = false;

/**
 * @property {URL} linterAPI
 * The URL for LintBridge API endpoint
 */
ParsoidConfig.prototype.linterAPI = null;

/**
 * @property {Function} the logger output function
 * By default, use stderr to output logs.
 */
ParsoidConfig.prototype.loggerBackend = null;

/**
 * @property {Function} the tracer output function
 * By default, use stderr to output traces.
 */
ParsoidConfig.prototype.tracerBackend = null;

/**
 * @property {boolean} strictSSL
 * By default require SSL certificates to be valid
 * Set to false when using self-signed SSL certificates
 */
ParsoidConfig.prototype.strictSSL = true;

/**
 * The default api proxy, overridden by apiConf.proxy entries.
 */
ParsoidConfig.prototype.defaultAPIProxyURI = undefined;

/**
 * The server from which to load style modules.
 */
ParsoidConfig.prototype.modulesLoadURI = undefined;
ParsoidConfig.prototype.getModulesLoadURI = function(wikiConf) {
	if ( this.modulesLoadURI === undefined ) {
		// If not set, use the same as the API
		return wikiConf.apiURI.replace(/[^\/]*\/\//, '//') // proto-relative
			.replace(/\/api.php$/, '/load.php');
	} else if ( this.modulesLoadURI === true ) {
		// Use bits.wikimedia.org, we need the site URI
		return wikiConf.server.replace(/[^\/]*\/\//, '//bits.wikimedia.org/')
			+ '/load.php';
	} else {
		// Use the value
		return this.modulesLoadURI;
	}
};

/**
 * Load WMF sites in the mwApiMap from the cached sitematrix.json
 */
ParsoidConfig.prototype.loadWMF = true;

/**
 * Initialize the mwApiMap and friends.
 */
ParsoidConfig.prototype.initMwApiMap = function() {
	var insertInMaps = function(proxyURI, site) {
		// Avoid overwriting those already set in localsettings setup.
		if (!this.mwApiMap.has(site.dbname)) {
			var url = site.url;
			var proxyHeaders;
			// When proxying, strip TLS and lie to the appserver to indicate
			// unwrapping has just occurred. The appserver isn't listening on
			// port 443 but a site setting may require a secure connection,
			// which the header identifies.
			if (proxyURI === undefined && /https/.test(site.url)) {
				url = url.replace("https", "http");
				proxyHeaders = { "X-Forwarded-Proto": "https" };
			}
			var apiConf = {
				uri: url + "/w/api.php",
				proxy: {
					uri: proxyURI,
					headers: proxyHeaders,
				},
			};
			this.setMwApi(site.dbname, apiConf);
		}
	};

	// See MWParserEnvironment.prototype.getAPIProxy for the meaning
	// of null / undefined in setMwApi.

	var self = this;
	Object.keys( sitematrix ).forEach(function( key ) {
		var val = sitematrix[key];
		if ( !Number.isNaN( Number(key) ) ) {
			val.site.forEach(insertInMaps.bind(self, undefined));
		} else if ( key === "specials" ) {
			val.forEach(function( site ) {
				// Don't use the default proxy for restricted sites.
				// private: Restricted read and write access.
				// fishbowl: Restricted write access, full read access.
				// closed: No write access.
				var prv = site.hasOwnProperty("private") ||
					site.hasOwnProperty("fishbowl");
				insertInMaps.call( self, prv ? null : undefined, site );
			});
		}
	});
};

/**
 * @property {null} Settings for Performance timer.
 */
ParsoidConfig.prototype.performanceTimer = null;

if (typeof module === "object") {
	module.exports.ParsoidConfig = ParsoidConfig;
}
