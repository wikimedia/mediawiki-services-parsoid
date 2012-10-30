"use strict";
/**
 * Small utility class that encapsulates the common 'collect all tokens
 * starting from a token of type x until token of type y or (optionally) the
 * end-of-input'. Only supported for synchronous in-order transformation
 * stages (SyncTokenTransformManager), as async out-of-order expansions
 * would wreak havoc with this kind of collector.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 * @author Subramanya Sastry <ssastry@wikimedia.org>
 *
 * Calls the passed-in callback with the collected tokens.
 */

/**
 * @class
 * @constructor
 * @param {Object} SyncTokenTransformManager to register with
 * @param {Function} Transform function, called like this:
 *   transform( tokens, cb, manager ) with
 *      tokens: chunk of tokens
 *      cb: function, returnTokens ( tokens, notYetDone ) with notYetDone
 *      indicating the last chunk of an async return.
 *      manager: TokenTransformManager, provides the args etc.
 * @param {Boolean} Match the 'end' tokens as closing tag as well (accept
 * unclosed sections).
 * @param {Nummber} Numerical rank of the tranform
 * @param {String} Token type to register for ('tag', 'text' etc)
 * @param {String} (optional, only for token type 'tag'): tag name.
 */

function TokenCollector ( manager, transformation, toEnd, rank, type, name ) {
	this.transformation = transformation;
	this.manager = manager;
	this.rank = rank;
	this.type = type;
	this.name = name;
	this.toEnd = toEnd;
	this.scopeStack = [];
	manager.addTransform( this._onDelimiterToken.bind( this ), "TokenCollector:_onDelimiterToken", rank, type, name );
}

/**
 * Register any collector with slightly lower priority than the start/end token type
 * XXX: This feels a bit hackish, a list-of-registrations per rank might be
 * better.
 */
TokenCollector.prototype._anyDelta = 0.00001;


/**
 * Handle the delimiter token.
 * XXX: Adjust to sync phase callback when that is modified!
 */
TokenCollector.prototype._onDelimiterToken = function ( token, frame, cb ) {
	var haveOpenTag = this.scopeStack.length > 0;
	var tc = token.constructor;
	if (tc === TagTk) {
		if (this.scopeStack.length === 0) {
			// Set up transforms
			this.manager.env.dp( 'starting collection on ', token );
			this.manager.addTransform( this._onAnyToken.bind ( this ),"TokenCollector:_onAnyToken",
					this.rank + this._anyDelta, 'any' );
			this.manager.addTransform( this._onDelimiterToken.bind( this ),"TokenCollector:_onDelimiterToken:end",
					this.rank, 'end' );
		}

		// Push a new scope
		var newScope = [];
		this.scopeStack.push(newScope);
		newScope.push(token);

		return { };
	} else if (tc === SelfclosingTagTk) {
		// Nothing to do -- just pass it along.
		this.manager.env.dp( 'skipping collection on ', token );
		return { tokens: [ token ] }; //this.transformation( [token, token] );
	} else if (haveOpenTag) {
		// EOFTk or EndTagTk
		this.manager.env.dp( 'finishing collection on ', token );

		// Pop top scope and push token onto it
		var activeTokens = this.scopeStack.pop();
		activeTokens.push(token);

		// clean up
		if (this.scopeStack.length === 0 || token.constructor === EOFTk) {
			this.manager.removeTransform( this.rank + this._anyDelta, 'any' );
			this.manager.removeTransform( this.rank, 'end' );
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

			return this.toEnd ? this.transformation(allToks) : { tokens: allToks };
		}
	} else {
		// EOFTk or  EndTagTk
		// EOFTk is okay, but EndTagTk is an error (ignoring error!)
		return { tokens: [ token ] }; //this.transformation( [token, token] );
	}
};

/**
 * Handle 'any' token in between delimiter tokens. Activated when
 * encountering the delimiter token, and collects all tokens until the end
 * token is reached.
 */
TokenCollector.prototype._onAnyToken = function ( token, frame, cb ) {
	// Simply collect anything ordinary in between
	this.scopeStack[this.scopeStack.length-1].push( token );
	return { };
};


if (typeof module === "object") {
	module.exports.TokenCollector = TokenCollector;
}
