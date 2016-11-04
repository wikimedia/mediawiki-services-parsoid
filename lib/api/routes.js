'use strict';
require('../../core-upgrade.js');

var childProcess = require('child_process');
var corepath = require('path');
var uuid = require('node-uuid').v4;
var Negotiator = require('negotiator');
var semver = require('semver');

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
	var metrics = parsoidConfig.metrics;
	var REQ_TIMEOUT = parsoidConfig.timeouts.request;

	// This helper is only to be used in middleware, before an environment
	// is setup.  The logger doesn't emit the expected location info.
	// You probably want `apiUtils.fatalRequest` instead.
	var errOut = function(res, text, httpStatus) {
		var err = new Error(text);
		err.httpStatus = httpStatus || 404;
		err.suppressLoggingStack = true;
		processLogger.log('fatal/request', err);
		apiUtils.errorResponse(res, text, err.httpStatus);
	};

	// Middlewares

	routes.internal = function(req, res, next) {
		res.locals.errorEnc = 'plain';
		var iwp = req.params.prefix || parsoidConfig.defaultWiki || '';
		if (!parsoidConfig.mwApiMap.has(iwp)) {
			return errOut(res, 'Invalid prefix: ' + iwp);
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

	var errorEncoding = new Map(Object.entries({
		'pagebundle': 'json',
		'html': 'html',
		'wikitext': 'plain',
	}));

	routes.v3Middle = function(req, res, next) {
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
			from: (req.method === 'POST') ? req.params.from : 'wikitext',
			format: req.params.format,
		}, req.body);

		if (!supportedFormats.has(opts.format)) {
			res.locals.errorEnc = 'plain';
			return errOut(res, 'Invalid format: ' + opts.from + '/to/' + opts.format);
		} else {
			res.locals.errorEnc = errorEncoding.get(opts.format);
		}

		if (!supportedFormats.has(opts.from)) {
			return errOut(res, 'Invalid format: ' + opts.from + '/to/' + opts.format);
		}

		var iwp = parsoidConfig.reverseMwApiMap.get(req.params.domain);
		if (!iwp) {
			return errOut(res, 'Invalid domain: ' + req.params.domain);
		}
		res.locals.iwp = iwp;

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

	var activeRequests = new Map();
	routes.updateActiveRequests = function(req, res, next) {
		var buf = new Buffer(16);
		uuid(null, buf);
		var id = buf.toString('hex');
		var location = res.locals.iwp + '/' + res.locals.pageName +
			(res.locals.oldid ? '?oldid=' + res.locals.oldid : '');
		activeRequests.set(id, {
			location: location,
			timeout: setTimeout(function() {
				// This is pretty harsh but was, in effect, what we were doing
				// before with the cpu timeouts.  Shoud be removed with
				// T123446 and T110961.
				processLogger.log('fatal', 'Timed out processing: ' + location);
				// `processLogger` is async; give it some time to deliver the msg.
				setTimeout(function() { process.exit(1); }, 100);
			}, REQ_TIMEOUT),
		});
		var current = [];
		activeRequests.forEach(function(val) {
			current.push(val.location);
		});
		process.emit('service_status', current);
		res.once('finish', function() {
			clearTimeout(activeRequests.get(id).timeout);
			activeRequests.delete(id);
		});
		next();
	};

	routes.parserEnvMw = function(req, res, next) {
		function errBack(logData, callback) {
			if (!res.headersSent) {
				return new Promise(function(resolve, reject) {
					var socket = res.socket;
					if (res.finished || (socket && !socket.writable)) {
						return resolve();
					}
					res.once('finish', resolve);
					apiUtils.errorResponse(res, logData.fullMsg(), logData.flatLogObject().httpStatus);
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
			env.logger.registerBackend(/fatal(\/.*)?/, errBack);
			if (env.conf.parsoid.allowCORS) {
				// Allow cross-domain requests (CORS) so that parsoid service
				// can be used by third-party sites.
				apiUtils.setHeader(res, 'Access-Control-Allow-Origin',
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
			processLogger.log('fatal/request', err);
			// Workaround how logdata flatten works so that the error object is
			// recursively flattened and a stack trace generated for this.
			errBack(new LogData('error', ['error:', err, 'path:', req.path]));
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
		apiUtils.renderResponse(res, 'home', { dev: parsoidConfig.devAPI });
	};

	// robots.txt: no indexing.
	routes.robots = function(req, res) {
		apiUtils.plainResponse(res, 'User-agent: *\nDisallow: /\n');
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
			apiUtils.jsonResponse(res, v);
		});
	};

	// Form-based HTML DOM -> wikitext interface for manual testing.
	routes.html2wtForm = function(req, res) {
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
	routes.wt2htmlForm = function(req, res) {
		var domain = parsoidConfig.mwApiMap.get(res.locals.iwp).domain;
		apiUtils.renderResponse(res, 'form', {
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

		return TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.getContentHandler().toHTML(env);
		})
		.then(apiUtils.roundTripDiff.bind(null, env, req, res, false))
		// .timeout(REQ_TIMEOUT)
		.then(apiUtils.rtResponse.bind(null, env, req, res))
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

		return TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.getContentHandler().toHTML(env);
		}).then(function(doc) {
			// strip newlines from the html
			var html = doc.innerHTML.replace(/[\r\n]/g, '');
			return apiUtils.roundTripDiff(env, req, res, false, DU.parseHTML(html));
		})
		// .timeout(REQ_TIMEOUT)
		.then(apiUtils.rtResponse.bind(null, env, req, res))
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

		return TemplateRequest.setPageSrcInfo(env, target, oldid).then(function() {
			env.log('info', 'started parsing');
			return env.getContentHandler().toHTML(env);
		}).then(function(doc) {
			doc = DU.parseHTML(DU.toXML(doc));
			var comment = doc.createComment('rtSelserEditTestComment');
			doc.body.appendChild(comment);
			return apiUtils.roundTripDiff(env, req, res, true, doc);
		})
		// .timeout(REQ_TIMEOUT)
		.then(apiUtils.rtResponse.bind(null, env, req, res))
		.catch(apiUtils.timeoutResp.bind(null, env));
	};

	// Form-based round-tripping for manual testing
	routes.getRtForm = function(req, res) {
		apiUtils.renderResponse(res, 'form', {
			title: 'Your wikitext:',
			name: 'content',
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

		return env.getContentHandler().toHTML(env)
		.then(apiUtils.roundTripDiff.bind(null, env, req, res, false))
		.then(apiUtils.rtResponse.bind(null, env, req, res))
		.catch(function(err) {
			env.log('fatal/request', err);
		});
	};

	// v3 Routes

	// Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.

	var wt2html = Promise.method(function(req, res, wt) {
		var env = res.locals.env;
		var opts = res.locals.opts;
		var oldid = res.locals.oldid;
		var target = env.normalizeAndResolvePageTitle();

		// Performance Timing options
		var startTimers = new Map();

		if (metrics) {
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
				if (opts.contentmodel) {
					env.page.meta.revision.contentmodel = opts.contentmodel;
				}

				// Don't cache requests when wt is set in case somebody uses
				// GET for wikitext parsing
				apiUtils.setHeader(res, 'Cache-Control', 'private,no-cache,s-maxage=0');

				if (metrics) {
					metrics.endTiming('wt2html.wt.init',
						startTimers.get('wt2html.init'));
					startTimers.set('wt2html.wt.parse', Date.now());
					metrics.timing('wt2html.wt.size.input', wikitext.length);
				}

				if (!res.locals.pageName) {
					// clear default page name
					env.page.name = '';
				}

				p2 = env.getContentHandler().toHTML(env);
			} else if (oldid) {
				// Indicate the MediaWiki revision in a header as well for
				// ease of extraction in clients.
				apiUtils.setHeader(res, 'content-revision-id', oldid);

				if (metrics) {
					metrics.endTiming('wt2html.pageWithOldid.init',
						startTimers.get('wt2html.init'));
					startTimers.set('wt2html.pageWithOldid.parse', Date.now());
					metrics.timing('wt2html.pageWithOldid.size.input', env.page.src.length);
				}

				p2 = env.getContentHandler().toHTML(env)
				.tap(function() {
					if (req.headers.cookie) {
						// Don't cache requests with a session.
						apiUtils.setHeader(res, 'Cache-Control', 'private,no-cache,s-maxage=0');
					}
				});
			} else {
				console.assert(false, 'Should be unreachable');
			}

			return p2
			// .timeout(REQ_TIMEOUT)
			.then(function(doc) {
				var html, pb;
				if (env.pageBundle) {
					var out = DU.extractDpAndSerialize(res.locals.bodyOnly ? doc.body : doc, {
						innerXML: res.locals.bodyOnly,
					});
					html = out.str;
					pb = out.pb;
				} else {
					html = DU.toXML(res.locals.bodyOnly ? doc.body : doc, {
						innerXML: res.locals.bodyOnly,
					});
				}
				apiUtils.wt2htmlRes(env, res, html, pb);

				if (metrics) {
					if (startTimers.has('wt2html.wt.parse')) {
						metrics.endTiming('wt2html.wt.parse',
							startTimers.get('wt2html.wt.parse'));
						metrics.timing('wt2html.wt.size.output', html.length);
					} else if (startTimers.has('wt2html.pageWithOldid.parse')) {
						metrics.endTiming('wt2html.pageWithOldid.parse',
							startTimers.get('wt2html.pageWithOldid.parse'));
						metrics.timing('wt2html.pageWithOldid.size.output', html.length);
					}
					metrics.endTiming('wt2html.total', startTimers.get('wt2html.total'));
				}

				apiUtils.logTime(env, res, 'parsing');
			});
		});
	});

	var html2wt = Promise.method(function(req, res, html) {
		var env = res.locals.env;
		var opts = res.locals.opts;

		// Performance Timing options
		var startTimers = new Map();

		env.page.reset();
		env.page.meta.revision.revid = res.locals.oldid;
		env.page.meta.revision.contentmodel =
			opts.contentmodel ||
			(opts.original && opts.original.contentmodel) ||
			env.page.meta.revision.contentmodel;

		env.bumpSerializerResourceUse('htmlSize', html.length);
		env.log('info', 'started serializing');

		if (metrics) {
			startTimers.set('html2wt.init', Date.now());
			startTimers.set('html2wt.total', Date.now());
			startTimers.set('html2wt.init.domparse', Date.now());
		}

		var doc = DU.parseHTML(html);

		// send domparse time, input size and init time to statsd/Graphite
		// init time is the time elapsed before serialization
		// init.domParse, a component of init time, is the time elapsed
		// from html string to DOM tree
		if (metrics) {
			metrics.endTiming('html2wt.init.domparse',
				startTimers.get('html2wt.init.domparse'));
			metrics.timing('html2wt.size.input', html.length);
			metrics.endTiming('html2wt.init', startTimers.get('html2wt.init'));
		}

		var original = opts.original;

		// Get the inlined content version from the html, if available
		var el = doc.querySelector('meta[property=mw:html:version]');
		if (el) {
			env.originalVersion = el.getAttribute('content');
			// Otherwise, the version in the original html headers should suffice
			// We assume the edited doc is derived from the original html
		} else if (original && original.html) {
			env.originalVersion = apiUtils.versionFromType(original.html);
			if (env.originalVersion === null) {
				// Or, should we check for a meta in the original html?
				return apiUtils.fatalRequest(env, 'Content-type of original html is missing.', 400);
			}
		}

		var pb, origPb;

		// If available, the modified data-mw blob is applied, while preserving
		// existing inline data-mw.  But, no data-parsoid application, since
		// that's internal, we only expect to find it in its original,
		// unmodified form.
		if (opts.from === 'pagebundle' && opts['data-mw'] &&
				semver.satisfies(env.originalVersion, '^2.0.0')) {
			// `opts` isn't a revision, but we'll find a `data-mw` there.
			pb = apiUtils.extractPageBundle(opts);
			pb.parsoid = { ids: {} };  // So it validates
			apiUtils.validatePageBundle(pb, env.originalVersion);
			DU.applyPageBundle(doc, pb);
		}

		if (original) {
			if (opts.from === 'pagebundle') {
				// Apply the pagebundle to the parsed doc.  This supports the
				// simple edit scenarios where data-mw might not necessarily
				// have been retrieved.
				pb = origPb = apiUtils.extractPageBundle(original);
				// However, if a modified data-mw was provided,
				// original data-mw is omitted to avoid losing deletions.
				if (opts['data-mw'] &&
						semver.satisfies(env.originalVersion, '^2.0.0')) {
					// Don't modify `origPb`, it's used below.
					pb = { parsoid: pb.parsoid, mw: { ids: {} } };
				}
				apiUtils.validatePageBundle(pb, env.originalVersion);
				DU.applyPageBundle(doc, pb);

				// TODO(arlolra): data-parsoid is no longer versioned
				// independently, but we leave this for backwards compatibility
				// until content version <= 1.2.0 is deprecated.  Anything new
				// should only depend on `env.originalVersion`.
				env.page.dpContentType = (original['data-parsoid'].headers || {})['content-type'];
			}

			// If we got original src, set it
			if (original.wikitext) {
				// Don't overwrite env.page.meta!
				env.page.src = original.wikitext.body;
			}

			// If we got original html, parse it
			if (original.html) {
				env.page.dom = DU.parseHTML(original.html.body).body;
				if (opts.from === 'pagebundle') {
					apiUtils.validatePageBundle(origPb, env.originalVersion);
					DU.applyPageBundle(env.page.dom.ownerDocument, origPb);
				}
			}
		}

		// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
		//   "Both it and the oldid parameter are needed for
		//    clean round-tripping of HTML retrieved earlier with"
		// So, no oldid => no selser
		var hasOldId = !!env.page.meta.revision.revid;
		var useSelser = hasOldId && env.conf.parsoid.useSelser;

		var handler = env.getContentHandler();
		return handler.fromHTML(env, doc.body, useSelser)
		// .timeout(REQ_TIMEOUT)
		.then(function(output) {
			if (metrics) {
				metrics.endTiming('html2wt.total',
					startTimers.get('html2wt.total'));
				metrics.timing('html2wt.size.output', output.length);
			}
			apiUtils.logTime(env, res, 'serializing');
			apiUtils.plainResponse(res, output, undefined, apiUtils.wikitextContentType(env));
		});
	});

	var html2html = Promise.method(function(req, res) {
		var env = res.locals.env;
		var opts = res.locals.opts;

		var revision = opts.previous || opts.original;
		if (!revision || !revision.html) {
			return apiUtils.fatalRequest(env, 'Missing revision html.', 400);
		}

		env.originalVersion = apiUtils.versionFromType(revision.html);
		if (env.originalVersion === null) {
			return apiUtils.fatalRequest(env, 'Content-type of revision html is missing.', 400);
		}

		// Set the contentmodel here for downgrades.
		// Reuse will overwrite it when setting the src.
		if (!env.page.meta) {
			env.page.meta = { revision: {} };
		}
		env.page.meta.revision.contentmodel =
			(revision && revision.contentmodel) ||
			env.page.meta.revision.contentmodel;

		// Downgrade (2 -> 1)
		if (revision === opts.original &&  // Maybe provide a stronger assertion.
				semver.satisfies(env.contentVersion, '^1.0.0') &&
				semver.satisfies(env.originalVersion, '^2.0.0')) {
			return apiUtils.downgrade2to1(env, revision, res);
		// No reuse from semantically different content versions.
		} else if (semver.satisfies(env.contentVersion, '^' + env.originalVersion)) {
			apiUtils.reuseExpansions(env, revision, opts.updates);
			return wt2html(req, res);
		} else {
			return apiUtils.fatalRequest(env, 'We do not know how to do this conversion.', 415);
		}
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
				if (env.page.meta && env.page.meta.revision && env.page.meta.revision.contentmodel) {
					apiUtils.setHeader(res, 'x-contentmodel', env.page.meta.revision.contentmodel);
				}
				apiUtils.plainResponse(res, env.page.src, undefined, apiUtils.wikitextContentType(env));
			});
		} else {
			p = wt2html(req, res);
		}
		return p.catch(apiUtils.timeoutResp.bind(null, env));
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
				p = html2wt(req, res, html);
			} else {
				// No use case for this yet
				if (opts.from === 'html') {
					return apiUtils.fatalRequest(env, 'Invalid from', 400);
				}
				p = html2html(req, res);
			}
		}
		return p.catch(apiUtils.timeoutResp.bind(null, env));
	};

	return routes;
};
