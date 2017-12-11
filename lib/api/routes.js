'use strict';

require('../../core-upgrade.js');

var childProcess = require('child_process');
var corepath = require('path');
var uuid = require('uuid/v4');
var Negotiator = require('negotiator');
var semver = require('semver');

var pkg = require('../../package.json');
var apiUtils = require('./apiUtils.js');
var DU = require('../utils/DOMUtils.js').DOMUtils;
var MWParserEnv = require('../config/MWParserEnvironment.js').MWParserEnvironment;
var Promise = require('../utils/promise.js');
var LogData = require('../logger/LogData.js').LogData;
var TemplateRequest = require('../mw/ApiRequest.js').TemplateRequest;

module.exports = function(parsoidConfig, processLogger, parsoidOptions, parse) {
	var routes = {};
	var metrics = parsoidConfig.metrics;
	var REQ_TIMEOUT = parsoidConfig.timeouts.request;

	// This helper is only to be used in middleware, before an environment
	// is setup.  The logger doesn't emit the expected location info.
	// You probably want `apiUtils.fatalRequest` instead.
	var errOut = function(res, text, httpStatus) {
		processLogger.log('fatal/request', text);
		apiUtils.errorResponse(res, text, httpStatus || 404);
	};

	// Middlewares

	var errorEncoding = new Map(Object.entries({
		'pagebundle': 'json',
		'html': 'html',
		'wikitext': 'plain',
		'lint': 'json',
	}));

	var validGets = new Set(['wikitext', 'html', 'pagebundle']);

	var wikitextTransforms = ['html', 'pagebundle'];
	if (parsoidConfig.linting) { wikitextTransforms.push('lint'); }

	var validTransforms = new Map(Object.entries({
		'wikitext': wikitextTransforms,
		'html': ['wikitext'],
		'pagebundle': ['wikitext', 'pagebundle'],
	}));

	routes.v3Middle = function(req, res, next) {
		res.locals.titleMissing = !req.params.title;
		res.locals.pageName = req.params.title || '';
		res.locals.oldid = req.params.revision || null;

		// "body_only" flag to return just the body (instead of the entire HTML doc)
		// We would like to deprecate use of this flag: T181657
		res.locals.body_only = !!(
			req.query.body_only || req.body.body_only
		);

		var opts = Object.assign({
			from: req.params.from,
			format: req.params.format,
		}, req.body);

		res.locals.errorEnc = errorEncoding.get(opts.format) || 'plain';

		if (req.method === 'GET' || req.method === 'HEAD') {
			if (!validGets.has(opts.format)) {
				return errOut(res, 'Invalid page format: ' + opts.format);
			}
		} else if (req.method === 'POST') {
			var transforms = validTransforms.get(opts.from);
			if (transforms === undefined || !transforms.includes(opts.format)) {
				return errOut(res, 'Invalid transform: ' + opts.from + '/to/' + opts.format);
			}
		} else {
			return errOut(res, 'Request method not supported.');
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

		res.locals.envOptions = {
			prefix: res.locals.iwp,
			pageName: res.locals.pageName,
			cookie: req.headers.cookie,
			reqId: req.headers['x-request-id'],
			userAgent: req.headers['user-agent'],
		};

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
				})
				.catch(function(e) {
					console.error(e.stack || e);
					res.end();
					return Promise.reject(e);
				})
				.nodify(callback);
			}
			return Promise.resolve().nodify(callback);
		}
		MWParserEnv.getParserEnv(parsoidConfig, res.locals.envOptions)
		.then(function(env) {
			env.logger.registerBackend(/fatal(\/.*)?/, errBack);
			res.locals.env = env;
			next();
		})
		.catch(function(err) {
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
			if (parsoidConfig.strictAcceptCheck) {
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
				}, function(err) {  // eslint-disable-line
					/* ignore the error, maybe this isn't a git checkout */
					return v;
				});
			});
		}
		return versionCache.then(function(v) {
			apiUtils.jsonResponse(res, v);
		});
	};

	// v3 Routes

	// Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.

	var wt2html = Promise.method(function(req, res, wt, reuseExpansions) {
		var env = res.locals.env;
		var opts = res.locals.opts;
		var oldid = res.locals.oldid;
		var target = env.normalizeAndResolvePageTitle();

		var pageBundle = !!(res.locals.opts && res.locals.opts.format === 'pagebundle');

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

		var doSubst = (typeof wt === 'string' && res.locals.subst);
		if (doSubst) {
			p = p.then(function(wikitext) {
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

			// Follow redirects if asked
			if (parsoidConfig.devAPI && req.query.follow_redirects) {
				// Get localized redirect matching regexp
				var reSrc = env.conf.wiki.getMagicWordMatcher('redirect').source;
				reSrc = '^[ \\t\\n\\r\\0\\x0b]*' +
						reSrc.substring(1, reSrc.length - 1) + // Strip ^ and $
						'[ \\t\\n\\r\\x0c]*(?::[ \\t\\n\\r\\x0c]*)?' +
						'\\[\\[([^\\]]+)\\]\\]';
				var re = new RegExp(reSrc, 'i');
				var s = wikitext || env.page.src;
				var redirMatch = s.match(re);
				if (redirMatch) {
					return apiUtils._redirectToPage(redirMatch[2], req, res);
				}
			}

			processLogger.log('info', 'started parsing');

			var envOptions = Object.assign({
				pageBundle: pageBundle,
				// Set data-parsoid to be discarded, so that the subst'ed
				// content is considered new when it comes back.
				discardDataParsoid: doSubst,
			}, res.locals.envOptions);

			// VE, the only client using body_only property,
			// doesn't want section tags when this flag is set.
			// (T181226)
			if (res.locals.body_only) {
				envOptions.wrapSections = false;
			}

			if (typeof wikitext === 'string') {
				// Don't cache requests when wt is set in case somebody uses
				// GET for wikitext parsing
				apiUtils.setHeader(res, 'Cache-Control', 'private,no-cache,s-maxage=0');

				if (metrics) {
					metrics.endTiming('wt2html.wt.init',
						startTimers.get('wt2html.init'));
					startTimers.set('wt2html.wt.parse', Date.now());
					metrics.timing('wt2html.wt.size.input', wikitext.length);
				}
			} else if (oldid) {
				envOptions.pageWithOldid = true;

				if (req.headers.cookie) {
					// Don't cache requests with a session.
					apiUtils.setHeader(res, 'Cache-Control', 'private,no-cache,s-maxage=0');
				}

				// Indicate the MediaWiki revision in a header as well for
				// ease of extraction in clients.
				apiUtils.setHeader(res, 'content-revision-id', oldid);

				if (metrics) {
					metrics.endTiming('wt2html.pageWithOldid.init',
						startTimers.get('wt2html.init'));
					startTimers.set('wt2html.pageWithOldid.parse', Date.now());
					metrics.timing('wt2html.pageWithOldid.size.input', env.page.src.length);
				}
			} else {
				console.assert(false, 'Should be unreachable');
			}

			return parse({
				// NOTE: This causes another TemplateRequest but otherwise
				// we don't have all the metadata.
				input: (typeof wikitext === 'string') ? wikitext : undefined,
				mode: 'wt2html',
				parsoidOptions: parsoidOptions,
				envOptions: envOptions,
				oldid: oldid,
				contentmodel: opts.contentmodel,
				contentVersion: env.contentVersion,
				body_only: res.locals.body_only,
				cacheConfig: true,
				reuseExpansions: reuseExpansions,
			})
			.then(function(out) {
				if (opts.format === 'lint') {
					apiUtils.jsonResponse(res, out.lint);
				} else {
					apiUtils.wt2htmlRes(env, res, out.html, out.pb, out.contentmodel);
				}
				var html = out.html;
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
				apiUtils.logTime(processLogger, res, 'parsing');
			});
		});
	});

	var html2wt = Promise.method(function(req, res, html) {
		var env = res.locals.env;
		var opts = res.locals.opts;

		var envOptions = Object.assign({
			scrubWikitext: apiUtils.shouldScrub(req, env.scrubWikitext),
		}, res.locals.envOptions);

		// Performance Timing options
		var startTimers = new Map();

		processLogger.log('info', 'started serializing');

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
				return apiUtils.fatalRequest(env, 'Content-type of original html is missing.', 400);
			}
		}
		if (metrics) {
			var ver = env.hasOwnProperty('originalVersion') ? env.originalVersion : 'default';
			metrics.increment('html2wt.original.version.' + ver);
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

		var oldhtml;
		var oldtext = null;

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
				envOptions.dpContentType = (original['data-parsoid'].headers || {})['content-type'];
			}

			// If we got original src, set it
			if (original.wikitext) {
				// Don't overwrite env.page.meta!
				oldtext = original.wikitext.body;
			}

			// If we got original html, parse it
			if (original.html) {
				var oldbody = DU.parseHTML(original.html.body).body;
				if (opts.from === 'pagebundle') {
					apiUtils.validatePageBundle(origPb, env.originalVersion);
					DU.applyPageBundle(oldbody.ownerDocument, origPb);
				}
				oldhtml = DU.toXML(oldbody);
			}
		}

		// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
		//   "Both it and the oldid parameter are needed for
		//    clean round-tripping of HTML retrieved earlier with"
		// So, no oldid => no selser
		var hasOldId = !!res.locals.oldid;
		var useSelser = hasOldId && parsoidConfig.useSelser;

		var selser;
		if (useSelser) {
			selser = { oldtext: oldtext, oldhtml: oldhtml };
		}

		return parse({
			input: DU.toXML(doc),
			mode: useSelser ? 'selser' : 'html2wt',
			parsoidOptions: parsoidOptions,
			envOptions: envOptions,
			oldid: res.locals.oldid,
			selser: selser,
			contentmodel: opts.contentmodel ||
				(opts.original && opts.original.contentmodel),
			cacheConfig: true,
		})
		.then(function(out) {
			if (metrics) {
				metrics.endTiming('html2wt.total',
					startTimers.get('html2wt.total'));
				metrics.timing('html2wt.size.output', out.wt.length);
			}
			apiUtils.logTime(processLogger, res, 'serializing');
			apiUtils.plainResponse(res, out.wt, undefined, apiUtils.wikitextContentType(env));
		});
	});

	var pb2pb = Promise.method(function(req, res) {
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
		if (metrics) {
			metrics.increment('pb2pb.original.version.' + env.originalVersion);
		}

		var contentmodel = (revision && revision.contentmodel);

		// TODO(arlolra): subbu has some sage advice in T114413#2365456 that
		// we should probably be more explicit about the pb2pb conversion
		// requested rather than this increasing complex fallback logic.

		// Downgrade (2 -> 1)
		if (revision === opts.original &&  // Maybe provide a stronger assertion.
				semver.satisfies(env.contentVersion, '^1.0.0') &&
				semver.satisfies(env.originalVersion, '^2.0.0')) {
			return apiUtils.downgrade2to1(env, revision, res, contentmodel);
		// No reuse from semantically different content versions.
		} else if (semver.satisfies(env.contentVersion, '^' + env.originalVersion)) {
			// Q(arlolra): Should redlinks be more complex than a bool?
			// See gwicke's proposal at T114413#2240381
			if (opts.updates && opts.updates.redlinks) {
				console.assert(parsoidConfig.useBatchAPI);
				// FIXME(arlolra): Maybe assert(revision === opts.original)
				return apiUtils.updateRedLinks(env, revision, res, contentmodel);
			} else {
				var doc = DU.parseHTML(revision.html.body);
				var pb = apiUtils.extractPageBundle(revision);
				apiUtils.validatePageBundle(pb, env.originalVersion);
				DU.applyPageBundle(doc, pb);
				var reuseExpansions = {
					updates: opts.updates,
					html: DU.toXML(doc),
				};
				return wt2html(req, res, undefined, reuseExpansions);
			}
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
		} else {
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
				p = pb2pb(req, res);
			}
		}
		return p.catch(apiUtils.timeoutResp.bind(null, env));
	};

	return routes;
};
