'use strict';
require('../../core-upgrade.js');

var cluster = require('cluster');
var domino = require('domino');
var util = require('util');
var qs = require('querystring');

var Diff = require('../utils/Diff.js').Diff;
var DU = require('../utils/DOMUtils.js').DOMUtils;
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
 * (Returns if a response has already been sent.)
 * This is not strictly HTTP spec conformant, but works in most clients. More
 * importantly, it works both behind proxies and on the internal network.
 * @method
 * @param {Object} args
 */
apiUtils.relativeRedirect = function(args) {
	if (!args.httpStatus) {
		args.httpStatus = 302; // moved temporarily
	}

	if (args.res && args.env && args.env.responseSent) {
		return;
	} else {
		args.res.writeHead(args.httpStatus, {
			'Location': args.path,
		});
		args.res.end();
	}
};

/**
 * Set header, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {MWParserEnvironment} env
 * @param {String} name
 * @param {String|String[]} value
 */
apiUtils.setHeader = function(res, env, name, value) {
	if (env.responseSent) {
		return;
	} else {
		res.setHeader(name, value);
	}
};

/**
 * Send response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {MWParserEnvironment} env
 * @param {Buffer|String|Array|Object} body
 *   Buffers are sent with Content-Type application/octet-stream.
 *   Strings are sent with Content-Type text/html.
 *   Arrays and Objects are JSON-encoded.
 * @param {Number} [status] HTTP status code
 */
apiUtils.sendResponse = function(res, env, body, status) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		if (status) {
			res.status(status);
		}
		res.send(body);
	}
};

/**
 * Render response, but only if response hasn't been sent.
 * @param {Response} res The response object from our routing function.
 * @param {MWParserEnvironment} env
 * @param {String} view
 * @param {Object} locals
 */
apiUtils.renderResponse = function(res, env, view, locals) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.render(view, locals);
	}
};

/**
 * Send JSON response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {MWParserEnvironment} env
 * @param {Object} json
 */
apiUtils.jsonResponse = function(res, env, json) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.json(json);
	}
};

/**
 * Timeouts
 *
 * The request timeout is a simple node timer that should fire first and catch
 * most cases where we have long running requests to optimize.
 *
 * The CPU timeout handles the case where a child process is starved in a CPU
 * bound task for too long and doesn't give node a chance to fire the above
 * timer. At the beginning of each request, the child sends a message to the
 * cluster master containing a request id. If the master doesn't get a second
 * message from the child with the corresponding id by CPU_TIMEOUT, it will
 * send the SIGKILL signal to the child process.
 *
 * The above is susceptible false positives. Node spins one event loop, so
 * multiple asynchronous requests will interfere with each others' timing.
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

var makeDone = function(timeoutId) {
	// Create this function in an outer scope so that we don't inadvertently
	// keep a reference to the promise here.
	return function() {
		process.send({ type: 'timeout', done: true, timeoutId: timeoutId });
	};
};

/**
 * @method
 * @param {Promise} p
 * @param {Response} res The response object from our routing function.
 */
apiUtils.cpuTimeout = function(p, res) {
	var CPU_TIMEOUT = res.locals.env.conf.parsoid.timeouts.cpu;
	var timeoutId = res.locals.timeoutId;
	var location = util.format(
		'[%s/%s%s]', res.locals.iwp, res.locals.pageName,
		(res.locals.oldid ? '?oldid=' + res.locals.oldid : '')
	);
	return new Promise(function(resolve, reject) {
		if (cluster.isMaster) {
			return p.then(resolve, reject);
		}
		// Notify the cluster master that a request has started
		// to wait for a corresponding done msg or timeout.
		process.send({
			type: 'timeout',
			timeout: CPU_TIMEOUT,
			timeoutId: timeoutId,
			location: location,
		});
		var done = makeDone(timeoutId);
		p.then(done, done);
		p.then(resolve, reject);
	});
};

apiUtils.logTime = function(env, res, str) {
	env.log('info', util.format(
		'completed %s in %s ms', str, Date.now() - res.locals.start
	));
};

apiUtils.rtResponse = function(env, req, res, data) {
	apiUtils.renderResponse(res, env, 'roundtrip', data);
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

	return DU.serializeDOM(env, doc.body, useSelser).then(function(out) {
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
	var tokens = tokenizer.tokenize(wt, null, null, true);
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
 * Validates the pagebundle was provided in the expected format.
 *
 * @method
 * @param {Object} obj
 */
apiUtils.validatePageBundle = function(obj) {
	// FIXME(arlolra): This should also accept the content-type of the
	// supplied html to determine which attributes are expected.
	var dp = obj['data-parsoid'];
	if (!dp || !dp.body || dp.body.constructor !== Object || !dp.body.ids) {
		var err = new Error('Invalid data-parsoid was provided.');
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

var profileRE = /^https:\/\/www.mediawiki.org\/wiki\/Specs\/(HTML|pagebundle)\/(\d+\.\d+\.\d+)$/;

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
		var tp = t.parameters;
		if ((opts.format === 'html' && t.type === 'text/html') ||
				(opts.format === 'pagebundle' && t.type === 'application/json') ||
				// 'pagebundle' is sending 'text/html' as well here.
				(tp && tp.profile === 'mediawiki.org/specs/html/1.2.0')) {
			if (tp && tp.profile) {
				var match = profileRE.exec(tp.profile);
				// TODO(arlolra): Remove when this version is no longer supported.
				if (!match && (tp.profile === 'mediawiki.org/specs/html/1.2.0')) {
					match = [null, opts.format, '1.2.0'];
				}
				if (match && (opts.format === match[1].toLowerCase())) {
					var contentVersion = env.resolveContentVersion(match[2]);
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
	var stats = env.conf.parsoid.stats;
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
	if (stats) {
		stats.count('redirectToOldid.' + format.toLowerCase(), '');
	}
	// Don't cache requests with no oldid
	apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
	apiUtils.relativeRedirect({ 'path': path, 'res': res, 'env': env });
};
