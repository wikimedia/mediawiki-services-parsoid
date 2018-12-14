/** @module */

'use strict';

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
		this.switchedOff = false;

		// This is set/reset by the token handlers at various points
		// in the token stream based on what is encountered.
		// This only enables/disables the onAny handler.
		this.active = true;
	}

	/**
	 * This handler is called for EOF tokens only
	 * @param {EOFTk} token EOF token to be processed
	 * @return {Object}
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
	 */
	onEnd(token) { return token; }

	/**
	 * This handler is called for newline tokens only
	 * @param {NlTk} token Newline token to be processed
	 * @return {Object}
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
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
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
	 */
	onTag(token) { return token; }

	/**
	 * This handler is called for *all* tokens in the token stream except if
	 * (a) The more specific handlers above modified the token
	 * (b) the more specific handlers (onTag, onEnd, onNewline) have set
	 *     the skip flag in their return values.
	 * (c) this handlers 'active' flag is set to false (can be set by any
	 *     of the handlers).
	 *
	 * @param {Token} token Token to be processed
	 * @return {Object}
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 */
	onAny(token) { return token; }

	resetState(opts) { this.atTopLevel = opts && opts.toplevel; }
};
