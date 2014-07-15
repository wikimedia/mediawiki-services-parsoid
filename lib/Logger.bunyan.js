/*
 * A Parsoid Logger backend that uses node-bunyan to serialize log output.
 *
 * Configuration:
 * To use the bunyan logging backend, create a BunyanLogger in localsettings.js,
 * get its logger or its tracer and assign it to parsoidConfig.loggerBackend or
 * to parsoidConfig.tracerBackend.
 *
 * Example:
 *  // Require the module
 *	var bunyanLogger = require('../lib/Logger.bunyan.js'),
 *      // Create a new BunyanLogger, passing it the bunyan configuration
 *		logger = new bunyanLogger.BunyanLogger({
 *			name: 'Parsoid tests',
 *			level: 'trace',
 *			stream: process.stderr});
 *
 *	// getLogger returns a backend that will output a simple representation of
 *	// the logging data.
 *	parsoidConfig.loggerBackend = logger.getLogger();
 *	// getTracer returns a backend that also pulls in an Error if it was present
 * 	// in the log data, plus some more fields. Combine it with the
 *	// bunyan.stdSerializers.err serializer to get the Error object properly
 *	// formatted.
 *	parsoidConfig.tracerBackend = logger.getTracer();
 *
 */
"use strict";

var bunyan = require('bunyan');

function BunyanLogger(options) {
	this._logger = bunyan.createLogger(options);
}

/*
 * Analyze the log type (info, debug, etc.) and return the correct
 * function to call.
 */
BunyanLogger.prototype._getBunyanLogger = function(logData) {
	var logType = logData.logType,
		// Use info as default
		logger = this._logger.info;
	if (logType.match(/^fatal($|\/)/)) {
		logger = this._logger.fatal;
	} else if (logType.match(/^error($|\/)/)) {
		logger = this._logger.error;
	} else if (logType.match(/^warn($|\/)/)) {
		logger = this._logger.warn;
	} else if (logType.match(/^info($|\/)/)) {
		logger = this._logger.info;
	} else if (logType.match(/^trace($|\/)/)) {
		logger = this._logger.trace;
	} else if (logType.match(/^debug($|\/)/)) {
		logger = this._logger.debug;
	}

	return logger.bind(this._logger);
};

BunyanLogger.prototype._createBunyanLog = function (logData) {
	// TODO: We could improve the representation of the log data by flattening
	// it here in a more convinient format
	var log = {
		type: logData.logType,
		location: logData.locationMsg(),
	};
	return log;
};

BunyanLogger.prototype._log = function(logData, cb) {
	var logger = this._getBunyanLogger(logData),
		log = this._createBunyanLog(logData);
	logger(log, logData.msg());
	cb();
};

BunyanLogger.prototype.getLogger = function() {
	return this._log.bind(this);
};

BunyanLogger.prototype._trace = function(logData, cb) {
	var logger = this._getBunyanLogger(logData),
		log = this._createBunyanLog(logData),
		firstArg = Array.isArray(logData.logObject) ? logData.logObject[0] : null;

	// Assume first numeric arg is always the pipeline id
	if (typeof firstArg === 'number') {
		log.pipeline = firstArg;
	}

	log.fullMsg = logData.fullMsg();
	if (logData.logObject instanceof Error) {
		log.err = logData.logObject;
	} else {
		log.data = logData.logObject;
	}
	logger(log, logData.msg());
	cb();
};

BunyanLogger.prototype.getTracer = function() {
	return this._trace.bind(this);
};

if (typeof module === "object") {
	module.exports.BunyanLogger = BunyanLogger;
}
