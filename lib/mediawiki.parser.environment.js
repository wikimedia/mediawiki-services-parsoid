'use strict';
require('./core-upgrade.js');

var WikiConfig = require('./mediawiki.WikiConfig.js').WikiConfig;
var ParsoidConfig = require('./mediawiki.ParsoidConfig.js').ParsoidConfig;
var ConfigRequest = require('./mediawiki.ApiRequest.js').ConfigRequest;
var Batcher = require('./mediawiki.Batcher.js').Batcher;
var Util = require('./mediawiki.Util.js').Util;
var JSUtils = require('./jsutils.js').JSUtils;
var Title = require('./mediawiki.Title.js').Title;
var ParserPipelineFactory = require('./mediawiki.parser.js').ParserPipelineFactory;
var Linter = require('./linter.js').Linter;
var ParsoidLogger = require('./ParsoidLogger.js').ParsoidLogger;
var util = require('util');

/**
 * @class
 *
 * Holds configuration data that isn't modified at runtime, debugging objects,
 * a page object that represents the page we're parsing, and more.
 *
 * @constructor
 * @param {ParsoidConfig|null} parsoidConfig
 * @param {WikiConfig|null} wikiConfig
 */
var MWParserEnvironment = function(parsoidConfig, wikiConfig, options) {
	options = options || {};

	// page information
	this.page = {
		name: this.defaultPageName,
		relativeLinkPrefix: '',
		id: null,
		src: null,  // start as null to distinguish the empty string
		dom: null,
		ns: null,
		title: null,  // a full Title object
	};

	// A passed-in cookie, if any
	this.cookie = options.cookie || null;

	// A passed-in request id, if any
	this.reqId = options.reqId || null;

	// Configuration
	this.conf = {};

	// execution state
	// TODO gwicke: probably not that useful any more as this is per-request
	// and the PHP preprocessor eliminates template source hits
	this.pageCache = {};
	// Global transclusion expansion cache (templates, parser functions etc)
	// Key: Full transclusion source
	this.transclusionCache = {};
	// Global extension tag expansion cache (templates, parser functions etc)
	// Key: Full extension source (including tags)
	this.extensionCache = {};
	// Global image expansion cache
	// Key: Full image source
	this.fileCache = {};

	if (!parsoidConfig) {
		// Global things, per-parser
		parsoidConfig = new ParsoidConfig(null, null);
	}

	this.linter = new Linter(this);
	this.conf.parsoid = parsoidConfig;

	// Store this in the environment to manipulate it on each request,
	// if necessary. Avoids having to clone the config.
	this.storeDataParsoid = parsoidConfig.storeDataParsoid;

	this.configureLogging();

	if (!wikiConfig) {
		// Local things, per-wiki
		console.assert(parsoidConfig.mwApiMap.has(options.prefix));
		wikiConfig = new WikiConfig(
			this, null, options.prefix,
			parsoidConfig.mwApiMap.get(options.prefix).uri,
			this.getAPIProxy(options.prefix)
		);
	}

	this.conf.wiki = wikiConfig;

	this.initializeForPageName(options.pageName || this.defaultPageName);

	this.pipelineFactory = new ParserPipelineFactory(this);

	// Outstanding page requests (for templates etc)
	this.requestQueue = {};

	this.batcher = new Batcher(this);
};

MWParserEnvironment.prototype.configureLogging = function() {
	var logger = new ParsoidLogger(this);
	this.setLogger(logger);

	// Configure backends
	logger.registerLoggingBackends([
		"fatal", "error", "warning", "info",
	], this.conf.parsoid, this.linter);
};

// The default page name
MWParserEnvironment.prototype.defaultPageName = "Main Page";

// Cache for wiki configurations, shared between requests.
MWParserEnvironment.prototype.confCache = {};

/**
 * @property {Object} page
 * @property {String} page.name
 * @property {String|null} page.src
 * @property {Node|null} page.dom
 * @property {String} page.relativeLinkPrefix
 *   Any leading ..?/ strings that will be necessary for building links.
 * @property {Number|null} page.id
 *   The revision ID we want to use for the page.
 */

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
	if (typeof (srcOrMetadata) === 'string' || srcOrMetadata === null) {
		this.page.meta = { revision: {} };
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
 */
MWParserEnvironment.prototype.initializeForPageName = function(pageName, dontReset) {
	// Create a title from the pageName
	var title = Title.fromPrefixedText(this, pageName);
	this.page.ns = title.ns.id;
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
 * @param {ParsoidConfig|null} parsoidConfig
 * @param {WikiConfig|null} wikiConfig
 * @param {Object} options
 * @param {Function} cb
 * @param {Error} cb.err
 * @param {MWParserEnvironment} cb.env The finished environment object
 * @static
 */
MWParserEnvironment.getParserEnv = function(parsoidConfig, wikiConfig, options, cb) {
	// Get that wiki's config
	return Promise.method(function() {
		options = options || {};
		if (!options.prefix && options.domain && parsoidConfig.reverseMwApiMap.has(options.domain)) {
			options.prefix = parsoidConfig.reverseMwApiMap.get(options.domain);
		}
		if (!options.prefix || !parsoidConfig.mwApiMap.has(options.prefix)) {
			throw new Error('No API URI available for prefix: ' + options.prefix);
		}
		var env = new MWParserEnvironment(parsoidConfig, wikiConfig, options);
		return env.switchToConfig(options.prefix).then(function() {
			if (!options.pageName) {
				env.initializeForPageName(env.conf.wiki.mainpage, true);
			}
			return env;
		});
	})().nodify(cb);
};

/**
 * Figure out the proxy to use for API requests for a given wiki
 */
MWParserEnvironment.prototype.getAPIProxy = function(prefix) {
	var apiProxy = { uri: undefined, headers: undefined };
	// Don't update the stored proxy object, otherwise subsequent calls
	// with the same prefix may do the wrong thing. (ex. null -> undefined ->
	// defaultAPIProxyURI)
	Object.assign(apiProxy, this.conf.parsoid.mwApiMap.get(prefix).proxy);
	if (apiProxy.uri === null ||
		this.conf.parsoid.mwApiMap.get(prefix).proxy === null) {
		// Explicitly disable the proxy if null was set for this prefix
		apiProxy.uri = undefined;
	} else if (apiProxy.uri === undefined) {
		// No specific api proxy set. Fall back to generic API proxy.
		apiProxy.uri = this.conf.parsoid.defaultAPIProxyURI;
	}
	return apiProxy;
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
	var parsoid = env.conf.parsoid;

	var uri;
	var getConfigPromise = Promise.method(function() {
		if (!prefix || !parsoid.mwApiMap.has(prefix)) {
			throw new Error('No API URI available for prefix: ' + prefix);
		} else {
			uri = parsoid.mwApiMap.get(prefix).uri;
			if (env.confCache[prefix]) {
				env.conf.wiki = env.confCache[prefix];
				return nothingToDo;
			} else if (parsoid.fetchConfig) {
				return ConfigRequest
					.promise(uri, env, env.getAPIProxy(prefix));
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
		env.conf.wiki = new WikiConfig(env, resultConf, prefix, uri,
				env.getAPIProxy(prefix));
		env.confCache[prefix] = env.conf.wiki;
	}).nodify(cb);
};

// XXX: move to Title!
MWParserEnvironment.prototype.normalizeTitle = function(name, noUnderScores,
		preserveLeadingColon) {
	if (typeof name !== 'string') {
		throw new Error('nooooooooo not a string');
	}
	var forceNS;
	var self = this;
	if (name.substr(0, 1) === ':') {
		forceNS = preserveLeadingColon ? ':' : '';
		name = name.substr(1);
	} else {
		forceNS = '';
	}

	name = name.trim();
	if (!noUnderScores) {
		name = name.replace(/[\s_]+/g, '_');
	}

	// Implement int: as alias for MediaWiki:
	if (name.substr(0, 4) === 'int:') {
		name = 'MediaWiki:' + name.substr(4);
	}

	// FIXME: Generalize namespace case normalization
	if (name.substr(0, 10).toLowerCase() === 'mediawiki:') {
		name = 'MediaWiki:' + name.substr(10);
	}

	function upperFirst(s) {
		return s.substr(0, 1).toUpperCase() + s.substr(1);
	}

	function splitNS() {
		var nsMatch = name.match(/^([a-zA-Z\- _]+):/);
		var ns = nsMatch && nsMatch[1] || '';
		if (ns !== '' && ns !== name) {
			if (self.conf.wiki.interwikiMap.has(Util.normalizeNamespaceName(ns))) {
				forceNS += ns + ':';
				name = name.slice(nsMatch[0].length);
				splitNS();
			} else {
				name = upperFirst(ns) + ':' + upperFirst(name.substr(ns.length + 1));
			}
		} else if (!self.conf.wiki.caseSensitive) {
			name = upperFirst(name);
		}
	}
	splitNS();
	// name = name.split(':').map( upperFirst ).join(':');
	// if (name === '') {
	// 	throw new Error('Invalid/empty title');
	// }
	return forceNS + name;
};

/**
 * TODO: Handle namespaces relative links like [[User:../../]] correctly, they
 * shouldn't be treated like links at all.
 */
MWParserEnvironment.prototype.resolveTitle = function(name, namespace) {
	// Default to main namespace
	namespace = namespace || 0;
	if (/^#/.test(name)) {
		// resolve lonely fragments (important if this.page is a subpage,
		// otherwise the relative link will be wrong)
		name = this.page.name + name;
	}
	if (this.conf.wiki.namespacesWithSubpages[namespace]) {
		// Resolve subpages
		var relUp = name.match(/^(\.\.\/)+/);
		var normalize = false;
		if (relUp) {
			var levels = relUp[0].length / 3;  // Levels are indicated by '../'.
			var titleBits = this.page.name.split(/\//);
			var newBits = titleBits.slice(0, titleBits.length - levels);
			if (name !== relUp[0]) {
				newBits.push(name.substr(levels * 3));
			}
			name = newBits.join('/');
			normalize = true;
		} else if (name.length && name[0] === '/') {
			// Resolve absolute subpage links
			name = this.page.name + name;
			normalize = true;
		}
		if (normalize) {
			// Remove final slashes if present.
			// See https://gerrit.wikimedia.org/r/173431
			name = name.replace(/\/+$/, '');
			name = this.normalizeTitle(name);
		}
	}
	// Strip leading ':'
	if (name[0] === ':') {
		name = name.substr(1);
	}
	return name;
};

MWParserEnvironment.prototype.isValidLinkTarget = function(href) {
	var hrefToken = Util.tokensToString(href);
	var subpageEnabled = false;

	// For links starting with ../ and pointing to subpages
	if (this.conf.wiki.namespacesWithSubpages[this.page.ns]) {
		subpageEnabled = true;
	}

	// decode percent-encoding so that we can reliably detect
	// bad page title characters
	hrefToken = Util.decodeURI(hrefToken);
	// ignore #anchor portion of target, that's not part of the page name
	hrefToken = hrefToken.replace(/#[^#]*$/, '');

	// Check for excessively nested subpages
	if (subpageEnabled) {
		var depth = /^(\.\.\/)+/.exec(hrefToken);
		if (depth) {
			depth = depth[0].length / 3; // '../' is 3 characters long
			if (depth >= this.page.name.split('/').length) {
				return false;
			}
		}
	}

	// handle invalid cases defined here :
	// https://en.wikipedia.org/wiki/Wikipedia:Page_name#Technical_restrictions_and_limitations
	var re = /[{}<>\[\]]|\uFFFD|[\x7F\x00-\x1F]|^\.$|^\.\.$|~{3,}/;
	var re2 = /(^\.(\.)?\/)+|(\/\.(\.)?)+$|\/\.\/|\/\.\.\//;
	// "A pagename can have the character %, but it must be
	// percent-encoded as %25 in the URL, to prevent it from being
	// interpreted as a single character. To prevent ambiguity, page
	// names cannot contain % followed by 2 hexadecimal digits."
	if (/%[0-9a-f][0-9a-f]/i.test(hrefToken)) { return false; }
	return !(re.test(hrefToken) || (re2.test(hrefToken) && !subpageEnabled) || hrefToken.length > 255);
};

/**
 * Simple debug helper
 */
MWParserEnvironment.prototype.dp = function() {
	if (this.conf.parsoid.debug) {
		if (arguments.length > 1) {
			try {
				console.warn(JSON.stringify(arguments, null, 2));
			} catch (e) {
				console.trace();
				console.warn(e);
			}
		} else {
			console.warn(arguments[0]);
		}
	}
};

/**
 * Even simpler debug helper that always prints..
 */
MWParserEnvironment.prototype.ap = function() {
	if (arguments.length > 1) {
		try {
			console.warn(JSON.stringify(arguments, null, 2));
		} catch (e) {
			console.warn(e);
		}
	} else {
		console.warn(arguments[0]);
	}
};

/**
 * Simple debug helper, trace-only
 */
MWParserEnvironment.prototype.tp = function() {
	if (this.conf.parsoid.debug) {
		if (arguments.length > 1) {
			console.warn(JSON.stringify(arguments, null, 2));
		} else {
			console.warn(arguments[0]);
		}
	}
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

// Apply extra normalizations before serializing DOM.
MWParserEnvironment.prototype.scrubWikitext = false;

if (typeof module === "object") {
	module.exports.MWParserEnvironment = MWParserEnvironment;
}
