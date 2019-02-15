/** @module */

'use strict';

require('../../core-upgrade.js');

var apiUtils = require('./apiUtils.js');
var ContentUtils = require('../utils/ContentUtils.js').ContentUtils;
var DOMUtils = require('../utils/DOMUtils.js').DOMUtils;
var Diff = require('../utils/Diff.js').Diff;
var JSUtils = require('../utils/jsutils.js').JSUtils;
var Util = require('../utils/Util.js').Util;
var TemplateRequest = require('../mw/ApiRequest.js').TemplateRequest;

var roundTripDiff = function(env, req, res, useSelser, doc) {
	// Re-parse the HTML to uncover foster-parenting issues
	doc = env.createDocument(doc.outerHTML);

	var handler = env.getContentHandler();
	return handler.fromHTML(env, doc.body, useSelser).then(function(out) {
		// Strip selser trigger comment
		out = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');

		// Emit base href so all relative urls resolve properly
		var headNodes = "";
		for (var hNode = doc.head.firstChild; hNode; hNode = hNode.nextSibling) {
			if (hNode.nodeName.toLowerCase() === 'base') {
				headNodes += ContentUtils.toXML(hNode);
				break;
			}
		}

		var bodyNodes = "";
		for (var bNode = doc.body.firstChild; bNode; bNode = bNode.nextSibling) {
			bodyNodes += ContentUtils.toXML(bNode);
		}

		var htmlSpeChars = Util.escapeHtml(out);
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

var rtResponse = function(env, req, res, data) {
	apiUtils.renderResponse(res, 'roundtrip', data);
	env.log('info', 'completed in ' + JSUtils.elapsedTime(res.locals.start) + 'ms');
};

/**
 * @func
 * @param {ParsoidConfig} parsoidConfig
 * @param {Logger} processLogger
 */
module.exports = function(parsoidConfig, processLogger) {

	var internal = {};

	// Middlewares

	internal.middle = function(req, res, next) {
		res.locals.errorEnc = 'plain';
		var iwp = req.params.prefix || parsoidConfig.defaultWiki || '';
		if (!parsoidConfig.mwApiMap.has(iwp)) {
			var text = 'Invalid prefix: ' + iwp;
			processLogger.log('fatal/request', new Error(text));
			return apiUtils.errorResponse(res, text, 404);
		}
		res.locals.iwp = iwp;
		res.locals.pageName = req.params.title || '';
		res.locals.oldid = req.body.oldid || req.query.oldid || null;
		// "body" flag to return just the body (instead of the entire HTML doc)
		res.locals.body_only = !!(req.query.body || req.body.body);
		// "subst" flag to perform {{subst:}} template expansion
		res.locals.subst = !!(req.query.subst || req.body.subst);
		res.locals.envOptions = {
			prefix: res.locals.iwp,
			pageName: res.locals.pageName,
		};
		next();
	};

	// Routes

	// Form-based HTML DOM -> wikitext interface for manual testing.
	internal.html2wtForm = function(req, res) {
		var domain = parsoidConfig.mwApiMap.get(res.locals.iwp).domain;
		var action = '/' + domain + '/v3/transform/html/to/wikitext/' + res.locals.pageName;
		if (req.query.hasOwnProperty('scrub_wikitext')) {
			action += "?scrub_wikitext=" + req.query.scrub_wikitext;
		}
		apiUtils.renderResponse(res, 'form', {
			title: 'Your HTML DOM:',
			action: action,
			name: 'html',
		});
	};

	// Form-based wikitext -> HTML DOM interface for manual testing
	internal.wt2htmlForm = function(req, res) {
		var domain = parsoidConfig.mwApiMap.get(res.locals.iwp).domain;
		apiUtils.renderResponse(res, 'form', {
			title: 'Your wikitext:',
			action: '/' + domain + '/v3/transform/wikitext/to/html/' + res.locals.pageName,
			name: 'wikitext',
		});
	};

	// Round-trip article testing.  Default to scrubbing wikitext here.  Can be
	// overridden with qs param.
	internal.roundtripTesting = function(req, res) {
		var env = res.locals.env;
		env.scrubWikitext = apiUtils.shouldScrub(req, true);

		var target = env.normalizeAndResolvePageTitle();

		var oldid = null;
		if (req.query.oldid) {
			oldid = req.query.oldid;
		}

		return TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.getContentHandler().toHTML(env);
		})
		.then(doc => roundTripDiff(env, req, res, false, doc))
		.then(data => rtResponse(env, req, res, data))
		.catch(function(err) {
			env.log('fatal/request', err);
		});
	};

	// Round-trip article testing with newline stripping for editor-created HTML
	// simulation.  Default to scrubbing wikitext here.  Can be overridden with qs
	// param.
	internal.roundtripTestingNL = function(req, res) {
		var env = res.locals.env;
		env.scrubWikitext = apiUtils.shouldScrub(req, true);

		var target = env.normalizeAndResolvePageTitle();

		var oldid = null;
		if (req.query.oldid) {
			oldid = req.query.oldid;
		}

		return TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.getContentHandler().toHTML(env);
		}).then(function(doc) {
			// strip newlines from the html
			var html = doc.innerHTML.replace(/[\r\n]/g, '');
			return roundTripDiff(env, req, res, false, DOMUtils.parseHTML(html));
		})
		.then(data => rtResponse(env, req, res, data))
		.catch(function(err) {
			env.log('fatal/request', err);
		});
	};

	// Round-trip article testing with selser over re-parsed HTML.  Default to
	// scrubbing wikitext here.  Can be overridden with qs param.
	internal.roundtripSelser = function(req, res) {
		var env = res.locals.env;
		env.scrubWikitext = apiUtils.shouldScrub(req, true);

		var target = env.normalizeAndResolvePageTitle();

		var oldid = null;
		if (req.query.oldid) {
			oldid = req.query.oldid;
		}

		return TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.getContentHandler().toHTML(env);
		}).then(function(doc) {
			doc = DOMUtils.parseHTML(ContentUtils.toXML(doc));
			var comment = doc.createComment('rtSelserEditTestComment');
			doc.body.appendChild(comment);
			return roundTripDiff(env, req, res, true, doc);
		})
		.then(data => rtResponse(env, req, res, data))
		.catch(function(err) {
			env.log('fatal/request', err);
		});
	};

	// Form-based round-tripping for manual testing
	internal.getRtForm = function(req, res) {
		apiUtils.renderResponse(res, 'form', {
			title: 'Your wikitext:',
			name: 'content',
		});
	};

	// Form-based round-tripping for manual testing.  Default to scrubbing wikitext
	// here.  Can be overridden with qs param.
	internal.postRtForm = function(req, res) {
		var env = res.locals.env;
		env.scrubWikitext = apiUtils.shouldScrub(req, true);

		env.setPageSrcInfo(req.body.content);
		env.log('info', 'started parsing');

		return env.getContentHandler().toHTML(env)
		.then(doc => roundTripDiff(env, req, res, false, doc))
		.then(data => rtResponse(env, req, res, data))
		.catch(function(err) {
			env.log('fatal/request', err);
		});
	};

	return internal;
};
