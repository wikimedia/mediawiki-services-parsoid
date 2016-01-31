'use strict';
require('../../core-upgrade.js');

var ConstrainedText = require('./ConstrainedText.js').ConstrainedText;
var DU = require('../utils/DOMUtils.js').DOMUtils;
var JSUtils = require('../utils/jsutils.js').JSUtils;
var Promise = require('../utils/promise.js');
var Util = require('../utils/Util.js').Util;
var WTSUtils = require('./WTSUtils.js').WTSUtils;

var escapeLine = require('./ConstrainedText.js').escapeLine;

/* *********************************************************************
 * Here is what the state attributes mean:
 *
 * rtTestMode
 *    Are we currently running round-trip tests?  If yes, then we know
 *    there won't be any edits and we more aggressively try to use original
 *    source and source flags during serialization since this is a test of
 *    Parsoid's efficacy in preserving information.
 *
 * sep
 *    Separator information:
 *    - constraints: min/max number of newlines
 *    - text: collected separator text from DOM text/comment nodes
 *    - lastSourceNode: -- to be documented --
 *
 * onSOL
 *    Is the serializer at the start of a new wikitext line?
 *
 * atStartOfOutput
 *    True when wts kicks off, false after the first char has been output
 *
 * inLink
 *    Is the serializer currently handling link content (children of <a>)?
 *
 * inIndentPre
 *    Is the serializer currently handling indent-pre tags?
 *
 * inPHPBlock
 *    Is the serializer currently handling a tag that the PHP parser
 *    treats as a block tag?
 *
 * inAttribute
 *    Is the serializer being invoked recursively to serialize a
 *    template-generated attribute (via WSP.getAttributeValue's
 *    template handling).  If so, we should suppress some
 *    serialization escapes, like autolink protection, since
 *    these are not valid for attribute values.
 *
 * hasIndentPreNowikis
 *    Did we introduce nowikis for indent-pre protection?
 *    If yes, we might run a post-pass to strip useless ones.
 *
 * hasQuoteNowikis
 *    Did we introduce nowikis to preserve quote semantics?
 *    If yes, we might run a post-pass to strip useless ones.
 *
 * hasSelfClosingNowikis:
 *    Did we introduce <nowiki />s?
 *    If yes, we do a postpass to remove unnecessary trailing ones.
 *
 * hasHeadingEscapes:
 *    Did we introduce nowikis around =.*= text?
 *    If yes, we do a postpass to remove unnecessary escapes.
 *
 * wikiTableNesting
 *    Records the nesting level of wikitext tables
 *
 * wteHandlerStack
 *    Stack of wikitext escaping handlers -- these handlers are responsible
 *    for smart escaping when the surrounding wikitext context is known.
 *
 * currLine
 *    This object is used by the wikitext escaping algorithm -- represents
 *    a "single line" of output wikitext as represented by a block node in
 *    the DOM.
 *
 *    - firstNode: first DOM node processed on this line
 *    - text: output so far from all nodes on the current line
 *    - chunks: list of ConstrainedText chunks comprising the current line
 *
 * singleLineContext
 *    Stack used to enforce single-line context
 * ********************************************************************* */

var initialState = {
	rtTestMode: true,
	sep: {},
	onSOL: true,
	escapeText: false,
	atStartOfOutput: true, // SSS FIXME: Can this be done away with in some way?
	inIndentPre: false,
	inPHPBlock: false,
	inAttribute: false,
	hasIndentPreNowikis: false,
	hasSelfClosingNowikis: false,
	hasQuoteNowikis: false,
	hasHeadingEscapes: false,
	wikiTableNesting: 0,
	wteHandlerStack: [],
	// XXX: replace with output buffering per line
	currLine: null,
	out: '',
	logPrefix: 'OUT:',
};

// Make sure the initialState is never modified
JSUtils.deepFreeze(initialState);

// Stack and helpers to enforce single-line context while serializing
function SingleLineContext() {
	this._stack = [];
}

var SLCP = SingleLineContext.prototype;

SLCP.enforce = function() {
	this._stack.push(true);
};

SLCP.enforced = function() {
	return this._stack.length > 0 && JSUtils.lastItem(this._stack);
};

SLCP.disable = function() {
	this._stack.push(false);
};

SLCP.pop = function() {
	this._stack.pop();
};

/**
 * @class
 * @constructor
 */
function SerializerState(serializer, options) {
	this.env = serializer.env;
	this.serializer = serializer;
	// Make sure options and initialState are cloned,
	// so we don't alter the initial state for later serializer runs.
	Util.extendProps(this, Util.clone(options), Util.clone(initialState));
	this.resetCurrLine(null);
	this.singleLineContext = new SingleLineContext();
}

var SSP = SerializerState.prototype;

/**
 */
SSP.initMode = function(selserMode) {
	this.selserMode = selserMode || false;
	this.rtTestMode = this.rtTestMode &&
			!this.selserMode;  // Always false in selser mode.
};

/**
 */
SSP.setSep = function(src) {
	this.sep.src = src;
	this.sepIntroducedSOL(src);
};

/**
 */
SSP.updateSep = function(node) {
	this.sep.lastSourceNode = node;
	this.sep.lastSourceSep = this.sep.src;
};

/**
 */
SSP.resetCurrLine = function(node) {
	this.currLine = {
		text: '',
		chunks: [],
		firstNode: node,
	};
};

/**
 */
SSP.flushLine = function() {
	this.out += escapeLine(this.currLine.chunks);
	this.currLine.chunks.length = 0;
};

/**
 * Serialize the children of a DOM node, sharing the global serializer state.
 * Typically called by a DOM-based handler to continue handling its children.
 */
SSP.serializeChildren = Promise.method(function(node, wtEscaper) {
	// SSS FIXME: Unsure if this is the right thing always
	if (wtEscaper) { this.wteHandlerStack.push(wtEscaper); }

	var serializeNextChild = Promise.method(function(child) {
		if (child === null) { return; }
		return this.serializer._serializeNode(child).then(function(next) {
			if (next === node) { return; }  // Serialized all children
			if (next === child) { next = next.nextSibling; }  // Advance
			return serializeNextChild(next);
		});
	}).bind(this);

	return serializeNextChild(node.firstChild).then(function() {
		if (wtEscaper) { this.wteHandlerStack.pop(); }

		// If we serialized children explicitly,
		// we were obviously processing a modified node.
		this.currNodeUnmodified = false;
	}.bind(this));
});

/**
 */
SSP.getOrigSrc = function(start, end) {
	console.assert(this.selserMode);
	return this.env.page.src.substring(start, end);
};

/**
 */
SSP.updateModificationFlags = function(node) {
	this.prevNodeUnmodified = this.currNodeUnmodified;
	this.currNodeUnmodified = false;
	this.prevNode = node;
};

/**
 * Separators put us in SOL state.
 */
SSP.sepIntroducedSOL = function(sep) {
	// Don't get tripped by newlines in comments!  Be wary of nowikis added
	// by makeSepIndentPreSafe on the last line.
	if (sep.replace(Util.COMMENT_REGEXP_G, '').search(/\n$/) !== -1) {
		// Since we are stashing away newlines for emitting
		// before the next element, we are in SOL state wrt
		// the content of that next element.
		//
		// FIXME: The only serious caveat is if all these newlines
		// will get stripped out in the context of any parent node
		// that suppress newlines (ex: <li> nodes that are forcibly
		// converted to non-html wikitext representation -- newlines
		// will get suppressed in those context). We currently don't
		// handle arbitrary HTML which cause these headaches. And,
		// in any case, we might decide to emit such HTML as native
		// HTML to avoid these problems. To be figured out later when
		// it is a real issue.
		this.onSOL = true;
	}
};

/**
 */
SSP.push = function(text, node) {
	this.currLine.chunks.push(ConstrainedText.cast(text, node));
};

/**
 */
SSP.pushSep = function(sep, node, debugPrefix) {
	// Replace newlines if we're in a single-line context
	if (this.singleLineContext.enforced()) {
		sep = sep.replace(/\n/g, ' ');
	}

	this.push(sep, node);

	// Reset separator state
	this.sep = {};
	this.sepIntroducedSOL(sep || '');

	this.env.log(this.serializer.logType,
		"--->", debugPrefix,
		function() { return JSON.stringify(sep); });
};

SSP.emitChunk = function(res, node) {
	res = ConstrainedText.cast(res, node);

	// Replace newlines if we're in a single-line context
	if (this.singleLineContext.enforced()) {
		res.text = res.text.replace(/\n/g, ' ');
	}

	/* --------------------------------------------------------------------------
	 * When block nodes are deleted, the deletion affects whether unmodified
	 * newline separators between a pair of unmodified P tags can be reused.
	 *
	 * Example:
	 * Original WT  : "<div>x</div>foo\nbar"
	 * Original HTML: "<div>x</div><p>foo</p>\n<p>bar</p>"
	 * Edited HTML  : "<p>foo</p>\n<p>bar</p>"
	 * Annotated DOM: "<mw:DiffMarker is-block><p>foo</p>\n<p>bar</p>"
	 * Expected WT  : "foo\n\nbar"
	 *
	 * Note the additional newline between "foo" and "bar" even though originally,
	 * there was just a single newline.
	 *
	 * So, even though the two P tags and the separator between them is
	 * unmodified, it is insufficient to rely on just that. We have to look at
	 * what has happened on the two wikitext lines onto which the two P tags
	 * will get serialized.
	 *
	 * Now, if you check the code for 'nextToDeletedBlockNodeInWT', that code is
	 * not really looking at ALL the nodes before/after the nodes that could
	 * serialize onto the wikitext lines. It is looking at the immediately
	 * adjacent nodes, i.e. it is not necessary to look if a block-tag was
	 * deleted 2 or 5 siblings away. If we had to actually examine all of those,
	 * nodes, this would get very complex, and it would be much simpler to just
	 * discard the original separators => potentially lots of dirty diffs.
	 *
	 * To understand why it is sufficient (for correctness) to examine just
	 * the immediately adjacent nodes, let us look at an additional example.
	 *
	 * Original WT  : "a<div>b</div>c<div>d</div>e\nf"
	 * Original HTML: "<p>a</p><div>b</div><p>c</p><div>d</div><p>e</p>\n<p>f</p>"
	 *
	 * Note how <block> tags and <p> tags interleave in the HTML. This would be
	 * the case always no matter how much inline content showed up between the
	 * block tags in wikitext. If the b-<div> was deleted, we don't care
	 * about it, since we still have the d-<div> before the P tag that preserves
	 * the correctness of the single "\n" separator. If the d-<div> was deleted,
	 * we conservatively ignore the original separator and let normal P-P constraints
	 * take care of it. At worst, we might generate a dirty diff in this scenario.
	 * -------------------------------------------------------------------------- */
	var origSepUsable =
		this.prevNodeUnmodified && !DU.nextToDeletedBlockNodeInWT(this.env, this.sep.lastSourceNode, true) &&
		this.currNodeUnmodified && !DU.nextToDeletedBlockNodeInWT(this.env, node, false);

	// Emit separator first
	if (res.noSep) {
		/* skip separators for internal tokens fromSelSer */
	} else {
		var origSep;
		if (origSepUsable) {
			if (this.prevNode && DU.isElt(this.prevNode) && DU.isElt(node)) {
				origSep = this.getOrigSrc(
					DU.getDataParsoid(this.prevNode).dsr[1],
					DU.getDataParsoid(node).dsr[0]
				);
			} else {
				origSep = this.sep.src;
			}
		}

		if (origSep !== undefined && WTSUtils.isValidSep(origSep)) {
			this.pushSep(origSep, node, 'ORIG-SEP:');
		} else {
			var sep = this.serializer.buildSep(node);
			if (sep !== undefined) {
				this.pushSep(sep, node, 'SEP:');
			}
		}
	}

	if (this.onSOL) {
		// process escapes in our full line
		this.flushLine();
		this.resetCurrLine(node);
	}

	// Escape 'res' if necessary
	if (this.escapeText) {
		res = new ConstrainedText({
			text: this.serializer.wteHandlers.escapeWikiText(res.text, {
				node: node,
				isLastChild: DU.nextNonDeletedSibling(node) === null,
			}),
			prefix: res.prefix,
			suffix: res.suffix,
			node: res.node,
		});
		this.escapeText = false;
	} else {
		// If 'res' is coming from selser and the current node is a paragraph tag,
		// check if 'res' might need some leading chars nowiki-escaped before being output.
		// Because of block-tag p-wrapping behavior, sol-sensitive characters that used to
		// be in non-sol positions, but yet wrapped in p-tags, could end up in sol-position
		// if those block tags get deleted during edits.
		//
		// Ex: a<div>foo</div>*b
		// -- wt2html --> <p>a</p><div>foo<div><p>*b</p>
		// --   EDIT  --> <p>a</p><p>*b</p>
		// -- html2wt --> a\n\n<nowiki>*</nowiki>b
		//
		// In this scenario, the <p>a</p>, <p>*b</p>, and <p>#c</p>
		// will be marked unmodified and will be processed below.
		if (this.selserMode
			&& this.onSOL
			&& this.currNodeUnmodified
			// 'node' came from original Parsoid HTML unmodified. So, if its content
			// needs nowiki-escaping, we know that the reason it didn't parse into
			// lists/headings/whatever is because it didn't occur at the start of the
			// line => it had a block-tag in the original wikitext. So if the previous
			// node was also unmodified (and since it also came from original Parsoid
			// HTML), we can safely infer that it couldn't have been an inline node or
			// a P-tag (if it were, the p-wrapping code would have swallowed that content
			// into 'node'). So, it would have to be some sort of block tag => this.onSOL
			// couldn't have been true (because we could have serialized 'node' on the
			// same line as the block tag) => we can save some effort by eliminating
			// scenarios where 'this.prevNodeUnmodified' is true.
			&& !this.prevNodeUnmodified
			&& node.nodeName === 'P' && !DU.isLiteralHTMLNode(node)) {
			var pChild = DU.firstNonSepChildNode(node);
			// If a text node, we have to make sure that the text doesn't
			// get reparsed as non-text in the wt2html pipeline.
			if (pChild && DU.isText(pChild)) {
				var solWikitextRE = JSUtils.rejoin(
					'^((?:', Util.COMMENT_REGEXP,
					'|',
					// SSS FIXME: What about onlyinclude and noinclude?
					/<includeonly>.*?<\/includeonly>/,
					')*)',
					/([ \*#:;{\|!=].*)$/
				);
				var match = res.match(solWikitextRE);
				if (match && match[2]) {
					if (/^([\*#:;]|{\||.*=$)/.test(match[2]) ||
						// ! and | chars are harmless outside tables
						(/^[\|!]/.test(match[2]) && this.wikiTableNesting > 0) ||
						// indent-pres are suppressed inside <blockquote>
						(/^ [^\s]/.test(match[2]) && !DU.hasAncestorOfName(node, 'BLOCKQUOTE'))) {
						res = ConstrainedText.cast((match[1] || '') +
							'<nowiki>' + match[2][0] + '</nowiki>' +
							match[2].substring(1), node);
					}
				}
			}
		}
	}

	// Emitting text that has not been escaped
	this.currLine.text += res.text;

	// Output res
	this.env.log(this.serializer.logType, '--->', this.logPrefix, function() {
		return JSON.stringify(res instanceof ConstrainedText ? res.text : res);
	});
	this.push(res, node);

	// Update separator state
	this.updateSep(node);

	// Update sol flag. Test for
	// newlines followed by optional includeonly or comments
	var solRE = JSUtils.rejoin(
		/(^|\n)/,
		'(',
		// SSS FIXME: What about onlyinclude and noinclude?
		/<includeonly>.*?<\/includeonly>/,
		'|',
		Util.COMMENT_REGEXP,
		')*$'
	);
	if (!solRE.test(res)) {
		this.onSOL = false;
	}

	// We've emit something so we're no longer at SOO.
	this.atStartOfOutput = false;
};

/**
 * Serialize children to a string.
 * Does not affect the separator state.
 */
SSP._serializeChildrenToString = Promise.method(function(node, wtEscaper, inState) {
	// FIXME: Make sure that the separators emitted here conform to the
	// syntactic constraints of syntactic context.
	var oldSep = this.sep;
	var oldSOL = this.onSOL;
	var oldOut = this.out;
	var oldStart = this.atStartOfOutput;
	var oldChunks = this.currLine.chunks;
	var oldLogPrefix = this.logPrefix;

	this.out = '';
	this.logPrefix = 'OUT(C):';
	this.sep = {};
	this.onSOL = false;
	this.atStartOfOutput = false;
	this.currLine.chunks = [];
	this[inState] = true;

	return this.serializeChildren(node, wtEscaper).then(function() {
		// Emit child-parent seps.
		this.emitChunk('', node);
		// We've reached EOF, flush the remaining buffered text.
		this.flushLine();

		// restore the state
		var bits = this.out;
		this.out = oldOut;
		this[inState] = false;
		this.sep = oldSep;
		this.onSOL = oldSOL;
		this.atStartOfOutput = oldStart;
		this.currLine.chunks = oldChunks;
		this.logPrefix = oldLogPrefix;
		return bits;
	}.bind(this));
});

SSP.serializeLinkChildrenToString = Promise.method(function(node, wtEscaper) {
	return this._serializeChildrenToString(node, wtEscaper, 'inLink');
});

SSP.serializeCaptionChildrenToString = Promise.method(function(node, wtEscaper) {
	return this._serializeChildrenToString(node, wtEscaper, 'inCaption');
});

SSP.serializeIndentPreChildrenToString = Promise.method(function(node, wtEscaper) {
	return this._serializeChildrenToString(node, wtEscaper, 'inIndentPre');
});


if (typeof module === "object") {
	module.exports.SerializerState = SerializerState;
}
