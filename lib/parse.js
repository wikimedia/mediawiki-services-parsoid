'use strict';

require('../core-upgrade.js');

var ParserEnv = require('./config/MWParserEnvironment.js').MWParserEnvironment;
var ParsoidConfig = require('./config/ParsoidConfig.js').ParsoidConfig;
var TemplateRequest = require('./mw/ApiRequest.js').TemplateRequest;
var DU = require('./utils/DOMUtils.js').DOMUtils;
var Promise = require('./utils/promise.js');

var wt2html, html2wt;

/**
 * Transform wikitext to html
 *
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {String} wt
 *
 * @return {Promise} Assuming we're ending at html
 *   @return {String} return.html
 *   @return {Array} return.lint The lint buffer
 *   @return {String} return.contentmodel
 *   @return {Object} [return.pb] If pageBundle was requested
 */
wt2html = function(obj, env, wt) {
	// `wt` will be `undefined` when we fetched page source and info,
	// which we don't want to overwrite.
	if (wt !== undefined) {
		env.setPageSrcInfo(wt);
	}
	var handler = env.getContentHandler(obj.contentmodel);
	return handler.toHTML(env)
	.tap(function(doc) {
		if (env.conf.parsoid.useBatchAPI) {
			return DU.addRedLinks(env, doc);
		}
	})
	.then(function(doc) {
		if (['wt2html', 'html2html'].includes(obj.mode)) {
			var out;
			if (env.pageBundle) {
				out = DU.extractDpAndSerialize(obj.bodyOnly ? doc.body : doc, {
					innerXML: obj.bodyOnly,
				});
			} else {
				out = {
					html: DU.toXML(obj.bodyOnly ? doc.body : doc, {
						innerXML: obj.bodyOnly,
					}),
				};
			}
			out.lint = env.lintLogger.buffer;
			if (env.conf.parsoid.linting) {
				env.log("end/parse");
			}
			out.contentmodel = (obj.contentmodel || env.page.getContentModel());
			return out;
		} else {
			return html2wt(obj, env, DU.toXML(doc));
		}
	});
};

/**
 * Transform html to wikitext
 *
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {String} html
 * @param {Object} pb
 *
 * @return {Promise} Assuming we're ending at wt
 *   @return {String} return.wt
 */
html2wt = function(obj, env, html, pb) {
	var useSelser = (obj.selser !== undefined);
	var doc = DU.parseHTML(html);
	pb = pb || DU.extractPageBundle(doc);
	if (useSelser && env.page.dom) {
		pb = pb || DU.extractPageBundle(env.page.dom.ownerDocument);
		if (pb) {
			DU.applyPageBundle(env.page.dom.ownerDocument, pb);
		}
	}
	if (pb) {
		DU.applyPageBundle(doc, pb);
	}
	var handler = env.getContentHandler(obj.contentmodel);
	return handler.fromHTML(env, doc.body, useSelser)
	.then(function(out) {
		if (['html2wt', 'wt2wt', 'selser'].includes(obj.mode)) {
			return { wt: out };
		} else {
			return wt2html(obj, env, out);
		}
	});
};

/**
 * Map of JSON.stringified parsoidOptions to ParsoidConfig
 */
var configCache = new Map();

/**
 * Parse wikitext (or html) to html (or wikitext).
 *
 * @param {Object} obj
 * @param {String} obj.input The string to parse
 * @param {String} obj.mode The mode to use
 * @param {Object} obj.parsoidOptions Will be Object.assign'ed to ParsoidConfig
 * @param {Object} obj.envOptions Will be Object.assign'ed to the env
 * @param {Boolean} [obj.cacheConfig] Cache the constructed ParsoidConfig
 * @param {Boolean} [obj.bodyOnly]
 * @param {Number} [obj.oldid]
 * @param {Object} [obj.selser]
 * @param {Object} [obj.pb]
 * @param {String} [obj.contentmodel]
 * @param {String} [obj.contentVersion]
 * @param {Object} [obj.reuseExpansions]
 * @param {Function} [cb] Optional callback
 *
 * @return {Promise}
 */
module.exports = Promise.method(function(obj, cb) {
	var start = Date.now();

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

	return ParserEnv.getParserEnv(parsoidConfig, obj.envOptions)
	.then(function(env) {
		env.startTime = start;

		// The content version to output
		if (obj.contentVersion) {
			env.setContentVersion(obj.contentVersion);
		}

		if (obj.reuseExpansions) {
			env.cacheReusableExpansions(obj.reuseExpansions);
		}

		if (obj.oldid) {
			env.page.meta.revision.revid = obj.oldid;
		}

		// Selser
		var selser = obj.selser;
		if (selser !== undefined) {
			if (selser.oldtext !== null) {
				env.setPageSrcInfo(selser.oldtext);
			}
			if (selser.oldhtml) {
				env.page.dom = DU.parseHTML(selser.oldhtml).body;
			}
			if (selser.domdiff) {
				// FIXME: need to load diff markers from attributes
				env.page.domdiff = {
					isEmpty: false,
					dom: DU.ppToDOM(selser.domdiff),
				};
				throw new Error('this is broken');
			}
		}

		var s1 = Date.now();
		env.bumpTimeUse("Setup Environment", s1 - start);

		if (['html2wt', 'html2html', 'selser'].includes(obj.mode)) {
			return html2wt(obj, env, obj.input, obj.pb);
		} else {
			var p;
			if (obj.input === undefined) {
				var target = env.normalizeAndResolvePageTitle();
				p = TemplateRequest
				.setPageSrcInfo(env, target, obj.oldid)
				.tap(function() {
					env.bumpTimeUse("Pre-parse (source fetch)", Date.now() - s1);
				});
			} else {
				p = Promise.resolve(obj.input);
			}
			return p
			.then(function(wt) {
				return wt2html(obj, env, wt);
			});
		}
	})
	.nodify(cb);
});
