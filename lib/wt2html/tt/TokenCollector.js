'use strict';

var coreutil = require('util');
var TokenHandler = require('./TokenHandler.js');
var defines = require('../parser.defines.js');
var JSUtils = require('../../utils/jsutils.js').JSUtils;

// define some constructor shortcuts
var EOFTk = defines.EOFTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;
var lastItem = JSUtils.lastItem;


/**
 * @class
 *
 * Small utility class that encapsulates the common 'collect all tokens
 * starting from a token of type x until token of type y or (optionally) the
 * end-of-input'. Only supported for synchronous in-order transformation
 * stages (SyncTokenTransformManager), as async out-of-order expansions
 * would wreak havoc with this kind of collector.
 *
 * @extends TokenHandler
 * @constructor
 */
function TokenCollector() {
	TokenHandler.apply(this, arguments);
}
coreutil.inherits(TokenCollector, TokenHandler);

// Numerical rank of the tranform.
TokenCollector.prototype.rank = null;

// Token type to register for ('tag', 'text' etc)
TokenCollector.prototype.type = null;

// (optional, only for token type 'tag'): tag name.
TokenCollector.prototype.name = null;

// Match the 'end' tokens as closing tag as well (accept unclosed sections).
TokenCollector.prototype.toEnd = null;

// FIXME: Document this!?
TokenCollector.prototype.ackEnd = null;

// Transform function
TokenCollector.prototype.transformation = function() {
	console.assert(false, 'Transformation not implemented!');
};

TokenCollector.prototype.init = function() {
	this.scopeStack = [];
	this.manager.addTransform(this._onDelimiterToken.bind(this),
		'TokenCollector:_onDelimiterToken', this.rank, this.type, this.name);
};

/**
 * Register any collector with slightly lower priority than the start/end token type
 * XXX: This feels a bit hackish, a list-of-registrations per rank might be
 * better.
 *
 * Don't make this delta much larger- could lead to conflicts in the
 * ExtensionContentCollector for example.
 * @private
 */
TokenCollector.prototype._anyDelta = 0.00000001;

/**
 * Handle the delimiter token.
 * XXX: Adjust to sync phase callback when that is modified!
 * @private
 */
TokenCollector.prototype._onDelimiterToken = function(token, frame, cb) {
	var haveOpenTag = this.scopeStack.length > 0;
	var tc = token.constructor;
	if (tc === TagTk) {
		if (this.scopeStack.length === 0) {
			// Set up transforms
			this.manager.env.dp('starting collection on ', token);
			this.manager.addTransform(this._onAnyToken.bind (this),
				'TokenCollector:_onAnyToken', this.rank + this._anyDelta, 'any');
			this.manager.addTransform(this._onDelimiterToken.bind(this),
				'TokenCollector:_onDelimiterToken:end', this.rank, 'end');
		}

		// Push a new scope
		var newScope = [];
		this.scopeStack.push(newScope);
		newScope.push(token);

		return { };
	} else if (tc === SelfclosingTagTk) {
		// We need to handle <ref /> for example, so call the handler.
		return this.transformation([token, token]);
	} else if (haveOpenTag) {
		// EOFTk or EndTagTk
		this.manager.env.dp('finishing collection on ', token);

		// Pop top scope and push token onto it
		var activeTokens = this.scopeStack.pop();
		activeTokens.push(token);

		// clean up
		if (this.scopeStack.length === 0 || token.constructor === EOFTk) {
			this.manager.removeTransform(this.rank + this._anyDelta, 'any');
			this.manager.removeTransform(this.rank, 'end');
		}

		if (tc === EndTagTk) {
			// Transformation can be either sync or async, but receives all collected
			// tokens instead of a single token.
			return this.transformation (activeTokens);
			// XXX sync version: return tokens
		} else {
			// EOF -- collapse stack!
			var allToks = [];
			for (var i = 0, n = this.scopeStack.length; i < n; i++) {
				allToks = allToks.concat(this.scopeStack[i]);
			}
			allToks = allToks.concat(activeTokens);

			var res = this.toEnd ? this.transformation(allToks) : { tokens: allToks };
			if (res.tokens && res.tokens.length &&
					lastItem(res.tokens).constructor !== EOFTk) {
				this.manager.env.log("error", this.name, "handler dropped the EOFTk!");

				// preserve the EOFTk
				res.tokens.push(token);
			}

			return res;
		}
	} else {
		// EndTagTk should be the only one that can reach here.
		console.assert(token.constructor === EndTagTk, "Expected an end tag.");
		if (this.ackEnd) {
			return this.transformation([ token ]);
		} else {
			// An unbalanced end tag. Ignore it.
			return { tokens: [ token ] };
		}
	}
};

/**
 * Handle 'any' token in between delimiter tokens. Activated when
 * encountering the delimiter token, and collects all tokens until the end
 * token is reached.
 * @private
 */
TokenCollector.prototype._onAnyToken = function(token, frame, cb) {
	// Simply collect anything ordinary in between
	lastItem(this.scopeStack).push(token);
	return { };
};


if (typeof module === "object") {
	module.exports.TokenCollector = TokenCollector;
}
