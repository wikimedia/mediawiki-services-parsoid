/** @module */

'use strict';

require('../core-upgrade.js');

var ParserEnv = require('./config/MWParserEnvironment.js').MWParserEnvironment;
var LanguageConverter = require('./language/LanguageConverter').LanguageConverter;
var AddRedLinks = require('./wt2html/pp/processors/AddRedLinks').AddRedLinks;
var ParsoidConfig = require('./config/ParsoidConfig.js').ParsoidConfig;
var TemplateRequest = require('./mw/ApiRequest.js').TemplateRequest;
var ContentUtils = require('./utils/ContentUtils.js').ContentUtils;
var DOMDataUtils = require('./utils/DOMDataUtils.js').DOMDataUtils;
var DOMUtils = require('./utils/DOMUtils.js').DOMUtils;
var Promise = require('./utils/promise.js');
var JSUtils = require('./utils/jsutils.js').JSUtils;

var _toHTML, _fromHTML;

/**
 * Transform content-model to html
 * (common-case will be wikitext -> html)
 *
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {string} str
 *
 * @return {Promise} Assuming we're ending at html
 *   @return {string} return.html
 *   @return {Array} return.lint The lint buffer
 *   @return {string} return.contentmodel
 *   @return {Object} return.headers HTTP language-related headers
 *   @return {string} return.headers.content-language Page language or variant
 *   @return {string} return.headers.vary Indicates whether variant conversion
 *     was done or could be done
 *   @return {Object} [return.pb] If pageBundle was requested
 */
_toHTML = Promise.async(function *(obj, env, str) {
	// `str` will be `undefined` when we fetched page source and info,
	// which we don't want to overwrite.
	if (str !== undefined) {
		env.setPageSrcInfo(str);
	}
	var handler = env.getContentHandler(obj.contentmodel);
	var doc = yield handler.toHTML(env);
	var out;
	if (env.pageBundle) {
		out = ContentUtils.extractDpAndSerialize(obj.body_only ? doc.body : doc, {
			innerXML: obj.body_only,
		});
	} else {
		out = {
			html: ContentUtils.toXML(obj.body_only ? doc.body : doc, {
				innerXML: obj.body_only,
			}),
		};
	}

	if (env.conf.parsoid.linting) {
		out.lint = env.lintLogger.buffer;
		yield env.log("end/parse"); // wait for linter logging to complete
	}
	out.contentmodel = (obj.contentmodel || env.page.getContentModel());
	out.headers = DOMUtils.findHttpEquivHeaders(doc);
	return out;
});

/**
 * Transform html to requested content-model
 *
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {string} html
 * @param {Object} pb
 *
 * @return {Promise} Assuming we're ending at wt
 *   @return {string} return.wt
 */
_fromHTML = Promise.async(function *(obj, env, html, pb) {
	var useSelser = (obj.selser !== undefined);
	var doc = env.createDocument(html);
	pb = pb || DOMDataUtils.extractPageBundle(doc);
	if (useSelser && env.page.dom) {
		pb = pb || DOMDataUtils.extractPageBundle(env.page.dom.ownerDocument);
		if (pb) {
			DOMDataUtils.applyPageBundle(env.page.dom.ownerDocument, pb);
		}
	}
	if (pb) {
		DOMDataUtils.applyPageBundle(doc, pb);
	}
	var handler = env.getContentHandler(obj.contentmodel);
	var out = yield handler.fromHTML(env, doc.body, useSelser);
	return { wt: out };
});

/**
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {string} html
 */
const _languageConversion = function(obj, env, html) {
	const doc = env.createDocument(html);
	// Note that `maybeConvert` could still be a no-op, in case the
	// __NOCONTENTCONVERT__ magic word is present, or the targetVariant
	// is a base language code or otherwise invalid.
	LanguageConverter.maybeConvert(
		env, doc, obj.variant.target,
		// FIXME: Setting this is untested and broken!
		null  // obj.variant.source
	);
	// Ensure there's a <head>
	if (!doc.head) {
		doc.documentElement
			.insertBefore(doc.createElement('head'), doc.body);
	}
	// Update content-language and vary headers.
	const ensureHeader = (h) => {
		let el = doc.querySelector(`meta[http-equiv="${h}"i]`);
		if (!el) {
			el = doc.createElement('meta');
			el.setAttribute('http-equiv', h);
			doc.head.appendChild(el);
		}
		return el;
	};
	ensureHeader('content-language')
		.setAttribute('content', env.htmlContentLanguage());
	ensureHeader('vary')
		.setAttribute('content', env.htmlVary());
	// Serialize & emit.
	return {
		html: ContentUtils.toXML(obj.body_only ? doc.body : doc, {
			innerXML: obj.body_only,
		}),
		headers: DOMUtils.findHttpEquivHeaders(doc),
	};
};

const _updateRedLinks = Promise.async(function *(obj, env, html) {
	var doc = env.createDocument(html);
	// Note: this only works if the configured wiki has the ParsoidBatchAPI
	// extension installed.
	yield AddRedLinks.addRedLinks(env, doc);
	// No need to `ContentUtils.extractDpAndSerialize`, it wasn't applied.
	return {
		html: ContentUtils.toXML(obj.body_only ? doc.body : doc, {
			innerXML: obj.body_only,
		}),
		headers: DOMUtils.findHttpEquivHeaders(doc),
	};
});

/**
 * Map of JSON.stringified parsoidOptions to ParsoidConfig
 */
var configCache = new Map();

/**
 * Parse wikitext (or html) to html (or wikitext).
 *
 * @param {Object} obj
 * @param {string} obj.input The string to parse
 * @param {string} obj.mode The mode to use
 * @param {Object} obj.parsoidOptions Will be Object.assign'ed to ParsoidConfig
 * @param {Object} obj.envOptions Will be Object.assign'ed to the env
 * @param {boolean} [obj.cacheConfig] Cache the constructed ParsoidConfig
 * @param {boolean} [obj.body_only] Only return the <body> children (T181657)
 * @param {Number} [obj.oldid]
 * @param {Object} [obj.selser]
 * @param {Object} [obj.pb]
 * @param {string} [obj.contentmodel]
 * @param {string} [obj.outputContentVersion]
 * @param {Object} [obj.reuseExpansions]
 * @param {string} [obj.pagelanguage]
 * @param {Object} [obj.variant]
 * @param {Function} [cb] Optional node-style callback
 *
 * @return {Promise}
 */
module.exports = Promise.async(function *(obj) {
	var start = JSUtils.startTime();

	// Enforce the contraints of passing to a worker
	obj = JSON.parse(JSON.stringify(obj));

	var hash = JSON.stringify(obj.parsoidOptions);
	var parsoidConfig;
	if (obj.cacheConfig && configCache.has(hash)) {
		parsoidConfig = configCache.get(hash);
	} else {
		parsoidConfig = new ParsoidConfig(null, obj.parsoidOptions);
		if (obj.cacheConfig) {
			configCache.set(hash, parsoidConfig);
			// At present, we don't envision using the cache with multiple
			// configurations.  Prevent it from growing unbounded inadvertently.
			console.assert(configCache.size === 1, 'Config properties changed.');
		}
	}

	var env = yield ParserEnv.getParserEnv(parsoidConfig, obj.envOptions);
	env.startTime = start;
	var s1 = JSUtils.startTime();
	env.bumpTimeUse("Setup Environment", s1 - start, 'Init');
	env.log('info', 'started ' + obj.mode);
	try {

		if (obj.oldid) {
			env.page.meta.revision.revid = obj.oldid;
		}

		var out;
		if (obj.mode === 'variant') {
			env.page.pagelanguage = obj.pagelanguage;
			return _languageConversion(obj, env, obj.input);
		} else if (obj.mode === 'redlinks') {
			return _updateRedLinks(obj, env, obj.input);
		} else if (['html2wt', 'html2html', 'selser'].includes(obj.mode)) {
			// Selser
			var selser = obj.selser;
			if (selser !== undefined) {
				if (selser.oldtext !== null) {
					env.setPageSrcInfo(selser.oldtext);
				}
				if (selser.oldhtml) {
					env.page.dom = env.createDocument(selser.oldhtml).body;
				}
				if (selser.domdiff) {
					// FIXME: need to load diff markers from attributes
					env.page.domdiff = {
						isEmpty: false,
						dom: ContentUtils.ppToDOM(env, selser.domdiff),
					};
					throw new Error('this is broken');
				}
			}
			var html = obj.input;
			env.bumpHtml2WtResourceUse('htmlSize', html.length);
			out = yield _fromHTML(obj, env, html, obj.pb);
			return obj.mode === 'html2html' ? _toHTML(obj, env, out.wt) : out;
		} else { /* wt2html, wt2wt */
			// The content version to output
			if (obj.outputContentVersion) {
				env.setOutputContentVersion(obj.outputContentVersion);
			}

			if (obj.reuseExpansions) {
				env.cacheReusableExpansions(obj.reuseExpansions);
			}

			var wt = obj.input;

			// Always fetch page info if we have an oldid
			if (obj.oldid || wt === undefined) {
				var target = env.normalizeAndResolvePageTitle();
				yield TemplateRequest.setPageSrcInfo(env, target, obj.oldid);
				env.bumpTimeUse("Pre-parse (source fetch)", JSUtils.elapsedTime(s1), 'Init');
				// Ensure that we don't env.page.reset() when calling
				// env.setPageSrcInfo(wt) in _toHTML()
				if (wt !== undefined) {
					env.topFrame.srcText = env.page.src = wt;
					wt = undefined;
				}
			}

			var wikitextSize = wt !== undefined ? wt.length : env.page.src.length;
			env.bumpWt2HtmlResourceUse('wikitextSize', wikitextSize);
			if (parsoidConfig.metrics) {
				var mstr = obj.envOptions.pageWithOldid ? 'pageWithOldid' : 'wt';
				parsoidConfig.metrics.timing(`wt2html.${mstr}.size.input`, wikitextSize);
			}

			// Explicitly setting the pagelanguage can override the fetched one
			if (obj.pagelanguage) {
				env.page.pagelanguage = obj.pagelanguage;
			}

			out = yield _toHTML(obj, env, wt);
			return obj.mode === 'wt2html' ? out : _fromHTML(obj, env, out.html);
		}
	} finally {
		var end = JSUtils.elapsedTime(start);
		yield env.log('info', `completed ${obj.mode} in ${end}ms`);
	}
}, 1);
