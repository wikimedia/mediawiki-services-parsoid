/**
 * General token sanitizer. Strips out (or encapsulates) unsafe and disallowed
 * tag types and attributes. Should run last in the third, synchronous
 * expansion stage.
 *
 * A large part of this code is a straight port from the PHP version.
 * @module
 */

'use strict';

require('../../../core-upgrade.js');

var semver = require('semver');

var JSUtils = require('../../utils/jsutils.js').JSUtils;
var TokenHandler = require('./TokenHandler.js');
var TokenUtils = require('../../utils/TokenUtils.js').TokenUtils;
var Util = require('../../utils/Util.js').Util;
var WikitextConstants = require('../../config/WikitextConstants.js').WikitextConstants;
const { KV, TagTk, EndTagTk, SelfclosingTagTk } = require('../../tokens/TokenTypes.js');

var UTF8Utils = {
	/**
	 * Returns true if a given Unicode codepoint is a valid character in
	 * both HTML5 and XML.
	 */
	validateCodepoint: function(codepoint) {
		// U+000C is valid in HTML5 but not allowed in XML.
		// U+000D is valid in XML but not allowed in HTML5.
		// U+007F - U+009F are disallowed in HTML5 (control characters).
		return codepoint === 0x09
			|| codepoint === 0x0a
			|| (codepoint >= 0x20 && codepoint <= 0x7e)
			|| (codepoint >= 0xa0 && codepoint <= 0xd7ff)
			|| (codepoint >= 0xe000 && codepoint <= 0xfffd)
			|| (codepoint >= 0x10000 && codepoint <= 0x10ffff);
	},

	/**
	 * Returns a JS string from the provided code point.
	 */
	codepointToUtf8: function(cp) {
		return String.fromCodePoint(cp);
	},

	/**
	 * Returns the code point at the first position of the string.
	 */
	utf8ToCodepoint: function(str) {
		return str.codePointAt(0);
	},
};

/**
 * @namespace
 */
var SanitizerConstants = {

	/** Character entity aliases accepted by MediaWiki */
	htmlEntityAliases: {
		'רלמ': 'rlm',
		'رلم': 'rlm',
	},

	/**
	 * List of all named character entities defined in HTML 4.01
	 * http://www.w3.org/TR/html4/sgml/entities.html
	 * As well as &apos; which is only defined starting in XHTML1.
	 */
	htmlEntities: {
		'Aacute':   193,
		'aacute':   225,
		'Acirc':    194,
		'acirc':    226,
		'acute':    180,
		'AElig':    198,
		'aelig':    230,
		'Agrave':   192,
		'agrave':   224,
		'alefsym':  8501,
		'Alpha':    913,
		'alpha':    945,
		'amp':      38,
		'and':      8743,
		'ang':      8736,
		'apos':     39, // New in XHTML & HTML 5; avoid in output for compatibility with IE.
		'Aring':    197,
		'aring':    229,
		'asymp':    8776,
		'Atilde':   195,
		'atilde':   227,
		'Auml':     196,
		'auml':     228,
		'bdquo':    8222,
		'Beta':     914,
		'beta':     946,
		'brvbar':   166,
		'bull':     8226,
		'cap':      8745,
		'Ccedil':   199,
		'ccedil':   231,
		'cedil':    184,
		'cent':     162,
		'Chi':      935,
		'chi':      967,
		'circ':     710,
		'clubs':    9827,
		'cong':     8773,
		'copy':     169,
		'crarr':    8629,
		'cup':      8746,
		'curren':   164,
		'dagger':   8224,
		'Dagger':   8225,
		'darr':     8595,
		'dArr':     8659,
		'deg':      176,
		'Delta':    916,
		'delta':    948,
		'diams':    9830,
		'divide':   247,
		'Eacute':   201,
		'eacute':   233,
		'Ecirc':    202,
		'ecirc':    234,
		'Egrave':   200,
		'egrave':   232,
		'empty':    8709,
		'emsp':     8195,
		'ensp':     8194,
		'Epsilon':  917,
		'epsilon':  949,
		'equiv':    8801,
		'Eta':      919,
		'eta':      951,
		'ETH':      208,
		'eth':      240,
		'Euml':     203,
		'euml':     235,
		'euro':     8364,
		'exist':    8707,
		'fnof':     402,
		'forall':   8704,
		'frac12':   189,
		'frac14':   188,
		'frac34':   190,
		'frasl':    8260,
		'Gamma':    915,
		'gamma':    947,
		'ge':       8805,
		'gt':       62,
		'harr':     8596,
		'hArr':     8660,
		'hearts':   9829,
		'hellip':   8230,
		'Iacute':   205,
		'iacute':   237,
		'Icirc':    206,
		'icirc':    238,
		'iexcl':    161,
		'Igrave':   204,
		'igrave':   236,
		'image':    8465,
		'infin':    8734,
		'int':      8747,
		'Iota':     921,
		'iota':     953,
		'iquest':   191,
		'isin':     8712,
		'Iuml':     207,
		'iuml':     239,
		'Kappa':    922,
		'kappa':    954,
		'Lambda':   923,
		'lambda':   955,
		'lang':     9001,
		'laquo':    171,
		'larr':     8592,
		'lArr':     8656,
		'lceil':    8968,
		'ldquo':    8220,
		'le':       8804,
		'lfloor':   8970,
		'lowast':   8727,
		'loz':      9674,
		'lrm':      8206,
		'lsaquo':   8249,
		'lsquo':    8216,
		'lt':       60,
		'macr':     175,
		'mdash':    8212,
		'micro':    181,
		'middot':   183,
		'minus':    8722,
		'Mu':       924,
		'mu':       956,
		'nabla':    8711,
		'nbsp':     160,
		'ndash':    8211,
		'ne':       8800,
		'ni':       8715,
		'not':      172,
		'notin':    8713,
		'nsub':     8836,
		'Ntilde':   209,
		'ntilde':   241,
		'Nu':       925,
		'nu':       957,
		'Oacute':   211,
		'oacute':   243,
		'Ocirc':    212,
		'ocirc':    244,
		'OElig':    338,
		'oelig':    339,
		'Ograve':   210,
		'ograve':   242,
		'oline':    8254,
		'Omega':    937,
		'omega':    969,
		'Omicron':  927,
		'omicron':  959,
		'oplus':    8853,
		'or':       8744,
		'ordf':     170,
		'ordm':     186,
		'Oslash':   216,
		'oslash':   248,
		'Otilde':   213,
		'otilde':   245,
		'otimes':   8855,
		'Ouml':     214,
		'ouml':     246,
		'para':     182,
		'part':     8706,
		'permil':   8240,
		'perp':     8869,
		'Phi':      934,
		'phi':      966,
		'Pi':       928,
		'pi':       960,
		'piv':      982,
		'plusmn':   177,
		'pound':    163,
		'prime':    8242,
		'Prime':    8243,
		'prod':     8719,
		'prop':     8733,
		'Psi':      936,
		'psi':      968,
		'quot':     34,
		'radic':    8730,
		'rang':     9002,
		'raquo':    187,
		'rarr':     8594,
		'rArr':     8658,
		'rceil':    8969,
		'rdquo':    8221,
		'real':     8476,
		'reg':      174,
		'rfloor':   8971,
		'Rho':      929,
		'rho':      961,
		'rlm':      8207,
		'rsaquo':   8250,
		'rsquo':    8217,
		'sbquo':    8218,
		'Scaron':   352,
		'scaron':   353,
		'sdot':     8901,
		'sect':     167,
		'shy':      173,
		'Sigma':    931,
		'sigma':    963,
		'sigmaf':   962,
		'sim':      8764,
		'spades':   9824,
		'sub':      8834,
		'sube':     8838,
		'sum':      8721,
		'sup':      8835,
		'sup1':     185,
		'sup2':     178,
		'sup3':     179,
		'supe':     8839,
		'szlig':    223,
		'Tau':      932,
		'tau':      964,
		'there4':   8756,
		'Theta':    920,
		'theta':    952,
		'thetasym': 977,
		'thinsp':   8201,
		'THORN':    222,
		'thorn':    254,
		'tilde':    732,
		'times':    215,
		'trade':    8482,
		'Uacute':   218,
		'uacute':   250,
		'uarr':     8593,
		'uArr':     8657,
		'Ucirc':    219,
		'ucirc':    251,
		'Ugrave':   217,
		'ugrave':   249,
		'uml':      168,
		'upsih':    978,
		'Upsilon':  933,
		'upsilon':  965,
		'Uuml':     220,
		'uuml':     252,
		'weierp':   8472,
		'Xi':       926,
		'xi':       958,
		'Yacute':   221,
		'yacute':   253,
		'yen':      165,
		'Yuml':     376,
		'yuml':     255,
		'Zeta':     918,
		'zeta':     950,
		'zwj':      8205,
		'zwnj':     8204,
	},

	UTF8_REPLACEMENT: "\xef\xbf\xbd",

	/**
	 * Regular expression to match various types of character references in
	 * Sanitizer::normalizeCharReferences and Sanitizer::decodeCharReferences
	 */
	CHAR_REFS_RE_G: /&([A-Za-z0-9\x80-\xff]+);|&\#([0-9]+);|&\#[xX]([0-9A-Fa-f]+);|(&)/g,

	/**
	 * Blacklist for evil uris like javascript:
	 * WARNING: DO NOT use this in any place that actually requires blacklisting
	 * for security reasons. There are NUMEROUS[1] ways to bypass blacklisting, the
	 * only way to be secure from javascript: uri based xss vectors is to whitelist
	 * things that you know are safe and deny everything else.
	 * [1]: http://ha.ckers.org/xss.html
	 */
	EVIL_URI_PATTERN: /(^|\s|\*\/\s*)(javascript|vbscript)([^\w]|$)/i,

	XMLNS_ATTRIBUTE_PATTERN: /^xmlns:[:A-Z_a-z-.0-9]+$/,

	IDN_RE_G: new RegExp(
		"[\t ]|" +  // general whitespace
		"\u00ad|" + // 00ad SOFT HYPHEN
		"\u1806|" + // 1806 MONGOLIAN TODO SOFT HYPHEN
		"\u200b|" + // 200b ZERO WIDTH SPACE
		"\u2060|" + // 2060 WORD JOINER
		"\ufeff|" + // feff ZERO WIDTH NO-BREAK SPACE
		"\u034f|" + // 034f COMBINING GRAPHEME JOINER
		"\u180b|" + // 180b MONGOLIAN FREE VARIATION SELECTOR ONE
		"\u180c|" + // 180c MONGOLIAN FREE VARIATION SELECTOR TWO
		"\u180d|" + // 180d MONGOLIAN FREE VARIATION SELECTOR THREE
		"\u200c|" + // 200c ZERO WIDTH NON-JOINER
		"\u200d|" + // 200d ZERO WIDTH JOINER
		"[\ufe00-\ufe0f]", // fe00-fe0f VARIATION SELECTOR-1-16
		"g"
	),

	setDerivedConstants: function() {
		function computeCSSDecodeRegexp() {
			// Decode escape sequences and line continuation
			// See the grammar in the CSS 2 spec, appendix D.
			// This has to be done AFTER decoding character references.
			// This means it isn't possible for this function to return
			// unsanitized escape sequences. It is possible to manufacture
			// input that contains character references that decode to
			// escape sequences that decode to character references, but
			// it's OK for the return value to contain character references
			// because the caller is supposed to escape those anyway.
			var space = '[\\x20\\t\\r\\n\\f]';
			var nl = '(?:\\n|\\r\\n|\\r|\\f)';
			var backslash = '\\\\';
			return new RegExp(backslash +
				"(?:" +
					"(" + nl + ")|" + // 1. Line continuation
					"([0-9A-Fa-f]{1,6})" + space + "?|" + // 2. character number
					"(.)|" + // 3. backslash cancelling special meaning
					"()$" + // 4. backslash at end of string
				")");
		}

		function setupAttributeWhitelist() {
			var common = [
			// HTML
				'id',
				'class',
				'style',
				'lang',
				'dir',
				'title',

				// WAI-ARIA
				'aria-describedby',
				'aria-flowto',
				'aria-label',
				'aria-labelledby',
				'aria-owns',
				'role',

				// RDFa
				// These attributes are specified in section 9 of
				// https://www.w3.org/TR/2008/REC-rdfa-syntax-20081014
				'about',
				'property',
				'resource',
				'datatype',
				'typeof',

				// Microdata. These are specified by
				// https://html.spec.whatwg.org/multipage/microdata.html#the-microdata-model
				'itemid',
				'itemprop',
				'itemref',
				'itemscope',
				'itemtype',
			];

			var block = common.concat(["align"]);
			var tablealign = ["align", "valign"];
			var tablecell = [
				'abbr',
				'axis',
				'headers',
				'scope',
				'rowspan',
				'colspan',
				'nowrap', // deprecated
				'width', // deprecated
				'height', // deprecated
				'bgcolor', // deprecated
			];

			// Numbers refer to sections in HTML 4.01 standard describing the element.
			// See: http://www.w3.org/TR/html4/
			return {
				// 7.5.4
				'div':    block,
				'center': common, // deprecated
				'span':   common,

				// 7.5.5
				'h1': block,
				'h2': block,
				'h3': block,
				'h4': block,
				'h5': block,
				'h6': block,

				// 7.5.6
				// address

				// 8.2.4
				'bdo': common,

				// 9.2.1
				'em':     common,
				'strong': common,
				'cite':   common,
				'dfn':    common,
				'code':   common,
				'samp':   common,
				'kbd':    common,
				'var':    common,
				'abbr':   common,
				// acronym

				// 9.2.2
				'blockquote': common.concat([ 'cite' ]),
				'q': common.concat([ 'cite' ]),

				// 9.2.3
				'sub': common,
				'sup': common,

				// 9.3.1
				'p': block,

				// 9.3.2
				'br': common.concat([ 'clear' ]),

				// https://www.w3.org/TR/html5/text-level-semantics.html#the-wbr-element
				'wbr': common,

				// 9.3.4
				'pre': common.concat([ 'width' ]),

				// 9.4
				'ins': common.concat([ 'cite', 'datetime' ]),
				'del': common.concat([ 'cite', 'datetime' ]),

				// 10.2
				'ul': common.concat([ 'type' ]),
				'ol': common.concat([ 'type', 'start', 'reversed' ]),
				'li': common.concat([ 'type', 'value' ]),

				// 10.3
				'dl': common,
				'dd': common,
				'dt': common,

				// 11.2.1
				'table': common.concat([
					'summary', 'width', 'border', 'frame',
					'rules', 'cellspacing', 'cellpadding',
					'align', 'bgcolor',
				]),

				// 11.2.2
				'caption': block,

				// 11.2.3
				'thead': common,
				'tfoot': common,
				'tbody': common,

				// 11.2.4
				'colgroup': common.concat([ 'span' ]),
				'col':      common.concat([ 'span' ]),

				// 11.2.5
				'tr': common.concat([ 'bgcolor' ]).concat(tablealign),

				// 11.2.6
				'td': common.concat(tablecell, tablealign),
				'th': common.concat(tablecell, tablealign),

				// 12.2
				// NOTE: <a> is not allowed directly, but the attrib
				// whitelist is used from the Parser object
				'a': common.concat([ 'href', 'rel', 'rev' ]), // rel/rev esp. for RDFa

				// 13.2
				// Not usually allowed, but may be used for extension-style hooks
				// such as <math> when it is rasterized, or if wgAllowImageTag is
				// true
				'img': common.concat([ 'alt', 'src', 'width', 'height', 'srcset' ]),
				// Attributes for A/V tags added in T163583 / T133673
				'audio': common.concat([ 'controls', 'preload', 'width', 'height' ]),
				'video': common.concat([ 'poster', 'controls', 'preload', 'width', 'height' ]),
				'source': common.concat([ 'type', 'src' ]),
				'track': common.concat([ 'type', 'src', 'srclang', 'kind', 'label' ]),

				// 15.2.1
				'tt':     common,
				'b':      common,
				'i':      common,
				'big':    common,
				'small':  common,
				'strike': common,
				's':      common,
				'u':      common,

				// 15.2.2
				'font': common.concat([ 'size', 'color', 'face' ]),
				// basefont

				// 15.3
				'hr': common.concat([ 'width' ]),

				// HTML Ruby annotation text module, simple ruby only.
				// https://www.w3.org/TR/html5/text-level-semantics.html#the-ruby-element
				'ruby': common,
				// rbc
				'rb':  common,
				'rp':  common,
				'rt':  common,  // common.concat([ 'rbspan' ]),
				'rtc': common,

				// MathML root element, where used for extensions
				// 'title' may not be 100% valid here; it's XHTML
				// http://www.w3.org/TR/REC-MathML/
				'math': [ 'class', 'style', 'id', 'title' ],

				// HTML 5 section 4.5
				'figure':        common,
				'figure-inline': common, // T118520
				'figcaption':    common,

				// HTML 5 section 4.6
				'bdi': common,

				// HTML5 elements, defined by:
				// https://html.spec.whatwg.org/multipage/semantics.html#the-data-element
				'data': common.concat(['value']),
				'time': common.concat(['datetime']),
				'mark': common,

				// meta and link are only permitted by removeHTMLtags when Microdata
				// is enabled so we don't bother adding a conditional to hide these
				// Also meta and link are only valid in WikiText as Microdata elements
				// (ie: validateTag rejects tags missing the attributes needed for Microdata)
				// So we don't bother including $common attributes that have no purpose.
				'meta': ['itemprop', 'content'],
				'link': ['itemprop', 'href', 'title'],
			};
		}

		// Tags whose end tags are not accepted, but whose start /
		// self-closing version might be legal.
		this.noEndTagSet = new Set(['br']);

		// |/?[^/])[^\\s]+$");
		this.cssDecodeRE = computeCSSDecodeRegexp();
		this.attributeWhitelist = setupAttributeWhitelist();
	},
};

// init caches, convert lists to hashtables, etc.
SanitizerConstants.setDerivedConstants();

var ignoreFields;
if (semver.gte(process.version, '6.5.0')) {
	// We're ignoring non-global RegExps in >=6.5.0 because it's the first
	// version of node to contain this lastIndex writable bug,
	// https://github.com/nodejs/node/blob/2cc29517966de7257a2f1b34c58c77225a21e05d/deps/v8/test/webkit/fast/regex/lastIndex-expected.txt#L45
	ignoreFields = {
		EVIL_URI_RE: true,
		XMLNS_ATTRIBUTE_RE: true,
	};
} else {
	ignoreFields = {};
}

// Can't freeze the regexp state variables w/ global flag
ignoreFields.IDN_RE_G = true;
ignoreFields.CHAR_REFS_RE_G = true;

// Freeze it blocking all accidental changes
JSUtils.deepFreezeButIgnore(SanitizerConstants, ignoreFields);

/* The sanitizer is a stand-alone object ("static class") that is not tied to
 * the parsing pipeline. This lets it be usable by extensions and code that
 * don't have access to the parsing pipeline. The SanitizerHandler provides
 * the parsing pipeline a hook into the sanitizer's abilities */
var Sanitizer = {};

Sanitizer.attributeWhitelistCache = {};

Sanitizer.attributeWhitelist = function(tag) {
	var awlCache = this.attributeWhitelistCache;
	if (!awlCache[tag]) {
		awlCache[tag] = new Set(SanitizerConstants.attributeWhitelist[tag] || []);
	}
	return awlCache[tag];
};

Sanitizer._stripIDNs = function(host) {
	return host.replace(SanitizerConstants.IDN_RE_G, '');
};

Sanitizer.cleanUrl = function(env, href, mode) {
	if (mode !== 'wikilink') {
		href = href.replace(/([\][<>"\x00-\x20\x7F\|])/g, Util.phpURLEncode);
	}

	var bits = href.match(/^((?:[a-zA-Z][^:\/]*:)?(?:\/\/)?)([^\/]+)(\/?.*)/);
	var proto, host, path;
	if (bits) {
		proto = bits[1];
		if (proto && !env.conf.wiki.hasValidProtocol(proto)) {
			// invalid proto, disallow URL
			return null;
		}
		host = Sanitizer._stripIDNs(bits[2]);
		var match = /^%5B([0-9A-Fa-f:.]+)%5D((:\d+)?)$/.exec(host);
		if (match) {
			// IPv6 host names
			host = '[' + match[1] + ']' + match[2];
		}
		path = bits[3];
	} else {
		proto = '';
		host = '';
		path = href;
	}
	return proto + host + path;
};

/**
 * If the named entity is defined in the HTML 4.0/XHTML 1.0 DTD,
 * return the UTF-8 encoding of that character. Otherwise, returns
 * pseudo-entity source (eg "&foo;").
 */
// gwicke: Use Util.decodeWtEntities instead?
Sanitizer.decodeEntity = function(name) {
	if (SanitizerConstants.htmlEntityAliases[name]) {
		name = SanitizerConstants.htmlEntityAliases[name];
	}
	var e = SanitizerConstants.htmlEntities[name];
	return e ? UTF8Utils.codepointToUtf8(e) : "&" + name + ";";
};

/**
 * Return UTF-8 string for a codepoint if that is a valid
 * character reference, otherwise U+FFFD REPLACEMENT CHARACTER.
 */
Sanitizer.decodeChar = function(codepoint) {
	if (UTF8Utils.validateCodepoint(codepoint)) {
		return UTF8Utils.codepointToUtf8(codepoint);
	} else {
		return SanitizerConstants.UTF8_REPLACEMENT;
	}
};

/**
 * Decode any character references, numeric or named entities,
 * in the text and return a UTF-8 string.
 */
Sanitizer.decodeCharReferences = function(text) {
	return text.replace(SanitizerConstants.CHAR_REFS_RE_G, function() {
		if (arguments[1]) {
			return Sanitizer.decodeEntity(arguments[1]);
		} else if (arguments[2]) {
			return Sanitizer.decodeChar(parseInt(arguments[2], 10));
		} else if (arguments[3]) {
			return Sanitizer.decodeChar(parseInt(arguments[3], 16));
		} else {
			return arguments[4];
		}
	});
};

var ieReplace = new Map(Object.entries({
	'ʀ': 'r',
	'ɴ': 'n',
	'ⁿ': 'n',
	'ʟ': 'l',
	'ɪ': 'i',
	'⁽': '(',
	'₍': '(',
}));

Sanitizer.normalizeCss = function(text) {
	// Decode character references like &#123;
	text = Sanitizer.decodeCharReferences(text);

	// Decode escape sequences and line continuation
	// See the grammar in the CSS 2 spec, appendix D.
	// This has to be done AFTER decoding character references.
	// This means it isn't possible for this function to return
	// unsanitized escape sequences. It is possible to manufacture
	// input that contains character references that decode to
	// escape sequences that decode to character references, but
	// it's OK for the return value to contain character references
	// because the caller is supposed to escape those anyway.
	text = text.replace(SanitizerConstants.cssDecodeRE, function cssDecodeCallback() {
		var c;
		if (arguments[1] !== undefined) {
			// Line continuation
			return '';
		} else if (arguments[2] !== undefined) {
			c = UTF8Utils.codepointToUtf8(parseInt(arguments[2], 16));
		} else if (arguments[3] !== undefined) {
			c = arguments[3];
		} else {
			c = '\\';
		}

		if (c === "\n" || c === '"' || c === "'" || c === '\\') {
			// These characters need to be escaped in strings
			// Clean up the escape sequence to avoid parsing errors by clients
			return '\\' + (c.charCodeAt(0)).toString(16) + ' ';
		} else {
			// Decode unnecessary escape
			return c;
		}
	});

	// Normalize Halfwidth and Fullwidth Unicode block that IE6 might treat as ascii
	text = text.replace(
		// U+FF01 to U+FF5A, excluding U+FF3C (T60088)
		/[\uFF01-\uFF3B\uFF3D-\uFF5A]/g,
		function(u) {
			var cp = UTF8Utils.utf8ToCodepoint(u);
			return String.fromCodePoint(cp - 65248);  // ASCII range \x21-\x7A
		});

	// Convert more characters IE6 might treat as ascii
	// U+0280, U+0274, U+207F, U+029F, U+026A, U+207D, U+208D
	text = text.replace(/\u0280|\u0274|\u207F|\u029F|\u026A|\u207D|\u208D/g, function(u) {
		return ieReplace.get(u) || u;
	});

	// Let the value through if it's nothing but a single comment, to
	// allow other functions which may reject it to pass some error
	// message through.
	if (!/^\s*\/\*[^*\/]*\*\/\s*$/.test(text)) {
		// Remove any comments; IE gets token splitting wrong
		// This must be done AFTER decoding character references and
		// escape sequences, because those steps can introduce comments
		// This step cannot introduce character references or escape
		// sequences, because it replaces comments with spaces rather
		// than removing them completely.
		text = Sanitizer.delimiterReplace('/*', '*/', ' ', text);

		// Remove anything after a comment-start token, to guard against
		// incorrect client implementations.
		const commentPos = text.indexOf('/*');
		if (commentPos !== -1) {
			text = text.slice(0, commentPos);
		}
	}

	// S followed by repeat, iteration, or prolonged sound marks,
	// which IE will treat as "ss"
	text = text.replace(/s(?:\u3031|\u309D|\u30FC|\u30FD|\uFE7C|\uFE7D|\uFF70)/ig, 'ss');

	return text;
};

// Cut-down version of StringUtils::delimiterReplace in mediawiki-core
Sanitizer.delimiterReplace = function(startDelim, endDelim, replace, subject, flags) {
	// Rather than port the full functionality of StringUtils::delimiterReplace,
	// just port the small subset actually used by Sanitizer.  Protect
	// ourselves with assertions in case someone naively tries to use
	// the stuff we lazily omitted.
	console.assert(flags === undefined, "Not Implemented");
	console.assert(replace.indexOf('$') === -1, "Not Implemented");
	const re = JSUtils.rejoin(
		JSUtils.escapeRegExp(startDelim),
		/[^]*?/,
		JSUtils.escapeRegExp(endDelim),
		{ flags: 'g' }
	);
	return subject.replace(re, replace);
};

var insecureRE = new RegExp(
	"expression" +
		"|filter\\s*:" +
		"|accelerator\\s*:" +
		"|-o-link\\s*:" +
		"|-o-link-source\\s*:" +
		"|-o-replace\\s*:" +
		"|url\\s*\\(" +
		"|image\\s*\\(" +
		"|image-set\\s*\\(" +
		"|attr\\s*\\([^)]+[\\s,]+url",
	"i"
);

Sanitizer.checkCss = function(text) {
	text = Sanitizer.normalizeCss(text);
	// \000-\010\013\016-\037\177 are the octal escape sequences
	if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text) ||
			text.indexOf(SanitizerConstants.UTF8_REPLACEMENT) > -1) {
		return '/* invalid control char */';
	} else if (insecureRE.test(text)) {
		return '/* insecure input */';
	} else {
		return text;
	}
};

Sanitizer.normalizeSectionIdWhiteSpace = function(id) {
	return Util.phpTrim(id.replace(/[ _]+/g, ' '));
};

/**
 * Given a section name or other user-generated or otherwise unsafe string, escapes it to be
 * a valid HTML id attribute.
 *
 * WARNING: unlike escapeId(), the output of this function is not guaranteed to be HTML safe,
 * be sure to use proper escaping.
 *
 * In Parsoid, proper escaping is usually handled for us by the HTML
 * serialization algorithm, but be careful of corner cases (such as
 * emitting attributes in wikitext).
 *
 * @param {string} id String to escape
 * @param {Object} options Specify whether the primary or fallback encoding
 *     should be used.
 * @return {string} Escaped ID
 *
 * @since 1.30
 */
Sanitizer.escapeIdForAttribute = function(id, options) {
	// For consistency with PHP's API, we accept "primary" or "fallback" as
	// the mode in 'options'.  This (slightly) abstracts the actual details
	// of the id encoding from the Parsoid code which handles ids; we could
	// swap primary and fallback here, or even transition to a new HTML6
	// encoding (!), without touching all the call sites.
	var mode = (options && options.fallback) ? 'legacy' : 'html5';
	return Sanitizer.escapeIdInternal(id, mode);
};

/**
 * Given a section name or other user-generated or otherwise unsafe string, escapes it to be
 * a valid URL fragment.
 *
 * WARNING: unlike escapeId(), the output of this function is not guaranteed to be HTML safe,
 * be sure to use proper escaping.
 *
 * @param {string} id String to escape
 * @return {string} Escaped ID
 *
 * @since 1.30
 */
Sanitizer.escapeIdForLink = function(id) {
	return Sanitizer.escapeIdInternal(id, 'html5');
};

/**
 * Given a section name or other user-generated or otherwise unsafe string, escapes it to be
 * a valid URL fragment for external interwikis.
 *
 * @param {string} id String to escape
 * @return {string} Escaped ID
 *
 * @since 1.30
 */
Sanitizer.escapeIdForExternalInterwiki = function(id) {
	// Assume $wgExternalInterwikiFragmentMode = 'legacy'
	return Sanitizer.escapeIdInternal(id, 'legacy');
};

/**
 * Helper for escapeIdFor*() functions. Performs most of the actual escaping.
 *
 * @param {string} id String to escape.
 * @param {string} mode 'html5' or 'legacy'
 * @return {string}
 */
Sanitizer.escapeIdInternal = function(id, mode) {
	switch (mode) {
		case 'html5':
			id = id.replace(/ /g, '_');
			break;
		case 'legacy':
			// This corresponds to 'noninitial' mode of the old escapeId
			id = id.replace(/ /g, '_');
			id = Util.phpURLEncode(id);
			id = id.replace(/%3A/g, ':');
			id = id.replace(/%/g, '.');
			break;
		default:
			throw new Error("Invalid mode: " + mode);
	}
	return id;
};

/**
 * Given a string containing a space delimited list of ids, escape each id
 * to match ids escaped by the escapeIdForAttribute() function.
 *
 * @since 1.27
 *
 * @param {string} referenceString Space delimited list of ids
 * @return {string}
 */
Sanitizer.escapeIdReferenceList = function(referenceString) {
	// Explode the space delimited list string into an array of tokens
	const references =
		String(referenceString).split(/\s+/g).filter(s => s.length)
		// Escape each token as an id
		.map(ref => Sanitizer.escapeIdForAttribute(ref));

	// Merge the array back to a space delimited list string
	// If the array is empty, the result will be an empty string ('')
	return references.join(' ');
};


// SSS FIXME: There is a test in mediawiki.environment.js that doles out
// and tests about ids. There are probably some tests in mediawiki.Util.js
// as well. We should move all these kind of tests somewhere else.
Sanitizer.isParsoidAttr = function(k, v, attrs) {
	// NOTES:
	// 1. Currently the tokenizer unconditionally escapes typeof and about
	//    attributes from wikitxt to data-x-typeof and data-x-about. So,
	//    this check will only pass through Parsoid inserted attrs.
	// 2. But, if we fix the over-aggressive escaping in the tokenizer to
	//    not escape non-Parsoid typeof and about, then this will return
	//    true for something like typeof='mw:Foo evilScriptHere'. But, that
	//    is safe since this check is only used to see if we should
	//    unconditionally discard the entire attribute or process it further.
	//    That further processing will catch and discard any dangerous
	//    strings in the rest of the attribute
	return (/^(?:typeof|property|rel)$/).test(k) && /(?:^|\s)mw:.+?(?=$|\s)/.test(v) ||
		k === "about" && /^#mwt\d+$/.test(v) ||
		k === "content" && /(?:^|\s)mw:.+?(?=$|\s)/.test(KV.lookup(attrs, 'property'));
};

/**
 * Given an attribute name, checks whether it is a reserved data attribute
 * (such as data-mw-foo) which is unavailable to user-generated HTML so MediaWiki
 * core and extension code can safely use it to communicate with frontend code.
 * @param {string} attr Attribute name.
 * @return {bool}
 */
Sanitizer.isReservedDataAttribute = function(attr) {
	// data-ooui is reserved for ooui.
	// data-mw and data-parsoid are reserved for parsoid.
	// data-mw-<name here> is reserved for extensions (or core) if
	// they need to communicate some data to the client and want to be
	// sure that it isn't coming from an untrusted user.
	// We ignore the possibility of namespaces since user-generated HTML
	// can't use them anymore.
	if (/^data-(mw|parsoid)/.test(attr)) {
		return false; // PARSOID SPECIFIC
	}
	return /^data-(ooui|mw|parsoid)/i.test(attr);
};

// php's `Sanitizer::getAttribsRegex()` only permits attribute keys matching
// these classes.  Transpiled by regexpu v4.1.1 on https://mothereff.in/regexpu
// which corresponds to Unicode v10.0.0
//
// From, /^[:_\p{L}\p{N}][:_\.\-\p{L}\p{N}]*$/u
var getAttribsRegex = /^(?:[0-:A-Z_a-z\xAA\xB2\xB3\xB5\xB9\xBA\xBC-\xBE\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u0660-\u0669\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07C0-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0966-\u096F\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09E6-\u09F1\u09F4-\u09F9\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A66-\u0A6F\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AE6-\u0AEF\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B66-\u0B6F\u0B71-\u0B77\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0BE6-\u0BF2\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C66-\u0C6F\u0C78-\u0C7E\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CE6-\u0CEF\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D58-\u0D61\u0D66-\u0D78\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DE6-\u0DEF\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F20-\u0F33\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F-\u1049\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u1090-\u1099\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1369-\u137C\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u17E0-\u17E9\u17F0-\u17F9\u1810-\u1819\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u1A00-\u1A16\u1A20-\u1A54\u1A80-\u1A89\u1A90-\u1A99\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B50-\u1B59\u1B83-\u1BA0\u1BAE-\u1BE5\u1C00-\u1C23\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2070\u2071\u2074-\u2079\u207F-\u2089\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2150-\u2189\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2CFD\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u3192-\u3195\u31A0-\u31BA\u31F0-\u31FF\u3220-\u3229\u3248-\u324F\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA830-\uA835\uA840-\uA873\uA882-\uA8B3\uA8D0-\uA8D9\uA8F2-\uA8F7\uA8FB\uA8FD\uA900-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF-\uA9D9\uA9E0-\uA9E4\uA9E6-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA50-\uAA59\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD07-\uDD33\uDD40-\uDD78\uDD8A\uDD8B\uDE80-\uDE9C\uDEA0-\uDED0\uDEE1-\uDEFB\uDF00-\uDF23\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC58-\uDC76\uDC79-\uDC9E\uDCA7-\uDCAF\uDCE0-\uDCF2\uDCF4\uDCF5\uDCFB-\uDD1B\uDD20-\uDD39\uDD80-\uDDB7\uDDBC-\uDDCF\uDDD2-\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE40-\uDE47\uDE60-\uDE7E\uDE80-\uDE9F\uDEC0-\uDEC7\uDEC9-\uDEE4\uDEEB-\uDEEF\uDF00-\uDF35\uDF40-\uDF55\uDF58-\uDF72\uDF78-\uDF91\uDFA9-\uDFAF]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDCFA-\uDCFF\uDE60-\uDE7E]|\uD804[\uDC03-\uDC37\uDC52-\uDC6F\uDC83-\uDCAF\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD03-\uDD26\uDD36-\uDD3F\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDD0-\uDDDA\uDDDC\uDDE1-\uDDF4\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDEF0-\uDEF9\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC50-\uDC59\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE50-\uDE59\uDE80-\uDEAA\uDEC0-\uDEC9\uDF00-\uDF19\uDF30-\uDF3B]|\uD806[\uDCA0-\uDCF2\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC50-\uDC6C\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF50-\uDF59\uDF5B-\uDF61\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD834[\uDF60-\uDF71]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD83A[\uDC00-\uDCC4\uDCC7-\uDCCF\uDD00-\uDD43\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD83C[\uDD00-\uDD0C]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D])(?:[\-\.0-:A-Z_a-z\xAA\xB2\xB3\xB5\xB9\xBA\xBC-\xBE\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u0660-\u0669\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07C0-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0966-\u096F\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09E6-\u09F1\u09F4-\u09F9\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A66-\u0A6F\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AE6-\u0AEF\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B66-\u0B6F\u0B71-\u0B77\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0BE6-\u0BF2\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C66-\u0C6F\u0C78-\u0C7E\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CE6-\u0CEF\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D58-\u0D61\u0D66-\u0D78\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DE6-\u0DEF\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F20-\u0F33\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F-\u1049\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u1090-\u1099\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1369-\u137C\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u17E0-\u17E9\u17F0-\u17F9\u1810-\u1819\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u1A00-\u1A16\u1A20-\u1A54\u1A80-\u1A89\u1A90-\u1A99\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B50-\u1B59\u1B83-\u1BA0\u1BAE-\u1BE5\u1C00-\u1C23\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2070\u2071\u2074-\u2079\u207F-\u2089\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2150-\u2189\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2CFD\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u3192-\u3195\u31A0-\u31BA\u31F0-\u31FF\u3220-\u3229\u3248-\u324F\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA830-\uA835\uA840-\uA873\uA882-\uA8B3\uA8D0-\uA8D9\uA8F2-\uA8F7\uA8FB\uA8FD\uA900-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF-\uA9D9\uA9E0-\uA9E4\uA9E6-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA50-\uAA59\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD07-\uDD33\uDD40-\uDD78\uDD8A\uDD8B\uDE80-\uDE9C\uDEA0-\uDED0\uDEE1-\uDEFB\uDF00-\uDF23\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC58-\uDC76\uDC79-\uDC9E\uDCA7-\uDCAF\uDCE0-\uDCF2\uDCF4\uDCF5\uDCFB-\uDD1B\uDD20-\uDD39\uDD80-\uDDB7\uDDBC-\uDDCF\uDDD2-\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE40-\uDE47\uDE60-\uDE7E\uDE80-\uDE9F\uDEC0-\uDEC7\uDEC9-\uDEE4\uDEEB-\uDEEF\uDF00-\uDF35\uDF40-\uDF55\uDF58-\uDF72\uDF78-\uDF91\uDFA9-\uDFAF]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDCFA-\uDCFF\uDE60-\uDE7E]|\uD804[\uDC03-\uDC37\uDC52-\uDC6F\uDC83-\uDCAF\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD03-\uDD26\uDD36-\uDD3F\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDD0-\uDDDA\uDDDC\uDDE1-\uDDF4\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDEF0-\uDEF9\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC50-\uDC59\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE50-\uDE59\uDE80-\uDEAA\uDEC0-\uDEC9\uDF00-\uDF19\uDF30-\uDF3B]|\uD806[\uDCA0-\uDCF2\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC50-\uDC6C\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF50-\uDF59\uDF5B-\uDF61\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD834[\uDF60-\uDF71]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD83A[\uDC00-\uDCC4\uDCC7-\uDCCF\uDD00-\uDD43\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD83C[\uDD00-\uDD0C]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D])*$/;

Sanitizer.sanitizeTagAttrs = function(env, tagName, token, attrs) {
	var tag       = tagName || token.name;
	var xmlnsRE   = SanitizerConstants.XMLNS_ATTRIBUTE_PATTERN;
	var evilUriRE = SanitizerConstants.EVIL_URI_PATTERN;

	var wlist = Sanitizer.attributeWhitelist(tag);
	var newAttrs = {};
	var n = attrs.length;
	for (var i = 0; i < n; i++) {
		var a = attrs[i];
		if (!a.v) { a.v = ""; }

		// Convert attributes to string, if necessary.
		a.k = TokenUtils.tokensToString(a.k);
		a.v = TokenUtils.tokensToString(a.v, false, {
			unpackDOMFragments: true,
			env,  // FIXME: Sneaking in `env` to avoid changing the signature
		});

		var origK = a.ksrc || a.k;
		var k = a.k.toLowerCase();
		var v = a.v;
		var origV = a.vsrc || v;
		var psdAttr = this.isParsoidAttr(k, v, attrs);

		// Bypass RDFa/whitelisting checks for Parsoid-inserted attrs
		// Safe to do since the tokenizer renames about/typeof attrs.
		// unconditionally. FIXME: The escaping solution in the tokenizer
		// may be aggressive. There is no need to escape typeof strings
		// that or about ids that don't resemble Parsoid tokens/about ids.
		if (!psdAttr) {
			if (!getAttribsRegex.test(k)) {
				newAttrs[k] = [null, origV, origK];
				continue;
			}

			// Allow XML namespace declaration to allow RDFa
			if (xmlnsRE.test(k)) {
				if (!evilUriRE.test(v)) {
					newAttrs[k] = [v, origV, origK];
				} else {
					newAttrs[k] = [null, origV, origK];
				}
				continue;
			}

			// Allow any attribute beginning with "data-"
			// However:
			// * Disallow data attributes used by MediaWiki code
			// * Ensure that the attribute is not namespaced by banning
			//   colons.
			if (
				(!/^data-[^:]*$/i.test(k) && !wlist.has(k)) ||
				Sanitizer.isReservedDataAttribute(k)
			) {
				newAttrs[k] = [null, origV, origK];
				continue;
			}
		}

		// Strip javascript "expression" from stylesheets.
		// http://msdn.microsoft.com/workshop/author/dhtml/overview/recalc.asp
		if (k === 'style') {
			v = Sanitizer.checkCss(v);
		}

		// Escape HTML id attributes
		if (k === 'id') {
			v = Sanitizer.escapeIdForAttribute(v, { fallback:false });
		}

		// Escape HTML id reference lists
		if (
			k === 'aria-describedby'
			|| k === 'aria-flowto'
			|| k === 'aria-labelledby'
			|| k === 'aria-owns'
		) {
			v = Sanitizer.escapeIdReferenceList(v);
		}

		// RDFa and microdata properties allow URLs, URIs and/or CURIs.
		// Check them for sanity
		if (
			k === 'rel' || k === 'rev'
			// RDFa
			|| k === 'about' || k === 'property'
			|| k === 'resource' || k === 'datatype'
			|| k === 'typeof'
			// HTML5 microdata
			|| k === 'itemid' || k === 'itemprop'
			|| k === 'itemref' || k === 'itemscope'
			|| k === 'itemtype'
		) {
			// Paranoia. Allow "simple" values but suppress javascript
			if (evilUriRE.test(v)) {
				// Retain the Parsoid typeofs for Parsoid attrs
				var newV = psdAttr ? origV.replace(/(?:^|\s)(?!mw:\w)[^\s]*/g, '').trim() : null;
				newAttrs[k] = [newV, origV, origK];
				continue;
			}
		}

		// NOTE: Even though elements using href/src are not allowed directly,
		// supply validation code that can be used by tag hook handlers, etc
		if (token && (k === 'href' || k === 'src' || k === 'poster')) { // T163583
			// `origV` will always be `v`, because `a.vsrc` isn't set, since
			// this attribute didn't come from source.  However, in the
			// LinkHandler, we may have already shadowed this value so use
			// that instead.
			var rel = token.getAttributeShadowInfo('rel');
			var mode = (k === 'href' && rel && (/^mw:WikiLink(\/Interwiki)?$/.test(rel.value))) ?
				'wikilink' : 'external';
			var origHref = token.getAttributeShadowInfo(k).value;
			var newHref = Sanitizer.cleanUrl(env, v, mode);
			if (newHref !== v) {
				newAttrs[k] = [newHref, origHref, origK];
				continue;
			}
		}

		// SSS FIXME: This logic is not RT-friendly.
		// If this attribute was previously set, override it.
		// Output should only have one attribute of each name.
		newAttrs[k] = [v, origV, origK];
	}

	// itemtype, itemid, itemref don't make sense without itemscope
	if (newAttrs.itemscope === undefined) {
		// SSS FIXME: This logic is not RT-friendly.
		delete newAttrs.itemtype;
		delete newAttrs.itemid;
		delete newAttrs.itemref;
	}
	// TODO: Strip itemprop if we aren't descendants of an itemscope.

	return newAttrs;
};

/**
 * Sanitize and apply attributes to a wrapper element.
 *
 * Used primarily when we're applying tokenized attributes directly to
 * dom elements, which wouldn't have had a chance to be sanitized before
 * tree building.
 */
Sanitizer.applySanitizedArgs = function(env, wrapper, attrs) {
	var sanitizedAttrs = Sanitizer.sanitizeTagAttrs(env, wrapper.nodeName.toLowerCase(), null, attrs);
	Object.keys(sanitizedAttrs).forEach(function(k) {
		if (sanitizedAttrs[k][0] !== null) {
			wrapper.setAttribute(k, sanitizedAttrs[k][0]);
		}
	});
};

/**
 * Sanitize a token.
 *
 * XXX: Make attribute sanitation reversible by storing round-trip info in
 * token.dataAttribs object (which is serialized as JSON in a data-parsoid
 * attribute in the DOM).
 */
Sanitizer.sanitizeToken = function(env, frame, token, inTemplate) {
	var i, l, kv;
	var attribs = token.attribs;
	var noEndTagSet = SanitizerConstants.noEndTagSet;
	var tagWhiteList = WikitextConstants.Sanitizer.TagWhiteList;

	if (TokenUtils.isHTMLTag(token) && (
		!tagWhiteList.has(token.name.toUpperCase()) ||
		(token.constructor === EndTagTk && noEndTagSet.has(token.name))
	)) { // unknown tag -- convert to plain text
		if (!inTemplate && token.dataAttribs.tsr) {
			// Just get the original token source, so that we can avoid
			// whitespace differences.
			token = token.getWTSource(frame);
		} else if (token.constructor !== EndTagTk) {
			// Handle things without a TSR: For example template or extension
			// content. Whitespace in these is not necessarily preserved.
			var buf = "<" + token.name;
			for (i = 0, l = attribs.length; i < l; i++) {
				kv = attribs[i];
				buf += " " + kv.k + "='" + kv.v + "'";
			}
			if (token.constructor === SelfclosingTagTk) {
				buf += " /";
			}
			buf += ">";
			token = buf;
		} else {
			token = "</" + token.name + ">";
		}
	} else {
		if (attribs && attribs.length > 0) {
			// Sanitize attributes
			if (token.constructor === TagTk || token.constructor === SelfclosingTagTk) {
				var newAttrs = this.sanitizeTagAttrs(env, null, token, attribs);

				// Reset token attribs and rebuild
				token.attribs = [];

				// SSS FIXME: We are right now adding shadow information for all sanitized
				// attributes.  This is being done to minimize dirty diffs for the first
				// cut.  It can be reasonably argued that we can permanently delete dangerous
				// and unacceptable attributes in the interest of safety/security and the
				// resultant dirty diffs should be acceptable.  But, this is something to do
				// in the future once we have passed the initial tests of parsoid acceptance.
				Object.keys(newAttrs).forEach(function(j) {
					var vs = newAttrs[j];
					// explicit check against null to prevent discarding empty strings
					if (vs[0] !== null) {
						token.addNormalizedAttribute(j, vs[0], vs[1]);
					} else {
						token.setShadowInfo(vs[2], vs[0], vs[1]);
					}
				});
			} else {
				// EndTagTk, drop attributes
				token.attribs = [];
			}
		}
	}

	return token;
};

/**
 * Sanitize a title to be used in a URI?
 */
Sanitizer.sanitizeTitleURI = function(title, isInterwiki) {
	var bits = title.split('#');
	var anchor = null;
	if (bits.length > 1) { // split at first '#'
		anchor = title.substring(bits[0].length + 1);
		title = bits[0];
	}
	title = title.replace(/[%? \[\]#|<>]/g, function(m) {
		return encodeURIComponent(m);
	});
	if (anchor !== null) {
		title += '#' + (isInterwiki
			? Sanitizer.escapeIdForExternalInterwiki(anchor)
			: Sanitizer.escapeIdForLink(anchor));
	}
	return title;
};

/**
 * @class
 * @param {TokenTransformManager} manager The manager for this part of the pipeline.
 * @param {Object} options
 */
class SanitizerHandler extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		this.register(manager);
		this.inTemplate = options.inTemplate;
	}
}

// Register this transformer with the TokenTransformer
SanitizerHandler.prototype.register = function(manager) {
	this.manager = manager;
};

SanitizerHandler.prototype.onAny = function(token) {
	var env = this.manager.env;
	env.log("trace/sanitizer", this.manager.pipelineId, function() {
		return JSON.stringify(token);
	});

	// Pass through a transparent line meta-token
	if (TokenUtils.isEmptyLineMetaToken(token)) {
		env.log("trace/sanitizer", this.manager.pipelineId, "--unchanged--");
		return { tokens: [ token ] };
	}

	token = Sanitizer.sanitizeToken(env, this.manager.frame, token, this.inTemplate);

	env.log("trace/sanitizer", this.manager.pipelineId, function() {
		return " ---> " + JSON.stringify(token);
	});
	return { tokens: [ token ] };
};

if (typeof module === "object") {
	module.exports.Sanitizer = Sanitizer;
	module.exports.SanitizerHandler = SanitizerHandler;
	module.exports.SanitizerConstants = SanitizerConstants;
}
