/**
 * Wikitext to HTML serializer.
 *
 * This serializer is designed to eventually
 * - accept arbitrary HTML and
 * - serialize that to wikitext in a way that round-trips back to the same
 *   HTML DOM as far as possible within the limitations of wikitext.
 *
 * Not much effort has been invested so far on supporting
 * non-Parsoid/VE-generated HTML. Some of this involves adaptively switching
 * between wikitext and HTML representations based on the values of attributes
 * and DOM context. A few special cases are already handled adaptively
 * (multi-paragraph list item contents are serialized as HTML tags for
 * example, generic A elements are serialized to HTML A tags), but in general
 * support for this is mostly missing.
 *
 * Example issue:
 * ```
 * <h1><p>foo</p></h1> will serialize to =\nfoo\n= whereas the
 *        correct serialized output would be: =<p>foo</p>=
 * ```
 *
 * What to do about this?
 * * add a generic 'can this HTML node be serialized to wikitext in this
 *   context' detection method and use that to adaptively switch between
 *   wikitext and HTML serialization.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const { ContentUtils } = require('../utils/ContentUtils.js');
const { ConstrainedText } = require('./ConstrainedText.js');
const { DiffUtils } = require('./DiffUtils.js');
const { DOMDataUtils } = require('../utils/DOMDataUtils.js');
const { DOMNormalizer } = require('./DOMNormalizer.js');
const { DOMUtils } = require('../utils/DOMUtils.js');
const { JSUtils } = require('../utils/jsutils.js');
const { KV, TagTk } = require('../tokens/TokenTypes.js');
const { TemplateDataRequest } = require('../mw/ApiRequest.js');
const { TokenUtils } = require('../utils/TokenUtils.js');
const { Util } = require('../utils/Util.js');
const { WikitextEscapeHandlers } = require('./WikitextEscapeHandlers.js');
const { WTSUtils } = require('./WTSUtils.js');
const { WTUtils } = require('../utils/WTUtils.js');
const { SerializerState } = require('./SerializerState.js');

const { WikitextConstants: Consts } = require('../config/WikitextConstants.js');
const { tagHandlers } = require('./DOMHandlers.js');
const DOMHandler = require('./DOMHandlers/DOMHandler.js');
const FallbackHTMLHandler = require('./DOMHandlers/FallbackHTMLHandler.js');
const EncapsulatedContentHandler = require('./DOMHandlers/EncapsulatedContentHandler.js');
const LinkHandlersModule = require('./LinkHandler.js');
const { languageVariantHandler } = require('./LanguageVariantHandler.js');
const Promise = require('../utils/promise.js');
const SeparatorsModule = require('./separators.js');

const { lastItem } = JSUtils;

/* Used by WikitextSerializer._serializeAttributes */
const IGNORED_ATTRIBUTES = new Set([
	'data-parsoid',
	'data-ve-changed',
	'data-parsoid-changed',
	'data-parsoid-diff',
	'data-parsoid-serialize',
	DOMDataUtils.DataObjectAttrName(),
]);

/* Used by WikitextSerializer._serializeAttributes */
const PARSOID_ATTRIBUTES = new Map([
	[ 'about', /^#mwt\d+$/ ],
	[ 'typeof', /(^|\s)mw:[^\s]+/g ],
]);

const TRAILING_COMMENT_OR_WS_AFTER_NL_REGEXP = JSUtils.rejoin(
	'\\n(\\s|', Util.COMMENT_REGEXP, ')*$'
);

const FORMATSTRING_REGEXP =
	/^(\n)?(\{\{ *_+)(\n? *\|\n? *_+ *= *)(_+)(\n? *\}\})(\n)?$/;

// Regular expressions for testing if nowikis added around
// heading-like wikitext are spurious or necessary.
const COMMENT_OR_WS_REGEXP = JSUtils.rejoin(
		'^(\\s|', Util.COMMENT_REGEXP, ')*$'
);

const HEADING_NOWIKI_REGEXP = JSUtils.rejoin(
		'^(?:', Util.COMMENT_REGEXP, ')*',
		/<nowiki>(=+[^=]+=+)<\/nowiki>(.+)$/
);

/**
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 *
 * @class
 * @param {Object} options List of options for serialization.
 * @param {MWParserEnvironment} options.env
 * @param {boolean} [options.rtTestMode]
 * @param {string} [options.logType="trace/wts"]
 * @alias module:html2wt/WikitextSerializer~WikitextSerializer
 */
class WikitextSerializer {
	constructor(options) {
		this.options = options;
		this.env = options.env;

		// Set rtTestMode if not already set.
		if (this.options.rtTestMode === undefined) {
			this.options.rtTestMode = this.env.conf.parsoid.rtTestMode;
		}

		this.logType = this.options.logType || "trace/wts";
		this.trace = (...args) => this.env.log(this.logType, ...args);

		this.state = new SerializerState(this, this.options);

		// WT escaping handlers
		this.wteHandlers = new WikitextEscapeHandlers(this.options);
	}
}

WikitextSerializer.prototype.linkHandler = function(node) {
	return LinkHandlersModule.linkHandler(this.state, node);
};

WikitextSerializer.prototype.figureHandler = function(node) {
	return LinkHandlersModule.figureHandler(this.state, node);
};

WikitextSerializer.prototype.languageVariantHandler = function(node) {
	return languageVariantHandler(this.state, node);
};

WikitextSerializer.prototype.updateSeparatorConstraints = function(...args) {
	return SeparatorsModule.updateSeparatorConstraints(this.state, ...args);
};

WikitextSerializer.prototype.buildSep = function(node) {
	return SeparatorsModule.buildSep(this.state, node);
};

// Methods

/**
 * @param {Object} opts
 * @param {Node} html
 */
WikitextSerializer.prototype.serializeHTML = Promise.async(function *(opts, html) {
	opts.logType = this.logType;
	var body = ContentUtils.ppToDOM(this.env, html, { markNew: true });
	return yield (new WikitextSerializer(opts)).serializeDOM(body);
});

WikitextSerializer.prototype.getAttributeKey = Promise.async(function *(node, key) {
	var tplAttrs = DOMDataUtils.getDataMw(node).attribs;
	if (tplAttrs) {
		// If this attribute's key is generated content,
		// serialize HTML back to generator wikitext.
		for (var i = 0; i < tplAttrs.length; i++) {
			var a = tplAttrs[i];
			if (a[0].txt === key && a[0].html) {
				return yield this.serializeHTML({
					env: this.env,
					onSOL: false,
				}, a[0].html);
			}
		}
	}
	return key;
});

WikitextSerializer.prototype.getAttributeValue = Promise.async(function *(node, key, value) {
	var tplAttrs = DOMDataUtils.getDataMw(node).attribs;
	if (tplAttrs) {
		// If this attribute's value is generated content,
		// serialize HTML back to generator wikitext.
		for (var i = 0; i < tplAttrs.length; i++) {
			var a = tplAttrs[i];
			if ((a[0] === key || a[0].txt === key) &&
					// !== null is required. html:"" will serialize to "" and
					// will be returned here. This is used to suppress the =".."
					// string in the attribute in scenarios where the template
					// generates a "k=v" string.
					// Ex: <div {{echo|1=style='color:red'}}>foo</div>
					a[1].html !== null &&
					// Only return here if the value is generated (ie. .html),
					// it may just be in .txt form.
					a[1].html !== undefined) {
				return yield this.serializeHTML({
					env: this.env,
					onSOL: false,
					inAttribute: true,
				}, a[1].html);
			}
		}
	}
	return value;
});

WikitextSerializer.prototype.serializedAttrVal = Promise.async(function *(node, name) {
	return yield this.serializedImageAttrVal(node, node, name);
});

WikitextSerializer.prototype.getAttributeValueAsShadowInfo = Promise.async(function *(node, key) {
	var v = yield this.getAttributeValue(node, key, null);
	if (v === null) { return v; }
	return {
		value: v,
		modified: false,
		fromsrc: true,
		fromDataMW: true,
	};
});

WikitextSerializer.prototype.serializedImageAttrVal = Promise.async(function *(dataMWnode, htmlAttrNode, key) {
	var v = yield this.getAttributeValueAsShadowInfo(dataMWnode, key);
	return v || WTSUtils.getAttributeShadowInfo(htmlAttrNode, key);
});

WikitextSerializer.prototype._serializeHTMLTag = Promise.async(function *(node, wrapperUnmodified) {
	// TODO(arlolra): As of 1.3.0, html pre is considered an extension
	// and wrapped in encapsulation.  When that version is no longer
	// accepted for serialization, we can remove this backwards
	// compatibility code.
	//
	// 'inHTMLPre' flag has to be updated always,
	// even when we are selsering in the wrapperUnmodified case.
	var token = WTSUtils.mkTagTk(node);
	if (token.name === 'pre') {
		// html-syntax pre is very similar to nowiki
		this.state.inHTMLPre = true;
	}

	if (wrapperUnmodified) {
		var dsr = DOMDataUtils.getDataParsoid(node).dsr;
		return this.state.getOrigSrc(dsr[0], dsr[0] + dsr[2]);
	}

	var da = token.dataAttribs;
	if (da.autoInsertedStart) {
		return '';
	}

	var close = '';
	if ((Util.isVoidElement(token.name) && !da.noClose) || da.selfClose) {
		close = ' /';
	}

	var sAttribs = yield this._serializeAttributes(node, token);
	if (sAttribs.length > 0) {
		sAttribs = ' ' + sAttribs;
	}

	var tokenName = da.srcTagName || token.name;
	var ret = `<${tokenName}${sAttribs}${close}>`;

	if (tokenName.toLowerCase() === 'nowiki') {
		ret = WTUtils.escapeNowikiTags(ret);
	}

	return ret;
});

WikitextSerializer.prototype._serializeHTMLEndTag = Promise.method(function(node, wrapperUnmodified) {
	if (wrapperUnmodified) {
		var dsr = DOMDataUtils.getDataParsoid(node).dsr;
		return this.state.getOrigSrc(dsr[1] - dsr[3], dsr[1]);
	}

	var token = WTSUtils.mkEndTagTk(node);
	if (token.name === 'pre') {
		this.state.inHTMLPre = false;
	}

	var tokenName = token.dataAttribs.srcTagName || token.name;
	var ret = '';

	if (!token.dataAttribs.autoInsertedEnd &&
			!Util.isVoidElement(token.name) &&
			!token.dataAttribs.selfClose) {
		ret = `</${tokenName}>`;
	}

	if (tokenName.toLowerCase() === 'nowiki') {
		ret = WTUtils.escapeNowikiTags(ret);
	}

	return ret;
});

WikitextSerializer.prototype._serializeAttributes = Promise.async(function *(node, token, isWt) {
	var attribs = token.attribs;

	var out = [];
	for (const kv of attribs) {
		const k = kv.k;
		let v, vInfo;

		// Unconditionally ignore
		// (all of the IGNORED_ATTRIBUTES should be filtered out earlier,
		// but ignore them here too just to make sure.)
		if (IGNORED_ATTRIBUTES.has(k) || k === 'data-mw') {
			continue;
		}

		// Ignore parsoid-like ids. They may have been left behind
		// by clients and shouldn't be serialized. This can also happen
		// in v2/v3 API when there is no matching data-parsoid entry found
		// for this id.
		if (k === "id" && /^mw[\w-]{2,}$/.test(kv.v)) {
			if (WTUtils.isNewElt(node)) {
				this.env.log("warn/html2wt",
					"Parsoid id found on element without a matching data-parsoid " +
					"entry: ID=" + kv.v + "; ELT=" + node.outerHTML);
			} else {
				vInfo = token.getAttributeShadowInfo(k);
				if (!vInfo.modified && vInfo.fromsrc) {
					out.push(k + '=' + '"' + vInfo.value.replace(/"/g, '&quot;') + '"');
				}
			}
			continue;
		}

		// Parsoid auto-generates ids for headings and they should
		// be stripped out, except if this is not auto-generated id.
		if (k === "id" && /H[1-6]/.test(node.nodeName)) {
			if (DOMDataUtils.getDataParsoid(node).reusedId === true) {
				vInfo = token.getAttributeShadowInfo(k);
				out.push(k + '=' + '"' + vInfo.value.replace(/"/g, '&quot;') + '"');
			}
			continue;
		}

		// Strip Parsoid-inserted class="mw-empty-elt" attributes
		if (k === 'class' && Consts.Output.FlaggedEmptyElts.has(node.nodeName)) {
			kv.v = kv.v.replace(/\bmw-empty-elt\b/, '');
			if (!kv.v) {
				continue;
			}
		}

		// Strip other Parsoid-generated values
		//
		// FIXME: Given that we are currently escaping about/typeof keys
		// that show up in wikitext, we could unconditionally strip these
		// away right now.
		const parsoidValueRegExp = PARSOID_ATTRIBUTES.get(k);
		if (parsoidValueRegExp && kv.v.match(parsoidValueRegExp)) {
			v = kv.v.replace(parsoidValueRegExp, '');
			if (v) {
				out.push(k + '=' + '"' + v + '"');
			}
			continue;
		}

		if (k.length > 0) {
			vInfo = token.getAttributeShadowInfo(k);
			v = vInfo.value;
			// Deal with k/v's that were template-generated
			let kk = yield this.getAttributeKey(node, k);
			// Pass in kv.k, not k since k can potentially
			// be original wikitext source for 'k' rather than
			// the string value of the key.
			let vv = yield this.getAttributeValue(node, kv.k, v);
			// Remove encapsulation from protected attributes
			// in pegTokenizer.pegjs:generic_newline_attribute
			kk = kk.replace(/^data-x-/i, '');
			if (vv.length > 0) {
				if (!vInfo.fromsrc && !isWt) {
					// Escape wikitext entities
					vv = Util.escapeWtEntities(vv)
						.replace(/>/g, '&gt;');
				}
				out.push(kk + '=' + '"' + vv.replace(/"/g, '&quot;') + '"');
			} else if (kk.match(/[{<]/)) {
				// Templated, <*include*>, or <ext-tag> generated
				out.push(kk);
			} else {
				out.push(kk + '=""');
			}
			continue;
		} else if (kv.v.length) {
			// not very likely..
			out.push(kv.v);
		}
	}

	// SSS FIXME: It can be reasonably argued that we can permanently delete
	// dangerous and unacceptable attributes in the interest of safety/security
	// and the resultant dirty diffs should be acceptable.  But, this is
	// something to do in the future once we have passed the initial tests
	// of parsoid acceptance.
	//
	// 'a' data attribs -- look for attributes that were removed
	// as part of sanitization and add them back
	var dataAttribs = token.dataAttribs;
	if (dataAttribs.a && dataAttribs.sa) {
		const aKeys = Object.keys(dataAttribs.a);
		for (const k of aKeys) {
			// Attrib not present -- sanitized away!
			if (!KV.lookupKV(attribs, k)) {
				const v = dataAttribs.sa[k];
				if (v) {
					out.push(k + '=' + '"' + v.replace(/"/g, '&quot;') + '"');
				} else {
					// at least preserve the key
					out.push(k);
				}
			}
		}
	}
	// XXX: round-trip optional whitespace / line breaks etc
	return out.join(' ');
});

WikitextSerializer.prototype._handleLIHackIfApplicable = function(node) {
	var liHackSrc = DOMDataUtils.getDataParsoid(node).liHackSrc;
	var prev = DOMUtils.previousNonSepSibling(node);

	// If we are dealing with an LI hack, then we must ensure that
	// we are dealing with either
	//
	//   1. A node with no previous sibling inside of a list.
	//
	//   2. A node whose previous sibling is a list element.
	if (liHackSrc !== undefined &&
			((prev === null && DOMUtils.isList(node.parentNode)) ||       // Case 1
			(prev !== null && DOMUtils.isListItem(prev)))) {              // Case 2
		this.state.emitChunk(liHackSrc, node);
	}
};

function formatStringSubst(format, value, forceTrim) {
	if (forceTrim) { value = value.trim(); }
	return format.replace(/_+/, function(hole) {
		if (value === '' || hole.length <= value.length) { return value; }
		return value + (' '.repeat(hole.length - value.length));
	});
}

function createParamComparator(dpArgInfo, tplData, dataMwKeys) {
	// Record order of parameters in new data-mw
	var newOrder = new Map(Array.from(dataMwKeys).map(
		(key, i) => [key, { order: i }]
	));
	// Record order of parameters in templatedata (if present)
	var tplDataOrder = new Map();
	var aliasMap = new Map();
	var keys = [];
	if (tplData && Array.isArray(tplData.paramOrder)) {
		var params = tplData.params;
		tplData.paramOrder.forEach((k, i) => {
			tplDataOrder.set(k, { order: i });
			aliasMap.set(k, { key: k, order: -1 });
			keys.push(k);
			// Aliases have the same sort order as the main name.
			var aliases = params && params[k] && params[k].aliases;
			(aliases || []).forEach((a, j) => {
				aliasMap.set(a, { key: k, order: j });
			});
		});
	}
	// Record order of parameters in original wikitext (from data-parsoid)
	var origOrder = new Map(dpArgInfo.map(
		(argInfo, i) => [argInfo.k, { order: i, dist: 0 }]
	));
	// Canonical parameter key gets the same order as an alias parameter
	// found in the original wikitext.
	dpArgInfo.forEach((argInfo, i) => {
		var canon = aliasMap.get(argInfo.k);
		if (canon && !origOrder.has(canon.key)) {
			origOrder.set(canon.key, origOrder.get(argInfo.k));
		}
	});
	// Find the closest "original parameter" for each templatedata parameter,
	// so that newly-added parameters are placed near the parameters which
	// templatedata says they should be adjacent to.
	var nearestOrder = new Map(origOrder);
	var reduceF = (acc, val, i) => {
		if (origOrder.has(val)) {
			acc = origOrder.get(val);
		}
		if (!(nearestOrder.has(val) && nearestOrder.get(val).dist < acc.dist)) {
			nearestOrder.set(val, acc);
		}
		return { order: acc.order, dist: acc.dist + 1 };
	};
	// Find closest original parameter before the key.
	keys.reduce(reduceF, { order: -1, dist: 2 * keys.length });
	// Find closest original parameter after the key.
	keys.reduceRight(reduceF, { order: origOrder.size, dist: keys.length });

	// Helper function to return a large number if the given key isn't
	// in the sort order map
	var big = Math.max(nearestOrder.size, newOrder.size);
	var defaultGet = (map, key1, key2) => {
		var key = ((!key2) || map.has(key1)) ? key1 : key2;
		return map.has(key) ? map.get(key).order : big;
	};

	return function cmp(a, b) {
		var acanon = aliasMap.get(a) || { key: a, order: -1 };
		var bcanon = aliasMap.get(b) || { key: b, order: -1 };
		// primary key is `nearestOrder` (nearest original parameter)
		var aOrder = defaultGet(nearestOrder, a, acanon.key);
		var bOrder = defaultGet(nearestOrder, b, bcanon.key);
		if (aOrder !== bOrder) { return aOrder - bOrder; }
		// secondary key is templatedata order
		if (acanon.key === bcanon.key) { return acanon.order - bcanon.order; }
		aOrder = defaultGet(tplDataOrder, acanon.key);
		bOrder = defaultGet(tplDataOrder, bcanon.key);
		if (aOrder !== bOrder) { return aOrder - bOrder; }
		// tertiary key is original input order (makes sort stable)
		aOrder = defaultGet(newOrder, a);
		bOrder = defaultGet(newOrder, b);
		return aOrder - bOrder;
	};
}

// See https://github.com/wikimedia/mediawiki-extensions-TemplateData/blob/master/Specification.md
// for the templatedata specification.
WikitextSerializer.prototype.serializePart = Promise.async(function *(state, buf, node, type, part, tplData, prevPart, nextPart) {
	// Parse custom format specification, if present.
	var defaultBlockSpc  = '{{_\n| _ = _\n}}'; // "block"
	var defaultInlineSpc = '{{_|_=_}}'; // "inline"

	var format = tplData && tplData.format ? tplData.format.toLowerCase() : null;
	if (format === 'block') { format = defaultBlockSpc; }
	if (format === 'inline') { format = defaultInlineSpc; }
	// Check format string for validity.
	var parsedFormat = FORMATSTRING_REGEXP.exec(format);
	if (!parsedFormat) {
		parsedFormat = FORMATSTRING_REGEXP.exec(defaultInlineSpc);
		format = null; // Indicates that no valid custom format was present.
	}
	var formatSOL = parsedFormat[1];
	var formatStart = parsedFormat[2];
	var formatParamName = parsedFormat[3];
	var formatParamValue = parsedFormat[4];
	var formatEnd = parsedFormat[5];
	var formatEOL = parsedFormat[6];
	var forceTrim = (format !== null) || WTUtils.isNewElt(node);

	// Shoehorn formatting of top-level templatearg wikitext into this code.
	if (type === 'templatearg') {
		formatStart = formatStart.replace(/{{/, '{{{');
		formatEnd = formatEnd.replace(/}}/, '}}}');
	}

	// handle SOL newline requirement
	if (formatSOL && !/\n$/.test(prevPart !== null ? buf : state.sep.src)) {
		buf += '\n';
	}

	// open the transclusion
	buf += formatStringSubst(formatStart, part.target.wt, forceTrim);

	// Trim whitespace from data-mw keys to deal with non-compliant
	// clients. Make sure param info is accessible for the stripped key
	// since later code will be using the stripped key always.
	var tplKeysFromDataMw = Object.keys(part.params).map((k) => {
		var strippedK = k.trim();
		if (k !== strippedK) {
			part.params[strippedK] = part.params[k];
		}
		return strippedK;
	});
	if (!tplKeysFromDataMw.length) {
		return buf + formatEnd;
	}

	var env = this.env;

	// Per-parameter info from data-parsoid for pre-existing parameters
	var dp = DOMDataUtils.getDataParsoid(node);
	var dpArgInfo = dp.pi && part.i !== undefined ?  dp.pi[part.i] || [] : [];

	// Build a key -> arg info map
	var dpArgInfoMap = new Map();
	dpArgInfo.forEach(
		argInfo => dpArgInfoMap.set(argInfo.k, argInfo)
	);

	// 1. Process all parameters and build a map of
	//    arg-name -> [serializeAsNamed, name, value]
	//
	// 2. Serialize tpl args in required order
	//
	// 3. Format them according to formatParamName/formatParamValue

	var kvMap = new Map();
	for (const k of tplKeysFromDataMw) {
		const param = part.params[k];
		let argInfo = dpArgInfoMap.get(k);
		if (!argInfo) {
			argInfo = {};
		}

		// TODO: Other formats?
		// Only consider the html parameter if the wikitext one
		// isn't present at all. If it's present but empty,
		// that's still considered a valid parameter.
		let value;
		if (param.wt !== undefined) {
			value = param.wt;
		} else {
			value = yield this.serializeHTML({ env: env }, param.html);
		}

		console.assert(typeof value === 'string',
			'For param: ' + k +
			', wt property should be a string but got: ' + value);

		let serializeAsNamed = argInfo.named || false;

		// The name is usually equal to the parameter key, but
		// if there's a key.wt attribute, use that.
		let name;
		if (param.key && param.key.wt !== undefined) {
			name = param.key.wt;
			// And make it appear even if there wasn't
			// data-parsoid information.
			serializeAsNamed = true;
		} else {
			name = k;
		}

		// Use 'k' as the key, not 'name'.
		//
		// The normalized form of 'k' is used as the key in both
		// data-parsoid and data-mw. The full non-normalized form
		// is present in 'param.key.wt'
		kvMap.set(k, { serializeAsNamed: serializeAsNamed, name: name, value: value });
	}

	var argOrder = Array.from(kvMap.keys())
		.sort(createParamComparator(dpArgInfo, tplData, kvMap.keys()));

	var argIndex = 1;
	var numericIndex = 1;

	var numPositionalArgs = dpArgInfo.reduce(function(n, pi) {
		return (part.params[pi.k] !== undefined && !pi.named) ? n + 1 : n;
	}, 0);

	var argBuf = [];
	for (const param of argOrder) {
		const kv = kvMap.get(param);
		// Add nowiki escapes for the arg value, as required
		const escapedValue = this.wteHandlers.escapeTplArgWT(kv.value, {
			serializeAsNamed: kv.serializeAsNamed || param !== numericIndex.toString(),
			type: type,
			argPositionalIndex: numericIndex,
			numPositionalArgs: numPositionalArgs,
			argIndex: argIndex++,
			numArgs: tplKeysFromDataMw.length,
		});
		if (escapedValue.serializeAsNamed) {
			// WS trimming for values of named args
			argBuf.push({ dpKey: param, name: kv.name, value: escapedValue.v.trim() });
		} else {
			numericIndex++;
			// No WS trimming for positional args
			argBuf.push({ dpKey: param, name: null, value: escapedValue.v });
		}
	}

	// If no explicit format is provided, default format is:
	// - 'inline' for new args
	// - whatever format is available from data-parsoid for old args
	// (aka, overriding formatParamName/formatParamValue)
	//
	// If an unedited node OR if paramFormat is unspecified,
	// this strategy prevents unnecessary normalization
	// of edited transclusions which don't have valid
	// templatedata formatting information.

	// "magic case": If the format string ends with a newline, an extra newline is added
	// between the template name and the first parameter.
	var modFormatParamName, modFormatParamValue;

	for (const arg of argBuf) {
		let name = arg.name;
		const val  = arg.value;
		if (name === null) {
			// We are serializing a positional parameter.
			// Whitespace is significant for these and
			// formatting would change semantics.
			name = '';
			modFormatParamName = '|_';
			modFormatParamValue = '_';
		} else if (name === '') {
			// No spacing for blank parameters ({{foo|=bar}})
			// This should be an edge case and probably only for
			// inline-formatted templates, but we are consciously
			// forcing this default here. Can revisit if this is
			// ever a problem.
			modFormatParamName = '|_=';
			modFormatParamValue = '_';
		} else {
			// Preserve existing spacing, esp if there was a comment
			// embedded in it. Otherwise, follow TemplateData's lead.
			// NOTE: In either case, we are forcibly normalizing
			// non-block-formatted transclusions into block formats
			// by adding missing newlines.
			const spc = (dpArgInfoMap.get(arg.dpKey) || {}).spc;
			if (spc && (!format || Util.COMMENT_REGEXP.test(spc[3]))) {
				const nl = formatParamName.startsWith('\n') ? '\n' : '';
				modFormatParamName = nl + '|' + spc[0] + '_' + spc[1] + '=' + spc[2];
				modFormatParamValue = '_' + spc[3];
			} else {
				modFormatParamName = formatParamName;
				modFormatParamValue = formatParamValue;
			}
		}

		// Don't create duplicate newlines.
		const trailing = TRAILING_COMMENT_OR_WS_AFTER_NL_REGEXP.test(buf);
		if (trailing && formatParamName.startsWith('\n')) {
			modFormatParamName = formatParamName.slice(1);
		}

		buf += formatStringSubst(modFormatParamName, name, forceTrim);
		buf += formatStringSubst(modFormatParamValue, val, forceTrim);
	}

	// Don't create duplicate newlines.
	if (TRAILING_COMMENT_OR_WS_AFTER_NL_REGEXP.test(buf) && formatEnd.startsWith('\n')) {
		buf += formatEnd.slice(1);
	} else {
		buf += formatEnd;
	}

	if (formatEOL) {
		if (nextPart === null) {
			// This is the last part of the block. Add the \n only
			// if the next non-comment node is not a text node
			// of if the text node doesn't have a leading \n.
			let next = DOMUtils.nextNonDeletedSibling(node);
			while (next && DOMUtils.isComment(next)) {
				next = DOMUtils.nextNonDeletedSibling(next);
			}
			if (!DOMUtils.isText(next) || !/^\n/.test(next.nodeValue)) {
				buf += '\n';
			}
		} else if (typeof nextPart !== 'string' || !/^\n/.test(nextPart)) {
			// If nextPart is another template, and it wants a leading nl,
			// this \n we add here will count towards that because of the
			// formatSOL check at the top.
			buf += '\n';
		}
	}

	return buf;
});

WikitextSerializer.prototype.serializeFromParts = Promise.async(function *(state, node, srcParts) {
	var env = this.env;
	var useTplData = WTUtils.isNewElt(node) || DiffUtils.hasDiffMarkers(node, env);
	var buf = '';
	const numParts = srcParts.length;
	for (let i = 0; i < numParts; i++) {
		const part = srcParts[i];
		const prevPart = i > 0 ? srcParts[i - 1] : null;
		const nextPart = i < numParts - 1 ? srcParts[i + 1] : null;
		var tplarg = part.templatearg;
		if (tplarg) {
			buf = yield this.serializePart(state, buf, node, 'templatearg', tplarg, null, prevPart, nextPart);
			continue;
		}

		var tpl = part.template;
		if (!tpl) {
			buf += part;
			continue;
		}

		// transclusion: tpl or parser function
		var tplHref = tpl.target.href;
		var isTpl = typeof (tplHref) === 'string';
		var type = isTpl ? 'template' : 'parserfunction';

		// While the API supports fetching multiple template data objects in one call,
		// we will fetch one at a time to benefit from cached responses.
		//
		// Fetch template data for the template
		var tplData = null;
		var fetched = false;
		try {
			var apiResp = null;
			if (isTpl && useTplData) {
				var href = tplHref.replace(/^\.\//, '');
				apiResp = yield TemplateDataRequest.promise(env, href, Util.makeHash(["templatedata", href]));
			}
			tplData = apiResp && apiResp[Object.keys(apiResp)[0]];
			// If the template doesn't exist, or does but has no TemplateData,
			// ignore it
			if (tplData && (tplData.missing || tplData.notemplatedata)) {
				tplData = null;
			}
			fetched = true;
			buf = yield this.serializePart(state, buf, node, type, tpl, tplData, prevPart, nextPart);
		} catch (err) {
			if (fetched && tplData === null) {
				// Retrying won't help here.
				throw err;
			} else {
				// No matter what error we encountered (fetching tpldata
				// or using it), log the error, and use default serialization mode.
				env.log('error/html2wt/tpldata', err);
				buf = yield this.serializePart(state, buf, node, type, tpl, null, prevPart, nextPart);
			}
		}
	}
	return buf;
});

WikitextSerializer.prototype.serializeExtensionStartTag = Promise.async(function *(node, state) {
	var dataMw = DOMDataUtils.getDataMw(node);
	var extName = dataMw.name;

	// Serialize extension attributes in normalized form as:
	// key='value'
	// FIXME: with no dataAttribs, shadow info will mark it as new
	var attrs = dataMw.attrs || {};
	var extTok = new TagTk(extName, Object.keys(attrs).map(function(k) {
		return new KV(k, attrs[k]);
	}));

	if (node.hasAttribute('about')) {
		extTok.addAttribute('about', node.getAttribute('about'));
	}
	if (node.hasAttribute('typeof')) {
		extTok.addAttribute('typeof', node.getAttribute('typeof'));
	}

	var attrStr = yield this._serializeAttributes(node, extTok);
	var src = '<' + extName;
	if (attrStr) {
		src += ' ' + attrStr;
	}
	return src + (dataMw.body ? '>' : ' />');
});

WikitextSerializer.prototype.defaultExtensionHandler = Promise.async(function *(node, state) {
	var dataMw = DOMDataUtils.getDataMw(node);
	var src = yield this.serializeExtensionStartTag(node, state);
	if (!dataMw.body) {
		return src;  // We self-closed this already.
	} else if (typeof dataMw.body.extsrc === 'string') {
		src += dataMw.body.extsrc;
	} else {
		state.env.log('error/html2wt/ext', 'Extension src unavailable for: ' + node.outerHTML);
	}
	return src + '</' + dataMw.name + '>';
});

/**
 * Get a `domHandler` for an element node.
 * @private
 */
WikitextSerializer.prototype._getDOMHandler = function(node) {
	if (!node || !DOMUtils.isElt(node)) { return new DOMHandler(); }

	if (WTUtils.isFirstEncapsulationWrapperNode(node)) {
		return new EncapsulatedContentHandler();
	}

	var dp = DOMDataUtils.getDataParsoid(node);
	var nodeName = node.nodeName.toLowerCase();

	// If available, use a specialized handler for serializing
	// to the specialized syntactic form of the tag.
	var handler = tagHandlers.get(nodeName + '_' + dp.stx);

	// Unless a specialized handler is available, use the HTML handler
	// for html-stx tags. But, <a> tags should never serialize as HTML.
	if (!handler && dp.stx === 'html' && nodeName !== 'a') {
		return new FallbackHTMLHandler();
	}

	// If in a HTML table tag, serialize table tags in the table
	// using HTML tags, instead of native wikitext tags.
	if (Consts.HTML.ChildTableTags.has(node.nodeName)
		&& !Consts.ZeroWidthWikitextTags.has(node.nodeName)
		&& WTUtils.inHTMLTableTag(node)) {
		return new FallbackHTMLHandler();
	}

	// If parent node is a list in html-syntax, then serialize
	// list content in html-syntax rather than wiki-syntax.
	if (DOMUtils.isListItem(node)
		&& DOMUtils.isList(node.parentNode)
		&& WTUtils.isLiteralHTMLNode(node.parentNode)) {
		return new FallbackHTMLHandler();
	}

	// Pick the best available handler
	return handler || tagHandlers.get(nodeName) || new FallbackHTMLHandler();
};

WikitextSerializer.prototype.separatorREs = {
	pureSepRE: /^[ \t\r\n]*$/,
	sepPrefixWithNlsRE: /^[ \t]*\n+[ \t\r\n]*/,
	sepSuffixWithNlsRE: /\n[ \t\r\n]*$/,
};

/**
 * Consolidate separator handling when emitting text.
 * @private
 */
WikitextSerializer.prototype._serializeText = function(res, node, omitEscaping) {
	var state = this.state;

	// Deal with trailing separator-like text (at least 1 newline and other whitespace)
	var newSepMatch = res.match(this.separatorREs.sepSuffixWithNlsRE);
	res = res.replace(this.separatorREs.sepSuffixWithNlsRE, '');

	if (!state.inIndentPre) {
		// Strip leading newlines and other whitespace
		var match = res.match(this.separatorREs.sepPrefixWithNlsRE);
		if (match) {
			state.appendSep(match[0]);
			res = res.substring(match[0].length);
		}
	}

	if (omitEscaping) {
		state.emitChunk(res, node);
	} else {
		// Always escape entities
		res = Util.escapeWtEntities(res);

		// If not in pre context, escape wikitext
		// XXX refactor: Handle this with escape handlers instead!
		state.escapeText = (state.onSOL || !state.currNodeUnmodified) && !state.inHTMLPre;
		state.emitChunk(res, node);
		state.escapeText = false;
	}

	// Move trailing newlines into the next separator
	if (newSepMatch) {
		if (!state.sep.src) {
			state.appendSep(newSepMatch[0]);
		} else {
			/* SSS FIXME: what are we doing with the stripped NLs?? */
		}
	}
};

/**
 * Serialize the content of a text node
 * @private
 */
WikitextSerializer.prototype._serializeTextNode = Promise.method(function(node) {
	this._serializeText(node.nodeValue, node, false);
});

/**
 * Emit non-separator wikitext that does not need to be escaped.
 */
WikitextSerializer.prototype.emitWikitext = function(res, node) {
	this._serializeText(res, node, true);
};

// DOM-based serialization
WikitextSerializer.prototype._serializeDOMNode = Promise.async(function *(node, domHandler) {
	// To serialize a node from source, the node should satisfy these
	// conditions:
	//
	// 1. It should not have a diff marker or be in a modified subtree
	//    WTS should not be in a subtree with a modification flag that
	//    applies to every node of a subtree (rather than an indication
	//    that some node in the subtree is modified).
	//
	// 2. It should continue to be valid in any surrounding edited context
	//    For some nodes, modification of surrounding context
	//    can change serialized output of this node
	//    (ex: <td>s and whether you emit | or || for them)
	//
	// 3. It should have valid, usable DSR
	//
	// 4. Either it has non-zero positive DSR width, or meets one of the
	//    following:
	//
	//    4a. It is content like <p><br/><p> or an automatically-inserted
	//        wikitext <references/> (HTML <ol>) (will have dsr-width 0)
	//    4b. it is fostered content (will have dsr-width 0)
	//    4c. it is misnested content (will have dsr-width 0)
	//
	// SSS FIXME: Additionally, we can guard against buggy DSR with
	// some sanity checks. We can test that non-sep src content
	// leading wikitext markup corresponds to the node type.
	//
	// Ex: If node.nodeName is 'UL', then src[0] should be '*'
	//
	// TO BE DONE

	var state = this.state;
	var wrapperUnmodified = false;
	var dp = DOMDataUtils.getDataParsoid(node);

	dp.dsr = dp.dsr || [];

	if (state.selserMode
			&& !state.inModifiedContent
			&& WTSUtils.origSrcValidInEditedContext(state.env, node)
			&& dp && Util.isValidDSR(dp.dsr)
			&& (dp.dsr[1] > dp.dsr[0]
			// FIXME: <p><br/></p>
			// nodes that have dsr width 0 because currently,
			// we emit newlines outside the p-nodes. So, this check
			// tries to handle that scenario.
			|| (dp.dsr[1] === dp.dsr[0] &&
				(/^(P|BR)$/.test(node.nodeName) || DOMDataUtils.getDataMw(node).autoGenerated))
			|| dp.fostered || dp.misnested)) {

		if (!DiffUtils.hasDiffMarkers(node, this.env)) {
			// If this HTML node will disappear in wikitext because of
			// zero width, then the separator constraints will carry over
			// to the node's children.
			//
			// Since we dont recurse into 'node' in selser mode, we update the
			// separator constraintInfo to apply to 'node' and its first child.
			//
			// We could clear constraintInfo altogether which would be
			// correct (but could normalize separators and introduce dirty
			// diffs unnecessarily).

			state.currNodeUnmodified = true;

			if (WTUtils.isZeroWidthWikitextElt(node) &&
					node.hasChildNodes() &&
					state.sep.constraints.constraintInfo.sepType === 'sibling') {
				state.sep.constraints.constraintInfo.onSOL = state.onSOL;
				state.sep.constraints.constraintInfo.sepType = 'parent-child';
				state.sep.constraints.constraintInfo.nodeA = node;
				state.sep.constraints.constraintInfo.nodeB = node.firstChild;
			}

			var out = state.getOrigSrc(dp.dsr[0], dp.dsr[1]);

			this.trace("ORIG-src with DSR",
				() => '[' + dp.dsr[0] + ',' + dp.dsr[1] + '] = ' + JSON.stringify(out)
			);

			// When reusing source, we should only suppress serializing
			// to a single line for the cases we've whitelisted in
			// normal serialization.
			var suppressSLC = WTUtils.isFirstEncapsulationWrapperNode(node) ||
					['DL', 'UL', 'OL'].indexOf(node.nodeName) > -1 ||
					(node.nodeName === 'TABLE' &&
						node.parentNode.nodeName === 'DD' &&
						DOMUtils.previousNonSepSibling(node) === null);

			// Use selser to serialize this text!  The original
			// wikitext is `out`.  But first allow
			// `ConstrainedText.fromSelSer` to figure out the right
			// type of ConstrainedText chunk(s) to use to represent
			// `out`, based on the node type.  Since we might actually
			// have to break this wikitext into multiple chunks,
			// `fromSelSer` returns an array.
			if (suppressSLC) { state.singleLineContext.disable(); }
			ConstrainedText.fromSelSer(out, node, dp, state.env)
				.forEach(ct => state.emitChunk(ct, ct.node));
			if (suppressSLC) { state.singleLineContext.pop(); }

			// Skip over encapsulated content since it has already been
			// serialized.
			if (WTUtils.isFirstEncapsulationWrapperNode(node)) {
				return WTUtils.skipOverEncapsulatedContent(node);
			} else {
				return node.nextSibling;
			}
		}

		if (DiffUtils.onlySubtreeChanged(node, this.env) &&
				WTSUtils.hasValidTagWidths(dp.dsr) &&
				// In general, we want to avoid nodes with auto-inserted
				// start/end tags since dsr for them might not be entirely
				// trustworthy. But, since wikitext does not have closing tags
				// for tr/td/th in the first place, dsr for them can be trusted.
				//
				// SSS FIXME: I think this is only for b/i tags for which we do
				// dsr fixups. It may be okay to use this for other tags.
				((!dp.autoInsertedStart && !dp.autoInsertedEnd) ||
				/^(TD|TH|TR)$/.test(node.nodeName))) {
			wrapperUnmodified = true;
		}
	}

	state.currNodeUnmodified = false;

	var currentModifiedState = state.inModifiedContent;

	var inModifiedContent = state.selserMode &&
			DiffUtils.hasInsertedDiffMark(node, this.env);

	if (inModifiedContent) { state.inModifiedContent = true; }

	var next = yield domHandler.handle(node, state, wrapperUnmodified);

	if (inModifiedContent) { state.inModifiedContent = currentModifiedState; }

	return next;
});

/**
 * Internal worker. Recursively serialize a DOM subtree.
 * @private
 */
WikitextSerializer.prototype._serializeNode = Promise.async(function *(node) {
	var prev, domHandler, method;
	var state = this.state;

	if (state.selserMode) {
		this.trace(() => WTSUtils.traceNodeName(node),
			"; prev-unmodified:", state.prevNodeUnmodified,
			"; SOL:", state.onSOL);
	} else {
		this.trace(() => WTSUtils.traceNodeName(node),
			"; SOL:", state.onSOL);
	}

	switch (node.nodeType) {
		case node.ELEMENT_NODE:
			// Ignore DiffMarker metas, but clear unmodified node state
			if (DOMUtils.isDiffMarker(node)) {
				state.updateModificationFlags(node);
				// `state.sep.lastSourceNode` is cleared here so that removed
				// separators between otherwise unmodified nodes don't get
				// restored.
				state.updateSep(node);
				return node.nextSibling;
			}
			domHandler = this._getDOMHandler(node);
			console.assert(domHandler && domHandler.handle,
				'No dom handler found for', node.outerHTML);
			method = this._serializeDOMNode;
			break;
		case node.TEXT_NODE:
			// This code assumes that the DOM is in normalized form with no
			// run of text nodes.
			// Accumulate whitespace from the text node into state.sep.src
			var text = node.nodeValue;
			if (!state.inIndentPre &&
					text.match(state.serializer.separatorREs.pureSepRE)) {
				state.appendSep(text);
				return node.nextSibling;
			}
			if (state.selserMode) {
				prev = node.previousSibling;
				if (!state.inModifiedContent && (
					(!prev && DOMUtils.isBody(node.parentNode)) ||
					(prev && !DOMUtils.isDiffMarker(prev))
				)) {
					state.currNodeUnmodified = true;
				} else {
					state.currNodeUnmodified = false;
				}
			}
			domHandler = new DOMHandler();
			method = this._serializeTextNode;
			break;
		case node.COMMENT_NODE:
			// Merge this into separators
			state.appendSep(WTSUtils.commentWT(node.nodeValue));
			return node.nextSibling;
		default:
			console.assert("Unhandled node type:", node.outerHTML);
	}

	prev = DOMUtils.previousNonSepSibling(node) || node.parentNode;
	this.updateSeparatorConstraints(
			prev, this._getDOMHandler(prev),
			node, domHandler);

	var nextNode = yield method.call(this, node, domHandler);

	var next = DOMUtils.nextNonSepSibling(node) || node.parentNode;
	this.updateSeparatorConstraints(
		node, domHandler,
		next, this._getDOMHandler(next));

	// Update modification flags
	state.updateModificationFlags(node);

	// If handlers didn't provide a valid next node,
	// default to next sibling.
	if (nextNode === undefined) {
		nextNode = node.nextSibling;
	}
	return nextNode;
});

WikitextSerializer.prototype._stripUnnecessaryHeadingNowikis = function(line) {
	var state = this.state;
	if (!state.hasHeadingEscapes) {
		return line;
	}

	var escaper = function(wt) {
		var ret = state.serializer.wteHandlers.escapedText(state, false, wt, false, true);
		return ret;
	};

	var match = line.match(HEADING_NOWIKI_REGEXP);
	if (match && !COMMENT_OR_WS_REGEXP.test(match[2])) {
		// The nowiking was spurious since the trailing = is not in EOL position
		return escaper(match[1]) + match[2];
	} else {
		// All is good.
		return line;
	}
};

WikitextSerializer.prototype._stripUnnecessaryIndentPreNowikis = function() {
	var env = this.env;
	// FIXME: The solTransparentWikitextRegexp includes redirects, which really
	// only belong at the SOF and should be unique. See the "New redirect" test.
	const nowikiRE = JSUtils.escapeRegExpIgnoreCase('nowiki');
	var noWikiRegexp = new RegExp(
		'^' + env.conf.wiki.solTransparentWikitextNoWsRegexp.source +
		'(<' + nowikiRE + '>\\s+</' + nowikiRE + '>)([^\\n]*(?:\\n|$))', 'm'
	);
	var pieces = this.state.out.split(noWikiRegexp);
	var out = pieces[0];
	for (var i = 1; i < pieces.length; i += 4) {
		out += pieces[i];
		var nowiki = pieces[i + 1];
		var rest = pieces[i + 2];
		// Ignore comments
		var htmlTags = rest.match(/<[^!][^<>]*>/g) || [];

		// Not required if just sol transparent wt.
		var reqd = !env.conf.wiki.solTransparentWikitextRegexp.test(rest);

		if (reqd) {
			for (var j = 0; j < htmlTags.length; j++) {
				// Strip </, attributes, and > to get the tagname
				var tagName = htmlTags[j].replace(/<\/?|\s.*|>/g, '').toUpperCase();
				if (!Consts.HTML.HTML5Tags.has(tagName)) {
					// If we encounter any tag that is not a html5 tag,
					// it could be an extension tag. We could do a more complex
					// regexp or tokenize the string to determine if any block tags
					// show up outside the extension tag. But, for now, we just
					// conservatively bail and leave the nowiki as is.
					reqd = true;
					break;
				} else if (TokenUtils.isBlockTag(tagName)) {
					// FIXME: Extension tags shadowing html5 tags might not
					// have block semantics.
					// Block tags on a line suppress nowikis
					reqd = false;
				}
			}
		}

		if (!reqd) {
			nowiki = nowiki.replace(/^<nowiki>(\s+)<\/nowiki>/, '$1');
		} else if (env.scrubWikitext) {
			let oldRest;
			const wsReplacementRE = new RegExp(
				'^(' + env.conf.wiki.solTransparentWikitextNoWsRegexp.source + ")?\\s+"
			);
			// Replace all leading whitespace
			do {
				oldRest = rest;
				rest = rest.replace(wsReplacementRE, '$1');
			} while (rest !== oldRest);

			// Protect against sol-sensitive wikitext characters
			const solCharsTest = new RegExp(
				'^' + env.conf.wiki.solTransparentWikitextNoWsRegexp.source + "[=*#:;]"
			);
			nowiki = nowiki.replace(/^<nowiki>(\s+)<\/nowiki>/, solCharsTest.test(rest) ? '<nowiki/>' : '');
		}
		out = out + nowiki + rest + pieces[i + 3];
	}
	this.state.out = out;
};

// This implements a heuristic to strip two common sources of <nowiki/>s.
// When <i> and <b> tags are matched up properly,
// - any single ' char before <i> or <b> does not need <nowiki/> protection.
// - any single ' char before </i> or </b> does not need <nowiki/> protection.
WikitextSerializer.prototype._stripUnnecessaryQuoteNowikis = function(line) {
	if (!this.state.hasQuoteNowikis) {
		return line;
	}

	// Optimization: We are interested in <nowiki/>s before quote chars.
	// So, skip this if we don't have both.
	if (!(/<nowiki\s*\/>/.test(line) && /'/.test(line))) {
		return line;
	}

	// * Split out all the [[ ]] {{ }} '' ''' ''''' <..> </...>
	//   parens in the regexp mean that the split segments will
	//   be spliced into the result array as the odd elements.
	// * If we match up the tags properly and we see opening
	//   <i> / <b> / <i><b> tags preceded by a '<nowiki/>, we
	//   can remove all those nowikis.
	//   Ex: '<nowiki/>''foo'' bar '<nowiki/>'''baz'''
	// * If we match up the tags properly and we see closing
	//   <i> / <b> / <i><b> tags preceded by a '<nowiki/>, we
	//   can remove all those nowikis.
	//   Ex: ''foo'<nowiki/>'' bar '''baz'<nowiki/>'''
	var p = line.split(/('''''|'''|''|\[\[|\]\]|\{\{|\}\}|<\w+(?:\s+[^>]*?|\s*?)\/?>|<\/\w+\s*>)/);

	// Which nowiki do we strip out?
	var nowikiIndex = -1;

	// Verify that everything else is properly paired up.
	var stack = [];
	var quotesOnStack = 0;
	var n = p.length;
	var nonHtmlTag = null;
	for (var j = 1; j < n; j += 2) {
		// For HTML tags, pull out just the tag name for clearer code below.
		var tag = ((/^<(\/?\w+)/.exec(p[j]) || '')[1] || p[j]).toLowerCase();
		var selfClose = false;
		if (/\/>$/.test(p[j])) { tag += '/'; selfClose = true; }

		// Ignore non-html-tag (<nowiki> OR extension tag) blocks
		if (!nonHtmlTag) {
			if (this.env.conf.wiki.extConfig.tags.has(tag)) {
				nonHtmlTag = tag;
				continue;
			}
		} else {
			if (tag[0] === '/' && tag.slice(1) === nonHtmlTag) {
				nonHtmlTag = null;
			}
			continue;
		}

		if (tag === ']]') {
			if (stack.pop() !== '[[') { return line; }
		} else if (tag === '}}') {
			if (stack.pop() !== '{{') { return line; }
		} else if (tag[0] === '/') { // closing html tag
			// match html/ext tags
			var opentag = stack.pop();
			if (tag !== ('/' + opentag)) {
				return line;
			}
		} else if (tag === 'nowiki/') {
			// We only want to process:
			// - trailing single quotes (bar')
			// - or single quotes by themselves without a preceding '' sequence
			if (/'$/.test(p[j - 1]) && !(p[j - 1] === "'" && /''$/.test(p[j - 2])) &&
				// Consider <b>foo<i>bar'</i>baz</b> or <b>foo'<i>bar'</i>baz</b>.
				// The <nowiki/> before the <i> or </i> cannot be stripped
				// if the <i> is embedded inside another quote.
				(quotesOnStack === 0
				// The only strippable scenario with a single quote elt on stack
				// is: ''bar'<nowiki/>''
				//   -> ["", "''", "bar'", "<nowiki/>", "", "''"]
				|| (quotesOnStack === 1
					&& j + 2 < n
					&& p[j + 1] === ""
					&& p[j + 2][0] === "'"
					&& p[j + 2] === lastItem(stack))
				)) {
				nowikiIndex = j;
			}
			continue;
		} else if (selfClose || tag === "br") {
			// Skip over self-closing tags or what should have been self-closed.
			// ( While we could do this for all void tags defined in
			//   mediawiki.wikitext.constants.js, <br> is the most common
			//   culprit. )
			continue;
		} else if (tag[0] === "'" && lastItem(stack) === tag) {
			stack.pop();
			quotesOnStack--;
		} else {
			stack.push(tag);
			if (tag[0] === "'") { quotesOnStack++; }
		}
	}

	if (stack.length) { return line; }

	if (nowikiIndex !== -1) {
		// We can only remove the final trailing nowiki.
		//
		// HTML  : <i>'foo'</i>
		// line  : ''<nowiki/>'foo'<nowiki/>''
		p[nowikiIndex] = '';
		return p.join('');
	} else {
		return line;
	}
};

/**
 * Serialize an HTML DOM document.
 * WARNING: You probably want to use {@link FromHTML.serializeDOM} instead.
 */
WikitextSerializer.prototype.serializeDOM = Promise.async(function *(body, selserMode) {
	console.assert(DOMUtils.isBody(body), 'Expected a body node.');
	// `editedDoc` is simply body's ownerDocument.  However, since we make
	// recursive calls to WikitextSerializer.prototype.serializeDOM with elements from dom fragments
	// from data-mw, we need this to be set prior to the initial call.
	// It's mainly required for correct serialization of citations in some
	// scenarios (Ex: <ref> nested in <references>).
	console.assert(this.env.page.editedDoc, 'Should be set.');

	if (!selserMode) {
		// Strip <section> tags
		// Selser mode will have done that already before running dom-diff
		ContentUtils.stripSectionTagsAndFallbackIds(body);
	}

	this.logType = selserMode ? "trace/selser" : "trace/wts";
	this.trace = (...args) => this.env.log(this.logType, ...args);

	var state = this.state;
	state.initMode(selserMode);

	// Normalize the DOM
	(new DOMNormalizer(state)).normalize(body);

	var psd = this.env.conf.parsoid;
	if (psd.dumpFlags && psd.dumpFlags.has("dom:post-normal")) {
		ContentUtils.dumpDOM(body, 'DOM: post-normal', { storeDiffMark: true, env: this.env });
	}

	yield state._kickOffSerialize(body);

	if (state.hasIndentPreNowikis) {
		// FIXME: Perhaps this can be done on a per-line basis
		// rather than do one post-pass on the entire document.
		//
		// Strip excess/useless nowikis
		this._stripUnnecessaryIndentPreNowikis();
	}

	var splitLines = state.selserMode ||
		state.hasQuoteNowikis ||
		state.hasSelfClosingNowikis ||
		state.hasHeadingEscapes;

	if (splitLines) {
		state.out = state.out.split('\n').map((line) => {
			// Strip excess/useless nowikis
			//
			// FIXME: Perhaps this can be done on a per-line basis
			// rather than do one post-pass on the entire document.
			line = this._stripUnnecessaryQuoteNowikis(line);

			// Strip (useless) trailing <nowiki/>s
			// Interim fix till we stop introducing them in the first place.
			//
			// Don't strip |param = <nowiki/> since that pattern is used
			// in transclusions and where the trailing <nowiki /> is a valid
			// template arg. So, use a conservative regexp to detect that usage.
			line = line.replace(/^([^=]*?)(?:<nowiki\s*\/>\s*)+$/, '$1');

			// Get rid of spurious heading nowiki escapes
			line = this._stripUnnecessaryHeadingNowikis(line);
			return line;
		}).join('\n');
	}

	if (state.redirectText && state.redirectText !== 'unbuffered') {
		var firstLine = state.out.split('\n', 1)[0];
		var nl = /^(\s|$)/.test(firstLine) ? '' : '\n';
		state.out = state.redirectText + nl + state.out;
	}

	return state.out;
});

if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
