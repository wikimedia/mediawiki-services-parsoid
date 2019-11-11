/**
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
 * @module
 */

'use strict';

const { DOMDataUtils } = require('../utils/DOMDataUtils.js');
const { DOMUtils } = require('../utils/DOMUtils.js');
const { JSUtils } = require('../utils/jsutils.js');
const { Util } = require('../utils/Util.js');

/**
 * A chunk of wikitext output.  This base class contains the
 * wikitext and a pointer to the DOM node which is responsible for
 * generating it.  Subclasses can add additional properties to record
 * context or wikitext boundary restrictions for proper escaping.
 * The chunk is serialized with the `escape` method, which might
 * alter the wikitext in order to ensure it doesn't run together
 * with its context (usually by adding `<nowiki>` tags).
 *
 * The main entry point is the static function `ConstrainedText.escapeLine()`.
 */
class ConstrainedText {
	/**
	 * This adds necessary escapes to a line of chunks.  We provide
	 * the `ConstrainedText#escape` function with its left and right
	 * context, and it can determine what escapes are needed.
	 *
	 * The `line` parameter is an array of `ConstrainedText` *chunks*
	 * which make up a line (or part of a line, in some cases of nested
	 * processing).
	 * @param {ConstrainedText[]} line
	 * @return {string}
	 * @static
	 */
	static escapeLine(line) {
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
			state.leftContext +=
				(thisEscape.prefix || '') + thisEscape.text + (thisEscape.suffix || '');
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
	}

	/**
	 * @param {Object} args Options.
	 * @param {string} args.text The text string associated with this chunk.
	 * @param {Node} args.node The DOM {@link Node} associated with this chunk.
	 * @param {string} [args.prefix]
	 *  The prefix string to add if the start of the chunk doesn't match its
	 *  constraints.
	 * @param {string} [args.suffix]
	 *  The suffix string to add if the end of the chunk doesn't match its
	 *  constraints.
	 */
	constructor(args) {
		this.text = args.text;
		this.node = args.node;
		if (args.prefix !== undefined || args.suffix !== undefined) {
			// save space in the object in the common case of no prefix/suffix
			this.prefix = args.prefix;
			this.suffix = args.suffix;
		}
	}

	/**
	 * Ensure that the argument `o`, which is perhaps a string, is a instance of
	 * `ConstrainedText`.
	 * @param {string|ConstrainedText} o
	 * @param {Node} node
	 *   The DOM {@link Node} corresponding to `o`.
	 * @return {ConstrainedText}
	 * @static
	 */
	static cast(o, node) {
		if (o instanceof ConstrainedText) { return o; }
		return new ConstrainedText({ text: o || '', node: node });
	}

	/**
	 * Use the provided `state`, which gives context and access to the entire
	 * list of chunks, to determine the proper escape prefix/suffix.
	 * Returns an object with a `text` property as well as optional
	 * `prefix` and 'suffix' properties giving desired escape strings.
	 * @param {Object} state
	 * @return {Object}
	 * @return {string} Return.text.
	 * @return {string} [return.prefix].
	 * @return {string} [return.suffix].
	 */
	escape(state) {
		// default implementation: no escaping, no prefixes or suffixes.
		return { text: this.text, prefix: this.prefix, suffix: this.suffix };
	}

	/**
	 * Simple equality.  This enforces type equality (ie subclasses are not equal).
	 * @param {Object} ct
	 * @return {boolean}
	 */
	equals(ct) {
		return this === ct ||
			(this.constructor === ConstrainedText &&
				ct.constructor === ConstrainedText &&
				this.text === ct.text);
	}

	/**
	 * Useful shortcut: execute a regular expression on the raw wikitext.
	 * @param {RegExp} re
	 * @return {Array|null}
	 *  An Array containing the matched results or null if there were no matches.
	 */
	match(re) {
		return this.text.match(re);
	}

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
	 * @static
	 * @param {string} text
	 * @param {Node} node
	 * @param {Object} dataParsoid
	 * @param {MWParserEnvironment} env
	 * @param {Object} opts
	 */
	// Main dispatch point: iterate through registered subclasses, asking
	// each if they can handle this node (by invoking `_fromSelSer`).
	static fromSelSer(text, node, dataParsoid, env, opts) {
		// We define parent types before subtypes, so search the list backwards
		// to be sure we check subtypes before parent types.
		var types = this._types;
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
	}

	/**
	 * Base case: the given node type does not correspond to a special
	 * `ConstrainedText` subclass.  We still have to be careful: the leftmost
	 * (rightmost) children of `node` may still be exposed to our left (right)
	 * context.  If so (ie, their DSR bounds coincide) split the selser text
	 * and emit multiple `ConstrainedText` chunks to preserve the proper
	 * boundary conditions.
	 * @static
	 * @private
	 */
	static _fromSelSer(text, node, dataParsoid, env, opts) {
		// look at leftmost and rightmost children, it may be that we need
		// to turn these into ConstrainedText chunks in order to preserve
		// the proper escape conditions on the prefix/suffix text.
		var firstChild = DOMUtils.firstNonDeletedChild(node);
		var lastChild = DOMUtils.lastNonDeletedChild(node);
		var firstChildDp = DOMUtils.isElt(firstChild) && DOMDataUtils.getDataParsoid(firstChild);
		var lastChildDp = DOMUtils.isElt(lastChild) && DOMDataUtils.getDataParsoid(lastChild);
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
			// extra separators from `SSP.emitChunk`
			chunks.forEach(function(t, i) {
				if (i > 0) { t.noSep = true; }
			});
		}
		return chunks;
	}
}

/**
 * This subclass allows specification of a regular expression for
 * acceptable (or prohibited) leading (and/or trailing) contexts.
 *
 * This is an *abstract* class; it's intended to be subclassed, not
 * used directly, and so it not included in the lists of types
 * tried by `fromSelSer`.
 *
 * @class
 * @extends ~ConstrainedText
 * @inheritdoc
 * @param {Object} args
 * @param {RegExp} args.goodPrefix
 * @param {RegExp} args.goodSuffix
 */
class RegExpConstrainedText extends ConstrainedText {
	constructor(args) {
		super(args);
		this.prefix = args.prefix !== undefined ? args.prefix : '<nowiki/>';
		this.suffix = args.suffix !== undefined ? args.suffix : '<nowiki/>';
		// functions which return true if escape prefix/suffix need to be added
		const matcher = (re, invert) => ((context) => {
			return re.test(context) ? !invert : invert;
		});
		this.prefixMatcher = args.goodPrefix ? matcher(args.goodPrefix, true) :
			args.badPrefix ? matcher(args.badPrefix, false) : false;
		this.suffixMatcher = args.goodSuffix ? matcher(args.goodSuffix, true) :
			args.badSuffix ? matcher(args.badSuffix, false) : false;
	}

	/** @inheritdoc */
	escape(state) {
		var result = { text: this.text };
		if (this.prefixMatcher && this.prefixMatcher(state.leftContext)) {
			result.prefix = this.prefix;
		}
		if (this.suffixMatcher && this.suffixMatcher(state.rightContext)) {
			result.suffix = this.suffix;
		}
		return result;
	}
}

/**
 * An internal wiki link, like `[[Foo]]`.
 * @class
 * @extends ~RegExpConstrainedText
 * @param {string} text
 * @param {Node} node
 * @param {WikiConfig} wikiConfig
 * @param {string} type
 *   The type of the link, as described by the `rel` attribute.
 */
class WikiLinkText extends RegExpConstrainedText {
	constructor(text, node, wikiConfig, type) {
		// category links/external links/images don't use link trails or prefixes
		var noTrails = !/^mw:WikiLink(\/Interwiki)?$/.test(type);
		var badPrefix = /(^|[^\[])(\[\[)*\[$/;
		if (!noTrails && wikiConfig.linkPrefixRegex) {
			badPrefix = JSUtils.rejoin('(', wikiConfig.linkPrefixRegex, ')|(', badPrefix, ')', { flags: 'u' });
		}
		super({
			text: text,
			node: node,
			badPrefix: badPrefix,
			badSuffix: noTrails ? undefined : wikiConfig.linkTrailRegex,
		});
		// We match link trails greedily when they exist.
		if (!(noTrails || /\]$/.test(text))) {
			this.greedy = true;
		}
	}

	escape(state) {
		var r = super.escape(state);
		// If previous token was also a WikiLink, its linktrail will
		// eat up any possible linkprefix characters, so we don't need
		// a <nowiki> in this case.  (Eg: [[a]]-[[b]] in iswiki; the -
		// character is both a link prefix and a link trail, but it gets
		// preferentially associated with the [[a]] as a link trail.)
		r.greedy = this.greedy;
		return r;
	}

	static _fromSelSer(text, node, dataParsoid, env) {
		var type = node.getAttribute('rel') || '';
		var stx = dataParsoid.stx || '';
		// TODO: Leaving this for backwards compatibility, remove when 1.5 is no longer bound
		if (type === 'mw:ExtLink') {
			type = 'mw:WikiLink/Interwiki';
		}
		if (/^mw:WikiLink(\/Interwiki)?$/.test(type) && /^(simple|piped)$/.test(stx)) {
			return new WikiLinkText(text, node, env.conf.wiki, type);
		}
	}
}

/**
 * An external link, like `[http://example.com]`.
 * @class
 * @extends ~ConstrainedText
 * @param {string} text
 * @param {Node} node
 * @param {WikiConfig} wikiConfig
 * @param {string} type
 *   The type of the link, as described by the `rel` attribute.
 */
class ExtLinkText extends ConstrainedText {
	constructor(text, node, wikiConfig, type) {
		super({
			text: text,
			node: node,
		});
	}

	static _fromSelSer(text, node, dataParsoid, env) {
		var type = node.getAttribute('rel') || '';
		var stx = dataParsoid.stx || '';
		if (type === 'mw:ExtLink' && !/^(simple|piped)$/.test(stx)) {
			return new ExtLinkText(text, node, env.conf.wiki, type);
		}
	}
}

/**
 * An autolink to an external resource, like `http://example.com`.
 * @class
 * @extends ~RegExpConstrainedText
 * @param {string} url
 * @param {Node} node
 */
class AutoURLLinkText extends RegExpConstrainedText {
	constructor(url, node) {
		super({
			text: url,
			node: node,
			// there's a \b boundary at start, and first char of url is a word char
			badPrefix: /\w$/,
			badSuffix: AutoURLLinkText.badSuffix(url),
		});
		// Hack around the difference between PHP \w and JS \w
		this.prefixMatcher = function(leftContext) {
			return Util.isUniWord(Util.lastUniChar(leftContext));
		};
	}

	static badSuffix(url) {
		// Cache the constructed regular expressions.
		if (this._badSuffix) { return this._badSuffix(url); }
		// build regexps representing the trailing context for an autourl link
		// This regexp comes from the PHP parser's EXT_LINK_URL_CLASS regexp.
		const EXT_LINK_URL_CLASS = /[^\[\]<>"\x00-\x20\x7F\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]/.source.slice(1, -1);
		// This set of trailing punctuation comes from Parser.php::makeFreeExternalLink
		const TRAILING_PUNCT = /[,;\\.:!?]/.source.slice(1, -1);
		const NOT_LTGTNBSP = /(?!&(lt|gt|nbsp|#x0*(3[CcEe]|[Aa]0)|#0*(60|62|160));)/.source;
		const NOT_QQ = /(?!'')/.source;

		const PAREN_AUTOURL_BAD_SUFFIX = new RegExp("^" + NOT_LTGTNBSP + NOT_QQ + "[" + TRAILING_PUNCT + "]*[" + EXT_LINK_URL_CLASS + TRAILING_PUNCT + "]");
		// if the URL has an doesn't have an open paren in it, TRAILING PUNCT will
		// include ')' as well.
		const NOPAREN_AUTOURL_BAD_SUFFIX = new RegExp("^" + NOT_LTGTNBSP + NOT_QQ + "[" + TRAILING_PUNCT + "\\)]*[" + EXT_LINK_URL_CLASS + TRAILING_PUNCT + "\\)]");
		this._badSuffix = (url) => {
			return /\(/.test(url) ? PAREN_AUTOURL_BAD_SUFFIX : NOPAREN_AUTOURL_BAD_SUFFIX;
		};
		return this._badSuffix(url);
	}

	static _fromSelSer(text, node, dataParsoid, env) {
		if ((node.tagName === 'A' && dataParsoid.stx === 'url') ||
			(node.tagName === 'IMG' && dataParsoid.type === 'extlink')) {
			return new AutoURLLinkText(text, node);
		}
	}

	// Special case for entities which "leak off the end".
	escape(state) {
		var r = super.escape(state);
		// If the text ends with an incomplete entity, be careful of
		// suffix text which could complete it.
		if (!r.suffix &&
			(/&[#0-9a-zA-Z]*$/.test(r.text)) &&
			(/^[#0-9a-zA-Z]*;/.test(state.rightContext))) {
			r.suffix = this.suffix;
		}
		return r;
	}
}

/**
 * An autolink to an RFC/PMID/ISBN, like `RFC 1234`.
 * @class
 * @extends ~RegExpConstrainedText
 * @param {string} text
 * @param {Node} node
 */
class MagicLinkText extends RegExpConstrainedText {
	constructor(text, node) {
		super({
			text: text,
			node: node,
			// there are \b boundaries on either side, and first/last characters
			// are word characters.
			badPrefix: /\w$/,
			badSuffix: /^\w/,
		});
		// Hack around the difference between PHP \w and JS \w
		this.prefixMatcher = function(leftContext) {
			return Util.isUniWord(Util.lastUniChar(leftContext));
		};
		this.suffixMatcher = function(rightContext) {
			return Util.isUniWord(rightContext);
		};
	}

	static _fromSelSer(text, node, dataParsoid, env) {
		if (dataParsoid.stx === 'magiclink') {
			return new MagicLinkText(text, node);
		}
	}
}

/**
 * Language Variant markup, like `-{ ... }-`.
 * @class
 * @extends ~RegExpConstrainedText
 * @param {string} text
 * @param {Node} node
 */
class LanguageVariantText extends RegExpConstrainedText {
	constructor(text, node) {
		super({
			text: text,
			node: node,
			// at sol vertical bars immediately preceding cause problems in tables
			badPrefix: /^\|$/,
		});
	}

	static _fromSelSer(text, node, dataParsoid, env) {
		if (node.getAttribute('typeof') === 'mw:LanguageVariant') {
			return new LanguageVariantText(text, node);
		}
	}
}

/**
 * List of types we attempt `fromSelSer` with.  This should include all the
 * concrete subclasses of `ConstrainedText` (`RegExpConstrainedText` is
 * missing since it is an abstract class).  We also include the
 * `ConstrainedText` class as the first element (even though it is
 * an abstract base class) as a little bit of a hack: it simplifies
 * `ConstrainedText.fromSelSer` by factoring some of its work into
 * `ConstrainedText._fromSelSer`.
 */
ConstrainedText._types = [
	// Base class is first, as a special case
	ConstrainedText,
	// All concrete subclasses of ConstrainedText
	WikiLinkText, ExtLinkText, AutoURLLinkText,
	MagicLinkText, LanguageVariantText,
];

module.exports = {
	ConstrainedText: ConstrainedText,
	RegExpConstrainedText: RegExpConstrainedText,
	AutoURLLinkText: AutoURLLinkText,
	ExtLinkText: ExtLinkText,
	LanguageVariantText: LanguageVariantText,
	MagicLinkText: MagicLinkText,
	WikiLinkText: WikiLinkText,
};
