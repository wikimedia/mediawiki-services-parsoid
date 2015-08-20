/*
 * Parsoid-specific configuration.
 * This is immutable after initialization.
 */
'use strict';
require('./core-upgrade.js');

var url = require('url');
var Cite = require('./ext.Cite.js').Cite;
var Util = require('./mediawiki.Util.js').Util;
var JSUtils = require('./jsutils.js').JSUtils;
var sitematrix = require('./sitematrix.json').sitematrix;

/*
 * @property {Object} CONFIG_DEFAULTS
 *   Timeout values for various things. All values in ms.
 */
var CONFIG_DEFAULTS = Object.freeze({
	timeouts: {
		// How long does a request have to generate a response?
		request: 4 * 60 * 1000,

		// How long should the cluster master wait to receive a request done response?
		// If this timeout expires for a worker, the master kills that worker process
		// and lets it respawn. This timeout exists to detect runaway parsing scenarios.
		//
		// This should always be larger than the request timeout. The 1 min. after req.
		// timeout is buffer for the req. timeout to be caught and send a response to
		// the cluster master
		//
		// The CPU timeout is set to match the Varnish request timeout at 5 minutes.
		cpu: 5 * 60 * 1000,

		// These are timeouts for different api endpoints to the mediawiki API
		mwApi: {
			// action=expandtemplates
			preprocessor: 30 * 1000,
			// action=parse
			extParse: 30 * 1000,
			// action=parsoid-batch
			batch: 60 * 1000,
			// action=query&prop=revisions
			srcFetch: 40 * 1000,
			// action=query&prop=imageinfo
			imgInfo: 40 * 1000,
			// action=query&meta=siteinfo
			configInfo: 40 * 1000,
		},

		// This setting is ONLY relevant for Parsoid installs that
		// prepopulate Varnish via the job-queue.
		//
		// How long to receive a response from the Varnish cache?
		// SSS FIXME: 10 secs seems like a long time for only-if-cached
		parsoidCacheReq: 10 * 1000,

		// This setting is ONLY relevant for Parsoid installs that
		// prepopulate Varnish via the job-queue.
		//
		// How long to wait for a reparse?
		// SSS FIXME: So we are only waiting 50 secs. even though it could
		// take 4 mins to complete? Shouldn't this just be the request timeout?
		parsoidCacheReparse: 50 * 1000,
	},

	retries: {
		mwApi: {
			all: 1,
			// No retrying config requests
			// FIXME: but why? seems like 1 retry is not a bad idea
			configInfo: 0,
		},

		// This setting is ONLY relevant for Parsoid installs that
		// prepopulate Varnish via the job-queue.
		//
		// No retrying reqs. to varnish
		parsoidCacheReq: 0,
	},
});

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
	this.timeouts = Util.clone(CONFIG_DEFAULTS.timeouts);
	this.retries = Util.clone(CONFIG_DEFAULTS.retries);
	this._uniq = 0;

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

	// SSS FIXME: This overrides the localsettings.js setting
	// Permissive CORS headers as Parsoid is full idempotent currently
	this.allowCORS = '*';

	// Make sure all critical required properties are present
	this._sanitizeIt();

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

/**
 * @property {boolean} fetchConfig
 *   Whether to fetch the wiki config from the server or use our local copy.
 */
ParsoidConfig.prototype.fetchConfig = true;

/**
 * @property {boolean} fetchImageInfo
 *   Whether to fetch image info via the API or else treat all images as missing.
 */
ParsoidConfig.prototype.fetchImageInfo = true;

/**
 * @property {boolean} rtTestMode
 *   Test in rt test mode (changes some parse & serialization strategies)
 */
ParsoidConfig.prototype.rtTestMode = false;

/**
 * @property {number} version
 *   Parsoid DOM format version.
 *   See https://phabricator.wikimedia.org/T54937
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
 * @property {String|null} linterAPI
 * The URL for LintBridge API endpoint
 */
ParsoidConfig.prototype.linterAPI = null;

/**
 * @property {Function} loggerBackend
 * The logger output function.
 * By default, use stderr to output logs.
 */
ParsoidConfig.prototype.loggerBackend = null;

/**
 * @property {Function} tracerBackend
 * The tracer output function.
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

/**
 * Load WMF sites in the interwikiMap from the cached sitematrix.json
 */
ParsoidConfig.prototype.loadWMF = true;

/**
 * Set to true to use the Parsoid-specific batch API from the ParsoidBatchAPI
 * extension (action=parsoid-batch).
 */
ParsoidConfig.prototype.useBatchAPI = false;

/**
 * The batch size for parse/preprocess requests
 */
ParsoidConfig.prototype.batchSize = 50;

/**
 * The maximum number of concurrent requests that the API request batcher will
 * allow to be active at any given time. Before this limit is reached, requests
 * will be dispatched more aggressively, giving smaller batches on average.
 * After the limit is reached, batches will be stored in a queue with
 * APIBatchSize items in each batch.
 */
ParsoidConfig.prototype.batchConcurrency = 4;

/**
 * @property {null} Settings for Performance timer.
 */
ParsoidConfig.prototype.performanceTimer = null;

/**
 * @property {string} Default user agent used for making Mediawiki API requests
 */
ParsoidConfig.prototype.userAgent = "Parsoid/" + (require('../package.json').version);

/**
 * @property {number} Number of outstanding event listeners waiting on Mediawiki API responses
 */
ParsoidConfig.prototype.maxListeners = 50000;

/**
 * @property {number} Form size limit in bytes (default is 2M in express)
 */
ParsoidConfig.prototype.maxFormSize = 15 * 1024 * 1024;

/**
 * Log warnings from the Mediawiki Api.
 */
ParsoidConfig.prototype.logMwApiWarnings = true;

/**
 * Suppress some warnings by default.
 */
ParsoidConfig.prototype.suppressMwApiWarnings = /modulemessages is deprecated/;

/**
 * @property {number} How often should we emit a heap sample? Time in ms.
 *
 * Only relevant if performance timing is enabled
 */
ParsoidConfig.prototype.heapUsageSampleInterval = 5 * 60 * 1000;

ParsoidConfig.prototype.getModulesLoadURI = function(wikiConf) {
	if (this.modulesLoadURI === undefined) {
		// If not set, use the same as the API
		return wikiConf.apiURI.replace(/[^\/]*\/\//, '//') // proto-relative
			.replace(/\/api.php$/, '/load.php');
	} else if (this.modulesLoadURI === true) {
		// Use bits.wikimedia.org, we need the site URI
		return wikiConf.server.replace(/[^\/]*\/\//, '//bits.wikimedia.org/')
			+ '/load.php';
	} else {
		// Use the value
		return this.modulesLoadURI;
	}
};

/**
 * Initialize the mwApiMap and friends.
 */
ParsoidConfig.prototype.initMwApiMap = function() {
	var insertInMaps = function(proxyURI, site) {
		// Avoid overwriting those already set in localsettings setup.
		if (!this.mwApiMap.has(site.dbname)) {
			var url = site.url;
			var apiConf = {
				prefix: site.dbname,
				uri: url + "/w/api.php",
				proxy: {
					uri: proxyURI,
					// WMF production servers don't listen on port 443.
					// see mediawiki.ApiRequest for handling of this option.
					strip_https: true,
				},
			};
			this.setMwApi(apiConf);
		}
	};

	// See MWParserEnvironment.prototype.getAPIProxy for the meaning
	// of null / undefined in setMwApi.

	var self = this;
	Object.keys(sitematrix).forEach(function(key) {
		var val = sitematrix[key];
		if (!Number.isNaN(Number(key))) {
			val.site.forEach(insertInMaps.bind(self, undefined));
		} else if (key === "specials") {
			val.forEach(function(site) {
				// Don't use the default proxy for restricted sites.
				// private: Restricted read and write access.
				// fishbowl: Restricted write access, full read access.
				// closed: No write access.
				var prv = site.hasOwnProperty("private") ||
					site.hasOwnProperty("fishbowl");
				insertInMaps.call(self, prv ? null : undefined, site);
			});
		}
	});
};

/**
 * @method
 *
 * Set up a wiki configuration.
 *
 * For backward compatibility, if there are two arguments the first is
 * taken as a prefix and the second as the configuration, and if
 * the configuration is a string it is used as the `uri` property
 * in a new empty configuration object.  This usage is deprecated;
 * we recommend users pass a configuration object as documented below.
 *
 * @param {Object} apiConf
 *   The wiki configuration object.
 * @param {String} apiConf.uri
 *   The URL to the wiki's Action API (`api.php`).
 *   This is the only mandatory argument.
 * @param {String} [apiConf.domain]
 *   The "domain" used to identify this wiki when using the Parsoid v2 API.
 *   It defaults to the hostname portion of `apiConf.uri`.
 * @param {String} [apiConf.prefix]
 *   An arbitrary unique identifier for this wiki.  If none is provided
 *   a unique string will be generated.
 * @param {Object} [apiConf.proxy]
 *   A proxy configuration object.
 * @param {String|null} [apiConf.proxy.uri]
 *   The URL of a proxy to use for API requests, or null to explicitly
 *   disable API request proxying for this wiki. Will fall back to
 *   {@link ParsoidConfig#defaultAPIProxyURI} if `undefined` (default value).
 * @param {Object} [apiConf.proxy.headers]
 *   Headers to add when proxying.
 */
ParsoidConfig.prototype.setMwApi = function(apiConf) {
	var prefix;
	// Backward-compatibility with old calling conventions.
	if (typeof arguments[0] === 'string') {
		console.warn(
			'String arguments to ParsoidConfig#setMwApi are deprecated:',
			arguments[0]
		);
		if (typeof arguments[1] === 'string') {
			apiConf = { prefix: arguments[0], uri: arguments[1] };
		} else if (typeof arguments[1] === 'object') {
			// Note that `apiConf` is aliased to `arguments[0]`.
			prefix = arguments[0];
			apiConf = arguments[1]; // overwrites `arguments[0]`
			apiConf.prefix = prefix;
		} else {
			apiConf = { uri: arguments[0] };
		}
	}
	console.assert(apiConf.uri, "Action API uri is mandatory.");
	if (!apiConf.prefix) {
		// Pick a unique prefix.
		do {
			apiConf.prefix = 'wiki$' + (this._uniq++);
		} while (this.mwApiMap.has(apiConf.prefix));
	}
	if (!apiConf.domain) {
		apiConf.domain = url.parse(apiConf.uri).host;
	}
	prefix = apiConf.prefix;

	if (this.mwApiMap.has(prefix)) {
		this.reverseMwApiMap.delete(this.mwApiMap.get(prefix).domain);
	}
	this.mwApiMap.set(prefix, apiConf);
	this.reverseMwApiMap.set(apiConf.domain, prefix);

	if (this.mwApiRegexp.match('(^|\\|)' + prefix + '(\\||$)') === null) {
		this.mwApiRegexp += (this.mwApiRegexp ? '|' : '') + prefix;
	}
};

/**
 * @method
 * @inheritdoc #setMwApi
 * @deprecated Use {@link #setMwApi} instead.
 */
ParsoidConfig.prototype.setInterwiki = ParsoidConfig.prototype.setMwApi;

/**
 * @method
 *
 * Remove an wiki configuration.
 *
 * @param {Object} apiConf
 *   A wiki configuration object.  The value of `apiConf.domain`, or if
 *   that is missing `apiConf.prefix`, will be used to locate the
 *   configuration to remove.  Deprecated: if a string is passed, it
 *   is used as the prefix to remove.
 */
ParsoidConfig.prototype.removeMwApi = function(apiConf) {
	var prefix, domain;
	if (typeof apiConf === 'string') {
		console.warn(
			"Passing a string to ParsoidConfig#removeMwApi is deprecated:",
			apiConf
		);
		apiConf = { prefix: apiConf };
	}
	prefix = apiConf.prefix;
	domain = apiConf.domain;
	console.assert(prefix || domain, "Must pass either prefix or domain");
	if (domain) {
		prefix = this.reverseMwApiMap.get(domain);
	}
	if (!prefix || !this.mwApiMap.has(prefix)) {
		return;
	}
	if (!domain) {
		domain = this.mwApiMap.get(prefix).domain;
	}
	this.reverseMwApiMap.delete(domain);
	this.mwApiMap.delete(prefix);
	this.mwApiRegexp = this.mwApiRegexp.replace(
		new RegExp('(^|\\|)' + prefix + '(\\||$)'), function() {
			return arguments[0] === ("|" + prefix + "|") ? "|" : '';
		}
	);
};

/**
 * @method
 * @inheritdoc #removeMwApi
 * @deprecated Use {@link #removeMwApi} instead.
 */
ParsoidConfig.prototype.removeInterwiki = ParsoidConfig.prototype.removeMwApi;

// Useful internal function for testing
ParsoidConfig.prototype._sanitizeIt = function() {
	this.sanitizeConfig(this, CONFIG_DEFAULTS);
};

ParsoidConfig.prototype.sanitizeConfig = function(obj, defaults) {
	// Make sure that all critical required values are set and
	// that localsettings.js mistakes don't leave holes in the settings.
	//
	// Ex: parsoidConfig.timeouts = {}

	var self = this;
	Object.keys(defaults).forEach(function(key) {
		if (obj[key] === null || obj[key] === undefined || typeof obj[key] !== typeof defaults[key]) {
			console.warn("WARNING: For config property " + key + ", required a value of type: " + (typeof defaults[key]));
			console.warn("Found " + JSON.stringify(obj[key]) + "; Resetting it to: " + JSON.stringify(defaults[key]));
			obj[key] = Util.clone(defaults[key]);
		} else if (typeof defaults[key] === 'object') {
			self.sanitizeConfig(obj[key], defaults[key]);
		}
	});
};

if (typeof module === "object") {
	module.exports.ParsoidConfig = ParsoidConfig;
}
