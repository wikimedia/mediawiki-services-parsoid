/** @module tokens/NlTk */

'use strict';

const Token = require('./Token.js').Token;

/**
 * Newline token.
 * @class
 * @extends ~Token
 */
class NlTk extends Token {
	/**
	 * @param {Array} tsr The TSR of the newline(s).
	 */
	constructor(tsr, da) {
		super();
		if (da) {
			/** @type {Object} */
			this.dataAttribs = da;
		} else if (tsr) {
			/** @type {Object} */
			this.dataAttribs = { tsr: tsr };
		}
	}

	/**
	 * Convert the token to JSON.
	 *
	 * @return {string} JSON string.
	 */
	toJSON() {
		return Object.assign({ type: 'NlTk' }, this);
	}
}

if (typeof module === "object") {
	module.exports = {
		NlTk: NlTk
	};
}
