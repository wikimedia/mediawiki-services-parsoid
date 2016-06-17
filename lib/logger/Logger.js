'use strict';
require('../../core-upgrade.js');

var async = require('async');
var LogData = require('./LogData.js').LogData;


/**
 * Multi-purpose logger. Supports different kinds of logging (errors,
 * warnings, fatal errors, etc.) and a variety of logging data (errors,
 * strings, objects).
 *
 * @class
 * @constructor
 * @param {Object} [opts]
 */
var Logger = function(opts) {
	if (!opts) { opts = {}; }

	this._opts = opts;
	this._logRequestQueue = [];
	this._backends = new Map();

	// Set up regular expressions so that logTypes can be registered with
	// backends, and so that logData can be routed to the right backends.
	// Default: matches empty string only
	this._testAllRE = new RegExp(/^$/);

	this._samplers = [];
	this._samplersRE = new RegExp(/^$/);
	this._samplersCache = new Map();
};

Logger.prototype._createLogData = function(logType, logObject) {
	return new LogData(logType, logObject);
};

/**
 * @method
 *
 * Outputs logging and tracing information to different backends.
 * @param {String} logType
 */
Logger.prototype.log = function(logType) {
	try {
		var self = this;

		// Potentially return early if we're sampling this log type.
		if (this._samplersRE.test(logType) &&
			!/^fatal/.test(logType)  // No sampling for fatals.
		) {
			if (!this._samplersCache.has(logType)) {
				var i = 0;
				var len = this._samplers.length;
				for (; i < len; i++) {
					var sample = this._samplers[i];
					if (sample.logTypeRE.test(logType)) {
						this._samplersCache.set(logType, sample.percent);
						break;  // Use the first applicable rate.
					}
				}
				console.assert(i < len,
					'Odd, couldn\'t find the sample rate for: ' + logType);
			}
			// This works because it's [0, 100)
			if ((Math.random() * 100) >= this._samplersCache.get(logType)) {
				return;
			}
		}

		// XXX this should be configurable.
		// Tests whether logType matches any of the applicable logTypes
		if (this._testAllRE.test(logType)) {
			var logObject = Array.prototype.slice.call(arguments, 1);
			var logData = this._createLogData(logType, logObject);
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
				this._routeToBackends(logData, function() {
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
 * Escape special regexp characters in a string used to build a regexp
 * @param {String} s
 * @return {String}
 */
function escapeRegExp(s) {
	return s.replace(/[\^\\$*+?.()|{}\[\]\/]/g, '\\$&');
}

/**
 * Convert logType into a source string for a regExp that we can
 * subsequently use to test logTypes passed in from Logger.log.
 * @param {RegExp} logType
 * @return {String}
 */
function logTypeToString(logType) {
	var logTypeString;
	if (logType instanceof RegExp) {
		logTypeString = logType.source;
	} else if (typeof (logType) === 'string') {
		logTypeString = '^' + escapeRegExp(logType) + '$';
	} else {
		throw new Error('logType is neither a regular expression nor a string.');
	}
	return logTypeString;
}

/**
 * @method
 *
 * Registers a backend by adding it to the collection of backends.
 * @param {RegExp} logType
 * @param {Function} backend Backend to send logging / tracing info to.
 */
Logger.prototype.registerBackend = function(logType, backend) {
	var backendArray = [];
	var logTypeString = logTypeToString(logType);

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

/**
 * @method
 *
 * Register sampling rates, in percent, for log types.
 * @param {RegExp} logType
 * @param {Number} percent
 */
Logger.prototype.registerSampling = function(logType, percent) {
	var logTypeString = logTypeToString(logType);
	percent = Number(percent);
	if (Number.isNaN(percent) || percent < 0 || percent > 100) {
		throw new Error('Sampling rate for ' + logType +
			' is not a percentage: ' + percent);
	}
	this._samplers.push({ logTypeRE: new RegExp(logTypeString), percent: percent });
	this._samplersRE = new RegExp(this._samplersRE.source + '|' + logTypeString);
};

Logger.prototype.getDefaultBackend = function() {
	return this._defaultBackend.bind(this);
};

Logger.prototype.getDefaultTracerBackend = function() {
	return this._defaultTracerBackend.bind(this);
};

/**
 * @method
 *
 * Optional default backend.
 * @param {LogData} logData
 * @param {Function} cb Callback for async.parallel.
 */
Logger.prototype._defaultBackend = function(logData, cb) {
	// Wrap in try-catch-finally so we can more accurately
	// pin backend crashers on specific logging backends.
	try {
		console.warn('[' + logData.logType + '] ' + logData.fullMsg());
	} catch (e) {
		console.error("Error in Logger._defaultBackend: " + e);
		return;
	} finally {
		cb();
	}
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
		var logType = logData.logType;

		// indent by number of slashes
		var indent = '  '.repeat(logType.match(/\//g).length - 1);
		// XXX: could shorten or strip trace/ logType prefix in a pure trace logger
		var msg = indent + logType;

		// Fixed-width type column so that the messages align
		var typeColumnWidth = 30;
		msg = msg.substr(0, typeColumnWidth);
		msg += ' '.repeat(typeColumnWidth - msg.length);
		msg += '| ' + indent + logData.msg();

		if (msg) {
			console.warn(msg);
		}
	} catch (e) {
		console.error("Error in Logger._defaultTracerBackend: " + e);
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
			backendArray.forEach(function(backend) { applicableBackends.push(function(cb) {
					try {
						backend(logData, function() { cb(null); });
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
	async.parallel(applicableBackends, function() {
		if (/^fatal$/.test(logData.logType)) {
			process.exit(1);
		}
		cb();
	});
};

if (typeof module === "object") {
	module.exports.Logger = Logger;
}
