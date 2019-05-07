/**
 * This file contains general utilities for token transforms.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var crypto = require('crypto');
var entities = require('entities');
var Consts = require('../config/WikitextConstants.js').WikitextConstants;
var TokenUtils = require('./TokenUtils.js').TokenUtils;
var Token = require('../tokens/Token.js').Token;
var KV = require('../tokens/KV.js').KV;

/**
 * @namespace
 */
var Util = {

	// Non-global and global versions of regexp for use everywhere
	COMMENT_REGEXP: /<!--(?:[^-]|-(?!->))*-->/,
	COMMENT_REGEXP_G: /<!--(?:[^-]|-(?!->))*-->/g,

	/**
	 * Regexp for checking marker metas typeofs representing
	 * transclusion markup or template param markup.
	 * @property {RegExp}
	 */
	TPL_META_TYPE_REGEXP: /(?:^|\s)(mw:(?:Transclusion|Param)(?:\/End)?)(?=$|\s)/,

	/**
	 * Update only those properties that are undefined or null in the target.
	 *
	 * @param {Object} tgt The object to modify.
	 * @param {...Object} subject The object to extend tgt with. Add more arguments to the function call to chain more extensions.
	 * @return {Object} The modified object.
	 */
	extendProps: function(tgt, subject /* FIXME: use spread operator */) {
		function internalExtend(target, obj) {
			var allKeys = [].concat(Object.keys(target), Object.keys(obj));
			for (var i = 0, numKeys = allKeys.length; i < numKeys; i++) {
				var k = allKeys[i];
				if (target[k] === undefined || target[k] === null) {
					target[k] = obj[k];
				}
			}
			return target;
		}
		var n = arguments.length;
		for (var j = 1; j < n; j++) {
			internalExtend(tgt, arguments[j]);
		}
		return tgt;
	},

	stripParsoidIdPrefix: function(aboutId) {
		// 'mwt' is the prefix used for new ids in mediawiki.parser.environment#newObjectId
		return aboutId.replace(/^#?mwt/, '');
	},

	isParsoidObjectId: function(aboutId) {
		// 'mwt' is the prefix used for new ids in mediawiki.parser.environment#newObjectId
		return aboutId.match(/^#mwt/);
	},

	/**
	 * Determine if the named tag is void (can not have content).
	 */
	isVoidElement: function(name) {
		return Consts.HTML.VoidTags.has(name.toUpperCase());
	},

	// deep clones by default.
	clone: function(obj, deepClone) {
		if (deepClone === undefined) {
			deepClone = true;
		}
		if (Array.isArray(obj)) {
			if (deepClone) {
				return obj.map(function(el) {
					return Util.clone(el, true);
				});
			} else {
				return obj.slice();
			}
		} else if (obj instanceof Object && // only "plain objects"
					Object.getPrototypeOf(obj) === Object.prototype) {
			/* This definition of "plain object" comes from jquery,
			 * via zepto.js.  But this is really a big hack; we should
			 * probably put a console.assert() here and more precisely
			 * delimit what we think is legit to clone. (Hint: not
			 * DOM trees.) */
			if (deepClone) {
				return Object.keys(obj).reduce(function(nobj, key) {
					nobj[key] = Util.clone(obj[key], true);
					return nobj;
				}, {});
			} else {
				return Object.assign({}, obj);
			}
		} else if (obj instanceof Token
				|| obj instanceof KV) {
			// Allow cloning of Token and KV objects, since that is useful
			const nobj = new obj.constructor();
			for (const key in obj) {
				nobj[key] = Util.clone(obj[key], true);
			}
			return nobj;
		} else {
			return obj;
		}
	},

	// Just a copy `Util.clone` used in *testing* to reverse the effects of
	// freezing an object.  Works with more that just "plain objects"
	unFreeze: function(obj, deepClone) {
		if (deepClone === undefined) {
			deepClone = true;
		}
		if (Array.isArray(obj)) {
			if (deepClone) {
				return obj.map(function(el) {
					return Util.unFreeze(el, true);
				});
			} else {
				return obj.slice();
			}
		} else if (obj instanceof Object) {
			if (deepClone) {
				return Object.keys(obj).reduce(function(nobj, key) {
					nobj[key] = Util.unFreeze(obj[key], true);
					return nobj;
				}, new obj.constructor());
			} else {
				return Object.assign({}, obj);
			}
		} else {
			return obj;
		}
	},

	/**
	 * Emulate PHP's urlencode by patching results of
	 * JS's `encodeURIComponent`.
	 *
	 * PHP: https://secure.php.net/manual/en/function.urlencode.php
	 *
	 * JS:  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
	 *
	 * Spaces to '+' is a PHP peculiarity as well.
	 */
	phpURLEncode: function(txt) {
		return encodeURIComponent(txt)
			.replace(/!/g, '%21')
			.replace(/'/g, '%27')
			.replace(/\(/g, '%28')
			.replace(/\)/g, '%29')
			.replace(/\*/g, '%2A')
			.replace(/~/g, '%7E')
			.replace(/%20/g, '+');
	},

	/*
	 * Wraps `decodeURI` in a try/catch to suppress throws from malformed URI
	 * sequences.  Distinct from `decodeURIComponent` in that certain
	 * sequences aren't decoded if they result in (un)reserved characters.
	 */
	decodeURI: function(s) {
		// Most of the time we should have valid input
		try {
			return decodeURI(s);
		} catch (e) {
			// Fall through
		}

		// Extract each encoded character and decode it individually
		return s.replace(
			/%[0-7][0-9A-F]|%[CD][0-9A-F]%[89AB][0-9A-F]|%E[0-9A-F](?:%[89AB][0-9A-F]){2}|%F[0-4](?:%[89AB][0-9A-F]){3}/gi,
			function(m) {
				try {
					return decodeURI(m);
				} catch (e) {
					return m;
				}
			}
		);
	},

	/*
	 * Wraps `decodeURIComponent` in a try/catch to suppress throws from
	 * malformed URI sequences.
	 */
	decodeURIComponent: function(s) {
		// Most of the time we should have valid input
		try {
			return decodeURIComponent(s);
		} catch (e) {
			// Fall through
		}

		// Extract each encoded character and decode it individually
		return s.replace(
			/%[0-7][0-9A-F]|%[CD][0-9A-F]%[89AB][0-9A-F]|%E[0-9A-F](?:%[89AB][0-9A-F]){2}|%F[0-4](?:%[89AB][0-9A-F]){3}/gi,
			function(m) {
				try {
					return decodeURIComponent(m);
				} catch (e) {
					return m;
				}
			}
		);
	},

	extractExtBody: function(token) {
		var src = token.getAttribute('source');
		var extTagWidths = token.dataAttribs.extTagWidths;
		return src.substring(extTagWidths[0], src.length - extTagWidths[1]);
	},

	isValidDSR: function(dsr, all) {
		const isValidOffset = n => typeof (n) === 'number' && n >= 0;
		return dsr &&
			isValidOffset(dsr[0]) && isValidOffset(dsr[1]) &&
			(!all || (isValidOffset(dsr[2]) && isValidOffset(dsr[3])));
	},

	/**
	 * Quickly hash an array or string.
	 *
	 * @param {Array|string} arr
	 */
	makeHash: function(arr) {
		var md5 = crypto.createHash('MD5');
		var i;
		if (Array.isArray(arr)) {
			for (i = 0; i < arr.length; i++) {
				if (arr[i] instanceof String) {
					md5.update(arr[i]);
				} else {
					md5.update(arr[i].toString());
				}
				md5.update("\0");
			}
		} else {
			md5.update(arr);
		}
		return md5.digest('hex');
	},

	/**
	 * Cannonicalizes a namespace name.
	 *
	 * Used by {@link WikiConfig}.
	 *
	 * @param {string} name Non-normalized namespace name.
	 * @return {string}
	 */
	normalizeNamespaceName: function(name) {
		return name.toLowerCase().replace(' ', '_');
	},

	/**
	 * Decode HTML5 entities in wikitext.
	 *
	 * NOTE that wikitext only allows semicolon-terminated entities, while
	 * HTML allows a number of "legacy" entities to be decoded without
	 * a terminating semicolon.  This function deliberately does not
	 * decode these HTML-only entity forms.
	 *
	 * @param {string} text
	 * @return {string}
	 */
	decodeWtEntities: function(text) {
		// HTML5 allows semicolon-less entities which wikitext does not:
		// in wikitext all entities must end in a semicolon.
		return text.replace(
			/&[#0-9a-zA-Z]+;/g,
			(match) => {
				// Be careful: `&ampamp;` can get through the above, which
				// decodeHTML5 will decode to `&amp;` -- but that's a sneaky
				// semicolon-less entity!
				const m = /^&#(?:x([A-Fa-f0-9]+)|(\d+));$/.exec(match);
				let c, cp;
				if (m) {
					// entities contains a bunch of weird legacy mappings
					// for numeric codepoints (T113194) which we don't want.
					if (m[1]) {
						cp = Number.parseInt(m[1], 16);
					} else {
						cp = Number.parseInt(m[2], 10);
					}
					if (cp > 0x10FFFF) {
						// Invalid entity, don't give to String.fromCodePoint
						return match;
					}
					c = String.fromCodePoint(cp);
				} else {
					c = entities.decodeHTML5(match);
					// Length can be legit greater than one if it is astral
					if (c.length > 1 && c.endsWith(';')) {
						// Invalid entity!
						return match;
					}
					cp = c.codePointAt(0);
				}
				// Check other banned codepoints (T106578)
				if (
					(cp < 0x09) ||
					(cp > 0x0A && cp < 0x20) ||
					(cp > 0x7E && cp < 0xA0) ||
					(cp > 0xD7FF && cp < 0xE000) ||
					(cp > 0xFFFD && cp < 0x10000) ||
					(cp > 0x10FFFF)
				) {
					// Invalid entity!
					return match;
				}
				return c;
			}
		);
	},

	/**
	 * Entity-escape anything that would decode to a valid wikitext entity.
	 *
	 * Note that HTML5 allows certain "semicolon-less" entities, like
	 * `&para`; these aren't allowed in wikitext and won't be escaped
	 * by this function.
	 *
	 * @param {string} text
	 * @return {string}
	 */
	escapeWtEntities: function(text) {
		// [CSA] replace with entities.encode( text, 2 )?
		// but that would encode *all* ampersands, where we apparently just want
		// to encode ampersands that precede valid entities.
		return text.replace(/&[#0-9a-zA-Z]+;/g, function(match) {
			var decodedChar = Util.decodeWtEntities(match);
			if (decodedChar !== match) {
				// Escape the ampersand
				return '&amp;' + match.substr(1);
			} else {
				// Not an entity, just return the string
				return match;
			}
		});
	},

	escapeHtml: function(s) {
		return s.replace(/["'&<>]/g, entities.encodeHTML5);
	},

	/**
	 * Encode all characters as entity references.  This is done to make
	 * characters safe for wikitext (regardless of whether they are
	 * HTML-safe).
	 * @param {string} s
	 * @return {string}
	 */
	entityEncodeAll: function(s) {
		// this is surrogate-aware
		return Array.from(s).map(function(c) {
			c = c.codePointAt(0).toString(16).toUpperCase();
			if (c.length === 1) { c = '0' + c; } // convention
			if (c === 'A0') { return '&nbsp;'; } // special-case common usage
			return '&#x' + c + ';';
		}).join('');
	},

	/**
	 * Determine whether the protocol of a link is potentially valid. Use the
	 * environment's per-wiki config to do so.
	 */
	isProtocolValid: function(linkTarget, env) {
		var wikiConf = env.conf.wiki;
		if (typeof linkTarget === 'string') {
			return wikiConf.hasValidProtocol(linkTarget);
		} else {
			return true;
		}
	},

	getExtArgInfo: function(extToken) {
		var name = extToken.getAttribute('name');
		var options = extToken.getAttribute('options');
		return {
			dict: {
				name: name,
				attrs: TokenUtils.kvToHash(options, true),
				body: { extsrc: Util.extractExtBody(extToken) },
			},
		};
	},

	parseMediaDimensions: function(str, onlyOne) {
		var dimensions = null;
		var match = str.match(/^(\d*)(?:x(\d+))?\s*(?:px\s*)?$/);
		if (match) {
			dimensions = { x: Number(match[1]) };
			if (match[2] !== undefined) {
				if (onlyOne) { return null; }
				dimensions.y = Number(match[2]);
			}
		}
		return dimensions;
	},

	// More generally, this is defined by the media handler in core
	validateMediaParam: function(num) {
		return num > 0;
	},

	// Extract content in a backwards compatible way
	getStar: function(revision) {
		var content = revision;
		if (revision && revision.slots) {
			content = revision.slots.main;
		}
		return content;
	},

	/**
	 * Magic words masquerading as templates.
	 * @property {Set}
	 */
	magicMasqs: new Set(["defaultsort", "displaytitle"]),

	/**
	 * This regex was generated by running through *all unicode characters* and
	 * testing them against *all regexes* for linktrails in a default MW install.
	 * We had to treat it a little bit, here's what we changed:
	 *
	 * 1. A-Z, though allowed in Walloon, is disallowed.
	 * 2. '"', though allowed in Chuvash, is disallowed.
	 * 3. '-', though allowed in Icelandic (possibly due to a bug), is disallowed.
	 * 4. '1', though allowed in Lak (possibly due to a bug), is disallowed.
	 * @property {RegExp}
	 */
	linkTrailRegex: new RegExp(
		'^[^\0-`{÷ĀĈ-ČĎĐĒĔĖĚĜĝĠ-ĪĬ-įĲĴ-ĹĻ-ĽĿŀŅņŉŊŌŎŏŒŔŖ-ŘŜŝŠŤŦŨŪ-ŬŮŲ-ŴŶŸ' +
		'ſ-ǤǦǨǪ-Ǯǰ-ȗȜ-ȞȠ-ɘɚ-ʑʓ-ʸʽ-̂̄-΅·΋΍΢Ϗ-ЯѐѝѠѢѤѦѨѪѬѮѰѲѴѶѸѺ-ѾҀ-҃҅-ҐҒҔҕҘҚҜ-ҠҤ-ҪҬҭҰҲ' +
		'Ҵ-ҶҸҹҼ-ҿӁ-ӗӚ-ӜӞӠ-ӢӤӦӪ-ӲӴӶ-ՠֈ-׏׫-ؠً-ٳٵ-ٽٿ-څڇ-ڗڙ-ڨڪ-ڬڮڰ-ڽڿ-ۅۈ-ۊۍ-۔ۖ-਀਄਋-਎਑਒' +
		'਩਱਴਷਺਻਽੃-੆੉੊੎-੘੝੟-੯ੴ-჏ჱ-ẼẾ-​\u200d-‒—-‗‚‛”--\ufffd\ufffd]+$'),

	/**
	 * Check whether some text is a valid link trail.
	 *
	 * @param {string} text
	 * @return {boolean}
	 */
	isLinkTrail: function(text) {
		if (text && text.match && text.match(this.linkTrailRegex)) {
			return true;
		} else {
			return false;
		}
	},

	/**
	 * Convert mediawiki-format language code to a BCP47-compliant language
	 * code suitable for including in HTML.  See
	 * `GlobalFunctions.php::wfBCP47()` in mediawiki sources.
	 *
	 * @param {string} code Mediawiki language code.
	 * @return {string} BCP47 language code.
	 */
	bcp47: function(code) {
		var codeSegment = code.split('-');
		var codeBCP = [];
		codeSegment.forEach(function(seg, segNo) {
			// When previous segment is x, it is a private segment and should be lc
			if (segNo > 0 && /^x$/i.test(codeSegment[segNo - 1])) {
				codeBCP[segNo] = seg.toLowerCase();
			// ISO 3166 country code
			} else if (seg.length === 2 && segNo > 0) {
				codeBCP[segNo] = seg.toUpperCase();
			// ISO 15924 script code
			} else if (seg.length === 4 && segNo > 0) {
				codeBCP[segNo] = seg[0].toUpperCase() + seg.slice(1).toLowerCase();
			// Use lowercase for other cases
			} else {
				codeBCP[segNo] = seg.toLowerCase();
			}
		});
		return codeBCP.join('-');
	},
};

if (typeof module === "object") {
	module.exports.Util = Util;
}
