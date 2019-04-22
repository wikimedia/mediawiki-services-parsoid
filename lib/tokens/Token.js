/** @module tokens/Token */

'use strict';

const KV = require('./KV.js').KV;

/**
 * Catch-all class for all token types.
 * @abstract
 * @class
 */
class Token {
	/**
	 * Generic set attribute method.
	 *
	 * @param {string} name
	 * @param {any} value
	 */
	addAttribute(name, value, srcOffsets) {
		this.attribs.push(new KV(name, value, srcOffsets));
	}

	/**
	 * Generic set attribute method with support for change detection.
	 * Set a value and preserve the original wikitext that produced it.
	 *
	 * @param {string} name
	 * @param {any} value
	 * @param {any} origValue
	 */
	addNormalizedAttribute(name, value, origValue) {
		this.addAttribute(name, value);
		this.setShadowInfo(name, value, origValue);
	}

	/**
	 * Generic attribute accessor.
	 *
	 * @param {string} name
	 * @return {any}
	 */
	getAttribute(name) {
		return KV.lookup(this.attribs, name);
	}

	getAttributeKV(name) {
		return KV.lookupKV(this.attribs, name);
	}

	/**
	 * Generic attribute accessor.
	 *
	 * @param {string} name
	 * @return {boolean}
	 */
	hasAttribute(name) {
		return this.getAttributeKV(name) !== null;
	}

	/**
	 * Set an unshadowed attribute.
	 *
	 * @param {string} name
	 * @param {any} value
	 */
	setAttribute(name, value) {
		// First look for the attribute and change the last match if found.
		for (var i = this.attribs.length - 1; i >= 0; i--) {
			var kv = this.attribs[i];
			var k = kv.k;
			if (k.constructor === String && k.toLowerCase() === name) {
				kv.v = value;
				this.attribs[i] = kv;
				return;
			}
		}
		// Nothing found, just add the attribute
		this.addAttribute(name, value);
	}

	/**
	 * Store the original value of an attribute in a token's dataAttribs.
	 *
	 * @param {string} name
	 * @param {any} value
	 * @param {any} origValue
	 */
	setShadowInfo(name, value, origValue) {
		// Don't shadow if value is the same or the orig is null
		if (value !== origValue && origValue !== null) {
			if (!this.dataAttribs.a) {
				this.dataAttribs.a = {};
			}
			this.dataAttribs.a[name] = value;
			if (!this.dataAttribs.sa) {
				this.dataAttribs.sa = {};
			}
			if (origValue !== undefined) {
				this.dataAttribs.sa[name] = origValue;
			}
		}
	}

	/**
	 * Attribute info accessor for the wikitext serializer. Performs change
	 * detection and uses unnormalized attribute values if set. Expects the
	 * context to be set to a token.
	 *
	 * @param {string} name
	 * @return {Object} Information about the shadow info attached to this attribute.
	 * @return {any} return.value
	 * @return {boolean} return.modified Whether the attribute was changed between parsing and now.
	 * @return {boolean} return.fromsrc Whether we needed to get the source of the attribute to round-trip it.
	 */
	getAttributeShadowInfo(name) {
		var curVal = this.getAttribute(name);

		// Not the case, continue regular round-trip information.
		if (this.dataAttribs.a === undefined ||
				this.dataAttribs.a[name] === undefined) {
			return {
				value: curVal,
				// Mark as modified if a new element
				modified: Object.keys(this.dataAttribs).length === 0,
				fromsrc: false,
			};
		} else if (this.dataAttribs.a[name] !== curVal) {
			return {
				value: curVal,
				modified: true,
				fromsrc: false,
			};
		} else if (this.dataAttribs.sa === undefined ||
				this.dataAttribs.sa[name] === undefined) {
			return {
				value: curVal,
				modified: false,
				fromsrc: false,
			};
		} else {
			return {
				value: this.dataAttribs.sa[name],
				modified: false,
				fromsrc: true,
			};
		}
	}

	/**
	 * Completely remove all attributes with this name.
	 *
	 * @param {string} name
	 */
	removeAttribute(name) {
		var out = [];
		var attribs = this.attribs;
		for (var i = 0, l = attribs.length; i < l; i++) {
			var kv = attribs[i];
			if (kv.k.toLowerCase() !== name) {
				out.push(kv);
			}
		}
		this.attribs = out;
	}

	/**
	 * Add a space-separated property value.
	 *
	 * @param {string} name
	 * @param {any} value The value to add to the attribute.
	 */
	addSpaceSeparatedAttribute(name, value) {
		var curVal = this.getAttributeKV(name);
		var vals;
		if (curVal !== null) {
			vals = curVal.v.split(/\s+/);
			for (var i = 0, l = vals.length; i < l; i++) {
				if (vals[i] === value) {
					// value is already included, nothing to do.
					return;
				}
			}
			// Value was not yet included in the existing attribute, just add
			// it separated with a space
			this.setAttribute(curVal.k, curVal.v + ' ' + value);
		} else {
			// the attribute did not exist at all, just add it
			this.addAttribute(name, value);
		}
	}

	/**
	 * Get the wikitext source of a token.
	 *
	 * @param {Frame|null} frame
	 * @return {string}
	 */
	getWTSource(frame) {
		const tsr = this.dataAttribs.tsr;
		console.assert(Array.isArray(tsr), 'Expected token to have tsr info.');
		const srcText = frame.srcText;
		return srcText.substring(tsr[0], tsr[1]);
	}
}

if (typeof module === "object") {
	module.exports = {
		Token: Token
	};
}
