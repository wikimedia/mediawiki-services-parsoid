/*
 * Chunk-based serialization support.
 *
 * Keeping wikitext output in `ConstrainedText` chunks allows us to
 * preserve meta-information about boundary conditions at the edges
 * of chunks.  This allows us to more easily add `<nowiki>` and other
 * fixups where needed to prevent misparsing caused by juxtaposition.
 *
 * For example, the chunk corresponding to a magic link can "remember"
 * that it needs to have word boundaries on either side.  If these aren't
 * present (after the chunks on either side have been serialized) then
 * we can add <nowiki> escapes at the proper places.
 */
'use strict';
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var Util = require('./mediawiki.Util.js').Util;
var WTSUtils = require('./wts.utils.js').WTSUtils;
var util = require('util');

/*
 * This adds necessary escapes to a line of chunks.  We provide
 * the `ConstrainedText#escape` function with its left and right
 * context, and it can determine what escapes are needed.
 *
 * The `line` parameter is an array of `ConstrainedText` *chunks*
 * which make up a line (or part of a line, in some cases of nested
 * processing).
 * @private
 */
var escapeLine = function(line, cb) {
	// The left context will be precise (that is, it is the result
	// of `ConstrainedText#escape` and will include any escapes
	// triggered by chunks on the left), but the right context
	// is just the (unescaped) text property from the chunk.
	// As we work left to right we will piece together a fully-escaped
	// string.  Be careful not to shoot yourself in the foot -- if the
	// escaped text is significantly different from the chunk's `text`
	// property, the preceding chunk may not have made the correct
	// decisions about emitting an escape suffix.  We could solve
	// this by looping until the state converges (or until we detect
	// a loop) but for now let's hope that's not necessary.
	var state = {
		leftContext: '',
		rightContext: line.map(function(ct) { return ct.text; }).join(''),
		line: line,
		pos: 0,
	};
	var safeLeft = '';
	for (state.pos = 0; state.pos < line.length; state.pos++) {
		var chunk = line[state.pos];
		// Process the escapes for this chunk, given escaped previous chunk
		state.rightContext = state.rightContext.slice(chunk.text.length);
		var thisEscape = chunk.escape(state);
		var origPos = state.leftContext.length;
		state.leftContext +=
			(thisEscape.prefix || '') + thisEscape.text + (thisEscape.suffix || '');
		if (cb) {
			cb(state.leftContext.slice(origPos), chunk.node);
		}
		if (thisEscape.greedy) {
			// protect the left context: this will be matched greedily
			// by this chunk, so there's no chance that a subsequent
			// token will include this in its prefix.
			safeLeft += state.leftContext;
			state.leftContext = '';
		}
	}
	// right context should be empty here.
	return safeLeft + state.leftContext;
};

/**
 * A chunk of wikitext output.  This base class contains the
 * wikitext and a pointer to the DOM node which is responsible for
 * generating it.  Subclasses can add additional properties to record
 * context or wikitext boundary restrictions for proper escaping.
 * The chunk is serialized with the `escape` method, which might
 * alter the wikitext in order to ensure it doesn't run together
 * with its context (usually by adding `<nowiki>` tags).
 * @class ConstrainedText
 */
/**
 * @method constructor
 * @param {Object} args Options
 * @param {string} args.text The text string associated with this chunk.
 * @param {Node} args.node The DOM {@link Node} associated with this chunk.
 * @param {string} [args.prefix]
 *  The prefix string to add if the start of the chunk doesn't match its
 *  constraints.
 * @param {string} [args.suffix]
 *  The suffix string to add if the end of the chunk doesn't match its
 *  constraints.
 */
var ConstrainedText = function ConstrainedText(args) {
	this.text = args.text;
	this.node = args.node;
	if (args.prefix !== undefined || args.suffix !== undefined) {
		// save space in the object in the common case of no prefix/suffix
		this.prefix = args.prefix;
		this.suffix = args.suffix;
	}
};
/**
 * Ensure that the argument `o`, which is perhaps a string, is a instance of
 * `ConstrainedText`.
 * @param {string|ConstrainedText} o
 * @param {Node} node
 *   The DOM {@link Node} corresponding to `o`.
 * @return {ConstrainedText}
 * @static
 */
ConstrainedText.cast = function(o, node) {
	if (o instanceof ConstrainedText) { return o; }
	return new ConstrainedText({ text: o, node: node });
};
/**
 * Use the provided `state`, which gives context and access to the entire
 * list of chunks, to determine the proper escape prefix/suffix.
 * Returns an object with a `text` property as well as optional
 * `prefix` and 'suffix' properties giving desired escape strings.
 * @param {Object} state
 * @return {Object}
 * @return {string} return.text
 * @return {string} [return.prefix]
 * @return {string} [return.suffix]
 */
ConstrainedText.prototype.escape = function(state) {
	// default implementation: no escaping, no prefixes or suffixes.
	return { text: this.text, prefix: this.prefix, suffix: this.suffix }; // jscs:ignore jsDoc
};
/**
 * Simple equality.  This enforces type equality (ie subclasses are not equal)
 * @param {Object} ct
 * @return {boolean}
 */
ConstrainedText.prototype.equals = function(ct) {
	return this === ct ||
		(this.constructor === ConstrainedText &&
			ct.constructor === ConstrainedText &&
			this.text === ct.text);
};
/**
 * Useful shortcut: execute a regular expression on the raw wikitext.
 * @param {RegExp} re
 * @return {Array|null}
 *  An Array containing the matched results or null if there were no matches.
 */
ConstrainedText.prototype.match = function(re) {
	return this.text.match(re);
};

/**
 * SelSer support: when we come across an unmodified node in during
 * selective serialization, we know we can use the original wikitext
 * for that node unmodified.  *But* there may be boundary conditions
 * on the left and right sides of the selser'ed text which are going
 * to require escaping.
 *
 * So rather than turning the node into a plain old `ConstrainedText`
 * chunk, allow subclasses of `ConstrainedText` to register as potential
 * handlers of selser nodes.  A selser'ed magic link, for example,
 * will then turn into a `MagicLinkText` and thus be able to enforce
 * the proper boundary constraints.
 * @method fromSelSer
 * @static
 * @param {string} text
 * @param {Node} node
 * @param {Object} dataParsoid
 * @param {MWParserEnvironment} env
 * @param {Object} opts
 */
// Main dispatch point: iterate through registered subclasses, asking
// each if they can handle this node (by invoking `_fromSelSer`).
ConstrainedText.fromSelSer = function(text, node, dataParsoid, env, opts) {
	// We define parent types before subtypes, so search the list backwards
	// to be sure we check subtypes before parent types.
	var types = ConstrainedText._types;
	for (var i = types.length - 1; i >= 0; i--) {
		var ct = types[i]._fromSelSer &&
			types[i]._fromSelSer(text, node, dataParsoid, env, opts);
		if (!ct) { continue; }
		if (!Array.isArray(ct)) { ct = [ct]; }
		// tag these chunks as coming from selser
		ct.forEach(function(t) { t.selser = true; });
		return ct;
	}
	// ConstrainedText._fromSelSer should handle everything which reaches it
	// so nothing should make it here.
	throw new Error("Should never happen.");
};

/**
 * Base case: the given node type does not correspond to a special
 * `ConstrainedText` subclass.  We still have to be careful: the leftmost
 * (rightmost) children of `node` may still be exposed to our left (right)
 * context.  If so (ie, their DSR bounds coincide) split the selser text
 * and emit multiple `ConstrainedText` chunks to preserve the proper
 * boundary conditions.
 * @method
 * @static
 * @private
 */
ConstrainedText._fromSelSer = function(text, node, dataParsoid, env, opts) {
	// look at leftmost and rightmost children, it may be that we need
	// to turn these into ConstrainedText chunks in order to preserve
	// the proper escape conditions on the prefix/suffix text.
	var firstChild = DU.firstNonDeletedChildNode(node);
	var lastChild = DU.lastNonDeletedChildNode(node);
	var firstChildDp = firstChild && DU.getDataParsoid(firstChild);
	var lastChildDp = lastChild && DU.getDataParsoid(lastChild);
	var prefixChunks = [];
	var suffixChunks = [];
	var len;
	var ignorePrefix = opts && opts.ignorePrefix;
	var ignoreSuffix = opts && opts.ignoreSuffix;
	// check to see if first child's DSR start is the same as this node's
	// DSR start.  If so, the first child is exposed to the (modified)
	// left-hand context, and so recursively convert it to the proper
	// list of specialized chunks.
	if (!ignorePrefix &&
		firstChildDp && Util.isValidDSR(firstChildDp.dsr) &&
		dataParsoid.dsr[0] === firstChildDp.dsr[0]) {
		len = firstChildDp.dsr[1] - firstChildDp.dsr[0];
		prefixChunks = ConstrainedText.fromSelSer(
			text.slice(0, len), firstChild, firstChildDp, env,
			// this child node's right context will be protected:
			{ ignoreSuffix: true }
		);
		text = text.slice(len);
	}
	// check to see if last child's DSR end is the same as this node's
	// DSR end.  If so, the last child is exposed to the (modified)
	// right-hand context, and so recursively convert it to the proper
	// list of specialized chunks.
	if (!ignoreSuffix && lastChild !== firstChild &&
		lastChildDp && Util.isValidDSR(lastChildDp.dsr) &&
		dataParsoid.dsr[1] === lastChildDp.dsr[1]) {
		len = lastChildDp.dsr[1] - lastChildDp.dsr[0];
		suffixChunks = ConstrainedText.fromSelSer(
			text.slice(-len), lastChild, lastChildDp, env,
			// this child node's left context will be protected:
			{ ignorePrefix: true }
		);
		text = text.slice(0, -len);
	}
	// glue together prefixChunks, whatever's left of `text`, and suffixChunks
	var chunks = [ ConstrainedText.cast(text, node) ];
	chunks = prefixChunks.concat(chunks, suffixChunks);
	// top-level chunks only:
	if (!(ignorePrefix || ignoreSuffix)) {
		// ensure that the first chunk belongs to `node` in order to
		// emit separators correctly before `node`
		if (chunks[0].node !== node) {
			chunks.unshift(ConstrainedText.cast('', node));
		}
		// set 'noSep' flag on all but the first chunk, so we don't get
		// extra separators from `emitSepAndOutput`
		chunks.forEach(function(t, i) {
			if (i > 0) { t.noSep = true; }
		});
	}
	return chunks;
};

ConstrainedText._types = [ ConstrainedText ];
/**
 * Add a subtype to the list of types we attempt `fromSelSer` with.
 * @static
 * @method
 * @param {ConstrainedText} subtype A subclass of {@link ConstrainedText}
 */
ConstrainedText.register = function(subtype) {
	ConstrainedText._types.push(subtype);
};
// Helper: `util.inherits` plus subtype registration.
var inherits = function(thisType, parentType) {
	util.inherits(thisType, parentType);
	ConstrainedText.register(thisType);
};

var matcher = function(re, invert) {
	return function(context) { return re.test(context) ? !invert : invert; };
};

/**
 * This subclass allows specification of a regular expression for
 * acceptable (or prohibited) leading (and/or trailing) contexts.
 * @class
 * @extends ConstrainedText
 * @constructor
 * @inheritdoc
 * @param {Object} args
 * @param {RegExp} args.goodPrefix
 * @param {RegExp} args.goodSuffix
 */
var RegExpConstrainedText = function RegExpConstrainedText(args) {
	RegExpConstrainedText.super_.call(this, args);
	this.prefix = args.prefix !== undefined ? args.prefix : '<nowiki/>';
	this.suffix = args.suffix !== undefined ? args.suffix : '<nowiki/>';
	// functions which return true if escape prefix/suffix need to be added
	this.prefixMatcher = args.goodPrefix ? matcher(args.goodPrefix, true) :
		args.badPrefix ? matcher(args.badPrefix, false) : false;
	this.suffixMatcher = args.goodSuffix ? matcher(args.goodSuffix, true) :
		args.badSuffix ? matcher(args.badSuffix, false) : false;
};
util.inherits(RegExpConstrainedText, ConstrainedText);

RegExpConstrainedText.prototype.escape = function(state) {
	var result = { text: this.text };
	if (this.prefixMatcher && this.prefixMatcher(state.leftContext)) {
		result.prefix = this.prefix;
	}
	if (this.suffixMatcher && this.suffixMatcher(state.rightContext)) {
		result.suffix = this.suffix;
	}
	return result;
};

/**
 * An internal wiki link, like `[[Foo]]`.
 * @class
 * @extends RegExpConstrainedText
 * @constructor
 * @param {string} text
 * @param {Node} node
 * @param {WikiConfig} wikiConfig
 * @param {string} type
 *   The type of the link, as described by the `rel` attribute.
 */
var WikiLinkText = function WikiLinkText(text, node, wikiConfig, type) {
	// category links/external links/images don't use link trails or prefixes
	var noTrails = !/^mw:(Wiki|Ext)Link$/.test(type);
	WikiLinkText.super_.call(this, {
		text: text,
		node: node,
		badPrefix: noTrails ? undefined : wikiConfig.linkPrefixRegex,
		badSuffix: noTrails ? undefined : wikiConfig.linkTrailRegex,
	});
	// We match link trails greedily when they exist.
	if (!(noTrails || /\]$/.test(text))) {
		this.greedy = true;
	}
};
inherits(WikiLinkText, RegExpConstrainedText);
WikiLinkText.prototype.escape = function(state) {
	var r = WikiLinkText.super_.prototype.escape.call(this, state);
	// If previous token was also a WikiLink, its linktrail will
	// eat up any possible linkprefix characters, so we don't need
	// a <nowiki> in this case.  (Eg: [[a]]-[[b]] in iswiki; the -
	// character is both a link prefix and a link trail, but it gets
	// preferentially associated with the [[a]] as a link trail.)
	r.greedy = this.greedy;
	return r;
};
WikiLinkText._fromSelSer = function(text, node, dataParsoid, env) {
	// interwiki links have type == 'mw:ExtLink', but they are written
	// with [[ ]] and get link trails -- so as far as we're concerned
	// they are WikiLinks.
	var type = node.getAttribute('rel') || '';
	var stx = dataParsoid.stx || '';
	if (/^mw:(Wiki|Ext)Link$/.test(type) && /^(simple|piped)$/.test(stx)) {
		return new WikiLinkText(text, node, env.conf.wiki, type);
	}
};

/**
 * An external link, like `[http://example.com]`.
 * @class
 * @extends ConstrainedText
 * @constructor
 * @param {string} text
 * @param {Node} node
 * @param {WikiConfig} wikiConfig
 * @param {string} type
 *   The type of the link, as described by the `rel` attribute.
 */
var ExtLinkText = function ExtLinkText(text, node, wikiConfig, type) {
	ExtLinkText.super_.call(this, {
		text: text,
		node: node,
	});
};
inherits(ExtLinkText, ConstrainedText);
ExtLinkText._fromSelSer = function(text, node, dataParsoid, env) {
	var type = node.getAttribute('rel') || '';
	var stx = dataParsoid.stx || '';
	if (type === 'mw:ExtLink' && !/^(simple|piped)$/.test(stx)) {
		return new ExtLinkText(text, node, env.conf.wiki, type);
	}
};

// build regexps representing the trailing context for an autourl link
// This regexp comes from the PHP parser's EXT_LINK_URL_CLASS regexp.
var EXT_LINK_URL_CLASS = /[^\[\]<>"\x00-\x20\x7F\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]/.source.slice(1, -1);
// This set of trailing punctuation comes from Parser.php::makeFreeExternalLink
var TRAILING_PUNCT = /[,;\\.:!?]/.source.slice(1, -1);
var NOT_LTGT = /(?!&(lt|gt);)/.source;

var AUTOURL_BAD_PAREN = new RegExp("^" + NOT_LTGT + "[" + TRAILING_PUNCT + "]*[" + EXT_LINK_URL_CLASS + TRAILING_PUNCT + "]");
// if the URL has an doesn't have an open paren in it, TRAILING PUNCT will
// include ')' as well.
var AUTOURL_BAD_NOPAREN = new RegExp("^" + NOT_LTGT + "[" + TRAILING_PUNCT + "\\)]*[" + EXT_LINK_URL_CLASS + TRAILING_PUNCT + "\\)]");

/**
 * An autolink to an external resource, like `http://example.com`.
 * @class
 * @extends RegExpConstrainedText
 * @constructor
 * @param {string} url
 * @param {Node} node
 */
var AutoURLLinkText = function AutoURLLinkText(url, node) {
	AutoURLLinkText.super_.call(this, {
		text: url,
		node: node,
		// there's a \b boundary at start, and first char of url is a word char
		badPrefix: /\w$/,
		badSuffix: /\(/.test(url) ? AUTOURL_BAD_PAREN : AUTOURL_BAD_NOPAREN,
	});
};
inherits(AutoURLLinkText, RegExpConstrainedText);
AutoURLLinkText._fromSelSer = function(text, node, dataParsoid, env) {
	if ((node.tagName === 'A' && dataParsoid.stx === 'url') ||
		(node.tagName === 'IMG' && dataParsoid.type === 'extlink')) {
		return new AutoURLLinkText(text, node);
	}
};

/**
 * An autolink to an RFC/PMID/ISBN, like `RFC 1234`.
 * @class
 * @extends RegExpConstrainedText
 * @constructor
 * @param {string} text
 * @param {Node} node
 */
var MagicLinkText = function MagicLinkText(text, node) {
	MagicLinkText.super_.call(this, {
		text: text,
		node: node,
		// there are \b boundaries on either side, and first/last characters
		// are word characters.
		badPrefix: /\w$/,
		badSuffix: /^\w/,
	});
};
inherits(MagicLinkText, RegExpConstrainedText);
MagicLinkText._fromSelSer = function(text, node, dataParsoid, env) {
	if (dataParsoid.stx === 'magiclink') {
		return new MagicLinkText(text, node);
	}
};

module.exports = {
	ConstrainedText: ConstrainedText,
	RegExpConstrainedText: RegExpConstrainedText,
	AutoURLLinkText: AutoURLLinkText,
	ExtLinkText: ExtLinkText,
	MagicLinkText: MagicLinkText,
	WikiLinkText: WikiLinkText,
	escapeLine: escapeLine,
};
