/**
 * Main parser environment object.  Holds configuration data that isn't
 * modified at runtime, debugging objects, a page object that represents
 * the article we're parsing, and more.
 *
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var semver = require('semver');
var Title = require('mediawiki-title').Title;
var Promise = require('../utils/promise.js');
var WikiConfig = require('./WikiConfig.js').WikiConfig;
var ConfigRequest = require('../mw/ApiRequest.js').ConfigRequest;
var Batcher = require('../mw/Batcher.js').Batcher;
var ContentUtils = require('../utils/ContentUtils.js').ContentUtils;
var DOMUtils = require('../utils/DOMUtils.js').DOMUtils;
var DOMDataUtils = require('../utils/DOMDataUtils.js').DOMDataUtils;
var Util = require('../utils/Util.js').Util;
var JSUtils = require('../utils/jsutils.js').JSUtils;
var TokenUtils = require('../utils/TokenUtils.js').TokenUtils;
var PipelineUtils = require('../utils/PipelineUtils.js').PipelineUtils;
var ParserPipelineFactory = require('../wt2html/parser.js').ParserPipelineFactory;
var LintLogger = require('../logger/LintLogger.js').LintLogger;
var ParsoidLogger = require('../logger/ParsoidLogger.js').ParsoidLogger;
var Sanitizer = require('../wt2html/tt/Sanitizer.js').Sanitizer;

const { Frame } = require('../wt2html/Frame.js');

/**
 * Represents the title, language, and other properties of a given article.
 *
 * @class
 */
var Page = function() {
	this.reset();
};

/**
 * The "true" url-decoded title; ie without any url-encoding which
 * might be necessary if the title were referenced in wikitext.
 *
 * @property {string} name
 */
Page.prototype.name = '';

/**
 * Any leading ..?/ strings that will be necessary for building links.
 *
 * @property {string} relativeLinkPrefix
 */
Page.prototype.relativeLinkPrefix = '';

/**
 * The page's ID.  Don't get this confused w/ `meta.revision.revid`
 * At present, it's only used in diff marking.
 *
 * @property {Number} id
 */
Page.prototype.id = -1;

/**
 * Start as null to distinguish the empty string.
 *
 * @property {string|null} src
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
 * The page language code, in mediawiki format.
 * Use `DOMUtils.BCP47()` to turn this into a proper BCP47 code
 * suitable for inclusion in HTML5.
 * @property {string|null} pagelanguage
 */
Page.prototype.pagelanguage = null;

/**
 * The page directionality.  Either `ltr` or `rtl`.
 * @property {string|null} pagelanguagedir
 */
Page.prototype.pagelanguagedir = null;

Page.prototype.reset = function() {
	this.meta = { revision: {} };
	this.setVariant(null);
};

Page.prototype.getContentModel = function() {
	// defaults to 'wikitext'
	return this.meta.revision.contentmodel || 'wikitext';
};

/**
 * Does this page's content model have content that is lintable?
 */
Page.prototype.hasLintableContentModel = function() {
	var contentmodel = this.getContentModel();

	// wikitext or anything that uses wikitext for content blobs
	return contentmodel === 'wikitext' || contentmodel === 'proofread-page';
};

Page.prototype.setVariant = function(code) {
	this.htmlVariant = code;
};

/**
 * Holds configuration data that isn't modified at runtime, debugging objects,
 * a page object that represents the page we're parsing, and more.
 * The title of the page is held in `this.page.name` and is stored
 * as a "true" url-decoded title, ie without any url-encoding which
 * might be necessary if the title were referenced in wikitext.
 *
 * Should probably be constructed with {@link .getParserEnv}.
 *
 * @class
 * @param {ParsoidConfig} parsoidConfig
 * @param {Object} [options]
 */
var MWParserEnvironment = function(parsoidConfig, options) {
	options = options || {};

	// page information
	this.page = new Page();
	this.topFrame = new Frame(null, this, [], '<uninitialized frame>');
	// XXX create `this.currentFrame` from TokenTransformManager#frame
	// once we've removed all async parsing.

	Object.assign(this, options);

	// Record time spent in various passes
	this.timeProfile = {};
	this.ioProfile = {};
	this.mwProfile = {};
	this.timeCategories = {};
	this.counts = {};

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

	this.configureLogging();

	// FIXME: Continuing with the line above, we can't initialize a specific
	// page until we have the correct wiki config, since things like
	// namespace aliases may not be same as the baseconfig, which has an
	// effect on what are considered valid titles.  At present, the only
	// consequence should be that failed config requests would all be
	// attributed to the mainpage, which doesn't seem so bad.
	this.initializeForPageName(this.conf.wiki.mainpage);

	this.pipelineFactory = new ParserPipelineFactory(this);

	// Outstanding page requests (for templates etc)
	this.requestQueue = {};

	this.batcher = new Batcher(this);

	this.setResourceLimits();

	// Fragments have had `storeDataAttribs` called on them
	this.fragmentMap = new Map();
	this.fid = 1;
};

// NOTE: Here's the spot to stuff references to $doc in the PHP port.
MWParserEnvironment.prototype.referenceDataObject = function(doc, bag) {
	DOMDataUtils.setDocBag(doc, bag);
};

MWParserEnvironment.prototype.createDocument = function(html) {
	const doc = DOMUtils.parseHTML(html);
	this.referenceDataObject(doc);
	return doc;
};

MWParserEnvironment.prototype.setFragment = function(nodes) {
	var oid = 'mwf' + this.fid++;
	this.fragmentMap.set(oid, nodes);
	return oid;
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
			// future but printWt2HtmlResourceUse exploits this convention.
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

MWParserEnvironment.prototype.bumpProfileTimeUse = function(profile, resource, time, cat) {
	if (!profile[resource]) {
		profile[resource] = 0;
	}
	profile[resource] += time;

	if (cat) {
		if (!this.timeCategories[cat]) {
			this.timeCategories[cat] = 0;
		}
		this.timeCategories[cat] += time;
	}
};

MWParserEnvironment.prototype.bumpTimeUse = function(resource, time, cat) {
	this.bumpProfileTimeUse(this.timeProfile, resource, time, cat);
};

MWParserEnvironment.prototype.bumpMWTime = function(resource, time, cat) {
	this.bumpProfileTimeUse(this.mwProfile, resource, time, cat);
};

MWParserEnvironment.prototype.bumpIOTime = function(resource, time, cat) {
	this.bumpProfileTimeUse(this.ioProfile, resource, time, cat);
};

MWParserEnvironment.prototype.bumpCount = function(resource, n) {
	if (!this.counts[resource]) {
		this.counts[resource] = 0;
	}
	if (!n) { n = 1; } // DEFAULT
	this.counts[resource] += n;
};

function formatLine(k, v, comment) {
	if (v === Math.round(v)) {
		return k.padStart(40) + ': ' + JSON.stringify(v).padStart(14) + (comment ? ' (' + comment + ')' : '');
	} else {
		return k.padStart(40) + ': ' + v.toFixed(5).padStart(14) + (comment ? ' (' + comment + ')' : '');
	}
}

MWParserEnvironment.prototype._formatProfile = function(profile, options) {
	if (!options) {
		options = {};
	}

	// Sort time profile in descending order
	var k, v;
	var total = 0;
	var outLines = [];
	for (k in profile) {
		v = profile[k];
		total += v;
		outLines.push([k, v]);
	}

	outLines.sort(function(a, b) {
		return b[1] - a[1];
	});

	var lines = [];
	for (var i = 0; i < outLines.length; i++) {
		k = outLines[i][0];
		v = outLines[i][1];
		let lineComment = '';
		if (options.printPercentage) {
			lineComment = Math.round(v * 1000 / total) / 10 + '%';
		}
		let buf = formatLine(k, v, lineComment);
		if (this.counts[k]) {
			buf += '; count: ' + JSON.stringify(this.counts[k]).padStart(6);
			buf += '; per-instance: ' +
			(v / this.counts[k]).toFixed(5).padEnd(10);
		}
		lines.push(buf);
	}
	return { buf: lines.join('\n'), total: total };
};

MWParserEnvironment.prototype.printTimeProfile = function() {
	var endTime = JSUtils.startTime();
	var mwOut = this._formatProfile(this.mwProfile);
	var ioOut = this._formatProfile(this.ioProfile);
	var cpuOut = this._formatProfile(this.timeProfile);
	this.log('trace/time', 'Finished parse at ', endTime);

	var outLines = [];
	outLines.push("-".repeat(85));
	outLines.push("Recorded times (in ms) for various parse components");
	outLines.push("");
	outLines.push(cpuOut.buf);
	outLines.push("-".repeat(85));
	outLines.push(ioOut.buf);
	outLines.push("");
	outLines.push(formatLine('Total API requests', this.counts["io.requests"]));
	if (this.counts.batches) {
		outLines.push(formatLine('# non-batched API requests', this.counts["io.requests"] - this.counts.batches));
		outLines.push(formatLine('# batches', this.counts.batches));
		outLines.push(formatLine('# API requests in batches', this.counts["batch.requests"]));
	}
	outLines.push("-".repeat(85));
	outLines.push(formatLine('TOTAL PARSE TIME (1)', endTime - this.startTime));
	outLines.push(formatLine('TOTAL PARSOID CPU TIME (2)', cpuOut.total));
	outLines.push(formatLine('Un/over-accounted parse time: (1) - (2)', endTime - this.startTime - cpuOut.total));
	outLines.push("");
	var catOut = this._formatProfile(this.timeCategories, { printPercentage: true });
	outLines.push(catOut.buf);
	outLines.push("");
	outLines.push(formatLine('TOTAL M/W API (I/O, CPU, QUEUE) TIME', ioOut.total, 'Total time across concurrent MW API requests'));
	if (mwOut.total > 0) {
		outLines.push(formatLine('TOTAL M/W CPU TIME', mwOut.total, 'Total CPU time across concurrent MW API requests'));
	}
	outLines.push("-".repeat(85));

	console.warn(outLines.join("\n"));
};

/**
 * @class
 */
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

MWParserEnvironment.prototype.bumpWt2HtmlResourceUse = function(resource, count) {
	var n = this.limits.wt2html[resource];
	n -= (count || 1);
	if (n < 0) {
		throw new PayloadTooLargeError(
			'wt2html: Exceeded max resource use: ' + resource + '. Aborting!');
	}
	this.limits.wt2html[resource] = n;
};

MWParserEnvironment.prototype.bumpHtml2WtResourceUse = function(resource, count) {
	var n = this.limits.html2wt[resource];
	n -= (count || 1);
	if (n < 0) {
		throw new PayloadTooLargeError(
			'html2wt: Exceeded max resource use: ' + resource + '. Aborting!');
	}
	this.limits.html2wt[resource] = n;
};

MWParserEnvironment.prototype.printWt2HtmlResourceUsage = function(otherResources) {
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

MWParserEnvironment.prototype.setLogger = function(logger) {
	this.logger = logger;
	this.log = (...args) => this.logger.log(...args);
};

MWParserEnvironment.prototype.configureLogging = function() {
	this.lintLogger = new LintLogger(this);
	var logger = new ParsoidLogger(this);
	var logLevels = this.logLevels || [
		"fatal", "error", "warn", "info",
	];
	logger.registerLoggingBackends(logLevels, this.conf.parsoid, this.lintLogger);
	this.setLogger(logger);
};

MWParserEnvironment.resetConfCache = function() {
	// Cache for wiki configurations, shared between requests.
	MWParserEnvironment.prototype.confCache = {};
};
MWParserEnvironment.resetConfCache();

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
 * See if we can reuse transclusion or extension expansions.
 *
 * @param {Object} obj
 * @param {string} obj.html
 * @param {Object} obj.updates Update mode.
 */
MWParserEnvironment.prototype.cacheReusableExpansions = function(obj) {
	var body = ContentUtils.ppToDOM(this, obj.html);
	var expansions = PipelineUtils.extractExpansions(this, body);
	var updates = Object.assign({}, obj.updates);
	Object.keys(updates).forEach(function(mode) {
		switch (mode) {
			case 'transclusions':
			case 'media':
				// Truthy values indicate that these need updating,
				// so don't reuse them.
				if (updates[mode]) {
					expansions[mode] = {};
				}
				break;
			default:
				throw new Error('Received an unexpected update mode.');
		}
	});
	this.setCaches(expansions);
};

/**
 * Set the src and optionally meta information for the page we're parsing.
 *
 * If the argument is a simple string, will clear metadata and just
 * set `this.page.src`.  Otherwise, the provided metadata object should
 * have fields corresponding to the JSON output given by
 * `action=query&prop=revisions` on the MW API.  That is:
 * ```
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
 *         slots: {
 *           main: {
 *             contentmodel:
 *             contentformat:
 *             "*   ":     // actual source text --> copied to this.page.src
 *           }
 *         }
 *       }
 *     }
 * ```
 * @param {string|Object} srcOrMetadata page source or metadata
 */
MWParserEnvironment.prototype.setPageSrcInfo = function(srcOrMetadata) {
	if (typeof srcOrMetadata === 'string' || !srcOrMetadata) {
		this.page.reset();
		this.page.src = srcOrMetadata || '';
		this.topFrame.srcText = this.page.src;
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
	var content = Util.getStar(metadata.revision);
	if (metadata.revision) {
		r.revid = metadata.revision.revid;
		r.parentid = metadata.revision.parentid;
		r.timestamp = metadata.revision.timestamp;
		r.sha1 = metadata.revision.sha1;
		r.size = metadata.revision.size;
		r.contentmodel = content && content.contentmodel;
		r.contentformat = content && content.contentformat;
	}

	// Update other page properties
	this.page.id = metadata.id || -1;
	this.page.ns = metadata.ns;
	this.page.latest = metadata.latest;
	this.page.pagelanguage = metadata.pagelanguage;
	this.page.pagelanguagedir = metadata.pagelanguagedir;
	this.page.src = (content && content['*']) || '';
	this.page.setVariant(null);

	this.topFrame.srcText = this.page.src;
};

/**
 * Initialize the environment for the page.
 *
 * @param {string} pageName
 * The "true" url-decoded pagename (see above).
 */
MWParserEnvironment.prototype.initializeForPageName = function(pageName, dontReset) {
	// Don't use the previous page's namespace as the default
	this.page.ns = 0;
	// Create a title from the pageName
	var title = this.makeTitleFromURLDecodedStr(pageName);
	this.page.ns = title.getNamespace()._id;
	this.page.title = title;
	this.page.name = pageName;
	this.topFrame.title = title;

	// Always prefix a ./ so that we don't have to escape colons. Those
	// would otherwise fool browsers into treating namespaces (like File:)
	// as protocols.
	this.page.relativeLinkPrefix = "./";

	// makeLink uses the relative link prefix => this should always
	// be done after that initialization.
	this.page.titleURI = this.makeLink(title);

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
 * @return {Promise<MWParserEnvironment>} The finished environment object
 * @static
 */
MWParserEnvironment.getParserEnv = Promise.async(function *(parsoidConfig, options) {
	// Get that wiki's config
	options = options || {};
	// Domain takes precedence over prefix; this call also allows for dynamic
	// configuration.
	if (options.domain) {
		options.prefix = parsoidConfig.getPrefixFor(options.domain);
	}
	if (!options.prefix || !parsoidConfig.mwApiMap.has(options.prefix)) {
		throw new Error('No API URI available for prefix: ' + options.prefix + '; domain: ' + options.domain);
	}
	var env = new MWParserEnvironment(parsoidConfig, options);
	yield env.switchToConfig(options.prefix, false);
	// Now that we have a config, we need to reinitialize the page
	// since, for example, not all wikis share the same namespace
	// aliases as enwiki.
	env.initializeForPageName(options.pageName || env.conf.wiki.mainpage, true);
	return env;
}, 2);

/**
 * Function that switches to a different configuration for a different wiki.
 * Caches all configs so we only need to get each one once (if we do it right)
 *
 * @method
 * @param {string} prefix The interwiki prefix that corresponds to the wiki we should use
 * @param {boolean} noCache Don't use cached configs; mainly for testing.
 * @return {Promise}
 */
MWParserEnvironment.prototype.switchToConfig = Promise.async(function *(prefix, noCache) {
	var env = this;
	var parsoidConfig = env.conf.parsoid;
	var resultConf;

	if (!prefix || !parsoidConfig.mwApiMap.has(prefix)) {
		throw new Error('No API URI available for prefix: ' + prefix);
	} else {
		if (!noCache && env.confCache[prefix]) {
			env.conf.wiki = env.confCache[prefix];
			return; // done!
		} else if (parsoidConfig.fetchConfig) {
			resultConf = yield ConfigRequest.promise(env);
		} else {
			// Load the config from cached config on disk
			var localConfigFile = '../../baseconfig/' + prefix + '.json';
			var localConfig = require(localConfigFile);
			if (localConfig && localConfig.query) {
				resultConf = localConfig.query;
			} else {
				throw new Error(
					'Could not read valid config from file: ' + localConfigFile
				);
			}
		}
	}

	env.conf.wiki = new WikiConfig(parsoidConfig, resultConf, prefix);
	env.confCache[prefix] = env.conf.wiki;
	if (parsoidConfig.fetchConfig) {
		yield env.conf.wiki.detectFeatures(env);
	}
});

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
	urlDecodedStr = urlDecodedStr.trim();
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

MWParserEnvironment.prototype._titleToString = function(title, ignoreFragment) {
	var fragment;
	if (ignoreFragment) {
		fragment = '';
	} else {
		fragment = title.getFragment() || '';
		if (fragment) {
			fragment = '#' + fragment;
		}
	}
	return title.getPrefixedDBKey() + fragment;
};

/**
 * Get normalized title key for a title string.
 *
 * @param {string} [urlDecodedStr] Should be in url-decoded format.
 * @param {boolean} [noExceptions] Return null instead of throwing exceptions.
 * @param {boolean} [ignoreFragment] Ignore the fragment, if any.
 * @return {string|null} Normalized title key for a title string (or null for invalid titles).
 */
MWParserEnvironment.prototype.normalizedTitleKey = function(urlDecodedStr, noExceptions, ignoreFragment) {
	var title = this.makeTitleFromURLDecodedStr(urlDecodedStr, undefined, noExceptions);
	if (!title) {
		return null;
	}

	return this._titleToString(title, ignoreFragment);
};

MWParserEnvironment.prototype.normalizeAndResolvePageTitle = function() {
	return this._titleToString(this.page.title);
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
/* See: Title::newFromURL in mediawiki. */
MWParserEnvironment.prototype.makeTitleFromText = function(str, defaultNS, noExceptions) {
	return this._makeTitle(Util.decodeURIComponent(str), defaultNS, noExceptions);
};

/* See: Title::newFromText in mediawiki. */
MWParserEnvironment.prototype.makeTitleFromURLDecodedStr = function(str, defaultNS, noExceptions) {
	return this._makeTitle(str, defaultNS, noExceptions);
};

MWParserEnvironment.prototype.makeLink = function(title) {
	return Sanitizer.sanitizeTitleURI(this.page.relativeLinkPrefix + this._titleToString(title), false);
};

MWParserEnvironment.prototype.isValidLinkTarget = function(href) {
	// decode percent-encoding so that we can reliably detect
	// bad page title characters
	var hrefToken = Util.decodeURIComponent(TokenUtils.tokensToString(href));
	return this.normalizedTitleKey(this.resolveTitle(hrefToken, true), true) !== null;
};

MWParserEnvironment.prototype.initUID = function() {
	this.uid = 1;
};

/**
 * Generate a UID.
 *
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
 * A passed-in cookie, if any
 */
MWParserEnvironment.prototype.cookie = null;

/**
 * A passed-in request id, if any
 */
MWParserEnvironment.prototype.reqId = null;

/**
 * A passed-in user agent, if any
 */
MWParserEnvironment.prototype.userAgent = null;

/**
 * Apply extra normalizations before serializing DOM.
 */
MWParserEnvironment.prototype.scrubWikitext = false;

/**
 * Sets ids on nodes and stores data-* attributes in a JSON blob
 */
MWParserEnvironment.prototype.pageBundle = false;

/**
 * @property {string} wikitextVersion
 */
MWParserEnvironment.prototype.wikitextVersion = '1.0.0';

/**
 * The content versions Parsoid knows how to produce.
 * Ordered by desirability.
 *
 * @property {Array} availableVersions
 */
MWParserEnvironment.prototype.availableVersions = ['2.1.0', '999.0.0'];

/**
 * The default content version that Parsoid will generate.
 *
 * @property {string} outputContentVersion
 */
MWParserEnvironment.prototype.outputContentVersion = MWParserEnvironment.prototype.availableVersions[0];

/**
 * The default content version that Parsoid assumes it's serializing or updating
 * in the pb2pb endpoints
 *
 * @property {string} inputContentVersion
 */
MWParserEnvironment.prototype.inputContentVersion = MWParserEnvironment.prototype.availableVersions[0];

/**
 * Whether Parsoid should add HTML section wrappers around logical sections.
 * Defaults to true.
 *
 * @property {string} wrapSections
 */
MWParserEnvironment.prototype.wrapSections = true;

/**
 * If non-null, the language variant used for Parsoid HTML; we convert
 * to this if wt2html, or from this (if html2wt).
 */
MWParserEnvironment.prototype.htmlVariantLanguage = null;

/**
 * If non-null, the language variant to be used for wikitext.  If null,
 * heuristics will be used to identify the original wikitext variant
 * in wt2html mode, and in html2wt mode new or edited HTML will be left
 * unconverted.
 */
MWParserEnvironment.prototype.wtVariantLanguage = null;

/**
 * See if any content version Parsoid knows how to produce satisfies the
 * the supplied version, when interpreted with semver caret semantics.
 * This will allow us to make backwards compatible changes, without the need
 * for clients to bump the version in their headers all the time.
 *
 * @param {string} v
 * @return {string|null}
 */
MWParserEnvironment.prototype.resolveContentVersion = function(v) {
	for (var i = 0; i < this.availableVersions.length; i++) {
		var a = this.availableVersions[i];
		if (semver.satisfies(a, '^' + v) &&
				// The section wrapping in 1.6.x should have induced a major
				// version bump, since it requires upgrading clients to
				// handle it.  We therefore hardcode this in so that we can
				// fail hard.
				semver.gte(v, '1.6.0')) {
			return a;
		}
	}
	return null;
};

/**
 * @param {string} v
 */
MWParserEnvironment.prototype.setOutputContentVersion = function(v) {
	if (this.availableVersions.indexOf(v) < 0) {
		throw new Error('Not an available content version.');
	}
	this.outputContentVersion = v;
};

MWParserEnvironment.prototype.scriptPath = function() {
	return this.conf.wiki.server.replace(/^[^\/]*\/\//, '//') +
		(this.conf.wiki.scriptpath || '');
};

MWParserEnvironment.prototype.getModulesLoadURI = function() {
	var modulesLoadURI = this.conf.parsoid.modulesLoadURI;
	if (modulesLoadURI === true) {
		this.log('warn',
			'Setting `modulesLoadURI` to `true` is no longer supported.');
		modulesLoadURI = undefined;
	}
	if (modulesLoadURI === undefined) {
		return this.scriptPath() + '/load.php';
	} else {
		return modulesLoadURI;
	}
};

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
 * @private
 */
var whitelist = new Set([
	'css',
	'javascript',
	'wikibase-item',
	'wikibase-lexeme',
	'wikibase-property',
	'proofread-page',
	'proofread-index',
	'Scribunto',
	'flow-board',
]);

/**
 * Get an appropriate content handler, given a contentmodel.
 *
 * @param {string} [forceContentModel] An optional content model
 *   which will override whatever the source specifies.
 * @return {Object} An appropriate content handler with `toHTML` and `fromHTML`
 *   methods.
 */
MWParserEnvironment.prototype.getContentHandler = function(forceContentModel) {
	var contentmodel = forceContentModel || this.page.getContentModel();
	if (!this.conf.wiki.extConfig.contentModels.has(contentmodel)) {
		if (!whitelist.has(contentmodel)) {
			this.log('warn', 'Unknown contentmodel', contentmodel);
		}
		contentmodel = 'wikitext';
	}
	return this.conf.wiki.extConfig.contentModels.get(contentmodel);
};

/**
 * Determine if LanguageConverter markup should be parsed on this page,
 * based on the wiki configuration and the current page language.
 *
 * @return {boolean}
 */
MWParserEnvironment.prototype.langConverterEnabled = function() {
	var lang = this.page.pagelanguage || this.conf.wiki.lang || 'en';
	return this.conf.wiki.langConverterEnabled.has(lang);
};

/**
 * Determine an appropriate content-language for the HTML form of this page.
 */
MWParserEnvironment.prototype.htmlContentLanguage = function() {
	// this.page.htmlVariant is set iff we do variant conversion on the HTML
	return this.page.htmlVariant ||
		this.page.pagelanguage || this.conf.wiki.lang || 'en';
};

/**
 * Determine appropriate vary headers for the HTML form of this page.
 */
MWParserEnvironment.prototype.htmlVary = function() {
	const varies = [ 'Accept' ]; // varies on Content-Type
	if (this.langConverterEnabled()) {
		varies.push('Accept-Language');
	}
	return varies.sort().join(', ');
};


if (typeof module === "object") {
	module.exports.MWParserEnvironment = MWParserEnvironment;
}
