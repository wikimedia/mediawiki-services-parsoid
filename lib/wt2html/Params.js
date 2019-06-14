/** @module wt2html/Params */

'use strict';

require('../../core-upgrade.js');

var Promise = require('../utils/promise.js');
const { KV } = require('../tokens/TokenTypes.js');
var TokenUtils = require('../utils/TokenUtils.js').TokenUtils;

/**
 * A parameter object wrapper, essentially an array of key/value pairs with a
 * few extra methods.
 *
 * @class
 * @extends Array
 */
class Params extends Array {
	constructor(params) {
		super(params.length);
		for (var i = 0; i < params.length; i++) {
			this[i] = params[i];
		}
		this.argDict = null;
		this.namedArgsDict = null;
	}

	dict() {
		if (this.argDict === null) {
			var res = {};
			for (var i = 0, l = this.length; i < l; i++) {
				var kv = this[i];
				var key = TokenUtils.tokensToString(kv.k).trim();
				res[key] = kv.v;
			}
			this.argDict = res;
		}
		return this.argDict;
	}

	named() {
		if (this.namedArgsDict === null) {
			var n = 1;
			var out = {};
			var namedArgs = {};

			for (var i = 0, l = this.length; i < l; i++) {
				// FIXME: Also check for whitespace-only named args!
				var k = this[i].k;
				var v = this[i].v;
				if (k.constructor === String) {
					k = k.trim();
				}
				if (!k.length &&
					// Check for blank named parameters
					this[i].srcOffsets[1] === this[i].srcOffsets[2]) {
					out[n.toString()] = v;
					n++;
				} else if (k.constructor === String) {
					namedArgs[k] = true;
					out[k] = v;
				} else {
					k = TokenUtils.tokensToString(k).trim();
					namedArgs[k] = true;
					out[k] = v;
				}
			}
			this.namedArgsDict = { namedArgs: namedArgs, dict: out };
		}

		return this.namedArgsDict;
	}

	/**
	 * Expand a slice of the parameters using the supplied get options.
	 * @return {Promise}
	 */
	getSlice(options, start, end) {
		var args = this.slice(start, end);
		return Promise.resolve(args.map(function(kv) {
			return new KV(kv.k, TokenUtils.tokensToString(kv.v), kv.srcOffsets);
		}));
	}
}

if (typeof module === "object") {
	module.exports = {
		Params: Params,
	};
}
