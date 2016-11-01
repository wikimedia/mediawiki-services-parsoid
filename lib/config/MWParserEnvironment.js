'use strict';
require('../../core-upgrade.js');

var semver = require('semver');
var Title = require('mediawiki-title').Title;
var Promise = require('../utils/promise.js');
var WikiConfig = require('./WikiConfig.js').WikiConfig;
var ConfigRequest = require('../mw/ApiRequest.js').ConfigRequest;
var Batcher = require('../mw/Batcher.js').Batcher;
var Util = require('../utils/Util.js').Util;
var ParserPipelineFactory = require('../wt2html/parser.js').ParserPipelineFactory;
var Linter = require('../logger/linter.js').Linter;
var ParsoidLogger = require('../logger/ParsoidLogger.js').ParsoidLogger;

/**
 * @class
 *
 * Holds configuration data that isn't modified at runtime, debugging objects,
 * a page object that represents the page we're parsing, and more.
 * The title of the page is held in `this.page.name` and is stored
 * as a "true" url-decoded title, i.e. without any url-encoding which
 * might be necessary if the title were referenced in wikitext.
 *
 * Should probably be constructed with: `MWParserEnvironment.getParserEnv`.
 *
 * @constructor
 * @param {ParsoidConfig} parsoidConfig
 * @param {Object} [options]
 */
var MWParserEnvironment = function(parsoidConfig, options) {
	options = options || {};
	var self = this;

	// page information
	this.page = (function() {
		var Page = function() {
			this.reset();
		};

		/**
		 * @property {String} name
		 */
		Page.prototype.name = self.defaultPageName;

		/**
		 * Any leading ..?/ strings that will be necessary for building links.
		 *
		 * @property {String} relativeLinkPrefix
		 */
		Page.prototype.relativeLinkPrefix = '';

		/**
		 * The page's ID.  Don't get this confused w/ `meta.revision.revid`
		 * At present, it's only used in diff marking.
		 *
		 * @property {Number|null} id
		 */
		Page.prototype.id = null;

		/**
		 * Start as null to distinguish the empty string.
		 *
		 * @property {String|null} src
		 */
		Page.prototype.src = null;

		/**
		 * @property {Node|null} dom
		 */
		Page.prototype.dom = null;

		/**
		 * @property {Number} ns
		 */
		Page.prototype.ns = 0;

		/**
		 * A full Title object.
		 * @property {Object|null} title
		 */
		Page.prototype.title = null;

		/**
		 * @method
		 */
		Page.prototype.reset = function() {
			this.meta = { revision: {} };
		};

		return new Page();
	})();

	// Record time spent in various passes
	this.timeProfile = {};

	// A passed-in cookie, if any
	this.cookie = options.cookie || null;

	// A passed-in request id, if any
	this.reqId = options.reqId || null;

	// A passed-in user agent, if any
	this.userAgent = options.userAgent || null;

	// execution state
	this.setCaches({});

	// Configuration
	this.conf = {
		parsoid: parsoidConfig,
		wiki: null,
	};

	// FIXME: This is temporary and will be replaced after the call to
	// `switchToConfig`.  However, it may somehow be used in the
	// `ConfigRequest` along the way. Perhaps worth seeing if that can be
	// eliminated so `WikiConfig` can't be instantiated without a `resultConf`.
	console.assert(parsoidConfig.mwApiMap.has(options.prefix));
	this.conf.wiki = new WikiConfig(parsoidConfig, null, options.prefix);

	// Sets ids on nodes and stores data-* attributes in a JSON blob
	this.pageBundle = false;

	this.linter = new Linter(this);
	this.configureLogging();

	this.initializeForPageName(options.pageName || this.defaultPageName);

	this.pipelineFactory = new ParserPipelineFactory(this);

	// Outstanding page requests (for templates etc)
	this.requestQueue = {};

	this.batcher = new Batcher(this);

	this.setResourceLimits();
};

MWParserEnvironment.prototype.setResourceLimits = function() {
	// This tracks resource usage in the parser
	var limits = this.conf.parsoid.limits;
	this.limits = {
		wt2html: {
			// The current resource limit strings seem to conveniently
			// fit the ('max' + capitalize(limit) + 's') convention.
			// We have one exception in the form of 'wikitextSize'.
			// Overall, I am not sure if this convention will hold in the
			// future but printParserResourceUse exploits this convention.
			token: limits.wt2html.maxTokens,
			listItem: limits.wt2html.maxListItems,
			tableCell: limits.wt2html.maxTableCells,
			transclusion: limits.wt2html.maxTransclusions,
			image: limits.wt2html.maxImages,
			wikitextSize: limits.wt2html.maxWikitextSize,
		},
		html2wt: {
			htmlSize: limits.html2wt.maxHTMLSize,
		},
	};
};

MWParserEnvironment.prototype.bumpTimeUse = function(resource, time) {
	if (!this.timeProfile[resource]) {
		this.timeProfile[resource] = 0;
	}
	this.timeProfile[resource] += time;
};

MWParserEnvironment.prototype.printTimeProfile = function() {
	var endTime = Date.now();
	this.log('trace/time', 'Finished parse at ', endTime);
	console.warn("-".repeat(55));
	console.warn("Recorded times (in ms) for sync token transformations");
	console.warn("-".repeat(55));

	// Sort time profile in descending order
	var k, v;
	var total = 0;
	var sortable = [];
	for (k in this.timeProfile) {
		v = this.timeProfile[k];
		total += v;
		sortable.push([k, v]);
	}
	sortable.push(['TOTAL PROFILED TIME', total]);
	sortable.push(['TOTAL PARSE TIME', endTime - this.startTime]);

	sortable.sort(function(a, b) {
		return b[1] - a[1];
	});


	// Print profile
	for (var i = 0; i < sortable.length; i++) {
		k = sortable[i][0];
		v = sortable[i][1];
		console.warn(k.padStart(30) + ': ' + v);
	}
	console.warn("-".repeat(55));
};

function PayloadTooLargeError(message) {
	Error.captureStackTrace(this, PayloadTooLargeError);
	this.name = "PayloadTooLargeError";
	this.message = message ||
		"Refusing to process the request because the payload is " +
		"larger than the server is willing or able to handle.";
	this.httpStatus = 413;
	this.suppressLoggingStack = true;
}
PayloadTooLargeError.prototype = Error.prototype;

MWParserEnvironment.prototype.bumpParserResourceUse = function(resource, count) {
	var n = this.limits.wt2html[resource];
	n -= (count || 1);
	if (n < 0) {
		throw new PayloadTooLargeError(
			'wt2html: Exceeded max resource use: ' + resource + '. Aborting!');
	}
	this.limits.wt2html[resource] = n;
};

MWParserEnvironment.prototype.bumpSerializerResourceUse = function(resource, count) {
	var n = this.limits.html2wt[resource];
	n -= (count || 1);
	if (n < 0) {
		throw new PayloadTooLargeError(
			'html2wt: Exceeded max resource use: ' + resource + '. Aborting!');
	}
	this.limits.html2wt[resource] = n;
};

MWParserEnvironment.prototype.printParserResourceUsage = function(otherResources) {
	console.warn('-------------------- Used resources -------------------');
	var k, limit;
	for (k in this.limits.wt2html) {
		if (k === 'wikitextSize') {
			limit = this.conf.parsoid.limits.wt2html.maxWikitextSize;
			console.warn('wikitextSize'.padStart(30) + ': ' +
				this.page.src.length + ' / ' + limit);
		} else {
			var maxK = 'max' + k[0].toUpperCase() + k.slice(1) + 's';
			limit = this.conf.parsoid.limits.wt2html[maxK];
			console.warn(('# ' + k + 's').padStart(30) + ': ' +
				(limit - this.limits.wt2html[k]) + " / " + limit);
		}
	}
	for (k in otherResources) {
		console.warn(k.padStart(30) + ': ' + otherResources[k]);
	}
	console.warn('-'.repeat(55));
};

MWParserEnvironment.prototype.configureLogging = function() {
	var logger = new ParsoidLogger(this);
	this.setLogger(logger);

	var defaultLogLevels = [
		"fatal", "error", "warning", "info",
	];

	if (this.conf.parsoid.linting && !this.conf.parsoid.linterSendAPI) {
		defaultLogLevels.push("lint");
	}

	// Configure backends
	logger.registerLoggingBackends(defaultLogLevels, this.conf.parsoid, this.linter);
};

// The default page name (true name, without wikitext url encoding)
MWParserEnvironment.prototype.defaultPageName = "Main Page";

// Cache for wiki configurations, shared between requests.
MWParserEnvironment.prototype.confCache = {};

MWParserEnvironment.prototype.setCaches = function(caches) {
	// TODO gwicke: probably not that useful any more as this is per-request
	// and the PHP preprocessor eliminates template source hits
	this.pageCache = caches.pages || {};

	// Global transclusion expansion cache (templates, parser functions etc)
	// Key: Full transclusion source
	this.transclusionCache = caches.transclusions || {};

	// Global extension tag expansion cache (templates, parser functions etc)
	// Key: Full extension source (including tags)
	this.extensionCache = caches.extensions || {};

	// Global image expansion cache
	// Key: Full image source
	this.mediaCache = caches.media || {};
};

/**
 * @method
 *
 * Set the src and optionally meta information for the page we're parsing.
 *
 * If the argument is a simple string, will clear metadata and just
 * set `this.page.src`.  Otherwise, the provided metadata object should
 * have fields corresponding to the JSON output given by
 * action=query&prop=revisions on the MW API.  That is:
 *
 *     metadata = {
 *       title: // normalized title (ie, spaces not underscores)
 *       ns:    // namespace
 *       id:    // page id
 *       revision: {
 *         revid:    // revision id
 *         parentid: // revision parent
 *         timestamp:
 *         user:     // contributor username
 *         userid:   // contributor user id
 *         sha1:
 *         size:     // in bytes
 *         comment:
 *         contentmodel:
 *         contentformat:
 *         "*   ":     // actual source text --> copied to this.page.src
 *       }
 *     }
 * @param {String|Object} srcOrMetadata page source or metadata
 */
MWParserEnvironment.prototype.setPageSrcInfo = function(srcOrMetadata) {
	if (typeof srcOrMetadata === 'string' || !srcOrMetadata) {
		this.page.reset();
		this.page.src = srcOrMetadata || '';
		return;
	}

	// I'm choosing to initialize this.page.meta "the hard way" (rather than
	// simply cloning the provided object) in part to document/enforce the
	// expected structure and fields.
	var metadata = srcOrMetadata;
	var m = this.page.meta;
	if (!m) { m = this.page.meta = {}; }
	m.title = metadata.title;
	var r = m.revision;
	if (!r) { r = m.revision = {}; }
	if (metadata.revision) {
		r.revid = metadata.revision.revid;
		r.parentid = metadata.revision.parentid;
		r.timestamp = metadata.revision.timestamp;
		r.user = metadata.revision.user;
		r.userid = metadata.revision.userid;
		r.sha1 = metadata.revision.sha1;
		r.size = metadata.revision.size;
		r.comment = metadata.revision.comment;
		r.contentmodel = metadata.revision.contentmodel;
		r.contentformat = metadata.revision.contentformat;
	}

	// Update other page properties
	this.page.id = metadata.id;
	this.page.ns = metadata.ns;
	this.page.latest = metadata.latest;
	this.page.src = (metadata.revision && metadata.revision['*']) || '';
};

MWParserEnvironment.prototype.setLogger = function(logger) {
	this.logger = logger;
	this.log = this.logger.log.bind(this.logger);
};

/**
 * @method
 *
 * Initialize the environment for the page
 *
 * @param {string} pageName
 * The "true" url-decoded pagename. (see above)
 */
MWParserEnvironment.prototype.initializeForPageName = function(pageName, dontReset) {
	// Don't use the previous page's namespace as the default
	this.page.ns = 0;
	// Create a title from the pageName
	var title = this.makeTitleFromURLDecodedStr(pageName);
	this.page.ns = title.getNamespace()._id;
	this.page.title = title;
	this.page.name = pageName;
	// Always prefix a ./ so that we don't have to escape colons. Those
	// would otherwise fool browsers into treating namespaces (like File:)
	// as protocols.
	this.page.relativeLinkPrefix = "./";
	if (!dontReset) {
		this.initUID();
	}
};

MWParserEnvironment.prototype.getVariable = function(varname, options) {
	// XXX what was the original author's intention?
	// something like this?:
	//  return this.options[varname];
	return this[varname];
};

MWParserEnvironment.prototype.setVariable = function(varname, value, options) {
	this[varname] = value;
};

/**
 * Alternate constructor for MWParserEnvironments
 *
 * @method
 * @param {ParsoidConfig} parsoidConfig
 * @param {Object} [options] Environment options.
 * @param {string} [options.pageName] the true url-decoded title of the page
 * @param {Function} [cb]
 * @param {Error} cb.err
 * @param {MWParserEnvironment} cb.env The finished environment object
 * @static
 */
MWParserEnvironment.getParserEnv = function(parsoidConfig, options, cb) {
	// Get that wiki's config
	return Promise.method(function() {
		options = options || {};
		if (!options.prefix && options.domain && parsoidConfig.reverseMwApiMap.has(options.domain)) {
			options.prefix = parsoidConfig.reverseMwApiMap.get(options.domain);
		}
		if (!options.prefix || !parsoidConfig.mwApiMap.has(options.prefix)) {
			throw new Error('No API URI available for prefix: ' + options.prefix + '; domain: ' + options.domain);
		}
		var env = new MWParserEnvironment(parsoidConfig, options);
		return env.switchToConfig(options.prefix).then(function() {
			if (!options.pageName) {
				env.initializeForPageName(env.conf.wiki.mainpage, true);
			}
			return env;
		});
	})().nodify(cb);
};

/**
 * Function that switches to a different configuration for a different wiki.
 * Caches all configs so we only need to get each one once (if we do it right)
 *
 * @param {string} prefix The interwiki prefix that corresponds to the wiki we should use
 * @param {Function} cb
 * @param {Error} cb.err
 */
MWParserEnvironment.prototype.switchToConfig = function(prefix, cb) {
	var env = this;
	var nothingToDo = {};  // unique marker value
	var parsoidConfig = env.conf.parsoid;

	var uri, proxy;
	var getConfigPromise = Promise.method(function() {
		if (!prefix || !parsoidConfig.mwApiMap.has(prefix)) {
			throw new Error('No API URI available for prefix: ' + prefix);
		} else {
			uri = parsoidConfig.mwApiMap.get(prefix).uri;
			proxy = parsoidConfig.getAPIProxy(prefix);
			if (env.confCache[prefix]) {
				env.conf.wiki = env.confCache[prefix];
				return nothingToDo;
			} else if (parsoidConfig.fetchConfig) {
				return ConfigRequest.promise(uri, env, proxy);
			} else {
				// Load the config from cached config on disk
				var localConfigFile = './baseconfig/' + prefix + '.json';
				var localConfig = require(localConfigFile);
				if (localConfig && localConfig.query) {
					return localConfig.query;
				} else {
					throw new Error('Could not read valid config from file: ' +
						localConfigFile);
				}
			}
		}
	});

	return getConfigPromise().then(function(resultConf) {
		if (resultConf === nothingToDo) { return; }
		env.conf.wiki = new WikiConfig(parsoidConfig, resultConf, prefix);
		env.confCache[prefix] = env.conf.wiki;
	}).nodify(cb);
};

/**
 * TODO: Handle namespaces relative links like [[User:../../]] correctly, they
 * shouldn't be treated like links at all.
 *
 * This function handles strings that are page-fragments or subpage references
 * and resolves those w.r.t the current page name so that title-handling code elsewhere
 * only deal with non-relative title strings.
 */
MWParserEnvironment.prototype.resolveTitle = function(urlDecodedStr, resolveOnly) {
	var origName = urlDecodedStr;
	urlDecodedStr = urlDecodedStr.trim().replace(/\s+/, ' ');
	if (/^#/.test(urlDecodedStr)) {
		// Resolve lonely fragments (important if this.page is a subpage,
		// otherwise the relative link will be wrong)
		urlDecodedStr = this.page.name + urlDecodedStr;
	}

	// Default return value
	var titleKey = urlDecodedStr;
	if (this.conf.wiki.namespacesWithSubpages[this.page.ns]) {
		// Resolve subpages
		var relUp = urlDecodedStr.match(/^(\.\.\/)+/);
		var reNormalize = false;
		if (relUp) {
			var levels = relUp[0].length / 3;  // Levels are indicated by '../'.
			var titleBits = this.page.name.split(/\//);
			if (titleBits.length <= levels) {
				// Too many levels -- invalid relative link
				return origName;
			}
			var newBits = titleBits.slice(0, titleBits.length - levels);
			if (urlDecodedStr !== relUp[0]) {
				newBits.push(urlDecodedStr.substr(levels * 3));
			}
			urlDecodedStr = newBits.join('/');
			reNormalize = true;
		} else if (urlDecodedStr.length && urlDecodedStr[0] === '/') {
			// Resolve absolute subpage links
			urlDecodedStr = this.page.name + urlDecodedStr;
			reNormalize = true;
		}

		if (reNormalize && !resolveOnly) {
			// Remove final slashes if present.
			// See https://gerrit.wikimedia.org/r/173431
			urlDecodedStr = urlDecodedStr.replace(/\/+$/, '');
			titleKey = this.normalizedTitleKey(urlDecodedStr);
		}
	}

	// Strip leading ':'
	if (titleKey[0] === ':' && !resolveOnly) {
		titleKey = titleKey.substr(1);
	}
	return titleKey;
};

/**
 * Get normalized title key for a title string
 *
 * @method
 * @param {String} [urlDecodedStr] should be in url-decoded format.
 * @param {Boolean} [noExceptions] return null instead of throwing exceptions.
 * @param {Boolean} [ignoreFragment] ignore the fragment, if any.
 * @return {String|null} normalized title key for a title string (or null for invalid titles)
 */
MWParserEnvironment.prototype.normalizedTitleKey = function(urlDecodedStr, noExceptions, ignoreFragment) {
	var title = this.makeTitleFromURLDecodedStr(urlDecodedStr, undefined, noExceptions);
	if (!title) {
		return null;
	}

	var fragment = '';
	if (!ignoreFragment) {
		fragment = title.getFragment() || '';
		if (fragment) {
			fragment = '#' + fragment;
		}
	}
	return title.getPrefixedDBKey() + fragment;
};

MWParserEnvironment.prototype.normalizeAndResolvePageTitle = function() {
	return this.resolveTitle(this.normalizedTitleKey(this.page.name));
};

/* urlDecodedText will be in url-decoded form */
MWParserEnvironment.prototype._makeTitle = function(urlDecodedText, defaultNS, noExceptions) {
	try {
		if (this.page && /^(\#|\/|\.\.\/)/.test(urlDecodedText)) {
			defaultNS = this.page.ns;
		}
		urlDecodedText = this.resolveTitle(urlDecodedText);
		return Title.newFromText(urlDecodedText, this.conf.wiki.siteInfo, defaultNS);
	} catch (e) {
		if (noExceptions) {
			return null;
		} else {
			throw e;
		}
	}
};

/* text might have url-encoded entities that need url-decoding */
/* See: Title::newFromText in mediawiki. */
MWParserEnvironment.prototype.makeTitleFromText = function(str, defaultNS, noExceptions) {
	return this._makeTitle(Util.decodeURI(str), defaultNS, noExceptions);
};

/* See: Title::newFromURL in mediawiki. */
MWParserEnvironment.prototype.makeTitleFromURLDecodedStr = function(str, defaultNS, noExceptions) {
	return this._makeTitle(str, defaultNS, noExceptions);
};

MWParserEnvironment.prototype.makeLink = function(title) {
	var fragment = title.getFragment() || '';
	if (fragment) {
		fragment = '#' + fragment;
	}
	return Util.sanitizeTitleURI(this.page.relativeLinkPrefix + title.getPrefixedDBKey() + fragment);
};

MWParserEnvironment.prototype.isValidLinkTarget = function(href) {
	// decode percent-encoding so that we can reliably detect
	// bad page title characters
	var hrefToken = Util.decodeURI(Util.tokensToString(href));
	return this.normalizedTitleKey(this.resolveTitle(hrefToken, true), true) !== null;
};

MWParserEnvironment.prototype.initUID = function() {
	this.uid = 1;
};

/**
 * Generate a UID
 *
 * @method
 * @return {number}
 * @private
 */
MWParserEnvironment.prototype.generateUID = function() {
	return this.uid++;
};

MWParserEnvironment.prototype.newObjectId = function() {
	return "mwt" + this.generateUID();
};

MWParserEnvironment.prototype.newAboutId = function() {
	return "#" + this.newObjectId();
};

/**
 * Apply extra normalizations before serializing DOM.
 */
MWParserEnvironment.prototype.scrubWikitext = false;

/**
 * @property {String} wikitextVersion
 */
MWParserEnvironment.prototype.wikitextVersion = '1.0.0';

/**
 * The content versions Parsoid knows how to produce.
 * Ordered by desirability.
 *
 * @property {Array} availableVersions
 */
MWParserEnvironment.prototype.availableVersions = ['1.2.1', '2.0.0'];

/**
 * The default content version that Parsoid will generate.
 *
 * @property {String} contentVersion
 */
MWParserEnvironment.prototype.contentVersion = MWParserEnvironment.prototype.availableVersions[0];

/**
 * The default content version that Parsoid assumes it's serializing.
 *
 * @property {String} originalVersion
 */
MWParserEnvironment.prototype.originalVersion = MWParserEnvironment.prototype.availableVersions[0];

/**
 * See if any content version Parsoid knows how to produce satisfies the
 * the supplied version, when interpreted with semver caret semantics.
 * This will allow us to make backwards compatible changes, without the need
 * for clients to bump the version in their headers all the time.
 *
 * @method
 * @param {String} v
 * @return {String|null}
 */
MWParserEnvironment.prototype.resolveContentVersion = function(v) {
	for (var i = 0; i < this.availableVersions.length; i++) {
		var a = this.availableVersions[i];
		if (semver.satisfies(a, '^' + v)) { return a; }
	}
	return null;
};

/**
 * @method
 * @param {String} v
 */
MWParserEnvironment.prototype.setContentVersion = function(v) {
	if (this.availableVersions.indexOf(v) < 0) {
		throw new Error('Not an available content version.');
	}
	this.contentVersion = v;
};

/**
 * @method
 */
MWParserEnvironment.prototype.getModulesLoadURI = function() {
	var modulesLoadURI = this.conf.parsoid.modulesLoadURI;
	if (modulesLoadURI === true) {
		this.log('warning',
			'Setting `modulesLoadURI` to `true` is no longer supported.');
		modulesLoadURI = undefined;
	}
	if (modulesLoadURI === undefined) {
		// If not set, use the same as the API
		return this.conf.wiki.apiURI
			.replace(/[^\/]*\/\//, '//') // proto-relative
			.replace(/\/api.php$/, '/load.php');
	} else {
		return modulesLoadURI;
	}
};

/**
 * @method
 */
MWParserEnvironment.prototype.setPageProperty = function(src, property) {
	console.assert(this.page);
	if (Array.isArray(src) && src.length > 0) {
		// This info comes back from the MW API when extension tags are parsed.
		// Since a page can have multiple extension tags, we can hit this code
		// multiple times and run into an already initialized set.
		if (!this.page[property]) {
			this.page[property] = new Set();
		}
		src.forEach(function(s) {
			this.page[property].add(s);
		}, this);
	}
};

/**
 * Content model whitelist
 *
 * Suppress warnings for these fallbacks to wikitext.
 */
var whitelist = new Set([
	'wikibase-item',
]);

/**
 * @method
 *
 * Get an appropriate content handler, given a contentmodel.
 *
 * @param {String} [forceContentModel] An optional content model
 *   which will override whatever the source specifies.
 * @return {Object} An appropriate content handler with `toHTML` and `fromHTML`
 *   methods.
 */
MWParserEnvironment.prototype.getContentHandler = function(forceContentModel) {
	var contentmodel = forceContentModel ||
			this.page.meta.revision.contentmodel ||
			'wikitext';
	if (!this.conf.wiki.extContentModel.has(contentmodel)) {
		if (!whitelist.has(contentmodel)) {
			this.log('warning', 'Unknown contentmodel', contentmodel);
		}
		contentmodel = 'wikitext';
	}
	return this.conf.wiki.extContentModel.get(contentmodel);
};


if (typeof module === "object") {
	module.exports.MWParserEnvironment = MWParserEnvironment;
}
