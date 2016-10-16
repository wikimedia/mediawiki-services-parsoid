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
	var enabledBuffer;
	// Everything is enabled
	if (env.conf.parsoid.linting === true) {
		enabledBuffer = this.buffer;
	} else if (Array.isArray(env.conf.parsoid.linting)) {
		enabledBuffer = this.buffer.filter(function(item) {
			return env.conf.parsoid.linting.indexOf(item.type) !== -1;
		});
	}

	this.buffer = [];

	if (env.page.id % env.conf.parsoid.linterAPISampling !== 0) {
		return;
	}

	try {
		if (env.conf.parsoid.linterSendAPI) {
			// Only send the request if it is
			// the latest revision
			if (env.page.meta.revision.revid === env.page.latest) {
				request.post(
					env.conf.wiki.apiURI,
					{ form: {
						data: JSON.stringify(enabledBuffer),
						page: env.page.name,
						revision: env.page.meta.revision.revid,
						action: 'record-lint',
						format: 'json',
						formatversion: 2,
					}, },
					function(error, response, body) {
						if (response.statusCode !== 200) {
							env.log('error/lint-api', body);
						}
					}
				);
			}
		}
	} catch (e) {
		env.log('error/lint-api', "Error in logLintOutput: " + e);
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
		this._env.log("error/linter", "Error in linterBackend: " + e);
	} finally {
		cb();
	}
};

if (typeof module === "object") {
	module.exports.Linter = Linter;
}
