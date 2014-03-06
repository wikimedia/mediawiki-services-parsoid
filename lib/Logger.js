"use strict";
require('./core-upgrade.js');

var Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js').DOMUtils,
	util = require('util'),
	defines = require('./mediawiki.parser.defines.js'),
	async = require('async');

/**
 *
 * Logs errors / warnings or prints out tracing output.
 *
 * @class
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {number} logLevel
 */

var Logger = function(env) {
	var self = this;
	this.env = env;
	this.logRequestQueue = [];
	this.backends = new Map();
	this.defaultLogLevels = ["error", "warning", "fatal"];
	this.traceTestRegExp = this.traceTest();
};

Logger.prototype.traceTest = function() {
	var traceTypes = "";
	var debugOn = "";
	var escapedTraceFlags;

	if (this.env.conf.parsoid.traceFlags !== null) {
		escapedTraceFlags = this.env.conf.parsoid.traceFlags.map(Util.escapeRegExp);
		traceTypes = "|trace\/(" + escapedTraceFlags.join("|") + ")";
	}

	if (this.env.conf.parsoid.debug) {
		debugOn = "|debug";
	}

	return new RegExp(this.defaultLogLevels.join("|") + traceTypes + debugOn);
};

Logger.prototype.changeLogLevels = function (newLogLevels) {
	this.defaultLogLevels = Array.prototype.slice.call(arguments);
	this.traceTestRegExp = this.traceTest();
};

Logger.prototype.defaultBackend = function(obj) {
	try {
		var messageString = obj.msg;
		if (obj.location) {
			messageString += "\n" + obj.location;
		}
		if (obj.stack) {
			messageString += "\n" + obj.stack;
		}
		console.warn( messageString );
	} catch (e) {
		return;
	}
};

Logger.prototype.registerBackend = function ( logType, backend ) {
	var logTypeString = logType instanceof RegExp ? logType.source : logType;

	if (!this.backends.has(logType)) {
		this.backends.set(logType, backend);

		if (!this.backendRegExp) {
			this.backendRegExp = new RegExp(logTypeString);
		} else {
			this.backendRegExp = new RegExp(this.backendRegExp.source + "|" +logTypeString);
		}
	}
};

Logger.prototype.flatten = function(o, topLevel) {
	// returns an object with two fields, "msg" (for the message, if any)
	// and "stack" (for the stack trace, if any)
	var f, msg, stack,
	self = this;

	if ( Array.isArray(o) && topLevel ) {
		// flatten components, but no longer in a top-level context.
		f = o.map(function(oo) { return self.flatten(oo); });
		// join all the messages with spaces between them.
		msg = f.map(function(oo) { return oo.msg; }).join(' ');
		// use the stack of the first item in the array with a stack
		stack = f.reduce(function(prev, oo) {
			return prev || oo.stack;
		}, undefined);
		return { msg: msg, stack: stack };
	} else if (o instanceof Error && o.code) {
			return { msg: o.toString(), stack: o.stack, code: o.code };
	} else if (o instanceof Error && !o.code) {
		return { msg: o.toString(), stack: o.stack };
	} else if (typeof(o)==='function') {
		f = this.flatten(o());
		return { msg: f.msg, stack: o.stack || f.stack };
	} else if (typeof(o)==='object' && o.hasOwnProperty('msg')) {
		f = this.flatten(o.msg);
		return { msg: f.msg, stack: o.stack || f.stack };
	} else if (typeof(o)==='string') {
		return { msg: o /* no stack */ };
	} else {
		return { msg: util.inspect(o) /* no stack */ };
	}
};

Logger.prototype.getApplicableBackends = function(logType, obj) {
	var applicableBackends = [];
	var self = this;
	var error;
	if (this.backendRegExp && this.backendRegExp.test(logType)) {
		this.backends.forEach(function(value, key, backends) {
			if (key === logType || key.test(logType)) {
				applicableBackends.push(function(callback){
					try {
						backends.get(key)(obj, function(){
							callback(null);
						});
					} catch (e) {
						error = { msg: "Backend crashed",
						stack: e.stack };
						self.defaultBackend(error);
						callback(null);
					}
				});
			}
		});
	}
	return applicableBackends;
};

Logger.prototype.routeToBackends = function(logType, obj, cb) {
	var applicableBackends = this.getApplicableBackends(logType, obj);
	var self = this;

	// If the logType is fatal, exits the process after logging
	// to all of the backends.
	// Additionally runs processFatalCB, which looks for fatal
	// events in the queue and logs them.
	async.parallel(applicableBackends, function(){
		if (/^fatal$/.test(logType)) {
			self.defaultBackend(obj);
			process.exit(1);
		} else {
			self.defaultBackend(obj);
		}
		cb();
	});
};

Logger.prototype.announceLocation = function (logType) {
	var location = logType + ' in ' + this.env.conf.wiki.iwp + ':' + this.env.page.name;
	if (this.env.page.revision && this.env.page.revision.revid) {
		location += ' with oldid: ' + this.env.page.revision.revid;
	}
	return location;
};

Logger.prototype.emitMessage = function (logType, logObject, callback) {
	var includeStackTrace = /(^(error|fatal)|(^|\/)stacktrace)(\/|$)/.test(logType);
	// XXX this should be configurable.
	var shouldAnnounceLocation = /^(error|warning)(\/|$)/.test(logType);

	// Gets everything that isn't logType
	var obj = this.flatten(logObject, 'top level');
	if (shouldAnnounceLocation) {
		obj.location = this.announceLocation(logType);
	}
	if (includeStackTrace && !obj.stack ) {
		obj.stack = new Error().stack;
	}
	this.routeToBackends(logType, obj, callback);
};

Logger.prototype.log = function (logType) {
	var self = this;

	// XXX this should be configurable.
	if (this.traceTestRegExp.test(logType)) {
		var logObject = Array.prototype.slice.call(arguments, 1);

		// If we are already processing a log request, but a log was generated
		// while processing the first request, processingLogRequest will be true.
		// We ignore all follow-on log events unless they are fatal. We put all
		// fatal log events on the logRequestQueue for processing later on.
		if (this.processingLogRequest) {
			if (/^fatal\/request$/.test(logType)) {
				// Array.prototype.slice.call converts arguments to a real array
				// So that arguments can later be used in log.apply
				this.logRequestQueue.push(Array.prototype.slice.call(arguments));
			}
			return;
		// We weren't already processing a request, so we set the processingLogReq
		// flag to true. Then we emit a message to the appropriate backends and
		// process any fatal log events that we find on the queue.
		} else {
			self.processingLogRequest = true;
			this.emitMessage(logType, logObject, function(){
				self.processingLogRequest = false;
				if (self.logRequestQueue.length > 0) {
					self.log.apply(self, self.logRequestQueue.pop());
				}
			});
		}
	}
};

if (typeof module === "object") {
	module.exports.Logger = Logger;
}