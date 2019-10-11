/** @module */

'use strict';

const { JSUtils } = require('../../utils/jsutils.js');
const { NlTk, EOFTk } = require('../../tokens/TokenTypes.js');

/**
 * @class
 */
module.exports = class TokenHandler {
	/**
	 * @param {TokenTransformManager} manager
	 *   The manager for this stage of the parse.
	 * @param {Object} options
	 *   Any options for the expander.
	 */
	constructor(manager, options) {
		this.manager = manager;
		this.env = manager.env;
		this.options = options;
		this.atTopLevel = false;

		// This is set if the token handler is disabled for the entire pipeline.
		this.disabled = false;

		// This is set/reset by the token handlers at various points
		// in the token stream based on what is encountered.
		// This only enables/disables the onAny handler.
		this.onAnyEnabled = true;
	}

	/**
	 * This handler is called for EOF tokens only
	 * @param {EOFTk} token EOF token to be processed
	 * @return {Object}
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skipOnAny: .. }
	 *    if 'skipOnAny' is set, onAny handler is skipped
	 */
	onEnd(token) { return token; }

	/**
	 * This handler is called for newline tokens only
	 * @param {NlTk} token Newline token to be processed
	 * @return {Object}
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skipOnAny: .. }
	 *    if 'skipOnAny' is set, onAny handler is skipped
	 */
	onNewline(token) { return token; }

	/**
	 * This handler is called for tokens that are not EOFTk or NLTk tokens.
	 * The handler may choose to process only specific kinds of tokens.
	 * For example, a list handler may only process 'listitem' TagTk tokens.
	 *
	 * @param {Token} token Token to be processed
	 * @return {Object}
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skipOnAny: .. }
	 *    if 'skipOnAny' is set, onAny handler is skipped
	 */
	onTag(token) { return token; }

	/**
	 * This handler is called for *all* tokens in the token stream except if
	 * (a) The more specific handlers above modified the token
	 * (b) the more specific handlers (onTag, onEnd, onNewline) have set
	 *     the skip flag in their return values.
	 * (c) this handlers 'onAnyEnabled' flag is set to false (can be set by any
	 *     of the handlers).
	 *
	 * @param {Token} token Token to be processed
	 * @return {Object}
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skipOnAny: .. }
	 */
	onAny(token) { return token; }

	/**
	 * Reset pipeline state (since pipelines are shared)
	 * @param {Object} opts Reset options
	 */
	resetState(opts) { this.atTopLevel = opts && opts.toplevel; }

	/* -------------------------- PORT-FIXME ------------------------------
	 * Once ported to PHP, we should benchmark a version of this function
	 * without any of the tracing code in it. There are upto 4 untaken branches
	 * that are executed in the hot loop for every single token. Unlike V8,
	 * this code will not be JIT-ted to eliminate that overhead.
	 *
	 * In the common case where tokens come through functions unmodified
	 * because of hitting default identity handlers, these 4 extra branches
	 * could potentially amount to something. That might be partially ameliorated
	 * by the fact that most modern processors have branch prediction and these
	 * branches will always fail and so might not be such a big deal.
	 *
	 * In any case, worth a performance test after the port.
	 * -------------------------------------------------------------------- */
	/**
	 * Push an input array of tokens through the transformer
	 * and return the transformed tokens
	 *
	 * @param {Object} env Parser Environment
	 * @param {Array} tokens The array of tokens to process
	 * @param {Object} traceState Tracing related state
	 * @return {Array} the array of transformed tokens
	 */
	processTokensSync(env, tokens, traceState) {
		const traceFlags = traceState && traceState.traceFlags;
		const traceTime = traceState && traceState.traceTime;
		let accum = [];
		while (tokens.length > 0) {
			const token = tokens.shift();

			if (traceFlags) {
				traceState.tracer(token, this);
			}

			let res, resTokens;
			if (traceTime) {
				const s = JSUtils.startTime();
				let traceName;
				if (token.constructor === NlTk) {
					res = this.onNewline(token);
					traceName = traceState.traceNames[0];
				} else if (token.constructor === EOFTk) {
					res = this.onEnd(token);
					traceName = traceState.traceNames[1];
				} else if (token.constructor !== String) {
					res = this.onTag(token);
					traceName = traceState.traceNames[2];
				} else {
					res = token;
				}
				if (traceName) {
					const t = JSUtils.elapsedTime(s);
					env.bumpTimeUse(traceName, t, "TT");
					env.bumpCount(traceName);
					traceState.tokenTimes += t;
				}
			} else {
				if (token.constructor === NlTk) {
					res = this.onNewline(token);
				} else if (token.constructor === EOFTk) {
					res = this.onEnd(token);
				} else if (token.constructor !== String) {
					res = this.onTag(token);
				} else {
					res = token;
				}
			}

			let modified = false;
			if (res !== token &&
				(!res.tokens || res.tokens.length !== 1 || res.tokens[0] !== token)
			) {
				resTokens = res.tokens;
				modified = true;
			}

			if (!modified && !res.skipOnAny && this.onAnyEnabled) {
				if (traceTime) {
					const s = JSUtils.startTime();
					const traceName = traceState.traceNames[3];
					res = this.onAny(token);
					const t = JSUtils.elapsedTime(s);
					env.bumpTimeUse(traceName, t, "TT");
					env.bumpCount(traceName);
					traceState.tokenTimes += t;
				} else {
					res = this.onAny(token);
				}
				if (res !== token &&
					(!res.tokens || res.tokens.length !== 1 || res.tokens[0] !== token)
				) {
					resTokens = res.tokens;
					modified = true;
				}
			}

			if (!modified) {
				accum.push(token);
			} else if (resTokens && resTokens.length) {
				accum = accum.concat(resTokens);
			}
		}

		return accum;
	}
};
