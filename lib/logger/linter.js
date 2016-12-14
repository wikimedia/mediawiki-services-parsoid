/*
 * Logger backend for linter.
 * This backend filters out logging messages with Logtype "lint/*" and
 * logs them (console, external service).
 */

'use strict';

var LintRequest = require('../mw/ApiRequest.js').LintRequest;

var Linter = function(env) {
	this._env = env;
	this.buffer = [];
};

Linter.prototype.logLintOutput = function(logData, cb) {
	var env = this._env;
	var enabledBuffer;
	try {
		if (env.conf.parsoid.linting === true) {
			enabledBuffer = this.buffer;  // Everything is enabled
		} else if (Array.isArray(env.conf.parsoid.linting)) {
			enabledBuffer = this.buffer.filter(function(item) {
				return env.conf.parsoid.linting.indexOf(item.type) !== -1;
			});
		} else {
			console.assert(false, 'Why are we here? Linting is disabled.');
		}

		this.buffer = [];

		if (env.page.id % env.conf.parsoid.linterAPISampling !== 0) {
			return;
		}

		if (!env.conf.parsoid.linterSendAPI) {
			enabledBuffer.forEach(function(item) {
				// Call this async, since recursive sync calls to the logger
				// are suppressed.  This messes up the ordering, as you'd
				// expect, but since it's only for debugging it should be
				// acceptable.
				process.nextTick(function() {
					env.log('info/lint/' + item.type, item);
				});
			});
			return;
		}

		// Only send the request if it the latest revision
		if (env.page.meta.revision.revid === env.page.latest) {
			LintRequest.promise(env, JSON.stringify(enabledBuffer))
			.then(function(data) {
				if (data.error) { env.log('error/lint/api', data.error); }
			})
			.catch(function(e) {
				env.log('error/lint/api', e);
			});
		}
	} catch (e) {
		env.log('error/lint/api', "Error in logLintOutput: " + e);
	} finally {
		cb();
	}
};

Linter.prototype.linterBackend = function(logData, cb) {
	// Wrap in try-catch-finally so we can more accurately
	// pin errors to specific logging backends
	try {
		var lintObj = logData.logObject[0];

		var msg = {
			type: logData.logType.match(/lint\/(.*)/)[1],
			params: lintObj.params || {},
		};

		var dsr = lintObj.dsr;
		if (dsr) {
			msg.dsr = dsr;
		}

		if (lintObj.templateInfo) {
			msg.templateInfo = lintObj.templateInfo;
		}

		var src = lintObj.src;
		if (msg.type === 'fostered' ||
				msg.type === 'multi-template' ||
				msg.type === 'mixed-content') {
			msg.src = src;
		} else if (dsr) {
			msg.src = src.substring(dsr[0], dsr[1]);
		}

		this.buffer.push(msg);
	} catch (e) {
		this._env.log("error/lint", "Error in linterBackend: " + e);
	} finally {
		cb();
	}
};

if (typeof module === "object") {
	module.exports.Linter = Linter;
}
