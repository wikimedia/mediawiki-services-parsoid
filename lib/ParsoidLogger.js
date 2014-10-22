"use strict";

var Logger = require ('./Logger.js').Logger,
	LogData = require('./LogData.js').LogData,
	Util = require( './mediawiki.Util.js' ).Util,
	coreutil = require('util');

function ParsoidLogger(env) {
	this.env = env;
	Logger.apply(this, {});

	// Set up a location message function in Logdata
	// so all logging backends can output location message
	var logger = this;
	LogData.prototype.locationMsg = function() { return logger.locationMsg(this); };
}

coreutil.inherits(ParsoidLogger, Logger);

ParsoidLogger.prototype.getDefaultBackend = function() {
	return this._defaultBackend.bind(this);
};

ParsoidLogger.prototype.getDefaultTracerBackend = function() {
	return this._defaultTracerBackend.bind(this);
};

ParsoidLogger.prototype.registerLoggingBackends = function(defaultLogLevels, parsoidConfig, linter) {
	// Register a default backend based on default logTypes.
	// DEFAULT: Combine all regexp-escaped default logTypes into a single regexp.
	var fixLogType = function(logType) { return Util.escapeRegExp(logType) + "(\\/|$)"; };
	var defaultRE = new RegExp((defaultLogLevels || []).map(fixLogType).join("|"));
	var loggerBackend;
	if (typeof(parsoidConfig.loggerBackend) === 'function') {
		loggerBackend = parsoidConfig.loggerBackend;
	} else if (parsoidConfig.loggerBackend && parsoidConfig.loggerBackend.name) {
		var parts = parsoidConfig.loggerBackend.name.split( '/' );
		// use a leading colon to indicate a parsoid-local logger.
		var ClassObj = require( parts.shift().replace( /^:/, './' ) );
		parts.forEach( function( k ) {
			ClassObj = ClassObj[k];
		} );
		loggerBackend = new ClassObj( parsoidConfig.loggerBackend.options ).
			getLogger();
	} else {
		loggerBackend = this.getDefaultBackend();
	}
	this.registerBackend(defaultRE, loggerBackend);

	// TRACE / DEBUG: Make trace / debug regexp with appropriate postfixes,
	// depending on the command-line options passed in.
	function buildTraceOrDebugFlag(parsoidFlags, logType) {
		if (Array.isArray(parsoidFlags)) {
			var escapedFlags = parsoidFlags.map(Util.escapeRegExp);
			var combinedFlag = logType + "\/(" + escapedFlags.join("|") + ")(\\/|$)";
			return new RegExp(combinedFlag);
		} else {
			return null;
		}
	}

	// Register separate backend for tracing / debugging events.
	// Tracing and debugging use the same backend for now.
	var tracerBackend = (typeof(parsoidConfig.tracerBackend) === 'function') ?
					parsoidConfig.tracerBackend : this.getDefaultTracerBackend();
	if (parsoidConfig.traceFlags) {
		this.registerBackend(buildTraceOrDebugFlag(parsoidConfig.traceFlags, "trace"),
			tracerBackend);
	}
	if (parsoidConfig.debugFlags) {
		this.registerBackend(buildTraceOrDebugFlag(parsoidConfig.debugFlags, "debug"),
			tracerBackend);
	}
	if (parsoidConfig.linting){
		this.registerBackend(/lint(\/.*)?/, linter.linterBackend.bind(linter));
		this.registerBackend(/end(\/.*)/, linter.logLintOutput.bind(linter));
	}
};

ParsoidLogger.prototype.locationMsg = function(logData) {
	var location = '[' + this.env.conf.wiki.iwp + '/' + this.env.page.name;
	var meta = this.env.page.meta;
	if (meta && meta.revision && meta.revision.revid) {
		location += '?oldid=' + meta.revision.revid;
	}
	return location + ']';
};

ParsoidLogger.prototype._defaultBackend = function(logData, cb) {
	// The default logging backend provided by Logger.js is not useful to us.
	// Parsoid needs to be able to emit page location to logs.
	try {
		console.warn('[' + logData.logType + ']' + logData.locationMsg() + ' ' + logData.fullMsg());
	} catch(e){
		console.error("Error in ParsoidLogger._defaultBackend: " + e);
	} finally{
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

ParsoidLogger.prototype._defaultTracerBackend = function(logData, cb) {
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

		// indent by number of slashes
		var level = logType.match(/\//g).length - 1;
		var indent = '  '.repeat(level);
		msg += indent;

		var prettyLogType = prettyLogTypeMap[logType];
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
		console.error("Error in ParsoidLogger._defaultTracerBackend: " + e);
		return;
	} finally {
		cb();
	}
};

if (typeof module === "object") {
	module.exports.ParsoidLogger = ParsoidLogger;
}
