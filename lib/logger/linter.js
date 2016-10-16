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
	var env = this._env;
	try {
		if (env.conf.parsoid.linterAPI) {
			// Only send the request if it is
			// the latest revision
			if (env.page.meta.revision.revid === env.page.latest) {
				request.post(
					env.conf.parsoid.linterAPI,
					{ form: {
						data: JSON.stringify(this.buffer),
						page: env.page.name,
						revision: env.page.meta.revision.revid,
						action: 'record-lint',
						format: 'json',
						formatversion: 2,
					}, },
					function(error, response, body) {
						console.log(body);
					}
				);
			}
		}
		this.buffer = [];
		return;
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
		var templateInfo = lintObj.templateInfo;
		var msg = {};

		var re = /lint\/(.*)/;
		var wiki = this._env.conf.wiki.iwp;

		msg.type = logType.match(re)[1];
		msg.wiki = wiki;
		msg.wikiurl = url.resolve(this._env.conf.parsoid.mwApiMap.get(wiki).uri, '/');
		msg.params = lintObj.params || {};

		if (logData.locationData) {
			msg.location = logData.locationData.toString();
		}

		if (dsr) {
			msg.dsr = dsr;
		}

		if (templateInfo) {
			msg.templateInfo = templateInfo;
		}
		if (logType === 'lint/fostered' || logType === 'lint/multi-template' || logType === 'lint/mixed-content') {
			msg.src = src;
		} else if (dsr) {
			msg.src = src.substring(dsr[0], dsr[1]);
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
