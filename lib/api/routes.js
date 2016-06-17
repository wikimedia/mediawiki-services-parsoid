'use strict';
require('../../core-upgrade.js');

var childProcess = require('child_process');
var corepath = require('path');
var Negotiator = require('negotiator');

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

		var opts = Object.assign({
			from: (req.method === 'GET') ? 'wikitext' : req.params.from,
			format: req.params.format,
		}, req.body);

		if (!supportedFormats.has(opts.format) || !supportedFormats.has(opts.from)) {
			return errOut(res, 'Invalid format: ' + opts.from + '/to/' + opts.format);
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
				env.pageBundle = true;
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

	routes.acceptable = function(req, res, next) {
		var env = res.locals.env;
		var opts = res.locals.opts;

		if (opts.format === 'wikitext') {
			return next();
		}

		// Parse accept header
		var negotiator = new Negotiator(req);
		var acceptableTypes = negotiator.mediaTypes(undefined, {
			detailed: true,
		});

		// Validate and set the content version
		if (!apiUtils.validateAndSetContentVersion(res, acceptableTypes)) {
			if (env.conf.parsoid.strictAcceptCheck) {
				var text = env.availableVersions.reduce(function(prev, curr) {
					return prev + apiUtils[opts.format + 'ContentType'](env, curr) + '\n';
				}, 'Not acceptable.\n');
				return apiUtils.fatalRequest(env, text, 406);
			} else {
				// Be explicit about giving the default content version.
				env.setContentVersion(env.availableVersions[0]);
				env.log('error/api/version',
					'Unacceptable profile string: ' + req.get('accept'));
			}
		}

		next();
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
		var domain = parsoidConfig.mwApiMap.get(res.locals.iwp).domain;
		var action = '/' + domain + '/v3/transform/html/to/wikitext/' + res.locals.pageName;
		if (req.query.hasOwnProperty('scrub_wikitext')) {
			action += "?scrub_wikitext=" + req.query.scrub_wikitext;
		}
		apiUtils.renderResponse(res, env, 'form', {
			title: 'Your HTML DOM:',
			action: action,
			name: 'html',
		});
	};

	// Form-based wikitext -> HTML DOM interface for manual testing
	routes.wt2htmlForm = function(req, res) {
		var env = res.locals.env;
		var domain = parsoidConfig.mwApiMap.get(res.locals.iwp).domain;
		apiUtils.renderResponse(res, env, 'form', {
			title: 'Your wikitext:',
			action: '/' + domain + '/v3/transform/wikitext/to/html/' + res.locals.pageName,
			name: 'wikitext',
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

	var wt2html = Promise.method(function(req, res, wt) {
		var env = res.locals.env;
		var oldid = res.locals.oldid;
		var target = env.normalizeAndResolvePageTitle();

		// Performance Timing options
		var stats = env.conf.parsoid.stats;
		var startTimers = new Map();

		if (stats) {
			// init refers to time elapsed before parsing begins
			startTimers.set('wt2html.init', Date.now());
			startTimers.set('wt2html.total', Date.now());
		}

		var p = Promise.resolve(wt);

		if (oldid || typeof wt !== 'string') {
			// Always fetch the page info if we have an oldid.
			// Otherwise, if no wt was passed, we need to figure out
			// the latest revid to which we'll redirect.
			p = p.tap(function() {
				return TemplateRequest.setPageSrcInfo(env, target, oldid);
			});
		}

		p = p.tap(function() {
			env.bumpParserResourceUse('wikitextSize',
				(typeof wt !== 'string' ? env.page.src : wt).length);
		});

		if (typeof wt === 'string' && res.locals.subst) {
			p = p.then(function(wikitext) {
				// FIXME: reset limits after subst'ing
				return apiUtils.substTopLevelTemplates(env, target, wikitext);
			});
		}

		return p.then(function(wikitext) {
			// Calling this `wikitext` so that it's easily distinguishable.
			// It may have been modified by substTopLevelTemplates.

			// Now that we have a revid, we can redirect
			if (typeof wikitext !== 'string' && !oldid) {
				return apiUtils.redirectToOldid(req, res);
			}

			env.log('info', 'started parsing');

			var p2;
			if (typeof wikitext === 'string') {
				env.setPageSrcInfo(wikitext);

				// Don't cache requests when wt is set in case somebody uses
				// GET for wikitext parsing
				apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');

				if (stats) {
					stats.timing('wt2html.wt.init', '',
						Date.now() - startTimers.get('wt2html.init'));
					startTimers.set('wt2html.wt.parse', Date.now());
					stats.timing('wt2html.wt.size.input', '', wikitext.length);
				}

				if (!res.locals.pageName) {
					// clear default page name
					env.page.name = '';
				}

				p2 = env.pipelineFactory.parse(env, wikitext);
			} else if (oldid) {
				// Indicate the MediaWiki revision in a header as well for
				// ease of extraction in clients.
				apiUtils.setHeader(res, env, 'content-revision-id', oldid);

				if (stats) {
					stats.timing('wt2html.pageWithOldid.init', '',
						Date.now() - startTimers.get('wt2html.init'));
					startTimers.set('wt2html.pageWithOldid.parse', Date.now());
					stats.timing('wt2html.pageWithOldid.size.input', '', env.page.src.length);
				}

				p2 = env.pipelineFactory.parse(env, env.page.src)
				.tap(function() {
					if (req.headers.cookie) {
						// Don't cache requests with a session.
						apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
					}
				});
			} else {
				console.assert(false, 'Should be unreachable');
			}

			return p2
			// .timeout(REQ_TIMEOUT)
			.then(function(doc) {
				var output;
				if (env.pageBundle) {
					var out = DU.extractDpAndSerialize(res.locals.bodyOnly ? doc.body : doc, {
						innerXML: res.locals.bodyOnly,
					});
					var response = {
						html: {
							headers: { 'content-type': apiUtils.htmlContentType(env) },
							body: out.str,
						},
						'data-parsoid': {
							headers: { 'content-type': apiUtils.dataParsoidContentType(env) },
							body: out.pb.parsoid,
						},
					};
					if (env.contentVersion !== '1.2.1') {
						response['data-mw'] = {
							headers: { 'content-type': apiUtils.dataMwContentType(env) },
							body: out.pb.mw,
						};
					}
					apiUtils.setHeader(res, env, 'content-type', apiUtils.pagebundleContentType(env));
					apiUtils.jsonResponse(res, env, response);
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
	});

	var html2wt = Promise.method(function(req, res, html) {
		var env = res.locals.env;
		var opts = res.locals.opts;

		// Performance Timing options
		var stats = env.conf.parsoid.stats;
		var startTimers = new Map();

		if (opts.original && opts.original.wikitext) {
			env.setPageSrcInfo(opts.original.wikitext.body);
		}

		// var REQ_TIMEOUT = env.conf.parsoid.timeouts.request;

		env.bumpSerializerResourceUse('htmlSize', html.length);
		env.page.id = res.locals.oldid;
		env.log('info', 'started serializing');

		if (stats) {
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

		if (opts.original) {
			var dp = opts.original['data-parsoid'];
			// This is optional to support serializing html with inlined
			// data-* attributes.
			if (dp) {
				apiUtils.validatePageBundle(opts.original);
				DU.applyPageBundle(doc, {
					parsoid: dp.body,
					mw: opts.original['data-mw'] && opts.original['data-mw'].body,
				});
				// FIXME(arlolra): use input content-type for this.
				env.page.dpContentType = (dp.headers || {})['content-type'];
			}
			if (opts.original.html) {
				env.page.dom = DU.parseHTML(opts.original.html.body).body;
				// However, if we're given stored html, data-* attributes
				// should be provided as well.  We have no use case for
				// stored inlined data-* attributes anymore.
				apiUtils.validatePageBundle(opts.original);
				DU.applyPageBundle(env.page.dom.ownerDocument, {
					parsoid: dp.body,
					mw: opts.original['data-mw'] && opts.original['data-mw'].body,
				});
			}
		}

		// SSS FIXME: As a fallback, lookup the content types
		// in the <head> of doc and/or env.page.dom
		// For now, ignoring this.

		// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
		//   "Both it and the oldid parameter are needed for
		//    clean round-tripping of HTML retrieved earlier with"
		// So, no oldid => no selser
		var hasOldId = (env.page.id && env.page.id !== '0');
		var useSelser = hasOldId && env.conf.parsoid.useSelser;

		return DU.serializeDOM(env, doc.body, useSelser)
		// .timeout(REQ_TIMEOUT)
		.then(function(output) {
			if (stats) {
				stats.timing('html2wt.total', '',
					Date.now() - startTimers.get('html2wt.total'));
				stats.timing('html2wt.size.output', '', output.length);
			}
			apiUtils.logTime(env, res, 'serializing');
			apiUtils.setHeader(res, env, 'content-type', apiUtils.wikitextContentType(env));
			apiUtils.sendResponse(res, env, output);
		});
	});

	var html2html = Promise.method(function(req, res) {
		var env = res.locals.env;
		var opts = res.locals.opts;

		// See if we can reuse transclusion or extension expansions.
		var revision = opts.previous || opts.original;
		if (revision) {
			var doc = DU.parseHTML(revision.html.body);
			// Similar to the html2wt case, stored html is expected
			// to also pass in data-* attributes.
			apiUtils.validatePageBundle(revision);
			DU.applyPageBundle(doc, {
				parsoid: revision['data-parsoid'].body,
				mw: revision['data-mw'] && revision['data-mw'].body,
			});
			DU.visitDOM(doc.body, DU.loadDataAttribs);
			var expansions = DU.extractExpansions(doc.body);
			Object.keys(opts.updates || {}).forEach(function(mode) {
				switch (mode) {
					case 'transclusions':
					case 'media':
						// Truthy values indicate that these need updating,
						// so don't reuse them.
						if (opts.updates[mode]) {
							expansions[mode] = {};
						}
						break;
					default:
						throw new Error('Received an unexpected update mode.');
				}
			});
			env.setCaches(expansions);
		}

		return wt2html(req, res);
	});

	// GET requests
	routes.v3Get = function(req, res) {
		var opts = res.locals.opts;
		var env = res.locals.env;
		var p;
		if (opts.format === 'wikitext') {
			var target = env.normalizeAndResolvePageTitle();
			var oldid = res.locals.oldid;
			p = TemplateRequest.setPageSrcInfo(env, target, oldid)
			.then(function() {
				if (!oldid) {
					return apiUtils.redirectToOldid(req, res);
				}
				apiUtils.setHeader(res, env, 'content-type', apiUtils.wikitextContentType(env));
				apiUtils.sendResponse(res, env, env.page.src);
			});
		} else {
			p = wt2html(req, res);
		}
		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// POST requests
	routes.v3Post = function(req, res) {
		var opts = res.locals.opts;
		var env = res.locals.env;
		var p;
		if (opts.from === 'wikitext') {
			// No use case for this yet
			if (opts.format === 'wikitext') {
				return apiUtils.fatalRequest(env, 'Invalid format', 400);
			}
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
			p = wt2html(req, res, wikitext);
		} else {  // from html/pagebundle
			if (opts.format === 'wikitext') {
				// html is required for serialization
				if (opts.html === undefined) {
					return apiUtils.fatalRequest(env, 'No html was supplied.', 400);
				}
				// Accept html as a string or object{body,headers}
				var html = (typeof opts.html === 'string') ?
					opts.html : (opts.html.body || '');

				// FIXME(arlolra): what content-type is this!? from headers,
				// original headers, or inlined version.  Also, bikeshed a
				// name for this (inputVersion, etc.) since contentVersion is
				// for the output.

				p = html2wt(req, res, html);
			} else {
				p = html2html(req, res);
			}
		}
		return apiUtils.cpuTimeout(p, res)
			.catch(apiUtils.timeoutResp.bind(null, env));
	};

	return routes;
};
