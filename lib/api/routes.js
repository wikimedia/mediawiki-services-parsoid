'use strict';
require('../../core-upgrade.js');

var childProcess = require('child_process');
var path = require('path');
var qs = require('querystring');

var pkg = require('../../package.json');
var apiUtils = require('./apiUtils.js');
var DU = require('../utils/DOMUtils.js').DOMUtils;
var MWParserEnv = require('../config/MWParserEnvironment.js').MWParserEnvironment;
var Promise = require('../utils/promise.js');
var LogData = require('../logger/LogData.js').LogData;
var ApiRequest = require('../mw/ApiRequest.js');

var ParsoidCacheRequest = ApiRequest.ParsoidCacheRequest;
var TemplateRequest = ApiRequest.TemplateRequest;


module.exports = function(parsoidConfig, processLogger) {
	var routes = {};
	// var REQ_TIMEOUT = parsoidConfig.timeouts.request;

	// This helper is only to be used in middleware, before an environment
	// is setup.  The logger doesn't emit the expected location info.
	// You probably want `apiUtils.fatalRequest` instead.
	var errOut = function(res, text, httpStatus) {
		var err = new Error(text);
		err.httpStatus = httpStatus || 404;
		err.suppressLoggingStack = true;
		processLogger.log('fatal/request', err);
		apiUtils.sendResponse(res, {}, text, err.httpStatus);
	};

	// Middlewares

	routes.v1Middle = function(req, res, next) {
		res.locals.apiVersion = 1;
		res.locals.iwp = req.params[0] || parsoidConfig.defaultWiki || '';
		res.locals.pageName = req.params[1] || 'Main_Page';
		res.locals.oldid = req.body.oldid || req.query.oldid || null;
		// "body" flag to return just the body (instead of the entire HTML doc)
		res.locals.bodyOnly = !!(req.query.body || req.body.body);
		// "subst" flag to perform {{subst:}} template expansion
		res.locals.subst = !!(req.query.subst || req.body.subst);
		next();
	};

	var wt2htmlFormats = new Set(['pagebundle', 'html']);
	var v2SupportedFormats = new Set(['pagebundle', 'html', 'wt']);
	var v3SupportedFormats = new Set(['pagebundle', 'html', 'wikitext']);

	routes.v23Middle = function(version, req, res, next) {
		var iwp = parsoidConfig.reverseMwApiMap.get(req.params.domain);
		if (!iwp) {
			return errOut(res, 'Invalid domain: ' + req.params.domain);
		}

		res.locals.apiVersion = version;
		res.locals.iwp = iwp;
		res.locals.titleMissing = !req.params.title;
		res.locals.pageName = req.params.title || 'Main_Page';
		res.locals.oldid = req.params.revision || null;

		// "body_only" flag to return just the body (instead of the entire HTML doc)
		if (version > 2) {
			// RESTBase renamed this from 'bodyOnly' to 'body_only' in
			// 1d9f5c45ec6, 2015-09-09.  Support the old name for compatibility.
			res.locals.bodyOnly = !!(
				req.query.body_only || req.body.body_only ||
				req.query.bodyOnly || req.body.bodyOnly
			);
		} else {
			// in v2 this flag was named "body"
			res.locals.bodyOnly = !!(req.query.body || req.body.body);
		}

		var opts = Object.assign({ format: req.params.format }, req.body);
		var supportedFormats = (version > 2) ?
			v3SupportedFormats : v2SupportedFormats;

		if (!supportedFormats.has(opts.format) ||
				(req.method === 'GET' && !wt2htmlFormats.has(opts.format))) {
			return errOut(res, 'Invalid format: ' + opts.format);
		}

		// In v2 the "wikitext" format was named "wt"
		if (opts.format === 'wt') {
			opts.format = 'wikitext';
		}

		// "subst" flag to perform {{subst:}} template expansion
		res.locals.subst = !!(req.query.subst || req.body.subst);
		// This is only supported for the html format
		if (res.locals.subst && opts.format !== 'html') {
			return errOut(res, 'Substitution is only supported for the HTML format.', 501);
		}

		if (req.method === 'POST') {
			var original = opts.original || {};
			if (original.revid) {
				res.locals.oldid = original.revid;
			}
			if (original.title) {
				res.locals.pageName = original.title;
			}
		}

		res.locals.opts = opts;
		next();
	};
	routes.v2Middle = routes.v23Middle.bind(routes, 2);
	routes.v3Middle = routes.v23Middle.bind(routes, 3);

	routes.parserEnvMw = function(req, res, next) {
		function errBack(env, logData, callback) {
			if (!env.responseSent) {
				return new Promise(function(resolve, reject) {
					var socket = res.socket;
					if (res.finished || (socket && !socket.writable)) {
						return resolve();
					}
					res.once('finish', resolve);
					apiUtils.setHeader(res, env, 'content-type', 'text/plain;charset=utf-8');
					apiUtils.sendResponse(res, env, logData.fullMsg(), logData.flatLogObject().httpStatus || 500);
				}).catch(function(e) {
					console.error(e.stack || e);
					res.end();
					return Promise.reject(e);
				}).nodify(callback);
			}
			return Promise.resolve().nodify(callback);
		}
		var options = {
			prefix: res.locals.iwp,
			pageName: res.locals.pageName,
			cookie: req.headers.cookie,
			reqId: req.headers['x-request-id'],
			userAgent: req.headers['user-agent'],
		};
		MWParserEnv.getParserEnv(parsoidConfig, options).then(function(env) {
			env.logger.registerBackend(/fatal(\/.*)?/, errBack.bind(this, env));
			if (env.conf.parsoid.allowCORS) {
				// Allow cross-domain requests (CORS) so that parsoid service
				// can be used by third-party sites.
				apiUtils.setHeader(res, env, 'Access-Control-Allow-Origin',
					env.conf.parsoid.allowCORS);
			}
			if (res.locals.opts && res.locals.opts.format === 'pagebundle') {
				env.storeDataParsoid = true;
			}
			// Check hasOwnProperty to avoid overwriting the default when
			// this isn't set.  `scrubWikitext` was renamed in RESTBase to
			// `scrub_wikitext`.  Support both for backwards compatibility,
			// but prefer the newer form.
			if (req.body.hasOwnProperty('scrub_wikitext')) {
				env.scrubWikitext = !(!req.body.scrub_wikitext ||
					req.body.scrub_wikitext === 'false');
			} else if (req.query.hasOwnProperty('scrub_wikitext')) {
				env.scrubWikitext = !(!req.query.scrub_wikitext ||
					req.query.scrub_wikitext === 'false');
			} else if (req.body.hasOwnProperty('scrubWikitext')) {
				env.scrubWikitext = !(!req.body.scrubWikitext ||
					req.body.scrubWikitext === 'false');
			} else if (req.query.hasOwnProperty('scrubWikitext')) {
				env.scrubWikitext = !(!req.query.scrubWikitext ||
					req.query.scrubWikitext === 'false');
			}
			res.locals.env = env;
			next();
		}).catch(function(err) {
			// Workaround how logdata flatten works so that the error object is
			// recursively flattened and a stack trace generated for this.
			errBack({}, new LogData('error', ['error:', err, 'path:', req.path]));
		});
	};


	// Routes

	routes.home = function(req, res) {
		res.render('home');
	};

	// robots.txt: no indexing.
	routes.robots = function(req, res) {
		res.send("User-agent: *\nDisallow: /\n");
	};

	// Return Parsoid version based on package.json + git sha1 if available
	var versionCache;
	routes.version = function(req, res) {
		if (!versionCache) {
			versionCache = Promise.resolve({
				name: pkg.name,
				version: pkg.version,
			}).then(function(v) {
				return Promise.promisify(
					childProcess.execFile, ['stdout', 'stderr'], childProcess
				)('git', ['rev-parse', 'HEAD'], {
					cwd: path.join(__dirname, '..'),
				}).then(function(out) {
					v.sha = out.stdout.slice(0, -1);
					return v;
				}, function(err) {
					/* ignore the error, maybe this isn't a git checkout */
					return v;
				});
			});
		}
		return versionCache.then(function(v) {
			res.json(v);
		});
	};

	// Form-based HTML DOM -> wikitext interface for manual testing.
	routes.html2wtForm = function(req, res) {
		var env = res.locals.env;
		var action = '/' + res.locals.iwp + '/' + res.locals.pageName;
		if (req.query.hasOwnProperty('scrub_wikitext')) {
			action += "?scrub_wikitext=" + req.query.scrub_wikitext;
		}
		apiUtils.renderResponse(res, env, "form", {
			title: "Your HTML DOM:",
			action: action,
			name: "html",
		});
	};

	// Form-based wikitext -> HTML DOM interface for manual testing
	routes.wt2htmlForm = function(req, res) {
		var env = res.locals.env;
		apiUtils.renderResponse(res, env, 'form', {
			title: 'Your wikitext:',
			action: '/' + res.locals.iwp + '/' + res.locals.pageName,
			name: 'wt',
		});
	};

	// Round-trip article testing.  Default to scrubbing wikitext here.  Can be
	// overridden with qs param.
	routes.roundtripTesting = function(req, res) {
		var env = res.locals.env;

		if (!req.query.hasOwnProperty('scrub_wikitext') &&
			!req.body.hasOwnProperty('scrub_wikitext')) {
			env.scrubWikitext = true;
		}

		var target = env.resolveTitle(env.normalizeTitle(env.page.name), '');

		var oldid = null;
		if (req.query.oldid) {
			oldid = req.query.oldid;
		}

		var p = TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.pipelineFactory.parse(env, env.page.src);
		})
		.then(apiUtils.roundTripDiff.bind(null, env, req, res, false))
		// .timeout(REQ_TIMEOUT)
		.then(apiUtils.rtResponse.bind(null, env, req, res));

		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// Round-trip article testing with newline stripping for editor-created HTML
	// simulation.  Default to scrubbing wikitext here.  Can be overridden with qs
	// param.
	routes.roundtripTestingNL = function(req, res) {
		var env = res.locals.env;

		if (!req.query.hasOwnProperty('scrub_wikitext') &&
			!req.body.hasOwnProperty('scrub_wikitext')) {
			env.scrubWikitext = true;
		}

		var target = env.resolveTitle(env.normalizeTitle(env.page.name), '');

		var oldid = null;
		if (req.query.oldid) {
			oldid = req.query.oldid;
		}

		var p = TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.pipelineFactory.parse(env, env.page.src);
		}).then(function(doc) {
			// strip newlines from the html
			var html = doc.innerHTML.replace(/[\r\n]/g, '');
			return apiUtils.roundTripDiff(env, req, res, false, DU.parseHTML(html));
		})
		// .timeout(REQ_TIMEOUT)
		.then(apiUtils.rtResponse.bind(null, env, req, res));

		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// Round-trip article testing with selser over re-parsed HTML.  Default to
	// scrubbing wikitext here.  Can be overridden with qs param.
	routes.roundtripSelser = function(req, res) {
		var env = res.locals.env;

		if (!req.query.hasOwnProperty('scrub_wikitext') &&
			!req.body.hasOwnProperty('scrub_wikitext')) {
			env.scrubWikitext = true;
		}

		var target = env.resolveTitle(env.normalizeTitle(env.page.name), '');

		var oldid = null;
		if (req.query.oldid) {
			oldid = req.query.oldid;
		}

		var p = TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.pipelineFactory.parse(env, env.page.src);
		}).then(function(doc) {
			doc = DU.parseHTML(DU.serializeNode(doc).str);
			var comment = doc.createComment('rtSelserEditTestComment');
			doc.body.appendChild(comment);
			return apiUtils.roundTripDiff(env, req, res, true, doc);
		})
		// .timeout(REQ_TIMEOUT)
		.then(apiUtils.rtResponse.bind(null, env, req, res));

		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// Form-based round-tripping for manual testing
	routes.getRtForm = function(req, res) {
		var env = res.locals.env;
		apiUtils.renderResponse(res, env, "form", {
			title: "Your wikitext:",
			name: "content",
		});
	};

	// Form-based round-tripping for manual testing.  Default to scrubbing wikitext
	// here.  Can be overridden with qs param.
	routes.postRtForm = function(req, res) {
		var env = res.locals.env;

		if (!req.query.hasOwnProperty('scrub_wikitext') &&
			!req.body.hasOwnProperty('scrub_wikitext')) {
			env.scrubWikitext = true;
		}

		env.setPageSrcInfo(req.body.content);

		env.log('info', 'started parsing');
		return env.pipelineFactory.parse(env, env.page.src).then(
			apiUtils.roundTripDiff.bind(null, env, req, res, false)
		).then(
			apiUtils.rtResponse.bind(null, env, req, res)
		).catch(function(err) {
			env.log('fatal/request', err);
		});
	};


	// v1 Routes

	var v1Wt2html = function(req, res, wt) {
		var env = res.locals.env;
		var p = apiUtils.startWt2html(req, res, wt).then(function(ret) {
			if (typeof ret.wikitext === 'string') {
				return apiUtils.parseWt(ret)
					// .timeout(REQ_TIMEOUT)
					.then(apiUtils.endWt2html.bind(null, ret));
			} else if (ret.oldid) {
				var p2 = Promise.resolve(ret);
				// See if we can reuse transclusion or extension expansions.
				// And don't parse twice for recursive parsoid requests.
				if (env.conf.parsoid.parsoidCacheURI && !req.headers['x-parsoid-request']) {
					p2 = p2.then(function(ret2) {
						var meta = env.page.meta;
						// Try to retrieve a cached copy of the content.
						var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}');
						// If a cacheID is passed in X-Parsoid (from our PHP extension),
						// use that explicitly. Otherwise default to the parentID.
						var cacheID = parsoidHeader.cacheID || meta.revision.parentid;
						return ParsoidCacheRequest
							.promise(env, meta.title, cacheID)
							.then(function(src) {
								// Extract transclusion and extension content from the DOM
								ret2.reuse = {
									expansions: DU.extractExpansions(DU.parseHTML(src)),
								};
								if (parsoidHeader.cacheID) {
									ret2.reuse.mode = parsoidHeader.mode;
								}
								return ret2;
							}, function(err) {
								// No luck with the cache request.
								return ret2;
							});
					});
				}
				return p2.then(apiUtils.parsePageWithOldid).tap(function() {
					if (req.headers.cookie) {
						// Don't cache requests with a session.
						apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
					} else {
						apiUtils.setHeader(res, env, 'Cache-Control', 's-maxage=2592000');
					}
				})
				// .timeout(REQ_TIMEOUT)
				.then(apiUtils.endWt2html.bind(null, ret));
			} else {
				var revid = env.page.meta.revision.revid;
				var path = [
					'',
					ret.prefix,
					encodeURIComponent(ret.target),
				].join('/');
				req.query.oldid = revid;
				path += '?' + qs.stringify(req.query);
				apiUtils.redirectToRevision(env, res, path, revid);
			}
		});

		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	routes.v1Get = function(req, res) {
		// Regular article parsing
		return v1Wt2html(req, res);
	};

	routes.v1Post = function(req, res) {
		var env = res.locals.env;
		var body = req.body;
		if (req.body.wt) {
			// Form-based article parsing
			return v1Wt2html(req, res, body.wt);
		} else {
			// Regular and form-based article serialization
			var p = apiUtils.startHtml2wt(req, res, body.html || body.content || '')
					.then(apiUtils.endHtml2wt)
					.then(function(output) {
				apiUtils.setHeader(res, env, 'content-type', apiUtils.wikitextContentType(env));
				apiUtils.sendResponse(res, env, output);
			});
			return apiUtils.cpuTimeout(p, res)
				.catch(apiUtils.timeoutResp.bind(null, env));
		}
	};


	// v2 Routes

	// Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.

	var v2Wt2html = function(req, res, wt) {
		var env = res.locals.env;
		var opts = res.locals.opts;
		var p = apiUtils.startWt2html(req, res, wt).then(function(ret) {
			if (typeof ret.wikitext === 'string') {
				return apiUtils.parseWt(ret)
					// .timeout(REQ_TIMEOUT)
					.then(apiUtils.v2endWt2html.bind(null, ret));
			} else if (ret.oldid) {
				var p2 = Promise.resolve(ret);
				// See if we can reuse transclusion or extension expansions.
				var revision = opts.previous || opts.original;
				if (revision) {
					p2 = p2.then(function(ret2) {
						var doc = DU.parseHTML(revision.html.body);
						// Similar to the html2wt case, stored html is expected
						// to also pass in dp.
						apiUtils.validateDp(revision);
						DU.applyDataParsoid(doc, revision['data-parsoid'].body);
						ret2.reuse = {
							expansions: DU.extractExpansions(doc),
						};
						if (opts.update) {
							['templates', 'files'].some(function(m) {
								if (opts.update[m]) {
									ret2.reuse.mode = m;
									return true;
								}
							});
						}
						return ret2;
					});
				}
				return p2.then(apiUtils.parsePageWithOldid).tap(function() {
					// Don't cache requests to the v2 entry point, as those
					// are stored by RESTBase & will just dilute the Varnish
					// cache in the meantime.
					apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
				})
				// .timeout(REQ_TIMEOUT)
				.then(apiUtils.v2endWt2html.bind(null, ret));
			} else {
				var revid = env.page.meta.revision.revid;
				var path = (res.locals.apiVersion > 2 ? [
					'',
					env.conf.parsoid.mwApiMap.get(ret.prefix).domain,
					'v3',
					'page',
					opts.format,
					encodeURIComponent(ret.target),
					revid,
				] : [
					'/v2',
					env.conf.parsoid.mwApiMap.get(ret.prefix).domain,
					opts.format === 'wikitext' ? 'wt' : opts.format,
					encodeURIComponent(ret.target),
					revid,
				]).join('/');
				if (Object.keys(req.query).length > 0) {
					path += '?' + qs.stringify(req.query);
				}
				apiUtils.redirectToRevision(env, res, path, revid);
			}
		});
		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// GET requests
	routes.v2Get = routes.v3Get = function(req, res) {
		return v2Wt2html(req, res);
	};

	// POST requests
	routes.v2Post = routes.v3Post = function(req, res) {
		var opts = res.locals.opts;
		var env = res.locals.env;

		if (wt2htmlFormats.has(opts.format)) {
			// Accept wikitext as a string or object{body,headers}
			var wikitext = (opts.wikitext && typeof opts.wikitext !== 'string') ?
				opts.wikitext.body : opts.wikitext;
			if (typeof wikitext !== 'string') {
				if (res.locals.titleMissing) {
					return apiUtils.fatalRequest(env, 'No title or wikitext was provided.', 400);
				}

				// We've been given source for this page
				if (opts.original && opts.original.wikitext) {
					wikitext = opts.original.wikitext.body;
				}
			}
			return v2Wt2html(req, res, wikitext);
		} else {
			// html is required for serialization
			if (opts.html === undefined) {
				return apiUtils.fatalRequest(env, 'No html was supplied.', 400);
			}
			// Accept html as a string or object{body,headers}
			var html = (typeof opts.html === 'string') ?
				opts.html : (opts.html.body || '');

			if (opts.original && opts.original.wikitext) {
				env.setPageSrcInfo(opts.original.wikitext.body);
			}

			var p = apiUtils.startHtml2wt(req, res, html).then(function(ret) {
				if (opts.original) {
					var dp = opts.original['data-parsoid'];
					// This is optional to support serializing html with inlined
					// data-parsoid.
					if (dp) {
						apiUtils.validateDp(opts.original);
						DU.applyDataParsoid(ret.doc, dp.body);
						env.page.dpContentType = (dp.headers || {})['content-type'];
					}
					if (opts.original.html) {
						env.page.dom = DU.parseHTML(opts.original.html.body).body;
						// However, if we're given stored html, data-parsoid
						// should be provided as well. We have no use case for
						// stored inlined dp anymore.
						apiUtils.validateDp(opts.original);
						DU.applyDataParsoid(env.page.dom.ownerDocument, dp.body);
						env.page.htmlContentType = (opts.original.html.headers || {})['content-type'];
					}
				}

				// SSS FIXME: As a fallback, lookup the content types
				// in the <head> of ret.doc and/or env.page.dom
				// For now, ignoring this.

				return ret;
			}).then(apiUtils.endHtml2wt).then(function(output) {
				if (res.locals.apiVersion > 2) {
					apiUtils.setHeader(res, env, 'content-type', apiUtils.wikitextContentType(env));
					apiUtils.sendResponse(res, env, output);
				} else {
					// In API v2 we used to send a JSON object here
					apiUtils.jsonResponse(res, env, {
						wikitext: {
							headers: { 'content-type': apiUtils.wikitextContentType(env) },
							body: output,
						},
					});
				}
			});
			return apiUtils.cpuTimeout(p, res)
				.catch(apiUtils.timeoutResp.bind(null, env));
		}
	};


	return routes;
};
