/** @module */

'use strict';

require('../../core-upgrade.js');

var LogData = require('./LogData.js').LogData;
var Promise = require('../utils/promise.js');
var JSUtils = require('../utils/jsutils.js').JSUtils;

/**
 * Multi-purpose logger. Supports different kinds of logging (errors,
 * warnings, fatal errors, etc.) and a variety of logging data (errors,
 * strings, objects).
 *
 * @class
 * @param {Object} [opts] Logger options (not used by superclass).
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
 * Outputs logging and tracing information to different backends.
 * @param {string} logType
 * @return {undefined|Promise} a {@link Promise} that will be fulfilled when all
 *  logging is complete; for efficiency `undefined` is returned if this
 *  `logType` is being ignored (the common case).
 */
Logger.prototype.log = function(logType) {
	try {
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
					// Array.from converts arguments to a real array
					// So that arguments can later be used in log.apply
					this._logRequestQueue.push(Array.from(arguments));
					// Create a deferred, which will be resolved when this
					// data is finally logged.
					var d = Promise.defer();
					this._logRequestQueue.push(d);
					return d.promise;
				}
				return; // ignored
			} else {
				// We weren't already processing a request, so processingLogRequest flag
				// is set to true. Then we send the logData to appropriate backends and
				// process any fatal log events that we find on the queue.
				this.processingLogRequest = true;
				// Callback to routeToBackends forces logging of fatal log events.
				var p = this._routeToBackends(logData);
				this.processingLogRequest = false;
				if (this._logRequestQueue.length > 0) {
					var args = this._logRequestQueue.pop();
					var dd = this._logRequestQueue.pop();
					this.log.apply(this, args).then(dd.resolve, dd.reject);
				}
				return p; // could be undefined, if no backends handled this
			}
		}
	} catch (e) {
		console.log(e.message);
		console.log(e.stack);
	}
	return; // nothing handled this log type
};

/**
 * Convert logType into a source string for a regExp that we can
 * subsequently use to test logTypes passed in from Logger.log.
 * @param {RegExp} logType
 * @return {string}
 * @private
 */
function logTypeToString(logType) {
	var logTypeString;
	if (logType instanceof RegExp) {
		logTypeString = logType.source;
	} else if (typeof (logType) === 'string') {
		logTypeString = '^' + JSUtils.escapeRegExp(logType) + '$';
	} else {
		throw new Error('logType is neither a regular expression nor a string.');
	}
	return logTypeString;
}

/**
 * Logger backend.
 * @callback module:logger/Logger~backendCallback
 * @param {LogData} logData The data to log.
 * @return {Promise} A {@link Promise} that is fulfilled when logging of this
 *  `logData` is complete.
 */

/**
 * Registers a backend by adding it to the collection of backends.
 * @param {RegExp} logType
 * @param {backendCallback} backend Backend to send logging / tracing info to.
 */
Logger.prototype.registerBackend = function(logType, backend) {
	var backendArray = [];
	var logTypeString = logTypeToString(logType);

	// If we've already started an array of backends for this logType,
	// add this backend to the array; otherwise, start a new array
	// consisting of this backend.
	if (this._backends.has(logTypeString)) {
		backendArray = this._backends.get(logTypeString);
	}
	if (backendArray.indexOf(backend) === -1) {
		backendArray.push(backend);
	}
	this._backends.set(logTypeString, backendArray);

	// Update the global test RE
	this._testAllRE = new RegExp(this._testAllRE.source + "|" + logTypeString);
};

/**
 * Register sampling rates, in percent, for log types.
 * @param {RegExp} logType
 * @param {number} percent
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

/** @return {backendCallback} */
Logger.prototype.getDefaultBackend = function() {
	return logData => this._defaultBackend(logData);
};

/** @return {backendCallback} */
Logger.prototype.getDefaultTracerBackend = function() {
	return logData => this._defaultTracerBackend(logData);
};

/**
 * Optional default backend.
 * @method
 * @param {LogData} logData
 * @return {Promise} Promise which is fulfilled when logging is complete.
 */
Logger.prototype._defaultBackend = Promise.async(function *(logData) { // eslint-disable-line require-yield
	// Wrap in try-catch-finally so we can more accurately
	// pin backend crashers on specific logging backends.
	try {
		console.warn('[' + logData.logType + '] ' + logData.fullMsg());
	} catch (e) {
		console.error("Error in Logger._defaultBackend: " + e);
	}
});

/**
 * Optional default tracing and debugging backend.
 * @method
 * @param {LogData} logData
 * @return {Promise} Promise which is fulfilled when logging is complete.
 */
Logger.prototype._defaultTracerBackend = Promise.async(function *(logData) { // eslint-disable-line require-yield
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
	}
});

/**
 * Gets all registered backends that apply to a particular logType.
 * @param {LogData} logData
 * @return {Generator.<backendCallback>}
 */
Logger.prototype._getApplicableBackends = function *(logData) {
	var logType = logData.logType;
	var backendsMap = this._backends;
	var logTypeString;
	for (logTypeString of backendsMap.keys()) {
		// Convert the stored logTypeString back into a regExp, in case
		// it applies to multiple logTypes (e.g. /fatal|error/).
		if (new RegExp(logTypeString).test(logType)) {
			yield* backendsMap.get(logTypeString);
		}
	}
};

/**
 * Routes log data to backends. If `logData.logType` is fatal, exits process
 * after logging to all backends.
 * @param {LogData} logData
 * @return {Promise|undefined} A {@link Promise} that is fulfilled when all
 *   logging is complete, or `undefined` if no backend was applicable and
 *   the `logType` was not fatal (fast path common case).
 */
Logger.prototype._routeToBackends = function(logData) {
	var applicableBackends = Array.from(this._getApplicableBackends(logData));
	var noop = function() {};
	// fast path!
	if (applicableBackends.length === 0 && !/^fatal$/.test(logData.logType)) {
		return; // no promise allocated on fast path.
	}
	// If the logType is fatal, exits the process after logging
	// to all of the backends.
	// Additionally runs a callback that looks for fatal
	// events in the queue and logs them.
	return Promise.all(applicableBackends.map(function(backend) {
		var d = Promise.defer();
		var p = d.promise;
		var r;
		try {
			// For backward-compatibility, pass in a callback as the 2nd arg
			// (it should be ignored by current backends)
			r = backend(logData, d.resolve);
		} catch (e) {
			// ignore any exceptions thrown while calling 'backend'
		}
		// Backends *should* return a Promise... but for backward-compatibility
		// don't fret if they don't.
		if (r && typeof (r) === 'object' && r.then) {
			p = Promise.race([p, r]);
		}
		// The returned promise should always resolve, never reject.
		return p.catch(noop);
	})).finally(function() {
		if (/^fatal$/.test(logData.logType)) {
			// Give some time for async loggers to deliver the message
			setTimeout(function() { process.exit(1); }, 100);
		}
	});
};

if (typeof module === "object") {
	module.exports.Logger = Logger;
}
