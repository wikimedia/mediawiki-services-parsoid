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
	}

	/**
	 */
	resetState(opts) {
		this.atTopLevel = opts && opts.toplevel;
	}
};
