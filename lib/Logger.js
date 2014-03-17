"use strict";
require('./core-upgrade.js');

var LogData = require('./LogData.js').LogData,
	Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js').DOMUtils,
	util = require('util'),
	defines = require('./mediawiki.parser.defines.js'),
	async = require('async');

/**
 * Multi-purpose logger. Supports different kinds of logging (errors,
 * warnings, fatal errors, etc.) and a variety of logging data (errors,
 * strings, objects).
 *
 * @class
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {boolean} dontRegisterDefaultBackend
 */
var Logger = function(env, opts) {
	if (!opts) { opts = {}; }
	this._env = env;
	this._logRequestQueue = [];
	this._backends = new Map();
	this._defaultLogLevels = opts.logLevels || ["error", "fatal"];
	this._traceTestRegExp = this._buildTraceTestRE();

	if (!opts.dontRegisterDefaultBackend) {
		this.registerBackend(this._traceTestRegExp, this._defaultBackend);
	}
};

/**
 * @method
 *
 * Outputs logging and tracing information to different backends.
 * @param {String} logType
 */
Logger.prototype.log = function (logType) {
	try {
		var self = this;

		// XXX this should be configurable.
		if (this._traceTestRegExp.test(logType)) {
			var logObject = Array.prototype.slice.call(arguments, 1);
			var logData = new LogData(this._env, logType, logObject);
			// If we are already processing a log request, but a log was generated
			// while processing the first request, processingLogRequest will be true.
			// We ignore all follow-on log events unless they are fatal. We put all
			// fatal log events on the logRequestQueue for processing later on.
			if (this.processingLogRequest) {
				if (/^fatal$/.test(logType)) {
					// Array.prototype.slice.call converts arguments to a real array
					// So that arguments can later be used in log.apply
					this._logRequestQueue.push(Array.prototype.slice.call(arguments));
				}
				return;
			// We weren't already processing a request, so we set the processingLogReq
			// flag to true. Then we send the logData to appropriate backends and
			// process any fatal log events that we find on the queue.
			} else {
				self.processingLogRequest = true;
				// Callback to routeToBackends forces logging of fatal log events.
				this._routeToBackends(logData, function(){
					self.processingLogRequest = false;
					if (self._logRequestQueue.length > 0) {
						self.log.apply(self, self._logRequestQueue.pop());
					}
				});
			}
		}
	} catch (e) {
		console.log(e.message);
		console.log(e.stack);
	}
};

/**
 * @method
 *
 * Registers a backend by adding it to the collection of backends.
 * @param {RegExp} logType
 * @param {Function} backend Backend to send logging / tracing info to.
 */
Logger.prototype.registerBackend = function (logType, backend) {
	if (!this._backends.has(logType)) {
		var logTypeString = logType instanceof RegExp ? logType.source : logType;
		this._backends.set(logType, backend);
		if (!this._backendRegExp) {
			this._backendRegExp = new RegExp(logTypeString);
		} else {
			this._backendRegExp = new RegExp(this._backendRegExp.source + "|" +logTypeString);
		}
	}
};

/**
 * @method
 *
 * Generates regexp to test if logType is a valid logType.
 * If the logType is not valid, the logger remains silent.
 */
Logger.prototype._buildTraceTestRE = function() {
	var fixFlag = function(flag) { return Util.escapeRegExp(flag) + "(\\/|$)"; };

	var flagsArray = this._defaultLogLevels.map(fixFlag);
	if (this._env.conf.parsoid.debug) {
		flagsArray.push(fixFlag("debug"));
	}

	if (this._env.conf.parsoid.traceFlags !== null) {
		var escapedTraceFlags = this._env.conf.parsoid.traceFlags.map(Util.escapeRegExp);
		flagsArray.push("trace\/(" + escapedTraceFlags.join("|") + ")(\\/|$)");
	}

	return new RegExp(flagsArray.join("|"));
};

/**
 * @method
 *
 * Optional default backend.
 * @param {LogData} logData
 * @param {Function} cb Callback for async.parallel.
 */
Logger.prototype._defaultBackend = function(logData, cb) {
	try {
		var logType = logData.logType;
		var msg = logData.msg();
		if (/^(error|warning)(\/|$)/.test(logType)) {
			msg += "\n" + logData.locationMsg();
		}
		if (/(^(error|fatal)|(^|\/)stacktrace)(\/|$)/.test(logType)) {
			msg += "\n" + logData.stack();
		}
		console.warn(msg);
	} catch (e) {
		console.error("Error in defaultBackend: " + e);
		return;
	} finally {
		cb();
	}
};

/**
 * @method
 *
 * Gets all registered backends that apply to a particular logType.
 * @param {LogData} logData
 */
Logger.prototype._getApplicableBackends = function(logData) {
	var applicableBackends = [];
	var logType = logData.logType;
	if (this._backendRegExp && this._backendRegExp.test(logType)) {
		this._backends.forEach(function(value, key, backends) {
			if (key === logType || key.test(logType)) {
				applicableBackends.push(function(cb){
					try {
						backends.get(key)(logData, function(){
							cb(null);
						});
					} catch (e) {
						cb(null);
					}
				});
			}
		});
	}
	return applicableBackends;
};

/**
 * @method
 *
 * Routes log data to backends. If logType is fatal, exits process
 * after logging to all backends.
 * @param {LogData} logData
 * @param {Function} cb
 */
Logger.prototype._routeToBackends = function(logData, cb) {
	var applicableBackends = this._getApplicableBackends(logData);
	// If the logType is fatal, exits the process after logging
	// to all of the backends.
	// Additionally runs a callback that looks for fatal
	// events in the queue and logs them.
	async.parallel(applicableBackends, function(){
		if (/^fatal$/.test(logData.logType)) {
			process.exit(1);
		}
		cb();
	});
};


if (typeof module === "object") {
	module.exports.Logger = Logger;
}
