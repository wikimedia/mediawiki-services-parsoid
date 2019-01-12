/** @module tokens/EOFTk */

'use strict';

const Token = require('./Token.js').Token;

class EOFTk extends Token {
	toJSON() {
		return Object.assign({ type: 'EOFTk' }, this);
	}
}

if (typeof module === "object") {
	module.exports = {
		EOFTk: EOFTk
	};
}
