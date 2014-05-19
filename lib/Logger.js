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

	// Set up regular expressions so that logTypes can be registered with
	// backends, and so that logData can be routed to the right backends.
	// Default: matches empty string only
	this._testAllRE = new RegExp(/^$/);
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
		// Tests whether logType matches any of the applicable logTypes
		// (including those set on env and the ones set via command line).
		if (this._testAllRE.test(logType)) {
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
			// We weren't already processing a request, so processingLogRequest flag
			// is set to true. Then we send the logData to appropriate backends and
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
	var backendArray = [];
	var logTypeString;

	// Convert logType into a source string for a regExp that we can
	// subsequently use to test logTypes passed in from Logger.log.
	if (logType instanceof RegExp) {
		logTypeString = logType.source;
	} else if (typeof(logType) === 'string') {
		logTypeString = "^" + Util.escapeRegExp(logType) + "$";
	} else {
		console.warn("LogType is neither a regular expression nor a string.");
		return;
	}

	// If we've already started an array of backends for this logType,
	// add this backend to the array; otherwise, start a new array
	// consisting of this backend.
	if (!this._backends.has(logTypeString)) {
		backendArray.push(backend);
	} else {
		backendArray = this._backends.get(logTypeString);
		if (backendArray.indexOf(backend) === -1) {
			backendArray.push(backend);
		}
	}
	this._backends.set(logTypeString, backendArray);

	// Update the global test RE
	this._testAllRE = new RegExp(this._testAllRE.source + "|" + logTypeString);
};

Logger.prototype.registerDefaultBackend = function(logType) {
	this.registerBackend(logType, this._defaultBackend);
};

Logger.prototype.registerTracer = function(logType) {
	this.registerBackend(logType, this._defaultTracerBackend);
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
		console.warn( logData.fullMsg() );
	} catch (e) {
		console.error("Error in defaultBackend: " + e);
		return;
	} finally {
		cb();
	}
};

var prettyLogTypeMap = {
	"trace/peg":        "[peg]",
	"trace/pre":        "[PRE]",
	"debug/pre":        "[PRE-DBG]",
	"trace/p-wrap":     "[P]",
	"trace/html":       "[HTML]",
	"debug/html":       "[HTML-DBG]",
	"trace/tsp":        "[TSP]",
	"trace/dsr":        "[DSR]",
	"trace/list":       "[LIST]",
	"trace/sync:1":     "[S1]",
	"trace/async:2":    "[A2]",
	"trace/sync:3":     "[S3]",
	"trace/wts":        "[WTS]",
	"debug/wts/sep":    "[SEP]",
	"trace/selser":     "[SELSER]",
	"trace/domdiff":    "[DOM-DIFF]",
	"trace/wt-escape":  "[wt-esc]"
};

/**
 * @method
 *
 * Optional default tracing and debugging backend.
 * @param {LogData} logData
 * @param {Function} cb Callback for async.parallel.
 */
Logger.prototype._defaultTracerBackend = function(logData, cb) {
	try {
		var msg = '';
		var typeColumnWidth = 15;
		var logType = logData.logType;
		var firstArg = Array.isArray(logData.logObject) ? logData.logObject[0] : null;

		// Assume first numeric arg is always the pipeline id
		if (typeof firstArg === 'number') {
			msg = firstArg + "-";
			logData.logObject.shift();
		}

		var level = logType.match(/\//g).length - 1;
		var prettyLogType = prettyLogTypeMap[logType];
		var indent = '  '.repeat(level);

		// indent by number of slashes
		msg += indent;
		if (prettyLogType) {
			msg += prettyLogType;
		} else {
			// XXX: could shorten or strip trace/ logType prefix in a pure
			// trace logger
			msg += logType;

			// More space for these log types
			typeColumnWidth = 30;
		}

		// Fixed-width type column so that the messages align
		msg = msg.substr(0, typeColumnWidth);
		msg += ' '.repeat(typeColumnWidth - msg.length);
		msg += '| ' + indent + logData.msg();

		if (msg) {
			console.warn(msg);
		}
	} catch (e) {
		console.error("Error in tracerBackend: " + e);
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
	var savedBackends = this._backends;

	// Pulls out any backendArrays corresponding to the logType
	savedBackends.forEach(function(backendArray, logTypeString) {
		// Convert the stored logTypeString back into a regExp, in case
		// it applies to multiple logTypes (e.g. /fatal|error/).
		if (new RegExp(logTypeString).test(logType)) {
			// Extracts relevant backends and pushes them onto applicableBackends
			backendArray.forEach( function(backend) { applicableBackends.push(function(cb){
					try {
						backend(logData, function(){
							cb(null);
						});
					} catch (e) {
						cb(null);
					}
				});
			});
		}
	});
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
