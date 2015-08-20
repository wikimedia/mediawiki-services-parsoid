'use strict';
require('../lib/core-upgrade.js');

var path = require('path');
var fs = require('fs');
var qs = require('querystring');
var url = require('url');
var childProcess = require('child_process');
var pkg = require('../package.json');
var apiUtils = require('./utils');

var MWParserEnv = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment;
var LogData = require('../lib/LogData.js').LogData;
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;
var ApiRequest = require('../lib/mediawiki.ApiRequest.js');

var ParsoidCacheRequest = ApiRequest.ParsoidCacheRequest;
var TemplateRequest = ApiRequest.TemplateRequest;


module.exports = function(parsoidConfig) {
	var routes = {};

	var REQ_TIMEOUT = parsoidConfig.timeouts.request;


	// Middlewares

	routes.interParams = function(req, res, next) {
		res.local('iwp', req.params[0] || parsoidConfig.defaultWiki || '');
		res.local('pageName', req.params[1] || '');
		res.local('oldid', req.body.oldid || req.query.oldid || null);
		// "body" flag to return just the body (instead of the entire HTML doc)
		res.local('body', !!(req.query.body || req.body.body));
		// "subst" flag to perform {{subst:}} template expansion
		res.local('subst', !!(req.query.subst || req.body.subst));
		next();
	};

	var wt2htmlFormats = new Set(['pagebundle', 'html']);
	var supportedFormats = new Set(['pagebundle', 'html', 'wt']);

	routes.v2Middle = function(req, res, next) {
		function errOut(err, code) {
			apiUtils.sendResponse(res, {}, err, code || 404);
		}

		var iwp = parsoidConfig.reverseMwApiMap.get(req.params.domain);
		if (!iwp) {
			return errOut('Invalid domain: ' + req.params.domain);
		}

		res.local('iwp', iwp);
		res.local('pageName', req.params.title || '');
		res.local('oldid', req.params.revision || null);

		// "body" flag to return just the body (instead of the entire HTML doc)
		res.local('body', !!(req.query.body || req.body.body));

		var v2 = Object.assign({ format: req.params.format }, req.body);

		if (!supportedFormats.has(v2.format) ||
				(req.method === 'GET' && !wt2htmlFormats.has(v2.format))) {
			return errOut('Invalid format.');
		}

		// "subst" flag to perform {{subst:}} template expansion
		res.local('subst', !!(req.query.subst || req.body.subst));
		// This is only supported for the html format
		if (res.local('subst') && v2.format !== 'html') {
			return errOut('Substitution is only supported for the HTML format.', 501);
		}

		if (req.method === 'POST') {
			var original = v2.original || {};
			if (original.revid) {
				res.local('oldid', original.revid);
			}
			if (original.title) {
				res.local('pageName', original.title);
			}
		}

		res.local('v2', v2);
		next();
	};

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
					apiUtils.sendResponse(res, env, logData.fullMsg(), logData.flatLogObject().code || 500);
				}).catch(function(e) {
					console.error(e.stack || e);
					res.end(e.stack || e);
				}).nodify(callback);
			}
			return Promise.resolve().nodify(callback);
		}
		var options = {
			prefix: res.local('iwp'),
			pageName: res.local('pageName'),
			cookie: req.headers.cookie,
			reqId: req.headers['x-request-id'],
		};
		MWParserEnv.getParserEnv(parsoidConfig, null, options).then(function(env) {
			env.logger.registerBackend(/fatal(\/.*)?/, errBack.bind(this, env));
			if (env.conf.parsoid.allowCORS) {
				// Allow cross-domain requests (CORS) so that parsoid service
				// can be used by third-party sites.
				apiUtils.setHeader(res, env, 'Access-Control-Allow-Origin',
					env.conf.parsoid.allowCORS);
			}
			if (res.local('v2') && res.local('v2').format === 'pagebundle') {
				env.storeDataParsoid = true;
			}
			if (req.body.hasOwnProperty('scrubWikitext')) {
				env.scrubWikitext = !(!req.body.scrubWikitext ||
					req.body.scrubWikitext === 'false');
			} else if (req.query.hasOwnProperty('scrubWikitext')) {
				env.scrubWikitext = !(!req.query.scrubWikitext ||
					req.query.scrubWikitext === 'false');
			}
			res.local('env', env);
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
		res.end("User-agent: *\nDisallow: /\n");
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
		var env = res.local('env');
		var action = "/" + res.local('iwp') + "/" + res.local('pageName');
		if (req.query.hasOwnProperty('scrubWikitext')) {
			action += "?scrubWikitext=" + req.query.scrubWikitext;
		}
		apiUtils.renderResponse(res, env, "form", {
			title: "Your HTML DOM:",
			action: action,
			name: "html",
		});
	};

	// Form-based wikitext -> HTML DOM interface for manual testing
	routes.wt2htmlForm = function(req, res) {
		var env = res.local('env');
		apiUtils.renderResponse(res, env, "form", {
			title: "Your wikitext:",
			action: "/" + res.local('iwp') + "/" + res.local('pageName'),
			name: "wt",
		});
	};

	// Round-trip article testing.  Default to scrubbing wikitext here.  Can be
	// overridden with qs param.
	routes.roundtripTesting = function(req, res) {
		var env = res.local('env');

		if (!req.query.hasOwnProperty('scrubWikitext') &&
			!req.body.hasOwnProperty('scrubWikitext')) {
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
		}).then(
			apiUtils.roundTripDiff.bind(null, env, req, res, false)
		).timeout(REQ_TIMEOUT).then(
			apiUtils.rtResponse.bind(null, env, req, res)
		);

		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// Round-trip article testing with newline stripping for editor-created HTML
	// simulation.  Default to scrubbing wikitext here.  Can be overridden with qs
	// param.
	routes.roundtripTestingNL = function(req, res) {
		var env = res.local('env');

		if (!req.query.hasOwnProperty('scrubWikitext') &&
			!req.body.hasOwnProperty('scrubWikitext')) {
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
		}).timeout(REQ_TIMEOUT).then(
			apiUtils.rtResponse.bind(null, env, req, res)
		);

		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// Round-trip article testing with selser over re-parsed HTML.  Default to
	// scrubbing wikitext here.  Can be overridden with qs param.
	routes.roundtripSelser = function(req, res) {
		var env = res.local('env');

		if (!req.query.hasOwnProperty('scrubWikitext') &&
			!req.body.hasOwnProperty('scrubWikitext')) {
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
		}).timeout(REQ_TIMEOUT).then(
			apiUtils.rtResponse.bind(null, env, req, res)
		);

		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// Form-based round-tripping for manual testing
	routes.getRtForm = function(req, res) {
		var env = res.local('env');
		apiUtils.renderResponse(res, env, "form", {
			title: "Your wikitext:",
			name: "content",
		});
	};

	// Form-based round-tripping for manual testing.  Default to scrubbing wikitext
	// here.  Can be overridden with qs param.
	routes.postRtForm = function(req, res) {
		var env = res.local('env');

		if (!req.query.hasOwnProperty('scrubWikitext') &&
			!req.body.hasOwnProperty('scrubWikitext')) {
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
		var env = res.local('env');
		var p = apiUtils.startWt2html(req, res, wt).then(function(ret) {
			if (typeof ret.wikitext === 'string') {
				return apiUtils.parseWt(ret)
					.timeout(REQ_TIMEOUT)
					.then(apiUtils.endWt2html.bind(null, ret));
			} else if (ret.oldid) {
				var p2 = Promise.resolve(ret);
				// See if we can reuse transclusion or extension expansions.
				// And don't parse twice for recursive parsoid requests.
				if (env.conf.parsoid.parsoidCacheURI && !req.headers['x-parsoid-request']) {
					p2 = p2.then(function(ret) {
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
								ret.reuse = {
									expansions: DU.extractExpansions(DU.parseHTML(src)),
								};
								if (parsoidHeader.cacheID) {
									ret.reuse.mode = parsoidHeader.mode;
								}
								return ret;
							}, function(err) {
								// No luck with the cache request.
								return ret;
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
				}).timeout(REQ_TIMEOUT).then(apiUtils.endWt2html.bind(null, ret));
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
		var env = res.local('env');
		var body = req.body;
		if (req.body.wt) {
			// Form-based article parsing
			return v1Wt2html(req, res, body.wt);
		} else {
			// Regular and form-based article serialization
			var p = apiUtils.startHtml2wt(req, res, body.html || body.content || '')
					.then(apiUtils.endHtml2wt)
					.then(function(output) {
				apiUtils.setHeader(res, env, 'content-type', apiUtils.WIKITEXT_CONTENT_TYPE);
				apiUtils.endResponse(res, env, output);
			});
			return apiUtils.cpuTimeout(p, res)
				.catch(apiUtils.timeoutResp.bind(null, env));
		}
	};


	// v2 Routes

	// Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.

	var v2Wt2html = function(req, res, wt) {
		var env = res.local('env');
		var v2 = res.local('v2');
		var p = apiUtils.startWt2html(req, res, wt).then(function(ret) {
			if (typeof ret.wikitext === 'string') {
				return apiUtils.parseWt(ret)
					.timeout(REQ_TIMEOUT)
					.then(apiUtils.v2endWt2html.bind(null, ret));
			} else if (ret.oldid) {
				var p2 = Promise.resolve(ret);
				// See if we can reuse transclusion or extension expansions.
				var revision = v2.previous || v2.original;
				if (revision) {
					p2 = p2.then(function(ret) {
						var doc = DU.parseHTML(revision.html.body);
						// Similar to the html2wt case, stored html is expected
						// to also pass in dp.
						apiUtils.validateDp(revision);
						DU.applyDataParsoid(doc, revision['data-parsoid'].body);
						ret.reuse = {
							expansions: DU.extractExpansions(doc),
						};
						if (v2.update) {
							['templates', 'files'].some(function(m) {
								if (v2.update[m]) {
									ret.reuse.mode = m;
									return true;
								}
							});
						}
						return ret;
					});
				}
				return p2.then(apiUtils.parsePageWithOldid).tap(function() {
					// Don't cache requests to the v2 entry point, as those
					// are stored by RESTBase & will just dilute the Varnish
					// cache in the meantime.
					apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
				})
				.timeout(REQ_TIMEOUT)
				.then(apiUtils.v2endWt2html.bind(null, ret));
			} else {
				var revid = env.page.meta.revision.revid;
				var path = [
					'/v2',
					env.conf.parsoid.mwApiMap.get(ret.prefix).domain,
					v2.format,
					encodeURIComponent(ret.target),
					revid,
				].join('/');
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
	routes.v2Get = function(req, res) {
		return v2Wt2html(req, res);
	};

	// POST requests
	routes.v2Post = function(req, res) {
		var v2 = res.local('v2');
		var env = res.local('env');

		function errOut(err, code) {
			apiUtils.sendResponse(res, env, err, code || 404);
		}

		if (wt2htmlFormats.has(v2.format)) {
			// Accept wikitext as a string or object{body,headers}
			var wikitext = (v2.wikitext && typeof v2.wikitext !== 'string') ?
				v2.wikitext.body : v2.wikitext;
			if (typeof wikitext !== 'string') {
				if (!res.local('pageName')) {
					return errOut('No title or wikitext was provided.', 400);
				}
				// We've been given source for this page
				if (v2.original && v2.original.wikitext) {
					wikitext = v2.original.wikitext.body;
				}
			}
			return v2Wt2html(req, res, wikitext);
		} else {
			// html is required for serialization
			if (v2.html === undefined) {
				return errOut('No html was supplied.', 400);
			}
			// Accept html as a string or object{body,headers}
			var html = (typeof v2.html === 'string') ?
				v2.html : (v2.html.body || '');

			if (v2.original && v2.original.wikitext) {
				env.setPageSrcInfo(v2.original.wikitext.body);
			}

			var p = apiUtils.startHtml2wt(req, res, html).then(function(ret) {
				if (v2.original) {
					var dp = v2.original['data-parsoid'];
					// This is optional to support serializing html with inlined
					// data-parsoid.
					if (dp) {
						apiUtils.validateDp(v2.original);
						DU.applyDataParsoid(ret.doc, dp.body);
					}
					if (v2.original.html) {
						env.page.dom = DU.parseHTML(v2.original.html.body).body;
						// However, if we're given stored html, data-parsoid
						// should be provided as well. We have no use case for
						// stored inlined dp anymore.
						apiUtils.validateDp(v2.original);
						DU.applyDataParsoid(env.page.dom.ownerDocument, dp.body);
					}
				}
				return ret;
			}).then(apiUtils.endHtml2wt).then(function(output) {
				apiUtils.jsonResponse(res, env, {
					wikitext: {
						headers: { 'content-type': apiUtils.WIKITEXT_CONTENT_TYPE },
						body: output,
					},
				});
			});
			return apiUtils.cpuTimeout(p, res)
				.catch(apiUtils.timeoutResp.bind(null, env));
		}
	};


	return routes;
};
