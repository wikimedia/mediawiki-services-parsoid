/** @module wt2html/parser_defines */

'use strict';

require('../../core-upgrade.js');
var Promise = require('../utils/promise.js');

var Util; // Util module var for circular dependency avoidance
var requireUtil = function() {
	if (!Util) {
		Util = require('../utils/Util.js').Util; // (circular dep)
	}
}; // initialized later to avoid circular dependency


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
	constructor(k, v, srcOffsets) {
		/** Key. */
		this.k = k;
		/** Value. */
		this.v = v;
		if (srcOffsets) {
			/** The source offsets. */
			this.srcOffsets = srcOffsets;
		}
	}
}

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
	addAttribute(name, value) {
		this.attribs.push(new KV(name, value));
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
		requireUtil();
		return Util.lookup(this.attribs, name);
	}

	/**
	 * Set an unshadowed attribute.
	 *
	 * @param {string} name
	 * @param {any} value
	 */
	setAttribute(name, value) {
		requireUtil();
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
		requireUtil();
		var curVal = Util.lookup(this.attribs, name);

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
		requireUtil();
		var curVal = Util.lookupKV(this.attribs, name);
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
	 * @param {MWParserEnvironment} env
	 * @return {string}
	 */
	getWTSource(env) {
		var tsr = this.dataAttribs.tsr;
		console.assert(Array.isArray(tsr), 'Expected token to have tsr info.');
		return env.page.src.substring(tsr[0], tsr[1]);
	}
}

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

	/**
	 * @return {string}
	 */
	defaultToString(t) {
		return "<" + this.name + ">";
	}

	/** @private */
	tagToStringFns(which) {
		switch (which) {
			case "listItem":
				return () => "<li:" + this.bullets.join('') + ">";
			case "mw-quote":
				return () => "<mw-quote:" + this.value + ">";
			case "urllink":
				return () => "<urllink:" + this.attribs[0].v + ">";
			case "behavior-switch":
				return () => "<behavior-switch:" + this.attribs[0].v + ">";
		}
		return () => this.defaultToString();
	}

	/**
	 * @param {boolean} compact Whether to return the full HTML, or just the
	 *   tag name.
	 * @return {string}
	 */
	toString(compact) {
		requireUtil();
		if (Util.isHTMLTag(this)) {
			if (compact) {
				return "<HTML:" + this.name + ">";
			} else {
				var buf = '';
				for (var i = 0, n = this.attribs.length; i < n; i++) {
					var a = this.attribs[i];
					buf += (Util.toStringTokens(a.k).join('') + "=" + Util.toStringTokens(a.v).join(''));
				}
				return "<HTML:" + this.name + " " + buf + ">";
			}
		} else {
			return this.tagToStringFns(this.name)();
		}
	}
}

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

	/**
	 * @return {string}
	 */
	toString() {
		if (Util.isHTMLTag(this)) {
			return "</HTML:" + this.name + ">";
		} else {
			return "</" + this.name + ">";
		}
	}
}

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

	/**
	 * @param {string} key
	 * @param {Object} arg
	 * @param {string} indent The string by which we should indent each new line.
	 * @param {string} indentIncrement The string we should add to each level of indentation.
	 * @return {Object}
	 * @return {boolean} return.present Whether there is any non-empty string representation of these tokens.
	 * @return {string} return.str
	 */
	multiTokenArgToString(key, arg, indent, indentIncrement) {
		requireUtil();
		var newIndent = indent + indentIncrement;
		var present = true;
		var toks    = Util.toStringTokens(arg, newIndent);
		var str     = toks.join("\n" + newIndent);

		if (toks.length > 1 || str[0] === '<') {
			str = [key, ":{\n", newIndent, str, "\n", indent, "}"].join('');
		} else {
			present = (str !== '');
		}

		return { present: present, str: str };
	}

	/**
	 * Get a string representation of the tag's attributes.
	 *
	 * @param {string} indent The string by which to indent every line.
	 * @param {string} indentIncrement The string to add to every successive level of indentation.
	 * @param {number} startAttrIndex Where to start converting attributes.
	 * @return {string}
	 */
	attrsToString(indent, indentIncrement, startAttrIndex) {
		var buf = [];
		for (var i = startAttrIndex, n = this.attribs.length; i < n; i++) {
			var a = this.attribs[i];
			var kVal = this.multiTokenArgToString("k", a.k, indent, indentIncrement);
			var vVal = this.multiTokenArgToString("v", a.v, indent, indentIncrement);

			if (kVal.present && vVal.present) {
				buf.push([kVal.str, "=", vVal.str].join(''));
			} else {
				if (kVal.present) {
					buf.push(kVal.str);
				}
				if (vVal.present) {
					buf.push(vVal.str);
				}
			}
		}

		return buf.join("\n" + indent + "|");
	}


	/**
	 * @param {boolean} compact Whether to return the full HTML, or just the tag name.
	 * @param {string} indent The string by which to indent each line.
	 * @return {string}
	 */
	defaultToString(compact, indent) {
		requireUtil();
		if (compact) {
			var buf = "<" + this.name + ">:";
			var attr0 = this.attribs[0];
			return attr0 ? buf + Util.toStringTokens(attr0.k, "\n") : buf;
		} else {
			if (!indent) {
				indent = "";
			}
			var origIndent = indent;
			var indentIncrement = "  ";
			indent += indentIncrement;
			return ["<", this.name, ">(\n", indent, this.attrsToString(indent, indentIncrement, 0), "\n", origIndent, ")"].join('');
		}
	}

	/** @private */
	tagToStringFns(which, compact, indent) {
		switch (which) {
			case "extlink":
				return (compact, indent) => {
					requireUtil();
					var indentIncrement = "  ";
					var href = Util.toStringTokens(Util.lookup(this.attribs, 'href'), indent + indentIncrement);
					if (compact) {
						return ["<extlink:", href, ">"].join('');
					} else {
						if (!indent) {
							indent = "";
						}
						var origIndent = indent;
						indent += indentIncrement;
						var content = Util.lookup(this.attribs, 'mw:content');
						content = this.multiTokenArgToString("v", content, indent, indentIncrement).str;
						return [
							"<extlink>(\n", indent,
							"href=", href, "\n", indent,
							"content=", content, "\n", origIndent,
							")",
						].join('');
					}
				};

			case "wikilink":
				return () => {
					requireUtil();
					if (!indent) {
						indent = "";
					}
					var indentIncrement = "  ";
					var href = Util.toStringTokens(Util.lookup(this.attribs, 'href'), indent + indentIncrement);
					if (compact) {
						return ["<wikilink:", href, ">"].join('');
					} else {
						if (!indent) {
							indent = "";
						}
						var origIndent = indent;
						indent += indentIncrement;
						var tail = Util.lookup(this.attribs, 'tail');
						var content = this.attrsToString(indent, indentIncrement, 2);
						return [
							"<wikilink>(\n", indent,
							"href=", href, "\n", indent,
							"tail=", tail, "\n", indent,
							"content=", content, "\n", origIndent,
							")",
						].join('');
					}
				};
		}
		return () => this.defaultToString(compact, indent);
	}

	/**
	 * @param {boolean} compact Whether to return the full HTML, or just the tag name.
	 * @param {string} indent The string by which to indent each line.
	 * @return {string}
	 */
	toString(compact, indent) {
		if (Util.isHTMLTag(this)) {
			return "<HTML:" + this.name + " />";
		} else {
			var f = this.tagToStringFns(this.name, compact, indent);
			return f();
		}
	}
}

/**
 * Newline token.
 * @class
 * @extends ~Token
 */
class NlTk extends Token {
	/**
	 * @param {Array} tsr The TSR of the newline(s).
	 */
	constructor(tsr) {
		super();
		if (tsr) {
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

	/**
	 * Convert the token to a simple string.
	 *
	 * @return {string} The string `"\n"`.
	 */
	toString() {
		return "\\n";
	}
}

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
		return Object.assign({ type: 'COMMENT' }, this);
	}

	toString() {
		return "<!--" + this.value + "-->";
	}
}

/* -------------------- EOFTk -------------------- */
class EOFTk extends Token {
	toJSON() {
		return Object.assign({ type: 'EOFTk' }, this);
	}

	toString() {
		return "";
	}
}


/* -------------------- Params -------------------- */
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
		requireUtil();
		if (this.argDict === null) {
			var res = {};
			for (var i = 0, l = this.length; i < l; i++) {
				var kv = this[i];
				var key = Util.tokensToString(kv.k).trim();
				res[key] = kv.v;
			}
			this.argDict = res;
		}
		return this.argDict;
	}

	named() {
		requireUtil();
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
					k = Util.tokensToString(k).trim();
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
		requireUtil();
		var args = this.slice(start, end);
		return Promise.all(args.map(Promise.async(function *(kv) { // eslint-disable-line require-yield
			var k = kv.k;
			var v = kv.v;
			if (Array.isArray(v) && v.length === 1 && v[0].constructor === String) {
				// remove String from Array
				kv = new KV(k, v[0], kv.srcOffsets);
			} else if (v.constructor !== String) {
				kv = new KV(k, Util.tokensToString(v), kv.srcOffsets);
			}
			return kv;
		})));
	}
}

if (typeof module === "object") {
	module.exports = {
		TagTk: TagTk,
		EndTagTk: EndTagTk,
		SelfclosingTagTk: SelfclosingTagTk,
		NlTk: NlTk,
		CommentTk: CommentTk,
		EOFTk: EOFTk,
		KV: KV,
		Params: Params,
	};
}
