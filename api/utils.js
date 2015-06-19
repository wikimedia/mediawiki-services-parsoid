'use strict';
require('../lib/core-upgrade.js');

var cluster = require('cluster');
var domino = require('domino');
var util = require('util');

var Diff = require('../lib/mediawiki.Diff.js').Diff;
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;


var apiUtils = module.exports = {};

/**
 * Send a redirect response with optional code and a relative URL
 *
 * (Returns if a response has already been sent.)
 * This is not strictly HTTP spec conformant, but works in most clients. More
 * importantly, it works both behind proxies and on the internal network.
 */
apiUtils.relativeRedirect = function(args) {
	if (!args.code) {
		args.code = 302; // moved temporarily
	}

	if (args.res && args.env && args.env.responseSent ) {
		return;
	} else {
		args.res.writeHead(args.code, {
			'Location': args.path
		});
		args.res.end();
	}
};

/**
 * Set header, but only if response hasn't been sent.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Response} res The response object from our routing function.
 * @property {Function} Serializer
 */
apiUtils.setHeader = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		res.setHeader.apply(res, Array.prototype.slice.call(arguments, 2));
	}
};

/**
 * End response, but only if response hasn't been sent.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Response} res The response object from our routing function.
 * @property {Function} Serializer
 */
apiUtils.endResponse = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.end.apply(res, Array.prototype.slice.call(arguments, 2));
		env.log("end/response");
	}
};

/**
 * Send response, but only if response hasn't been sent.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Response} res The response object from our routing function.
 * @property {Function} Serializer
 */
apiUtils.sendResponse = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.send.apply(res, Array.prototype.slice.call(arguments, 2));
	}
};

/**
 * Render response, but only if response hasn't been sent.
 */
apiUtils.renderResponse = function(res, env, template, data) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.render(template, data);
	}
};

apiUtils.jsonResponse = function(res, env) {
	if (env.responseSent) {
		return;
	} else {
		env.responseSent = true;
		res.json.apply(res, Array.prototype.slice.call(arguments, 2));
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

apiUtils.cpuTimeout = function(p, res) {
	var CPU_TIMEOUT = res.local('env').conf.parsoid.timeouts.cpu;
	var timeoutId = res.local('timeoutId');
	var location = util.format(
		'[%s/%s%s]', res.local('iwp'), res.local('pageName'),
		(res.local('oldid') ? '?oldid=' + res.local('oldid') : '')
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
			location: location
		});
		var done = makeDone(timeoutId);
		p.then(done, done);
		p.then(resolve, reject);
	});
};

apiUtils.logTime = function(env, res, str) {
	env.log('info', util.format(
		'completed %s in %s ms', str, Date.now() - res.local('start')
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
			reqUrl: req.url
		};
	});
};

apiUtils.startHtml2wt = Promise.method(function(req, res, html) {
	var env = res.local('env');

	env.page.id = res.local('oldid');
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
			Date.now() - startTimers.get( 'html2wt.init' ));
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
