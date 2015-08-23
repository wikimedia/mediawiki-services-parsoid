'use strict';
require('../lib/core-upgrade.js');

var cluster = require('cluster');
var domino = require('domino');
var util = require('util');

var Diff = require('../lib/mediawiki.Diff.js').Diff;
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;
var PegTokenizer = require('../lib/mediawiki.tokenizer.peg.js').PegTokenizer;
var ApiRequest = require('../lib/mediawiki.ApiRequest.js');

var TemplateRequest = ApiRequest.TemplateRequest;
var PHPParseRequest = ApiRequest.PHPParseRequest;


/**
 * @class apiUtils
 * @singleton
 */
var apiUtils = module.exports = {
	/** @property {string} */
	WIKITEXT_CONTENT_TYPE: 'text/plain;profile="mediawiki.org/specs/wikitext/1.0.0";charset=utf-8',
	/** @property {string} */
	HTML_CONTENT_TYPE:     'text/html;profile="mediawiki.org/specs/html/1.1.0";charset=utf-8',
};

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
	if (!args.code) {
		args.code = 302; // moved temporarily
	}

	if (args.res && args.env && args.env.responseSent) {
		return;
	} else {
		args.res.writeHead(args.code, {
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
 * End response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {MWParserEnvironment} env
 * @param {String|Buffer} [out]
 */
apiUtils.endResponse = function(res, env, out) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.end(out);
		env.log("end/response");
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
		err.stack = null;
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

// Cluster support was very experimental and missing methods in v0.8.x
var sufficientNodeVersion = !/^v0\.[0-8]\./.test(process.version);

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
		if (cluster.isMaster || !sufficientNodeVersion) {
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
				headNodes += DU.serializeNode(hNodes[i]).str;
				break;
			}
		}

		var bNodes = doc.body.childNodes;
		var bodyNodes = "";
		for (i = 0; i < bNodes.length; i++) {
			bodyNodes += DU.serializeNode(bNodes[i]).str;
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

apiUtils.startHtml2wt = Promise.method(function(req, res, html) {
	var env = res.locals.env;

	env.page.id = res.locals.oldid;
	env.log('info', 'started serializing');

	// Performance Timing options
	var timer = env.conf.parsoid.performanceTimer;
	var startTimers;

	if (timer) {
		startTimers = new Map();
		startTimers.set('html2wt.init', Date.now());
		startTimers.set('html2wt.total', Date.now());
		startTimers.set('html2wt.init.domparse', Date.now());
	}

	var doc = DU.parseHTML(html);

	// send domparse time, input size and init time to statsd/Graphite
	// init time is the time elapsed before serialization
	// init.domParse, a component of init time, is the time elapsed from html string to DOM tree
	if (timer) {
		timer.timing('html2wt.init.domparse', '',
			Date.now() - startTimers.get('html2wt.init.domparse'));
		timer.timing('html2wt.size.input', '', html.length);
		timer.timing('html2wt.init', '',
			Date.now() - startTimers.get('html2wt.init'));
	}

	return {
		env: env,
		res: res,
		doc: doc,
		startTimers: startTimers,
	};
});

apiUtils.endHtml2wt = function(ret) {
	var env = ret.env;
	var timer = env.conf.parsoid.performanceTimer;
	var REQ_TIMEOUT = env.conf.parsoid.timeouts.request;

	// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
	//   "Both it and the oldid parameter are needed for
	//    clean round-tripping of HTML retrieved earlier with"
	// So, no oldid => no selser
	var hasOldId = (env.page.id && env.page.id !== '0');
	var useSelser = hasOldId && env.conf.parsoid.useSelser;
	return DU.serializeDOM(env, ret.doc.body, useSelser)
			.timeout(REQ_TIMEOUT)
			.then(function(output) {
		if (timer) {
			timer.timing('html2wt.total', '',
				Date.now() - ret.startTimers.get('html2wt.total'));
			timer.timing('html2wt.size.output', '', output.length);
		}
		apiUtils.logTime(env, ret.res, 'serializing');
		return output;
	});
};

// To support the 'subst' API parameter, we need to prefix each
// top-level template with 'subst'. To make sure we do this for the
// correct templates, tokenize the starting wikitext and use that to
// detect top-level templates. Then, substitute each starting '{{' with
// '{{subst' using the template token's tsr.
var substTopLevelTemplates = function(env, target, wt) {
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

apiUtils.startWt2html = function(req, res, wt) {
	var env = res.locals.env;

	// Performance Timing options
	var timer = env.conf.parsoid.performanceTimer;
	var startTimers;

	if (timer) {
		startTimers = new Map();
		// init refers to time elapsed before parsing begins
		startTimers.set('wt2html.init', Date.now());
		startTimers.set('wt2html.total', Date.now());
	}

	var prefix = res.locals.iwp;
	var oldid = res.locals.oldid;
	var target = env.resolveTitle(env.normalizeTitle(env.page.name), '');

	var p = Promise.resolve(wt);

	if (oldid || typeof wt !== 'string') {
		// Always fetch the page info if we have an oldid.
		// Otherwise, if no wt was passed, we need to figure out
		// the latest revid to which we'll redirect.
		p = p.tap(function() {
			return TemplateRequest.setPageSrcInfo(env, target, oldid);
		});
	}

	if (typeof wt === 'string' && res.locals.subst) {
		p = p.then(function(wt) {
			return substTopLevelTemplates(env, target, wt);
		});
	}

	return p.then(function(wikitext) {
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
};

apiUtils.redirectToRevision = function(env, res, path, revid) {
	var timer = env.conf.parsoid.performanceTimer;
	env.log('info', 'redirecting to revision', revid);

	if (timer) {
		timer.count('wt2html.redirectToOldid', '');
	}

	// Don't cache requests with no oldid
	apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
	apiUtils.relativeRedirect({ 'path': path, 'res': res, 'env': env });
};

apiUtils.parsePageWithOldid = function(ret) {
	var env = ret.env;
	var timer = env.conf.parsoid.performanceTimer;
	var startTimers = ret.startTimers;
	env.log('info', 'started parsing');

	// Indicate the MediaWiki revision in a header as well for
	// ease of extraction in clients.
	apiUtils.setHeader(ret.res, env, 'content-revision-id', ret.oldid);

	if (timer) {
		timer.timing('wt2html.pageWithOldid.init', '',
			Date.now() - startTimers.get('wt2html.init'));
		startTimers.set('wt2html.pageWithOldid.parse', Date.now());
		timer.timing('wt2html.pageWithOldid.size.input', '', env.page.src.length);
	}

	var expansions = ret.reuse && ret.reuse.expansions;
	if (expansions) {
		// Figure out what we can reuse
		switch (ret.reuse.mode) {
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
};

apiUtils.parseWt = function(ret) {
	var env = ret.env;
	var res = ret.res;
	var timer = env.conf.parsoid.performanceTimer;
	var startTimers = ret.startTimers;

	env.log('info', 'started parsing');
	env.setPageSrcInfo(ret.wikitext);

	// Don't cache requests when wt is set in case somebody uses
	// GET for wikitext parsing
	apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');

	if (timer) {
		timer.timing('wt2html.wt.init', '',
			Date.now() - startTimers.get('wt2html.init'));
		startTimers.set('wt2html.wt.parse', Date.now());
		timer.timing('wt2html.wt.size.input', '', ret.wikitext.length);
	}

	if (!res.locals.pageName) {
		// clear default page name
		env.page.name = '';
	}

	return env.pipelineFactory.parse(env, ret.wikitext);
};

apiUtils.endWt2html = function(ret, doc, output) {
	var env = ret.env;
	var res = ret.res;
	var timer = env.conf.parsoid.performanceTimer;
	var startTimers = ret.startTimers;

	if (doc) {
		output = DU.serializeNode(res.locals.bodyOnly ? doc.body : doc, {
			// in v3 api, just the children of the body
			innerXML: res.locals.bodyOnly && res.locals.apiVersion > 2,
		}).str;
		apiUtils.setHeader(res, env, 'content-type', apiUtils.HTML_CONTENT_TYPE);
		apiUtils.endResponse(res, env, output);
	}

	if (timer) {
		if (startTimers.has('wt2html.wt.parse')) {
			timer.timing('wt2html.wt.parse', '',
				Date.now() - startTimers.get('wt2html.wt.parse'));
			timer.timing('wt2html.wt.size.output', '', output.length);
		} else if (startTimers.has('wt2html.pageWithOldid.parse')) {
			timer.timing('wt2html.pageWithOldid.parse', '',
				Date.now() - startTimers.get('wt2html.pageWithOldid.parse'));
			timer.timing('wt2html.pageWithOldid.size.output', '', output.length);
		}
		timer.timing('wt2html.total', '',
			Date.now() - startTimers.get('wt2html.total'));
	}

	apiUtils.logTime(env, res, 'parsing');
};

apiUtils.v2endWt2html = function(ret, doc) {
	var env = ret.env;
	var res = ret.res;
	var opts = res.locals.opts;
	if (opts.format === 'pagebundle') {
		var out = DU.extractDpAndSerialize(doc, {
			bodyOnly: res.locals.bodyOnly,
			// in v3 api, just the children of the body
			innerXML: res.locals.bodyOnly && res.locals.apiVersion > 2,
		});
		apiUtils.jsonResponse(res, env, {
			html: {
				headers: { 'content-type': apiUtils.HTML_CONTENT_TYPE },
				body: out.str,
			},
			'data-parsoid': {
				headers: { 'content-type': out.type },
				body: out.dp,
			},
		});
		apiUtils.endWt2html(ret, null, out.str);
	} else {
		apiUtils.endWt2html(ret, doc);
	}
};

apiUtils.validateDp = function(obj) {
	var dp = obj['data-parsoid'];
	if (!dp || !dp.body || dp.body.constructor !== Object || !dp.body.ids) {
		var err = new Error('Invalid data-parsoid was provided.');
		err.code = 400;
		throw err;
	}
};
