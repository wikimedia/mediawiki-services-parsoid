"use strict";
require('./core-upgrade.js');

var util = require('util');

/**
 * Consolidates logging data into a single flattened
 * object (flatLogObject) and exposes various methods
 * that can be used by backends to generate message
 * strings (e.g., stack trace).
 *
 * @class
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} logType Type of log being generated.
 * @param {object} logObject Data being logged.
 */
var LogData = function (env, logType, logObject) {
	this.logType = logType;
	this.logObject = logObject;
	this._error = logObject instanceof Error ? logObject : new Error();

	this._env = env;
	// Cache log information if previously constructed.
	this._cache = {};
};

/**
 * @method
 *
 * Generate a full message string consisting of a message,
 * location, and stack trace.
 */
LogData.prototype.fullMsg = function(){
	if (this._cache.fullMsg === undefined) {
		var messageString = this.locationMsg() + ' ' + this.msg();

		// Stack traces only for error & fatal
		// FIXME: This should be configurable later on.
		if (/^(error|fatal)(\/|$)?/.test(this.logType) && this.stack()) {
			messageString += '\n' + this.stack();
		}

		this._cache.fullMsg = messageString;
	}
	return this._cache.fullMsg;
};

/**
 * @method
 *
 * Generate a message string that combines all of the
 * logObject's message fields (if an originally an object)
 * or strings (if originally an array of strings)
 */
LogData.prototype.msg = function() {
	if (this._cache.msg === undefined) {
		this._cache.msg = this.flatLogObject().msg;
	}
	return this._cache.msg;
};

/**
 * @method
 *
 * Generate a message string with information about the wiki
 * page in which the log occurred.
 */
LogData.prototype.locationMsg = function() {
	if (this._cache.locationMsg === undefined) {
		this._cache.locationMsg = this._announceLocation();
	}
	return this._cache.locationMsg;
};

LogData.prototype._getStack = function() {
	// Save original Error.prepareStackTrace
	var origPrepareStackTrace = Error.prepareStackTrace;

	// Override with function that just returns `stack`
	Error.prepareStackTrace = function (_, stack) {
		return stack;
	};

	// Create a new `Error`, which automatically gets `stack`
	var stack = this._error.stack;

	// Restore original `Error.prepareStackTrace`
	Error.prepareStackTrace = origPrepareStackTrace;

	// Remove superfluous function calls on stack
	stack = 'Stack:\n  ' + stack.slice(2).join('\n  ');

	return stack;
};

/**
 * @method
 *
 * Generates a message string with a stack trace. Uses the
 * flattened logObject's stack trace if it exists; otherwise,
 * creates a new stack trace.
 */
LogData.prototype.stack = function(){
	if (this._cache.stack === undefined) {
		this._cache.stack = this.flatLogObject().stack === undefined
			? this._getStack() : this.flatLogObject().stack;
	}
	return this._cache.stack;
};


/**
 * @method
 *
 * Flattens the logObject array into a single object for access
 * by backends.
 */
LogData.prototype.flatLogObject = function() {
	if (this._cache.flatLogObject === undefined) {
		this._cache.flatLogObject = this._flatten(this.logObject, 'top level');
	}
	return this._cache.flatLogObject;
};

/**
 * @method
 *
 * Returns a flattened object with an arbitrary number of fields,
 * including "msg" (for the message, if any) and "stack" (for the
 * stack trace, if any)
 *
 * @param {Object} o Data being logged
 * @param {String} topLevel
 */
LogData.prototype._announceLocation = function () {
	if ( !this._env ) {
		return "";
	}
	var location = '[' + this.logType + '][' + this._env.conf.wiki.iwp + '/' + this._env.page.name;
	if (this._env.page.meta &&
		this._env.page.meta.revision &&
		this._env.page.meta.revision.revid) {
		location += '?oldid=' + this._env.page.meta.revision.revid;
	}
	return location + ']';
};


/**
 * @method
 *
 * Returns a flattened object with an arbitrary number of fields,
 * including "msg" (combining all "msg" fields and strings from
 * underlying objects) and "stack" (a stack trace, if any)
 *
 * @param {Object} o Object to flatten
 * @param {String} topLevel Separate top-level from recursive calls.
 */
LogData.prototype._flatten = function(o, topLevel) {
	var f, stack, msg, longMsg,
	self = this;

	if ( typeof(o) === 'undefined' || o === null ) {
		return { msg: '' };
	} else if ( Array.isArray(o) && topLevel ) {
		// flatten components, but no longer in a top-level context.
		f = o.map(function(oo) { return self._flatten(oo); });
		// join all the messages with spaces or newlines between them.
		var tobool = function(x) { return !!x; };
		msg = f.map(function(oo) { return oo.msg; }).filter(tobool).
		join(' ');
		longMsg = f.map(function(oo) { return oo.msg; }).filter(tobool).
		join('\n');
		// merge all custom fields
		f = f.reduce(function(prev, oo) {
			return Object.assign(prev, oo);
		}, {});
		return Object.assign(f, {
			msg: msg,
			longMsg: longMsg
		});
	} else if (o instanceof Error) {
		f = { msg: o.message, stack: o.stack };
		if ( o.code ) {
			f.code = o.code;
		}
		return f;
	} else if (typeof(o)==='function') {
		return self._flatten(o());
	} else if (typeof (o) === 'object' && o.hasOwnProperty('msg')) {
		return o;
	} else if ( typeof(o) === 'string' ) {
		return { msg: o };
	} else {
		return { msg: JSON.stringify(o)};
	}
};

if (typeof module === "object") {
	module.exports.LogData = LogData;
}
