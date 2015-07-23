/*
 * Logger backend for linter.
 * This backend filters out logging messages with Logtype "lint/*" and
 * logs them (console, external service).
 */

'use strict';

var request = require('request');
var url = require('url');

var Linter = function(env) {
	this._env = env;
	this.buffer = [];
};

Linter.prototype.logLintOutput = function(logData, cb) {
	try {
		if (this.buffer.length > 0) {
			if (!this._env.conf.parsoid.linterAPI) {
				console.log(this.buffer);
			} else {
				request.post(
					this._env.conf.parsoid.linterAPI,
					{ json: this.buffer },
					function(error, response, body) {
						if (!error && response.statusCode === 200) {
							console.log(body);
						}
					}
				);
			}
			this.buffer = [];
			return;
		} else {
			console.log("No Issues found");
		}
	} catch (e) {
		console.error("Error in logLintOutput: " + e);
		return;
	} finally {
		cb();
	}
};

Linter.prototype.linterBackend = function(logData, cb) {
	// Wrap in try-catch-finally so we can more accurately
	// pin errors to specific logging backends
	try {
		var logType = logData.logType;
		var lintObj = logData.logObject[0];
		var src = lintObj.src;
		var dsr = lintObj.dsr;
		var inTransclusion = lintObj.inTransclusion;
		var msg = {};

		var re = /lint\/(.*)/;
		var wiki = this._env.conf.wiki.iwp;

		msg.type = logType.match(re)[1];
		msg.wiki = wiki;
		msg.page = this._env.page.name;
		msg.revision = this._env.page.meta.revision.revid;
		msg.wikiurl = url.resolve(this._env.conf.parsoid.mwApiMap.get(wiki).uri, '/');

		if (logData.locationData) {
			msg.location = logData.locationData.toString();
		}

		if (dsr) {
			msg.dsr = dsr;
		}

		if (inTransclusion) {
			msg.inTransclusion = inTransclusion;
		}
		if (logType === 'lint/fostered' || logType === 'lint/multi-template' || logType === 'lint/mixed-content') {
			msg.src = src;
		} else if (dsr) {
			msg.src = src.substring(dsr[0], dsr[1]);
		}

		if (logData.logObject[2]) {
			msg.tips = logData.tip;
		}

		this.buffer.push(msg);

	} catch (e) {
		console.error("Error in linterBackend: " + e);
		return;
	} finally {
		cb();
	}
};

if (typeof module === "object") {
	module.exports.Linter = Linter;
}
