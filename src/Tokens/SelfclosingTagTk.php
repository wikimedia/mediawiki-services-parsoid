/** @module tokens/SelfclosingTagTk */

'use strict';

const Token = require('./Token.js').Token;

/**
 * HTML tag token for a self-closing tag (like a br or hr).
 * @class
 * @extends ~Token
 */
class SelfclosingTagTk extends Token {
	/**
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
		return Object.assign({ type: 'SelfclosingTagTk' }, this);
	}
}

if (typeof module === "object") {
	module.exports = {
		SelfclosingTagTk: SelfclosingTagTk
	};
}
