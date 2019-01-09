/** @module */

'use strict';

const { lastItem } = require('../../utils/jsutils.js').JSUtils;
const TokenHandler = require('./TokenHandler.js');
const { EOFTk } = require('../../tokens/TokenTypes.js');

/**
 * Buffers tokens from the JS code for downstream PHP transformers.
 * Since they shell out to run in a separate process, they cannot
 * process token chunks while retaining state between invocations.
 * So, this "transformer" buffers the entire token stream till EOF.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class PHPBuffer extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		this.buffer = [];
	}

	processTokensSync(env, tokens, traceState) {
		this.buffer = this.buffer.concat(tokens);
		let ret = [];
		if (lastItem(this.buffer).constructor === EOFTk) {
			ret = this.buffer;
			this.buffer = [];
		}
		return ret;
	}
}

if (typeof module === "object") {
	module.exports.PHPBuffer = PHPBuffer;
}
