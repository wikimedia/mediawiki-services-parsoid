/** @module tokens/EndTagTk */

'use strict';

const Token = require('./Token.js').Token;

/**
 * HTML end tag token.
 * @class
 * @extends ~Token
 */
class EndTagTk extends Token {
	/*
	* @param {string} name
	* @param {KV[]} attribs
	* @param {Object} dataAttribs
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
		return Object.assign({ type: 'EndTagTk' }, this);
	}
}

if (typeof module === "object") {
	module.exports = {
		EndTagTk: EndTagTk
	};
}
