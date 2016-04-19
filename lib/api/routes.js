'use strict';
require('../../core-upgrade.js');

var childProcess = require('child_process');
var corepath = require('path');
var qs = require('querystring');

var pkg = require('../../package.json');
var apiUtils = require('./apiUtils.js');
var DU = require('../utils/DOMUtils.js').DOMUtils;
var MWParserEnv = require('../config/MWParserEnvironment.js').MWParserEnvironment;
var Promise = require('../utils/promise.js');
var LogData = require('../logger/LogData.js').LogData;
var ApiRequest = require('../mw/ApiRequest.js');

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

	routes.internal = function(req, res, next) {
		var iwp = req.params.prefix || parsoidConfig.defaultWiki || '';
		if (!parsoidConfig.mwApiMap.has(iwp)) {
			return errOut(res, 'Invalid prefix: ' + iwp);
		}
		res.locals.apiVersion = 1;
		var stats = parsoidConfig.stats;
		if (stats) {
			stats.count('api.version.' + res.locals.apiVersion, '');
		}
		res.locals.iwp = iwp;
		res.locals.pageName = req.params.title || 'Main_Page';
		res.locals.oldid = req.body.oldid || req.query.oldid || null;
		// "body" flag to return just the body (instead of the entire HTML doc)
		res.locals.bodyOnly = !!(req.query.body || req.body.body);
		// "subst" flag to perform {{subst:}} template expansion
		res.locals.subst = !!(req.query.subst || req.body.subst);
		next();
	};

	var wt2htmlFormats = new Set(['pagebundle', 'html']);
	var supportedFormats = new Set(['pagebundle', 'html', 'wikitext']);

	routes.v3Middle = function(req, res, next) {
		var iwp = parsoidConfig.reverseMwApiMap.get(req.params.domain);
		if (!iwp) {
			return errOut(res, 'Invalid domain: ' + req.params.domain);
		}

		res.locals.apiVersion = 3;
		var stats = parsoidConfig.stats;
		if (stats) {
			stats.count('api.version.' + res.locals.apiVersion, '');
		}

		res.locals.iwp = iwp;
		res.locals.titleMissing = !req.params.title;
		res.locals.pageName = req.params.title || 'Main_Page';
		res.locals.oldid = req.params.revision || null;

		// "body_only" flag to return just the body (instead of the entire HTML doc)
		// RESTBase renamed this from 'bodyOnly' to 'body_only' in
		// 1d9f5c45ec6, 2015-09-09.  Support the old name for compatibility.
		res.locals.bodyOnly = !!(
			req.query.body_only || req.body.body_only ||
			req.query.bodyOnly || req.body.bodyOnly
		);

		var opts = Object.assign({ format: req.params.format }, req.body);

		if (!supportedFormats.has(opts.format) ||
				(req.method === 'GET' && !wt2htmlFormats.has(opts.format))) {
			return errOut(res, 'Invalid format: ' + opts.format);
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
				res.locals.titleMissing = false;
				res.locals.pageName = original.title;
			}
		}

		res.locals.opts = opts;
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
					cwd: corepath.join(__dirname, '..'),
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

		var target = env.normalizeAndResolvePageTitle();

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

		var target = env.normalizeAndResolvePageTitle();

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

		var target = env.normalizeAndResolvePageTitle();

		var oldid = null;
		if (req.query.oldid) {
			oldid = req.query.oldid;
		}

		var p = TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.pipelineFactory.parse(env, env.page.src);
		}).then(function(doc) {
			doc = DU.parseHTML(DU.toXML(doc));
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

	// v3 Routes

	// Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.

	var wt2html = function(req, res, wt) {
		var env = res.locals.env;
		var opts = res.locals.opts;

		// Performance Timing options
		var stats = env.conf.parsoid.stats;
		var startTimers = new Map();

		var p = Promise.method(function() {
			// Check early if we have a wt string.
			if (typeof wt === 'string') {
				env.bumpParserResourceUse('wikitextSize', wt.length);
			}

			if (stats) {
				// init refers to time elapsed before parsing begins
				startTimers.set('wt2html.init', Date.now());
				startTimers.set('wt2html.total', Date.now());
			}

			var prefix = res.locals.iwp;
			var oldid = res.locals.oldid;
			var target = env.normalizeAndResolvePageTitle();

			var p2 = Promise.resolve(wt);

			if (oldid || typeof wt !== 'string') {
				// Always fetch the page info if we have an oldid.
				// Otherwise, if no wt was passed, we need to figure out
				// the latest revid to which we'll redirect.
				p2 = p2.tap(function() {
					return TemplateRequest.setPageSrcInfo(env, target, oldid);
				}).tap(function() {
					// Now that we have the page src, check if we're using that as wt.
					if (typeof wt !== 'string') {
						env.bumpParserResourceUse('wikitextSize', env.page.src.length);
					}
				});
			}

			if (typeof wt === 'string' && res.locals.subst) {
				p2 = p2.then(function(wikitext) {
					// FIXME: reset limits after subst'ing
					return apiUtils.substTopLevelTemplates(env, target, wikitext);
				});
			}

			return p2.then(function(wikitext) {
				return {
					req: req,
					res: res,
					env: env,
					startTimers: startTimers,
					oldid: oldid,
					target: target,
					prefix: prefix,
					// Calling this wikitext so that it's easily distinguishable.
					// It may have been modified by substTopLevelTemplates.
					wikitext: wikitext,
				};
			});
		})().then(function(ret) {
			if (typeof ret.wikitext !== 'string' && !ret.oldid) {
				var revid = env.page.meta.revision.revid;
				var path = [
					'',
					env.conf.parsoid.mwApiMap.get(ret.prefix).domain,
					'v3',
					'page',
					opts.format,
					encodeURIComponent(ret.target),
					revid,
				].join('/');
				if (Object.keys(req.query).length > 0) {
					path += '?' + qs.stringify(req.query);
				}
				env.log('info', 'redirecting to revision', revid);
				if (stats) {
					stats.count('wt2html.redirectToOldid', '');
				}
				// Don't cache requests with no oldid
				apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
				apiUtils.relativeRedirect({ 'path': path, 'res': res, 'env': env });
				return;
			}
			var p2;
			if (typeof ret.wikitext === 'string') {
				env.log('info', 'started parsing');
				env.setPageSrcInfo(ret.wikitext);

				// Don't cache requests when wt is set in case somebody uses
				// GET for wikitext parsing
				apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');

				if (stats) {
					stats.timing('wt2html.wt.init', '',
						Date.now() - startTimers.get('wt2html.init'));
					startTimers.set('wt2html.wt.parse', Date.now());
					stats.timing('wt2html.wt.size.input', '', ret.wikitext.length);
				}

				if (!res.locals.pageName) {
					// clear default page name
					env.page.name = '';
				}

				p2 = env.pipelineFactory.parse(env, ret.wikitext);
			} else if (ret.oldid) {
				p2 = Promise.resolve(ret);
				// See if we can reuse transclusion or extension expansions.
				var revision = opts.previous || opts.original;
				if (revision) {
					p2 = p2.then(function(ret2) {
						var doc = DU.parseHTML(revision.html.body);
						// Similar to the html2wt case, stored html is expected
						// to also pass in dp.
						apiUtils.validateDp(revision);
						DU.applyDataParsoid(doc, revision['data-parsoid'].body);
						DU.visitDOM(doc.body, DU.loadDataAttribs);
						ret2.reuse = {
							expansions: DU.extractExpansions(doc.body),
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
				p2 = p2.then(function(ret2) {
					env.log('info', 'started parsing');

					// Indicate the MediaWiki revision in a header as well for
					// ease of extraction in clients.
					apiUtils.setHeader(ret2.res, env, 'content-revision-id', ret2.oldid);

					if (stats) {
						stats.timing('wt2html.pageWithOldid.init', '',
							Date.now() - startTimers.get('wt2html.init'));
						startTimers.set('wt2html.pageWithOldid.parse', Date.now());
						stats.timing('wt2html.pageWithOldid.size.input', '', env.page.src.length);
					}

					var expansions = ret2.reuse && ret2.reuse.expansions;
					if (expansions) {
						// Figure out what we can reuse
						switch (ret2.reuse.mode) {
						case "templates":
							// Transclusions need to be updated, so don't reuse them.
							expansions.transclusions = {};
							break;
						case "files":
							// Files need to be updated, so don't reuse them.
							expansions.files = {};
							break;
						}
					}

					return env.pipelineFactory.parse(env, env.page.src, expansions);
				}).tap(function() {
					if (req.headers.cookie) {
						// Don't cache requests with a session.
						apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
					}
				});
			}
			return p2
			// .timeout(REQ_TIMEOUT)
			.then(function(doc) {
				var output;
				if (opts.format === 'pagebundle') {
					var out = DU.extractDpAndSerialize(res.locals.bodyOnly ? doc.body : doc, {
						innerXML: res.locals.bodyOnly,
					});
					apiUtils.jsonResponse(res, env, {
						html: {
							headers: { 'content-type': apiUtils.htmlContentType(env) },
							body: out.str,
						},
						'data-parsoid': {
							headers: { 'content-type': out.type },
							body: out.dp,
						},
					});
					output = out.str;
				} else {
					output = DU.toXML(res.locals.bodyOnly ? doc.body : doc, {
						innerXML: res.locals.bodyOnly,
					});
					apiUtils.setHeader(res, env, 'content-type', apiUtils.htmlContentType(env));
					apiUtils.sendResponse(res, env, output);
				}

				if (stats) {
					if (startTimers.has('wt2html.wt.parse')) {
						stats.timing('wt2html.wt.parse', '',
							Date.now() - startTimers.get('wt2html.wt.parse'));
						stats.timing('wt2html.wt.size.output', '', output.length);
					} else if (startTimers.has('wt2html.pageWithOldid.parse')) {
						stats.timing('wt2html.pageWithOldid.parse', '',
							Date.now() - startTimers.get('wt2html.pageWithOldid.parse'));
						stats.timing('wt2html.pageWithOldid.size.output', '', output.length);
					}
					stats.timing('wt2html.total', '',
						Date.now() - startTimers.get('wt2html.total'));
				}

				apiUtils.logTime(env, res, 'parsing');
			});
		});
		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	var html2wt = function(req, res, html) {
		var env = res.locals.env;
		var opts = res.locals.opts;

		if (opts.original && opts.original.wikitext) {
			env.setPageSrcInfo(opts.original.wikitext.body);
		}

		var p = Promise.method(function() {
			env.bumpSerializerResourceUse('htmlSize', html.length);
			env.page.id = res.locals.oldid;
			env.log('info', 'started serializing');

			// Performance Timing options
			var stats = env.conf.parsoid.stats;
			var startTimers;

			if (stats) {
				startTimers = new Map();
				startTimers.set('html2wt.init', Date.now());
				startTimers.set('html2wt.total', Date.now());
				startTimers.set('html2wt.init.domparse', Date.now());
			}

			var doc = DU.parseHTML(html);

			// send domparse time, input size and init time to statsd/Graphite
			// init time is the time elapsed before serialization
			// init.domParse, a component of init time, is the time elapsed
			// from html string to DOM tree
			if (stats) {
				stats.timing('html2wt.init.domparse', '',
					Date.now() - startTimers.get('html2wt.init.domparse'));
				stats.timing('html2wt.size.input', '', html.length);
				stats.timing('html2wt.init', '',
					Date.now() - startTimers.get('html2wt.init'));
			}

			return {
				env: env,
				res: res,
				doc: doc,
				startTimers: startTimers,
			};
		})().then(function(ret) {
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
		}).then(function(ret) {
			var stats = env.conf.parsoid.stats;
			// var REQ_TIMEOUT = env.conf.parsoid.timeouts.request;

			// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
			//   "Both it and the oldid parameter are needed for
			//    clean round-tripping of HTML retrieved earlier with"
			// So, no oldid => no selser
			var hasOldId = (env.page.id && env.page.id !== '0');
			var useSelser = hasOldId && env.conf.parsoid.useSelser;
			return DU.serializeDOM(env, ret.doc.body, useSelser)
					// .timeout(REQ_TIMEOUT)
					.then(function(output) {
				if (stats) {
					stats.timing('html2wt.total', '',
						Date.now() - ret.startTimers.get('html2wt.total'));
					stats.timing('html2wt.size.output', '', output.length);
				}
				apiUtils.logTime(env, ret.res, 'serializing');
				return output;
			});
		}).then(function(output) {
			apiUtils.setHeader(res, env, 'content-type', apiUtils.wikitextContentType(env));
			apiUtils.sendResponse(res, env, output);
		});
		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// GET requests
	routes.v3Get = function(req, res) {
		return wt2html(req, res);
	};

	// POST requests
	routes.v3Post = function(req, res) {
		var opts = res.locals.opts;
		var env = res.locals.env;

		if (wt2htmlFormats.has(opts.format)) {
			// Accept wikitext as a string or object{body,headers}
			var wikitext = opts.wikitext;
			if (typeof wikitext !== 'string' && opts.wikitext) {
				wikitext = opts.wikitext.body;
			}
			// We've been given source for this page
			if (typeof wikitext !== 'string' && opts.original && opts.original.wikitext) {
				wikitext = opts.original.wikitext.body;
			}
			// Abort if no wikitext or title.
			if (typeof wikitext !== 'string' && res.locals.titleMissing) {
				return apiUtils.fatalRequest(env, 'No title or wikitext was provided.', 400);
			}
			return wt2html(req, res, wikitext);
		} else {
			// html is required for serialization
			if (opts.html === undefined) {
				return apiUtils.fatalRequest(env, 'No html was supplied.', 400);
			}
			// Accept html as a string or object{body,headers}
			var html = (typeof opts.html === 'string') ?
				opts.html : (opts.html.body || '');

			return html2wt(req, res, html);
		}
	};

	return routes;
};
