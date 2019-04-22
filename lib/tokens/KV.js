/** @module tokens/KV */

'use strict';

/**
 * @class
 *
 * Key-value pair.
 */
class KV {
	/**
	 * @param {any} k
	 * @param {any} v
	 * @param {Array} srcOffsets The source offsets.
	 */
	constructor(k, v, srcOffsets, ksrc = null, vsrc = null) {
		/** Key. */
		this.k = k;
		/** Value. */
		this.v = v;
		if (srcOffsets) {
			/** The source offsets. */
			this.srcOffsets = srcOffsets;
			console.assert(Array.isArray(srcOffsets) && srcOffsets.length === 4);
		}
		if (ksrc) {
			this.ksrc = ksrc;
		}
		if (vsrc) {
			this.vsrc = vsrc;
		}
	}

	/**
	 * @return {string}
	 */
	toJSON() {
		const ret = { k: this.k, v: this.v, srcOffsets: this.srcOffsets };
		if (this.ksrc) {
			ret.ksrc = this.ksrc;
		}
		if (this.vsrc) {
			ret.vsrc = this.vsrc;
		}
		return ret;
	}

	static lookupKV(kvs, key) {
		if (!kvs) {
			return null;
		}
		var kv;
		for (var i = 0, l = kvs.length; i < l; i++) {
			kv = kvs[i];
			if (kv.k.constructor === String && kv.k.trim() === key) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	}

	static lookup(kvs, key) {
		var kv = this.lookupKV(kvs, key);
		return kv === null ? null : kv.v;
	}
}

if (typeof module === "object") {
	module.exports = {
		KV: KV
	};
}
