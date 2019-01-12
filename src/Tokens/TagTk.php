/** @module tokens/TagTk */

'use strict';

const Token = require('./Token.js').Token;

/**
 * HTML tag token.
 * @class
 * @extends ~Token
 */
class TagTk extends Token {
	/**
	 * @param {string} name
	 * @param {KV[]} attribs
	 * @param {Object} dataAttribs Data-parsoid object.
	 */
	constructor(name, attribs, dataAttribs) {
		super();
		/** @type {string} */
		this.name = name;
		/** @type {KV[]} */
		this.attribs = attribs || [];
		/** @type {Object} */
		this.dataAttribs = dataAttribs || {};
	}

	/**
	 * @return {string}
	 */
	toJSON() {
		return Object.assign({ type: 'TagTk' }, this);
	}
}

if (typeof module === "object") {
	module.exports = {
		TagTk: TagTk
	};
}
