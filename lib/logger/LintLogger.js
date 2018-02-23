/** @module */
/**
 * Logger backend for linter.
 * This backend filters out logging messages with Logtype "lint/*" and
 * logs them (console, external service).
 */

'use strict';

var LintRequest = require('../mw/ApiRequest.js').LintRequest;
var Promise = require('../utils/promise.js');

/**
 * @class
 */
var LintLogger = function(env) {
	this._env = env;
	this.buffer = [];
};

LintLogger.prototype._lintError = function() {
	var env = this._env;
	var args = arguments;
	// Call this async since recursive sync calls to the logger are suppressed
	process.nextTick(function() {
		env.log.apply(env, args);
	});
};

/**
 * @method
 * @param {LogData} logData
 * @return {Promise}
 */
LintLogger.prototype.logLintOutput = Promise.async(function *(logData) {
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

		if (env.page.id % env.conf.parsoid.linter.apiSampling !== 0) {
			return;
		}

		// Skip linting if we cannot lint it
		if (!env.page.hasLintableContentModel()) {
			return;
		}

		if (!env.conf.parsoid.linter.sendAPI) {
			enabledBuffer.forEach(function(item) {
				// Call this async, since recursive sync calls to the logger
				// are suppressed.  This messes up the ordering, as you'd
				// expect, but since it's only for debugging it should be
				// acceptable.
				process.nextTick(function() {
					env.log('warn/lint/' + item.type, item);
				});
			});
			return;
		}

		if (!env.conf.wiki.linterEnabled) {
			// If it's not installed, we can't send a request,
			// so skip.
			return;
		}

		if (!env.pageWithOldid) {
			// We only want to send to the MW API if this was a request to
			// parse the full page.
			return;
		}

		// Only send the request if it the latest revision
		if (env.page.meta.revision.revid === env.page.latest) {
			try {
				var data = yield LintRequest.promise(env, JSON.stringify(enabledBuffer));
				if (data.error) { env.log('error/lint/api', data.error); }
			} catch (ee) {
				env.log('error/lint/api', ee);
			}
		}
	} catch (e) {
		this._lintError('error/lint/api', "Error in logLintOutput: ", e);
	}
});

/**
 * @method
 * @param {LogData} logData
 * @return {Promise}
 */
LintLogger.prototype.linterBackend = Promise.async(function *(logData) { // eslint-disable-line require-yield
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
			if (lintObj.templateInfo) {
				msg.templateInfo = lintObj.templateInfo;
			}

			this.buffer.push(msg);
		} else {
			this._lintError('error/lint', 'Missing DSR; msg=', msg);
		}
	} catch (e) {
		this._lintError('error/lint', 'Error in linterBackend: ', e);
	}
});

if (typeof module === "object") {
	module.exports.LintLogger = LintLogger;
}
