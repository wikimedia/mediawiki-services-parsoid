/**
 * Parsoid-specific configuration.
 * This is immutable after initialization.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var fs = require('fs');
var path = require('path');
var url = require('url');
var ServiceRunner = require('service-runner');

var Util = require('../utils/Util.js').Util;
var JSUtils = require('../utils/jsutils.js').JSUtils;
var wmfSiteMatrix = require('./wmf.sitematrix.json').sitematrix;

/*
 * @property {Object} CONFIG_DEFAULTS
 *   Timeout values for various things. All values in ms.
 * @private
 */
var CONFIG_DEFAULTS = Object.freeze({
	timeouts: {
		// How long does a request have to generate a response?
		request: 4 * 60 * 1000,

		// These are timeouts for different api endpoints to the mediawiki API
		mwApi: {
			// action=expandtemplates
			preprocessor: 30 * 1000,
			// action=parse
			extParse: 30 * 1000,
			// action=templateData
			templateData: 30 * 1000,
			// action=parsoid-batch
			batch: 60 * 1000,
			// action=query&prop=revisions
			srcFetch: 40 * 1000,
			// action=query&prop=imageinfo
			imgInfo: 40 * 1000,
			// action=query&meta=siteinfo
			configInfo: 40 * 1000,
			// action=record-lint
			lint: 30 * 1000,
			// Connection timeout setting for the http agent
			connect: 5 * 1000,
		},
	},

	// Max concurrency level for accessing the Mediawiki API
	maxSockets: 15,

	// Multiple of cpu_workers number requests to queue before rejecting
	maxConcurrentCalls: 5,

	retries: {
		mwApi: {
			all: 1,
			// No retrying config requests
			// FIXME: but why? seems like 1 retry is not a bad idea
			configInfo: 0,
		},
	},

	// Somewhat arbitrary numbers for starters.
	// If these limits are breached, we return a http 413 (Payload too large)
	limits: {
		wt2html: {
			// We won't handle pages beyond this size
			maxWikitextSize: 1000000, // 1M

			// Max list items per page
			maxListItems: 30000,

			// Max table cells per page
			maxTableCells: 30000,

			// Max transclusions per page
			maxTransclusions: 10000,

			// DISABLED for now
			// Max images per page
			maxImages: 1000,

			// Max top-level token size
			maxTokens: 1000000, // 1M
		},
		html2wt: {
			// We refuse to serialize HTML strings bigger than this
			maxHTMLSize: 10000000,  // 10M
		},
	},

	linter: {
		// Whether to send lint errors to the MW API
		// Requires the MW Linter extension to be installed and configured.
		sendAPI: false,

		// Ratio at which to sample linter errors, per page.
		// This is deterministic and based on page_id.
		apiSampling: 1,

		// Max length of content covered by 'white-space:nowrap' CSS
		// that we consider "safe" when Tidy is replaced. Beyond that,
		// wikitext will have to be fixed up to manually insert whitespace
		// at the right places.
		tidyWhitespaceBugMaxLength: 100,
	},
});

var prepareLog = function(logData) {
	var log = Object.assign({ logType: logData.logType }, logData.locationData);
	var flat = logData.flatLogObject();
	Object.keys(flat).forEach(function(k) {
		// Be sure we don't have a `type` field here since logstash
		// treats that as magical.  We created a special `location`
		// field above and bunyan will add a `level` field (from the
		// contents of our `type` field) when we call the specific
		// logger returned by `_getBunyanLogger`.
		if (/^(type|location|level)$/.test(k)) { return; }
		log[k] = flat[k];
	});
	return log;
};

/**
 * Global Parsoid configuration object. Will hold things like debug/trace
 * options, mw api map, and local settings like fetchTemplates.
 *
 * @class
 * @param {Object} localSettings The localSettings object, probably from a localsettings.js file.
 * @param {Function} localSettings.setup The local settings setup function, which sets up our local configuration.
 * @param {ParsoidConfig} localSettings.setup.opts The setup function is passed the object under construction so it can extend the config directly.
 * @param {Object} options Any options we want to set over the defaults. See the class properties for more information.
 */
function ParsoidConfig(localSettings, options) {
	options = options || {};

	this.mwApiMap = new Map();
	this.reverseMwApiMap = new Map();
	Object.keys(CONFIG_DEFAULTS).forEach(function(k) {
		this[k] = Util.clone(CONFIG_DEFAULTS[k]);
	}, this);
	this._uniq = 0;

	// Don't freak out!
	// This happily overwrites inherited properties.
	Object.assign(this, options);
	// Trace, debug, and dump flags should be sets, but options might
	// include them as arrays.
	['traceFlags', 'debugFlags', 'dumpFlags'].forEach(function(f) {
		if (Array.isArray(this[f])) {
			this[f] = new Set(this[f]);
		}
	}, this);

	if (options.parent && (!this.loggerBackend || !this.metrics)) {
		var srlogger = ServiceRunner.getLogger(options.parent.logging);
		if (!this.loggerBackend) {
			this.loggerBackend = function(logData, cb) {
				srlogger.log(logData.logType, prepareLog(logData));
				cb();
			};
		}
		if (!this.metrics) {
			this.metrics = ServiceRunner.getMetrics(options.parent.metrics, srlogger);
		}
	}

	if (!localSettings && options.localsettings) {
		localSettings = require(options.localsettings);
	}

	if (localSettings && localSettings.setup) {
		localSettings.setup(this);
	}

	// Call setMwApi for each specified API.
	if (Array.isArray(this.mwApis)) {
		this.mwApis.forEach(function(api) {
			this.setMwApi(api);
		}, this);
	}

	if (this.loadWMF) {
		this.loadWMFApiMap();
	}

	// Make sure all critical required properties are present
	this._sanitizeIt();

	// ParsoidConfig is used across requests. Freeze it to avoid mutation.
	var ignoreFields = {
		metrics: true,
		loggerBackend: true,
		mwApiMap: true,
		reverseMwApiMap: true
	};
	JSUtils.deepFreezeButIgnore(this, ignoreFields);
}


/**
 * @property {boolean} debug Whether to print debugging information.
 */
ParsoidConfig.prototype.debug = false;

/**
 * @property {Set} traceFlags Flags that tell us which tracing information to print.
 */
ParsoidConfig.prototype.traceFlags = null;

/**
 * @property {Set} debugFlags Flags that tell us which debugging information to print.
 */
ParsoidConfig.prototype.debugFlags = null;

/**
 * @property {Set} dumpFlags Flags that tell us what state to dump.
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
 * @property {string} defaultWiki The wiki we should use for template, page, and configuration requests. We set this as a default because a configuration file (e.g. the API service's config.yaml) might set this, but we will still use the appropriate wiki when requests come in for a different prefix.
 */
ParsoidConfig.prototype.defaultWiki = 'enwiki';

/**
 * @property {string} allowCORS Permissive CORS headers as Parsoid is full idempotent currently
 */
ParsoidConfig.prototype.allowCORS = '*';

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
 * @property {boolean} addHTMLTemplateParameters
 * When processing template parameters, parse them to HTML and add it to the
 * template parameters data.
 */
ParsoidConfig.prototype.addHTMLTemplateParameters = false;

/**
 * @property {boolean|Array} linting Whether to enable linter Backend.
 * Or an array of enabled lint types
 */
ParsoidConfig.prototype.linting = false;

/**
 * @property {Function} loggerBackend
 * The logger output function.
 * By default, use stderr to output logs.
 */
ParsoidConfig.prototype.loggerBackend = null;

/**
 * @property {Array|null} loggerSampling
 * An array of arrays of log types and sample rates, in percent.
 * Omissions imply 100.
 * For example,
 *   parsoidConfig.loggerSampling = [
 *     ['warn/dsr/inconsistent', 1],
 *   ];
 */
ParsoidConfig.prototype.loggerSampling = null;

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
 * Server to connect to for MediaWiki API requests.
 */
ParsoidConfig.prototype.mwApiServer = undefined;

/**
 * The server from which to load style modules.
 */
ParsoidConfig.prototype.modulesLoadURI = undefined;

/**
 * Load WMF sites in the interwikiMap from the cached wmf.sitematrix.json
 */
ParsoidConfig.prototype.loadWMF = false;

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
 * @property {Object|null} Statistics aggregator, for counting and timing.
 */
ParsoidConfig.prototype.metrics = null;

/**
 * @property {string} Default user agent used for making Mediawiki API requests
 */
ParsoidConfig.prototype.userAgent = "Parsoid/" + (require('../../package.json').version);

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
ParsoidConfig.prototype.suppressMwApiWarnings = /modulemessages is deprecated|Unrecognized parameter: variant/;

/**
 * If enabled, bidi chars adjacent to category links will be stripped
 * in the html -> wt serialization pass.
 */
ParsoidConfig.prototype.scrubBidiChars = false;

/**
 * @property {number} How often should we emit a heap sample? Time in ms.
 *
 * Only relevant if performance timing is enabled
 */
ParsoidConfig.prototype.heapUsageSampleInterval = 5 * 60 * 1000;

/**
 * @property {function|null} Allow dynamic configuration of unknown domains.
 *
 * See T100841.
 */
ParsoidConfig.prototype.dynamicConfig = null;

/**
 * Initialize the mwApiMap and friends.
 */
ParsoidConfig.prototype.loadWMFApiMap = function() {
	var insertInMaps = (site) => {
		// Don't use the default proxy for restricted sites.
		// private: Restricted read and write access.
		// fishbowl: Restricted write access, full read access.
		// closed: No write access.
		// nonglobal: Public but requires registration.
		const restricted = site.hasOwnProperty("private") ||
			site.hasOwnProperty("fishbowl") ||
			site.hasOwnProperty("nonglobal");

		// Avoid overwriting those already set in localsettings setup.
		if (!this.mwApiMap.has(site.dbname)) {
			var apiConf = {
				prefix: site.dbname,
				uri: site.url + "/w/api.php",
				proxy: {
					uri: restricted ? null : undefined,
					// WMF production servers don't listen on port 443.
					// see mediawiki.ApiRequest for handling of this option.
					strip_https: true,
				},
				nonglobal: site.hasOwnProperty("nonglobal"),
				restricted,
			};
			this.setMwApi(apiConf);
		}
	};

	// See getAPIProxy for the meaning of null / undefined in setMwApi.

	Object.keys(wmfSiteMatrix).forEach((key) => {
		var val = wmfSiteMatrix[key];
		if (!Number.isNaN(Number(key))) {
			val.site.forEach(insertInMaps);
		} else if (key === "specials") {
			val.forEach(insertInMaps);
		}
	});
};

/**
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
 * @param {string} apiConf.uri
 *   The URL to the wiki's Action API (`api.php`).
 *   This is the only mandatory argument.
 * @param {string} [apiConf.domain]
 *   The "domain" used to identify this wiki when using the Parsoid v2/v3 API.
 *   It defaults to the hostname portion of `apiConf.uri`.
 * @param {string} [apiConf.prefix]
 *   An arbitrary unique identifier for this wiki.  If none is provided
 *   a unique string will be generated.
 * @param {Object} [apiConf.proxy]
 *   A proxy configuration object.
 * @param {string|null} [apiConf.proxy.uri]
 *   The URL of a proxy to use for API requests, or null to explicitly
 *   disable API request proxying for this wiki. Will fall back to
 *   {@link ParsoidConfig#defaultAPIProxyURI} if `undefined` (default value).
 * @param {Object} [apiConf.proxy.headers]
 *   Headers to add when proxying.
 * @param {Array} [apiConf.extensions]
 *   A list of native extension constructors.  Otherwise, registers cite by
 *   default.
 * @param {boolean} [apiConf.strictSSL]
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
			apiConf = Object.assign({}, arguments[1]);  // overwrites `arguments[0]`
			apiConf.prefix = prefix;
		} else {
			apiConf = { uri: arguments[0] };
		}
	} else {
		console.assert(typeof apiConf === 'object');
		apiConf = Object.assign({}, apiConf);  // Don't modify the passed in object
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

	// Give them some default extensions.
	if (!Array.isArray(apiConf.extensions)) {
		// Native support for certain extensions (Cite, etc)
		// Note that in order to remain compatible with mediawiki core,
		// core extensions (for example, for the JSON content model)
		// must take precedence over other extensions.
		apiConf.extensions = Util.clone(this.defaultNativeExtensions);
		/* Include global user extensions */
		ParsoidConfig._collectExtensions(
			apiConf.extensions
		);
		/* Include wiki-specific user extensions */
		// User can specify an alternate directory here, so they can point
		// directly at their mediawiki core install if they wish.
		ParsoidConfig._collectExtensions(
			apiConf.extensions, apiConf.extdir || apiConf.domain
		);
	}

	if (this.reverseMwApiMap.has(apiConf.domain)) {
		console.warn(
			"Domain should be unique in ParsoidConfig#setMwApi calls:",
			apiConf.domain
		);
		console.warn(
			"(It doesn't have to be an actual domain, just a unique string.)"
		);
	}
	if (this.mwApiMap.has(prefix)) {
		console.warn(
			"Prefix should be unique in ParsoidConfig#setMwApi calls:",
			prefix
		);
		this.reverseMwApiMap.delete(this.mwApiMap.get(prefix).domain);
	}
	this.mwApiMap.set(prefix, apiConf);
	this.reverseMwApiMap.set(apiConf.domain, prefix);
};

/**
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
};

/**
 * Return the internal prefix used to index configuration information for
 * the given domain string.  If the prefix is not present, attempts
 * dynamic configuration using the `dynamicConfig` hook before returning.
 *
 * XXX: We should eventually move the dynamic configuration to lookups on
 * the mwApiMap, once we remove `prefix` from our codebase: T206764.
 *
 * @param {string} domain
 * @return {string} Internal prefix
 */
ParsoidConfig.prototype.getPrefixFor = function(domain) {
	// Support dynamic configuration
	if (!this.reverseMwApiMap.has(domain) && this.dynamicConfig) {
		this.dynamicConfig(domain);
	}
	return this.reverseMwApiMap.get(domain);
};

/**
 * Figure out the proxy to use for API requests for a given wiki.
 *
 * @param {string} prefix
 * @return {Object}
 */
ParsoidConfig.prototype.getAPIProxy = function(prefix) {
	var apiProxy = { uri: undefined, headers: undefined };
	// Don't update the stored proxy object, otherwise subsequent calls
	// with the same prefix may do the wrong thing. (ex. null -> undefined ->
	// defaultAPIProxyURI)
	Object.assign(apiProxy, this.mwApiMap.get(prefix).proxy);
	if (apiProxy.uri === null ||
		this.mwApiMap.get(prefix).proxy === null) {
		// Explicitly disable the proxy if null was set for this prefix
		apiProxy.uri = undefined;
	} else if (apiProxy.uri === undefined) {
		// No specific api proxy set. Fall back to generic API proxy.
		apiProxy.uri = this.defaultAPIProxyURI;
	}
	return apiProxy;
};

// Collect extensions from a directory.
ParsoidConfig._collectExtensions = function(arr, dir, isNative) {
	var base = path.join(__dirname, '..', '..', 'extensions');
	if (dir) { base = path.resolve(base, dir); }
	try {
		if (!fs.statSync(base).isDirectory()) { return; /* not dir */ }
	} catch (e) { return; /* no file there */ }
	var files = fs.readdirSync(base);
	// Sort! To ensure that we have a repeatable order in which we load
	// and process extensions.
	files.sort();
	files.forEach(function(d) {
		var p = isNative ? path.join(base, d) : path.join(base, d, 'parsoid');
		try {
			if (!fs.statSync(p).isDirectory()) { return; /* not dir */ }
		} catch (e) { return; /* no file there */ }
		// Make sure that exceptions here are visible to user.
		arr.push(ParsoidConfig.loadExtension(p));
	});
};

ParsoidConfig.loadExtension = function(modulePath) {
	// The extension will load the extension API relative to this module.
	var ext = require(modulePath);
	console.assert(
		typeof ext === 'function',
		"Extension is not a function when loading " + modulePath
	);
	return ext;
};

// Useful internal function for testing
ParsoidConfig.prototype._sanitizeIt = function() {
	this.sanitizeConfig(this, CONFIG_DEFAULTS);
};

ParsoidConfig.prototype.sanitizeConfig = function(obj, defaults) {
	// Make sure that all critical required values are set and
	// that localsettings.js mistakes don't leave holes in the settings.
	//
	// Ex: parsoidConfig.timeouts = {}

	Object.keys(defaults).forEach((key) => {
		if (obj[key] === null || obj[key] === undefined || typeof obj[key] !== typeof defaults[key]) {
			if (obj[key] !== undefined) {
				console.warn("WARNING: For config property " + key + ", required a value of type: " + (typeof defaults[key]));
				console.warn("Found " + JSON.stringify(obj[key]) + "; Resetting it to: " + JSON.stringify(defaults[key]));
			}
			obj[key] = Util.clone(defaults[key]);
		} else if (typeof defaults[key] === 'object') {
			this.sanitizeConfig(obj[key], defaults[key]);
		}
	});
};

ParsoidConfig.prototype.defaultNativeExtensions = [];
ParsoidConfig._collectExtensions(
	ParsoidConfig.prototype.defaultNativeExtensions,
	path.resolve(__dirname, '../ext'),
	true /* don't require a 'parsoid' subdirectory */
);

/**
 * @property {boolean} Expose development routes in the HTTP API.
 */
ParsoidConfig.prototype.devAPI = false;

/**
 * @property {boolean} Enable editing galleries via HTML, instead of extsrc.
 */
ParsoidConfig.prototype.nativeGallery = true;

if (typeof module === "object") {
	module.exports.ParsoidConfig = ParsoidConfig;
}
