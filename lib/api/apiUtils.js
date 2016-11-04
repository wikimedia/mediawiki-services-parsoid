'use strict';
require('../../core-upgrade.js');

var domino = require('domino');
var util = require('util');
var semver = require('semver');
var qs = require('querystring');
var contentType = require('content-type');

var Diff = require('../utils/Diff.js').Diff;
var DU = require('../utils/DOMUtils.js').DOMUtils;
var Util = require('../utils/Util.js').Util;
var PegTokenizer = require('../wt2html/tokenizer.js').PegTokenizer;
var Promise = require('../utils/promise.js');
var PHPParseRequest = require('../mw/ApiRequest.js').PHPParseRequest;


/**
 * @class apiUtils
 * @singleton
 */
var apiUtils = module.exports = { };

/**
 * Send a redirect response with optional code and a relative URL
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} path
 * @param {Number} [httpStatus]
 */
apiUtils.relativeRedirect = function(res, path, httpStatus) {
	if (res.headersSent) { return; }
	var args = [path];
	if (typeof httpStatus === 'number') {
		args.unshift(httpStatus);
	}
	res.redirect.apply(res, args);
};

/**
 * Set header, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} field
 * @param {String} value
 */
apiUtils.setHeader = function(res, field, value) {
	if (res.headersSent) { return; }
	res.set(field, value);
};

/**
 * Send an html response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} body
 * @param {Number} [status] HTTP status code
 * @param {String} [contentType] A more specific type to use.
 * @param {Boolean} [omitEscape] Be explicit about omitting escaping.
 */
apiUtils.htmlResponse = function(res, body, status, contentType, omitEscape) {
	if (res.headersSent) { return; }
	if (typeof status === 'number') {
		res.status(status);
	}
	contentType = contentType || 'text/html; charset=utf-8';
	console.assert(/^text\/html;/.test(contentType));
	apiUtils.setHeader(res, 'content-type', contentType);
	// Explicit cast, since express varies response encoding by argument type
	// though that's probably offset by setting the header above
	body = String(body);
	if (!omitEscape) {
		body = Util.entityEncodeAll(body);
	}
	res.send(body);  // Default string encoding for send is text/html
};

/**
 * Send a plaintext response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} text
 * @param {Number} [status] HTTP status code
 * @param {String} [contentType] A more specific type to use.
 */
apiUtils.plainResponse = function(res, text, status, contentType) {
	if (res.headersSent) { return; }
	if (typeof status === 'number') {
		res.status(status);
	}
	contentType = contentType || 'text/plain; charset=utf-8';
	console.assert(/^text\/plain;/.test(contentType));
	apiUtils.setHeader(res, 'content-type', contentType);
	// Explicit cast, since express varies response encoding by argument type
	// though that's probably offset by setting the header above
	res.send(String(text));
};

/**
 * Send a JSON response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {Object} json
 * @param {Number} [status] HTTP status code
 * @param {String} [contentType] A more specific type to use.
 */
apiUtils.jsonResponse = function(res, json, status, contentType) {
	if (res.headersSent) { return; }
	if (typeof status === 'number') {
		res.status(status);
	}
	contentType = contentType || 'application/json; charset=utf-8';
	console.assert(/^application\/json;/.test(contentType));
	apiUtils.setHeader(res, 'content-type', contentType);
	res.json(json);
};

/**
 * Render response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} view
 * @param {Object} locals
 */
apiUtils.renderResponse = function(res, view, locals) {
	if (res.headersSent) { return; }
	res.render(view, locals);
};

/**
 * Error response
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} text
 * @param {Number} [status]
 */
apiUtils.errorResponse = function(res, text, status) {
	if (typeof status !== 'number') {
		status = 500;
	}
	var enc = res.locals.errorEnc;
	if (enc === 'json') {
		text = { error: text };
	}
	apiUtils[enc + 'Response'](res, text, status);
};

/**
 * The request timeout is a simple node timer that should fire first and catch
 * most cases where we have long running requests to optimize.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Error} err
 */
apiUtils.timeoutResp = function(env, err) {
	if (err instanceof Promise.TimeoutError) {
		err = new Error('Request timed out.');
		err.suppressLoggingStack = true;
	}
	env.log('fatal/request', err);
};

apiUtils.logTime = function(env, res, str) {
	env.log('info', util.format(
		'completed %s in %s ms', str, Date.now() - res.locals.start
	));
};

apiUtils.rtResponse = function(env, req, res, data) {
	apiUtils.renderResponse(res, 'roundtrip', data);
	apiUtils.logTime(env, res, 'parsing');
};

var htmlSpecialChars = function(s) {
	return s.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
};

apiUtils.roundTripDiff = function(env, req, res, useSelser, doc) {
	// Re-parse the HTML to uncover foster-parenting issues
	doc = domino.createDocument(doc.outerHTML);

	var handler = env.getContentHandler();
	return handler.fromHTML(env, doc.body, useSelser).then(function(out) {
		// Strip selser trigger comment
		out = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');

		// Emit base href so all relative urls resolve properly
		var hNodes = doc.head.childNodes;
		var headNodes = "";
		for (var i = 0; i < hNodes.length; i++) {
			if (hNodes[i].nodeName.toLowerCase() === 'base') {
				headNodes += DU.toXML(hNodes[i]);
				break;
			}
		}

		var bNodes = doc.body.childNodes;
		var bodyNodes = "";
		for (i = 0; i < bNodes.length; i++) {
			bodyNodes += DU.toXML(bNodes[i]);
		}

		var htmlSpeChars = htmlSpecialChars(out);
		var patch = Diff.convertChangesToXML(Diff.diffLines(env.page.src, out));

		return {
			headers: headNodes,
			bodyNodes: bodyNodes,
			htmlSpeChars: htmlSpeChars,
			patch: patch,
			reqUrl: req.url,
		};
	});
};

// To support the 'subst' API parameter, we need to prefix each
// top-level template with 'subst'. To make sure we do this for the
// correct templates, tokenize the starting wikitext and use that to
// detect top-level templates. Then, substitute each starting '{{' with
// '{{subst' using the template token's tsr.
apiUtils.substTopLevelTemplates = function(env, target, wt) {
	var tokenizer = new PegTokenizer(env);
	var tokens = tokenizer.tokenizeSync(wt, null, null, true);
	var tsrIncr = 0;
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].name === 'template') {
			var tsr = tokens[i].dataAttribs.tsr;
			wt = wt.substring(0, tsr[0] + tsrIncr) +
				'{{subst:' +
				wt.substring(tsr[0] + tsrIncr + 2);
			tsrIncr += 6;
		}
	}
	// Now pass it to the MediaWiki API with onlypst set so that it
	// subst's the templates.
	return PHPParseRequest.promise(env, target, wt, true).then(function(wikitext) {
		// Set data-parsoid to be discarded, so that the subst'ed
		// content is considered new when it comes back.
		env.discardDataParsoid = true;
		// Use the returned wikitext as the page source.
		return wikitext;
	});
};

apiUtils.wikitextContentType = function(env) {
	return 'text/plain; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/wikitext/' + env.wikitextVersion + '"';
};

apiUtils.htmlContentType = function(env, contentVersion) {
	return 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/' + (contentVersion || env.contentVersion) + '"';
};

apiUtils.dataParsoidContentType = function(env) {
	// Some backwards compatibility for when the content version wasn't
	// applied uniformly.
	var dpVersion = (env.contentVersion === '1.2.1') ? '0.0.2' : env.contentVersion;
	return 'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/' + dpVersion + '"';
};

apiUtils.dataMwContentType = function(env) {
	return 'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/data-mw/' + env.contentVersion + '"';
};

apiUtils.pagebundleContentType = function(env, contentVersion) {
	return 'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/pagebundle/' + (contentVersion || env.contentVersion) + '"';
};

/**
 * Extracts a pagebundle from a revision.
 *
 * @method
 * @param revision
 * @return {Object}
 */
apiUtils.extractPageBundle = function(revision) {
	return {
		parsoid: revision['data-parsoid'] && revision['data-parsoid'].body,
		mw: revision['data-mw'] && revision['data-mw'].body,
	};
};

/**
 * Validates the pagebundle was provided in the expected format.
 *
 * @method
 * @param {Object} pb
 * @param {String} originalVersion
 */
apiUtils.validatePageBundle = function(pb, originalVersion) {
	var err;
	if (!pb.parsoid || pb.parsoid.constructor !== Object || !pb.parsoid.ids) {
		err = new Error('Invalid data-parsoid was provided.');
		err.httpStatus = 400;
		err.suppressLoggingStack = true;
		throw err;
	}
	if (semver.satisfies(originalVersion, '^2.0.0') &&
			(!pb.mw || pb.mw.constructor !== Object || !pb.mw.ids)) {
		err = new Error('Invalid data-mw was provided.');
		err.httpStatus = 400;
		err.suppressLoggingStack = true;
		throw err;
	}
};

/**
 * Log a fatal/request.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {String} text
 * @param {Number} [httpStatus]
 */
apiUtils.fatalRequest = function(env, text, httpStatus) {
	var err = new Error(text);
	err.httpStatus = httpStatus || 404;
	err.suppressLoggingStack = true;
	env.log('fatal/request', err);
};

/**
 * Determine the content version from the html's content type.
 *
 * @param {Object} html
 * @return {String|null}
 */
apiUtils.versionFromType = function(html) {
	var ct = html.headers && html.headers['content-type'];
	if (ct) {
		try {
			var t = contentType.parse(ct);
			var profile = t.parameters && t.parameters.profile;
			if (profile) {
				var p = apiUtils.parseProfile(profile, 'html');
				return p && p.version;
			} else {
				return null;
			}
		} catch (e) {
			return null;
		}
	} else {
		return null;
	}
};

var oldSpec = /^mediawiki.org\/specs\/(html)\/(\d+\.\d+\.\d+)$/;
var newSpec = /^https:\/\/www.mediawiki.org\/wiki\/Specs\/(HTML|pagebundle)\/(\d+\.\d+\.\d+)$/;

/**
 * Used to extract the format and content version from a profile.
 *
 * @method
 * @param {String} profile
 * @param {String} format
 *   Just used for backwards compatibility w/ <= 1.2.0
 *   where the pagebundle didn't have a spec.
 * @return {Object|null}
 */
apiUtils.parseProfile = function(profile, format) {
	var match = newSpec.exec(profile);
	// TODO(arlolra): Remove when this version is no longer supported.
	if (!match) {
		match = oldSpec.exec(profile);
		if (match) { match[1] = format; }
	}
	if (match) {
		return {
			format: match[1].toLowerCase(),
			version: match[2],
		};
	} else {
		return null;
	}
};

/**
 * Set the content version to an acceptable version.
 * Returns false if Parsoid is unable to supply one.
 *
 * @method
 * @param {Response} res
 * @param {Array} acceptableTypes
 * @return {Boolean}
 */
apiUtils.validateAndSetContentVersion = function(res, acceptableTypes) {
	var env = res.locals.env;
	var opts = res.locals.opts;

	// `acceptableTypes` is already sorted by quality.
	return !acceptableTypes.length || acceptableTypes.some(function(t) {
		var profile = t.parameters && t.parameters.profile;
		if ((opts.format === 'html' && t.type === 'text/html') ||
				(opts.format === 'pagebundle' && t.type === 'application/json') ||
				// 'pagebundle' is sending 'text/html' in older versions
				oldSpec.exec(profile)) {
			if (profile) {
				var p = apiUtils.parseProfile(profile, opts.format);
				if (p && (opts.format === p.format)) {
					var contentVersion = env.resolveContentVersion(p.version);
					if (contentVersion !== null) {
						env.setContentVersion(contentVersion);
						return true;
					} else {
						return false;
					}
				} else {
					return false;
				}
			} else {
				return true;
			}
		} else if (t.type === '*/*' ||
				(opts.format === 'html' && t.type === 'text/*')) {
			return true;
		}
	});
};

/**
 * @method
 * @param {Request} req
 * @param {Response} res
 */
apiUtils.redirectToOldid = function(req, res) {
	var opts = res.locals.opts;
	var env = res.locals.env;
	var metrics = env.conf.parsoid.metrics;
	var prefix = res.locals.iwp;
	var format = opts.format;
	var target = env.normalizeAndResolvePageTitle();
	var revid = env.page.meta.revision.revid;
	var path = [
		'',
		env.conf.parsoid.mwApiMap.get(prefix).domain,
		'v3',
		'page',
		format,
		encodeURIComponent(target),
		revid,
	].join('/');
	if (Object.keys(req.query).length > 0) {
		path += '?' + qs.stringify(req.query);
	}
	env.log('info', 'redirecting to revision', revid, 'for', format);
	if (metrics) {
		metrics.increment('redirectToOldid.' + format.toLowerCase());
	}
	// Don't cache requests with no oldid
	apiUtils.setHeader(res, 'Cache-Control', 'private,no-cache,s-maxage=0');
	apiUtils.relativeRedirect(res, path);
};

/**
 * See if we can reuse transclusion or extension expansions.
 *
 * @method
 * @param {MWParserEnvironment} env
 */
apiUtils.reuseExpansions = function(env, revision, updates) {
	updates = updates || {};
	var doc = DU.parseHTML(revision.html.body);
	var pb = apiUtils.extractPageBundle(revision);
	apiUtils.validatePageBundle(pb, env.originalVersion);
	DU.applyPageBundle(doc, pb);
	DU.visitDOM(doc.body, DU.loadDataAttribs);
	var expansions = DU.extractExpansions(doc.body);
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
	env.setCaches(expansions);
};

/**
 * Downgrade content from 2.x to 1.x
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Object} revision
 * @param {Response} res
 */
apiUtils.downgrade2to1 = function(env, revision, res) {
	var doc = DU.parseHTML(revision.html.body);
	var pb = apiUtils.extractPageBundle(revision);
	apiUtils.validatePageBundle(pb, env.originalVersion);
	// Effectively, skip applying data-parsoid.
	DU.applyPageBundle(doc, { parsoid: { ids: {} }, mw: pb.mw });
	// No need to `DU.extractDpAndSerialize`, it wasn't applied.
	var html = DU.toXML(res.locals.bodyOnly ? doc.body : doc, {
		innerXML: res.locals.bodyOnly,
	});
	apiUtils.wt2htmlRes(env, res, html, pb);
};

/**
 * Send an appropriate response with the right content types for wt2html
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Object} res
 * @param {String} html
 * @param {Object} pb
 */
apiUtils.wt2htmlRes = function(env, res, html, pb) {
	if (env.pageBundle) {
		var response = {
			contentmodel: env.page.meta.revision.contentmodel,
			html: {
				headers: { 'content-type': apiUtils.htmlContentType(env) },
				body: html,
			},
			'data-parsoid': {
				headers: { 'content-type': apiUtils.dataParsoidContentType(env) },
				body: pb.parsoid,
			},
		};
		if (semver.satisfies(env.contentVersion, '^2.0.0')) {
			response['data-mw'] = {
				headers: { 'content-type': apiUtils.dataMwContentType(env) },
				body: pb.mw,
			};
		}
		apiUtils.jsonResponse(res, response, undefined, apiUtils.pagebundleContentType(env));
	} else {
		apiUtils.htmlResponse(res, html, undefined, apiUtils.htmlContentType(env), true);
	}
	env.log('end/response');  // Flush log buffer for linter
};
