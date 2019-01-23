/** @module */

'use strict';

const TokenHandler = require('./TokenHandler.js');
const lastItem = require('../../utils/jsutils.js').JSUtils.lastItem;
const { TagTk, EndTagTk, SelfclosingTagTk, EOFTk } = require('../../tokens/TokenTypes.js');

/**
 * Small utility class that encapsulates the common 'collect all tokens
 * starting from a token of type x until token of type y or (optionally) the
 * end-of-input'. Only supported for synchronous in-order transformation
 * stages (SyncTokenTransformManager), as async out-of-order expansions
 * would wreak havoc with this kind of collector.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class TokenCollector extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		this.onAnyEnabled = false;
		this.scopeStack = [];
	}

	onTag(token) {
		return token.name === this.NAME() ? this._onDelimiterToken(token) : token;
	}

	onEnd(token) {
		return this.onAnyEnabled ? this._onDelimiterToken(token) : token;
	}

	onAny(token) {
		return this._onAnyToken(token);
	}

	// Token type to register for ('tag', 'text' etc)
	TYPE() { throw new Error('Not implemented'); }
	// (optional, only for token type 'tag'): tag name.
	NAME() { throw new Error('Not implemented'); }
	// Match the 'end' tokens as closing tag as well (accept unclosed sections).
	TOEND() { throw new Error('Not implemented'); }
	// FIXME: Document this!?
	ACKEND() { throw new Error('Not implemented'); }

	// Transform function
	transformation() {
		console.assert(false, 'Transformation not implemented!');
	}

	/**
	 * Handle the delimiter token.
	 * XXX: Adjust to sync phase callback when that is modified!
	 * @private
	 */
	_onDelimiterToken(token) {
		var haveOpenTag = this.scopeStack.length > 0;
		var tc = token.constructor;
		if (tc === TagTk) {
			if (this.scopeStack.length === 0) {
				this.onAnyEnabled = true;
				// Set up transforms
				this.manager.env.log('debug', 'starting collection on ', token);
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
			this.manager.env.log('debug', 'finishing collection on ', token);

			// Pop top scope and push token onto it
			var activeTokens = this.scopeStack.pop();
			activeTokens.push(token);

			// clean up
			if (this.scopeStack.length === 0 || token.constructor === EOFTk) {
				this.onAnyEnabled = false;
			}

			if (tc === EndTagTk) {
				// Transformation can be either sync or async, but receives all collected
				// tokens instead of a single token.
				return this.transformation(activeTokens);
				// XXX sync version: return tokens
			} else {
				// EOF -- collapse stack!
				var allToks = [];
				for (var i = 0, n = this.scopeStack.length; i < n; i++) {
					allToks = allToks.concat(this.scopeStack[i]);
				}
				allToks = allToks.concat(activeTokens);

				var res = this.TOEND() ? this.transformation(allToks) : { tokens: allToks };
				if (res.tokens && res.tokens.length &&
						lastItem(res.tokens).constructor !== EOFTk) {
					this.manager.env.log("error", this.NAME(), "handler dropped the EOFTk!");

					// preserve the EOFTk
					res.tokens.push(token);
				}

				return res;
			}
		} else {
			// EndTagTk should be the only one that can reach here.
			console.assert(token.constructor === EndTagTk, "Expected an end tag.");
			if (this.ACKEND()) {
				return this.transformation([ token ]);
			} else {
				// An unbalanced end tag. Ignore it.
				return { tokens: [ token ] };
			}
		}
	}

	/**
	 * Handle 'any' token in between delimiter tokens. Activated when
	 * encountering the delimiter token, and collects all tokens until the end
	 * token is reached.
	 * @private
	 */
	_onAnyToken(token) {
		// Simply collect anything ordinary in between
		lastItem(this.scopeStack).push(token);
		return { };
	}
}

if (typeof module === "object") {
	module.exports.TokenCollector = TokenCollector;
}
