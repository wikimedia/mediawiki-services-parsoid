/** @module tokens/CommentTk */

'use strict';

const Token = require('./Token.js').Token;

/**
 * @class
 * @extends ~Token
 */
class CommentTk extends Token {
	/**
	 * @param {string} value
	 * @param {Object} dataAttribs data-parsoid object.
	 */
	constructor(value, dataAttribs) {
		super();
		/** @type {string} */
		this.value = value;
		// won't survive in the DOM, but still useful for token serialization
		if (dataAttribs !== undefined) {
			/** @type {Object} */
			this.dataAttribs = dataAttribs;
		}
	}

	toJSON() {
		return Object.assign({ type: 'CommentTk' }, this);
	}
}

if (typeof module === "object") {
	module.exports = {
		CommentTk: CommentTk
	};
}
