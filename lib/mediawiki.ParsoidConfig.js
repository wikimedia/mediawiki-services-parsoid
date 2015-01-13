/*
 * Parsoid-specific configuration. We'll use this object to configure
 * interwiki regexes, mostly.
 */
"use strict";

require('./core-upgrade.js');
var url = require('url'),
	Cite = require('./ext.Cite.js').Cite,
	Util = require('./mediawiki.Util.js').Util,
	sitematrix = require('./sitematrix.json').sitematrix;


/**
 * @class
 *
 * Global Parsoid configuration object. Will hold things like debug/trace
 * options, interwiki map, and local settings like fetchTemplates.
 *
 * @constructor
 * @param {Object} localSettings The localSettings object, probably from a localsettings.js file.
 * @param {Function} localSettings.setup The local settings setup function, which sets up our local configuration.
 * @param {ParsoidConfig} localSettings.setup.opts The setup function is passed the object under construction so it can extend the config directly.
 * @param {Object} options Any options we want to set over the defaults. Will not overwrite things set by the localSettings.setup function. See the class properties for more information.
 */
function ParsoidConfig( localSettings, options ) {
	this.interwikiMap = new Map();
	this.reverseIWMap = new Map();
	this.apiProxyURIs = new Map();
	this.interwikiRegexp = "";

	if ( localSettings && localSettings.setup ) {
		localSettings.setup( this );
	}

	// Don't freak out!
	// This happily overwrites inherited properties.
	if (options) {
		Object.assign( this, options );
	}

	if ( this.loadWMF ) {
		this.initInterwikiMap();
	}

	// SSS FIXME: Hardcoded right now, but need a generic registration mechanism
	// for native handlers
	this.nativeExtensions = {
		cite: new Cite()
	};

	// Permissive CORS headers as Parsoid is full idempotent currently
	this.allowCORS = '*';
}

/**
 * @method
 *
 * Set an interwiki prefix.
 *
 * @param {string} prefix
 * @param {string} apiURI The URL to the wiki's api.php.
 * @param {string} apiProxyURI The URL of a proxy to use for API requests, or
 * null to explicitly disable API request proxying for this wiki. Will fall
 * back to ParsoidConfig.defaultAPIProxyURI if undefined (default value).
 */
ParsoidConfig.prototype.setInterwiki = function( prefix, apiURI, apiProxyURI ) {
	this.interwikiMap.set( prefix, apiURI );
	this.reverseIWMap.set( url.parse( apiURI ).host, prefix );

	if ( apiProxyURI !== undefined ) {
		this.apiProxyURIs.set(prefix, apiProxyURI);
	} else {
		this.apiProxyURIs.delete(prefix);
	}

	if ( this.interwikiRegexp.match( '(^|\\|)' + prefix + '(\\||$)' ) === null ) {
		this.interwikiRegexp += (this.interwikiRegexp ? '|' : '') + prefix;
	}
};

/**
 * @method
 *
 * Remove an interwiki prefix.
 *
 * @param {string} prefix
 */
ParsoidConfig.prototype.removeInterwiki = function( prefix ) {
	if ( !this.interwikiMap.has(prefix) ) {
		return;
	}
	var u = url.parse( this.interwikiMap.get(prefix) );
	this.reverseIWMap.delete(u.host);
	this.interwikiMap.delete(prefix);
	this.apiProxyURIs.delete(prefix);
	this.interwikiRegexp = this.interwikiRegexp.replace(
		new RegExp( '(^|\\|)' + prefix + '(\\||$)' ), function() {
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
 * @property {boolean} fetchWT
 * When transforming from html to wt, fetch the original wikitext before.
 * Intended for use in round-trip testing.
 */
 ParsoidConfig.prototype.fetchWT = false;

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
 * The default api proxy, overridden by apiProxyURIs entries.
 */
ParsoidConfig.prototype.defaultAPIProxyURI = undefined;

/**
 * Load WMF sites in the interwikiMap from the cached sitematrix.json
 */
ParsoidConfig.prototype.loadWMF = true;

/**
 * Initialize the interwikiMap and friends.
 */
ParsoidConfig.prototype.initInterwikiMap = function() {
	var insertInMaps = function( proxy, site ) {
		// Avoid overwriting those already set in localsettings setup.
		if ( !this.interwikiMap.has( site.dbname ) ) {
			this.setInterwiki( site.dbname, site.url + "/w/api.php", proxy );
		}
	};

	// See MWParserEnvironment.prototype.getAPIProxyURI for these values.
	var normal = insertInMaps.bind(this, undefined);
	var special = insertInMaps.bind(this, null);

	Object.keys( sitematrix ).forEach(function( key ) {
		var val = sitematrix[key];
		if ( !Number.isNaN( Number(key) ) ) {
			val.site.forEach(normal);
		} else if ( key === "specials" ) {
			val.forEach(special);
		}
	});
};


if (typeof module === "object") {
	module.exports.ParsoidConfig = ParsoidConfig;
}
