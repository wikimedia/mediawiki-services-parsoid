/* ----------------------------------------------------------------------
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
 * example, generic a elements are serialized to HTML a tags), but in general
 * support for this is mostly missing.
 *
 * Example issue:
 * <h1><p>foo</p></h1> will serialize to =\nfoo\n= whereas the
 *        correct serialized output would be: =<p>foo</p>=
 *
 * What to do about this?
 * * add a generic 'can this HTML node be serialized to wikitext in this
 *   context' detection method and use that to adaptively switch between
 *   wikitext and HTML serialization
 * ---------------------------------------------------------------------- */

"use strict";

require('./core-upgrade.js');
var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	wtConsts = require('./mediawiki.wikitext.constants.js'),
	Consts = wtConsts.WikitextConstants,
	JSUtils = require('./jsutils.js').JSUtils,
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	pd = require('./mediawiki.parser.defines.js'),
	Title = require('./mediawiki.Title.js').Title,
	minimizeWTQuoteTags = require('./dom.minimizeWTQuoteTags.js').minimizeWTQuoteTags,
	SanitizerConstants = require('./ext.core.Sanitizer.js').SanitizerConstants;

function isValidSep(sep) {
	return sep.match(/^(\s|<!--([^\-]|-(?!->))*-->)*$/);
}

function isValidDSR(dsr) {
	return dsr &&
		typeof(dsr[0]) === 'number' && dsr[0] >= 0 &&
		typeof(dsr[1]) === 'number' && dsr[1] >= 0;
}

function hasValidTagWidths(dsr) {
	return dsr &&
		typeof(dsr[2]) === 'number' && dsr[2] >= 0 &&
		typeof(dsr[3]) === 'number' && dsr[3] >= 0;
}

/**
 * Emit the start tag source when not round-trip testing, or when the node is
 * not marked with autoInsertedStart
 */
var emitStartTag = function (src, node, state, cb) {
	if (!state.rtTesting) {
		cb(src, node);
	} else if ( !DU.getDataParsoid( node ).autoInsertedStart ) {
		cb(src, node);
	}
	// else: drop content
};

/**
 * Emit the start tag source when not round-trip testing, or when the node is
 * not marked with autoInsertedStart
 */
var emitEndTag = function (src, node, state, cb) {
	if (!state.rtTesting) {
		cb(src, node);
	} else if ( !DU.getDataParsoid( node ).autoInsertedEnd ) {
		cb(src, node);
	}
	// else: drop content
};

function commentWT(comment) {
	return '<!--' + comment.replace(/-->/, '--&gt;') + '-->';
}

function isHtmlBlockTag(name) {
	return name === 'body' || Util.isBlockTag(name);
}

function isTd(token) {
	return token && token.constructor === pd.TagTk && token.name === 'td';
}

function isListItem(token) {
	return token && token.constructor === pd.TagTk &&
		['li', 'dt', 'dd'].indexOf(token.name) !== -1;
}

function precedingSeparatorTxt(n) {
	// Given the CSS white-space property and specifically,
	// "pre" and "pre-line" values for this property, it seems that any
	// sane HTML editor would have to preserve IEW in HTML documents
	// to preserve rendering. One use-case where an editor might change
	// IEW drastically would be when the user explicitly requests it
	// (Ex: pretty-printing of raw source code).
	//
	// For now, we are going to exploit this.  This information is
	// only used to extrapolate DSR values and extract a separator
	// string from source, and is only used locally.  In addition,
	// the extracted text is verified for being a valid separator.
	//
	// So, at worst, this can create a local dirty diff around separators
	// and at best, it gets us a clean diff.

	var buf = '', orig = n;
	while (n) {
		if (DU.isIEW(n)) {
			buf += n.nodeValue;
		} else if (n.nodeType === n.COMMENT_NODE) {
			buf += "<!--";
			buf += n.nodeValue;
			buf += "-->";
		} else if (n !== orig) { // dont return if input node!
			return null;
		}

		n = n.previousSibling;
	}

	return buf;
}

// ignore the cases where the serializer adds newlines not present in the dom
function startsOnANewLine( node ) {
	var name = node.nodeName.toUpperCase();
	return Consts.BlockScopeOpenTags.has( name ) &&
		!DU.isLiteralHTMLNode( node ) &&
		name !== "BLOCKQUOTE";
}

// look ahead on current line for block content
function hasBlocksOnLine( node, first ) {

	// special case for firstNode:
	// we're at sol so ignore possible \n at first char
	if ( first ) {
		if ( node.textContent.substring( 1 ).match( /\n/ ) ) {
			return false;
		}
		node = node.nextSibling;
	}

	while ( node ) {
		if ( DU.isElt( node ) ) {
			if ( DU.isBlockNode( node ) ) {
				return !startsOnANewLine( node );
			}
			if ( node.childNodes.length > 0 ) {
				if ( hasBlocksOnLine( node.firstChild, false ) ) {
					return true;
				}
			}
		} else {
			if ( node.textContent.match( /\n/ ) ) {
				return false;
			}
		}
		node = node.nextSibling;
	}
	return false;

}

// Empty constructor
var WikitextEscapeHandlers = function(env) {
	this.urlParser = new PegTokenizer(env);
};

var WEHP = WikitextEscapeHandlers.prototype;

WEHP.isFirstContentNode = function(node) {
	// Conservative but safe
	if (!node) {
		return true;
	}

	// Skip deleted-node markers
	return DU.previousNonDeletedSibling(node) === null;
};

WEHP.headingHandler = function(headingNode, state, text, opts) {
	// Since we are now adding space around '=' chars in new headings
	// there is no need to escape '=' chars in text.
	if (DU.isNewElt(headingNode)) {
		return false;
	}

	// Only "=" at the extremities trigger escaping
	if (opts.isLastChild && DU.isText(headingNode.firstChild)) {
		var line = state.currLine.text;
		if (line.length === 0) {
			line = text;
		}
		return line[0] === '=' &&
			text && text.length > 0 && text[text.length-1] === '=';
	} else {
		return false;
	}
};

WEHP.liHandler = function(liNode, state, text, opts) {
	// For <dt> nodes, ":" anywhere trigger nowiki
	// For first nodes of <li>'s, bullets in sol posn trigger escaping
	if (liNode.nodeName === 'DT' && /:/.test(text)) {
		return true;
	} else if (state.currLine.text === '' && this.isFirstContentNode(opts.node)) {
		return text.match(/^[#\*:;]/);
	} else {
		return false;
	}
};

WEHP.quoteHandler = function(state, text, opts) {
	// SSS FIXME: Can be refined
	if (text.match(/'$/)) {
		var next = DU.nextNonDeletedSibling(opts.node);
		return next === null || Consts.WTQuoteTags.has(next.nodeName);
	} else if (text.match(/^'/)) {
		var prev = DU.previousNonDeletedSibling(opts.node);
		return prev === null || Consts.WTQuoteTags.has(prev.nodeName);
	}

	return false;
};

WEHP.thHandler = function(state, text) {
	return text.match(/!!|\|\|/);
};

WEHP.wikilinkHandler = function(state, text) {
	return text.match(/(^\|)|(\[\[)|(\]\])|(^[^\[]*\]$)/);
};

WEHP.aHandler = function(state, text) {
	return text.match(/\]$/);
};

WEHP.tdHandler = function(tdNode, state, text, opts) {
	// If 'text' is on the same wikitext line as the "|" corresponding
	// to the <td>,
	// * | in a td should be escaped
	// * +- in SOL position for the first node on the current line should be escaped
	return (!opts.node || state.currLine.firstNode === tdNode) &&
		text.match(/\|/) || (
			!state.inWideTD &&
			state.currLine.text === '' &&
			// Has to be the first content node in the <td>.
			// In <td><a ..>..</a>-foo</td>, even though "-foo" meets the other conditions,
			// we don't need to escape it.
			this.isFirstContentNode(opts.node) &&
			text.match(/^[\-+]/)
		);
};

WEHP.hasWikitextTokens = function ( state, onNewline, options, text, linksOnly ) {
	if (this.traceWTE) {
		console.warn("WTE-tokenize: nl:" + onNewline + ":text=" + JSON.stringify(text));
	}

	// tokenize the text

	var sol = onNewline && !(state.inIndentPre || state.inPPHPBlock);
	var tokens = state.serializer.tokenizeStr(state, text, sol);

	// If the token stream has a pd.TagTk, pd.SelfclosingTagTk, pd.EndTagTk or pd.CommentTk
	// then this text needs escaping!
	var numEntities = 0;
	for (var i = 0, n = tokens.length; i < n; i++) {
		var t = tokens[i];

		if (this.traceWTE) {
			console.warn("T: " + JSON.stringify(t));
		}

		var tc = t.constructor;

		// Ignore non-whitelisted html tags
		if (t.isHTMLTag()) {
			if (/(?:^|\s)mw:Extension(?=$|\s)/.test(t.getAttribute("typeof")) &&
				options.extName !== t.getAttribute("name"))
			{
				return true;
			}

			// Always escape isolated extension tags (bug 57469). Consider this:
			//    echo "&lt;ref&gt;foo<p>&lt;/ref&gt;</p>" | node parse --html2wt
			// The <ref> and </ref> tag-like text is spread across the DOM, and in
			// the worst case can be anywhere. So, we conservatively escape these
			// elements always (which can lead to excessive nowiki-escapes in some
			// cases, but is always safe).
			if ((tc === pd.TagTk || tc === pd.EndTagTk) &&
				state.env.conf.wiki.isExtensionTag(t.name))
			{
				return true;
			}

			if (!Consts.Sanitizer.TagWhiteList.has( t.name.toUpperCase() )) {
				continue;
			}
		}

		if (tc === pd.SelfclosingTagTk) {
			// * Ignore extlink tokens without valid urls
			// * Ignore RFC/ISBN/PMID tokens when those are encountered in the
			//   context of another link's content -- those are not parsed to
			//   ext-links in that context.
			if (t.name === 'extlink' &&
				(!this.urlParser.tokenizeURL(t.getAttribute("href"))) ||
				state.inLink && t.dataAttribs && t.dataAttribs.stx === "protocol")
			{
				continue;
			}

			// Ignore url links
			if (t.name === 'urllink') {
				continue;
			}

			// Ignore invalid behavior-switch tokens
			if (t.name === 'behavior-switch' && !state.env.conf.wiki.isMagicWord(t.attribs[0].v)) {
				continue;
			}

			// ignore TSR marker metas
			if (t.name === 'meta' && t.getAttribute('typeof') === 'mw:TSRMarker') {
				continue;
			}

			if (!linksOnly || t.name === 'wikilink') {
				return true;
			}

		}

		if ( state.inCaption && tc === pd.TagTk && t.name === 'listItem' ) {
			continue;
		}

		if (!linksOnly && tc === pd.TagTk) {

			// Ignore mw:Entity tokens
			if (t.name === 'span' && t.getAttribute('typeof') === 'mw:Entity') {
				numEntities++;
				continue;
			}
			// Ignore heading tokens
			if (t.name.match(/^h\d$/)) {
				continue;
			}
			// Ignore table tokens outside of tables
			if (t.name in {td:1, tr:1, th:1} && !state.inTable) {
				continue;
			}

			// Ignore display-hack placeholders -- they dont need nowiki escaping
			// They are added as a display-hack by the tokenizer (and we should probably
			// find a better solution than that if one exists).
			if (t.getAttribute('typeof') === 'mw:Placeholder' && t.dataAttribs.isDisplayHack) {
				// Skip over the entity and the end-tag as well
				i += 2;
				continue;
			}

			return true;
		}

		if (!linksOnly && tc === pd.EndTagTk) {
			// Ignore mw:Entity tokens
			if (numEntities > 0 && t.name === 'span') {
				numEntities--;
				continue;
			}
			// Ignore heading tokens
			if (t.name.match(/^h\d$/)) {
				continue;
			}

			// Ignore table tokens outside of tables
			if (t.name in {td:1, tr:1, th:1} && !state.inTable) {
				continue;
			}

			// </br>!
			if (SanitizerConstants.noEndTagSet.has( t.name.toLowerCase() )) {
				continue;
			}

			return true;
		}
	}

	return false;
};

/**
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 *
 * @class
 * @constructor
 * @param options {Object} List of options for serialization
 */
function WikitextSerializer( options ) {
	this.options = options || {};
	this.env = options.env;
	this.options.rtTesting = !this.env.conf.parsoid.editMode;

	// Set up debugging helpers
	this.debugging = this.env.conf.parsoid.traceFlags &&
		(this.env.conf.parsoid.traceFlags.indexOf("wts") !== -1);

	this.traceWTE = this.env.conf.parsoid.traceFlags &&
		(this.env.conf.parsoid.traceFlags.indexOf("wt-escape") !== -1);

	if ( this.env.conf.parsoid.debug || this.debugging ) {
		WikitextSerializer.prototype.debug_pp = function () {
			Util.debug_pp.apply(Util, arguments);
		};

		WikitextSerializer.prototype.debug = function ( ) {
			this.debug_pp.apply(this, ["WTS: ", ''].concat([].slice.apply(arguments)));
		};

		WikitextSerializer.prototype.trace = function () {
			console.error(JSON.stringify(["WTS:"].concat([].slice.apply(arguments))));
		};
	} else {
		WikitextSerializer.prototype.debug_pp = function ( ) {};
		WikitextSerializer.prototype.debug = function ( ) {};
		WikitextSerializer.prototype.trace = function () {};
	}

	// New wt escaping handler
	this.wteHandlers = new WikitextEscapeHandlers(this.env);
	this.wteHandlers.traceWTE = this.traceWTE;
}

var WSP = WikitextSerializer.prototype;

/* *********************************************************************
 * Here is what the state attributes mean:
 *
 * rtTesting
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
 * inIndentPre
 *    Is the serializer currently handling indent-pre tags?
 *
 * inPHPBlock
 *    Is the serializer currently handling a tag that the PHP parser
 *    treats as a block tag?
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
 *    - text: output so far from all (unescaped) text nodes on the current line
 *    - processed: has 'text' been analyzed already?
 *    - hasOpenHeadingChar: does the emitted text have an "=" char in sol posn?
 *    - hasOpenBrackets: does the line have open left brackets?
 * ********************************************************************* */

WSP.initialState = {
	rtTesting: true,
	sep: {},
	onSOL: true,
	escapeText: false,
	atStartOfOutput: true, // SSS FIXME: Can this be done away with in some way?
	inIndentPre: false,
	inPHPBlock: false,
	wteHandlerStack: [],
	// XXX: replace with output buffering per line
	currLine: {
		text: '',
		firstNode: null,
		processed: false,
		hasOpenHeadingChar: false,
		hasOpenBrackets: false
	},

	/////////////////////////////////////////////////////////////////
	// End of state
	/////////////////////////////////////////////////////////////////
	resetCurrLine: function (node) {
		this.currLine = {
			text: '',
			firstNode: node,
			processed: false,
			hasOpenHeadingChar: false,
			hasOpenBrackets: false
		};
	},

	// Serialize the children of a DOM node, sharing the global serializer
	// state. Typically called by a DOM-based handler to continue handling its
	// children.
	serializeChildren: function(node, chunkCB, wtEscaper) {
		try {
			// TODO gwicke: use nested WikitextSerializer instead?
			var oldCB = this.chunkCB,
				oldSep = this.sep,
				children = node.childNodes,
				child = children[0],
				nextChild;

			this.chunkCB = chunkCB;

			// SSS FIXME: Unsure if this is the right thing always
			if (wtEscaper) {
				this.wteHandlerStack.push(wtEscaper);
			}

			while (child) {
				nextChild = this.serializer._serializeNode(child, this);
				if (nextChild === node) {
					// serialized all children
					break;
				} else if (nextChild === child) {
					// advance the child
					child = child.nextSibling;
				} else {
					//console.log('nextChild', nextChild && nextChild.outerHTML);
					child = nextChild;
				}
			}

			this.chunkCB = oldCB;

			if (wtEscaper) {
				this.wteHandlerStack.pop();
			}
		} catch (e) {
			this.env.log("fatal", e);
		}
	},

	getOrigSrc: function(start, end) {
		return this.env.page.src.substring(start, end);
	},

	emitSep: function(sep, node, cb, debugPrefix) {
		cb(sep, node);

		// Reset separator state
		this.sep = {};
		if (sep && sep.match(/\n/)) {
			this.onSOL = true;
		}
		if (this.serializer.debugging) {
			console.log(debugPrefix, JSON.stringify(sep));
		}
	},

	emitSepAndOutput: function(res, node, cb) {
		// Emit separator first
		if (this.prevNodeUnmodified && this.currNodeUnmodified) {
			var origSep = this.getOrigSrc(
				DU.getDataParsoid( this.prevNode ).dsr[1],
				DU.getDataParsoid( node ).dsr[0]
			);
			if (isValidSep(origSep)) {
				this.emitSep(origSep, node, cb, 'ORIG-SEP:');
			} else {
				this.serializer.emitSeparator(this, cb, node);
			}
		} else {
			this.serializer.emitSeparator(this, cb, node);
		}

		this.prevNodeUnmodified = this.currNodeUnmodified;
		this.prevNode = node;
		this.currNodeUnmodified = false;

		if (this.onSOL) {
			this.resetCurrLine(node);
		}

		// Escape 'res' if necessary
		var origRes = res;
		if (this.escapeText) {
			res = this.serializer.escapeWikiText(this, res, {
				node: node,
				isLastChild: DU.nextNonDeletedSibling(node) === null
			} );
			this.escapeText = false;
		}

		// Emitting text that has not been escaped
		if (DU.isText(node) && res === origRes) {
			this.currLine.text += res;
			this.currLine.processed = false;
		}

		// Output res
		cb(res, node);

		// Update state
		this.sep.lastSourceNode = node;
		this.sep.lastSourceSep = this.sep.src;

		if (!res.match(/^(\s|<!--(?:[^\-]|-(?!->))*-->)*$/)) {
			this.onSOL = false;
		}
	},

	/**
	 * Serialize children to a string.
	 * Does not affect the separator state.
	 */
	serializeChildrenToString: function(node, wtEscaper, onSOL) {
		// FIXME: Make sure that the separators emitted here conform to the
		// syntactic constraints of syntactic context.
		var bits = '',
			oldSep = this.sep,
			// appendToBits just ignores anything returned but
			// the source, but that is fine. Selser etc is handled in
			// the top level callback at a slightly coarser level.
			appendToBits = function(out) { bits += out; },
			self = this,
			cb = function(res, node) {
				self.emitSepAndOutput(res, node, appendToBits);
			};
		this.sep = {};
		if (onSOL !== undefined) {
			this.onSOL = onSOL;
		}
		this.serializeChildren(node, cb, wtEscaper);
		self.serializer.emitSeparator(this, appendToBits, node);
		// restore the separator state
		this.sep = oldSep;
		return bits;
	},

	serializeLinkChildrenToString: function(node, wtEscaper, onSOL) {
		this.inLink = true;
		var out = this.serializeChildrenToString(node, wtEscaper, onSOL);
		this.inLink = false;
		return out;
	}
};

// Make sure the initialState is never modified
JSUtils.deepFreeze( WSP.initialState );

/* ----------------------------------------------------------------
 * This function attempts to wrap smallest escapable units into
 * nowikis (which can potentially add multiple nowiki pairs in a
 * single string).  However, it does attempt to coalesce adjacent
 * nowiki segments into a single nowiki wrapper.
 *
 * Full-wrapping is enabled in the following cases:
 * - origText has url triggers (RFC, ISBN, etc.)
 * - is being escaped within context-specific handlers
 * ---------------------------------------------------------------- */
WSP.escapedText = function(state, sol, origText, fullWrap) {

	var match = origText.match(/^((?:.*?|[\r\n]+[^\r\n]|[~]{3,5})*?)((?:\r?\n)*)$/),
		text = match[1],
		nls = match[2],
		nowikisAdded = false;

	// console.warn("SOL: " + sol + "; text: " + text);

	if (fullWrap) {
		return "<nowiki>" + text + "</nowiki>" + nls;
	} else {
		var buf = '',
			inNowiki = false,
			tokensWithoutClosingTag = JSUtils.arrayToSet([
				// These token types don't come with a closing tag
				'listItem', 'td', 'tr'
			]);

		// Tokenize string and pop EOFTk
		var tokens = this.tokenizeStr(state, text, sol);
		tokens.pop();

		// Add nowikis intelligently
		var smartNowikier = function(open, close, str, i, numToks) {
			// Max length of string that gets "unnecessarily"
			// sucked into a nowiki (15 is an arbitrary number)
			var maxExcessWrapLength = 15;

			// If we are being asked to close a nowiki
			// without opening one, we open a nowiki.
			//
			// Ex: "</s>" will parse to an end-tag
			if (open || (close && !inNowiki)) {
				if (!inNowiki) {
					buf += "<nowiki>";
					inNowiki = true;
					nowikisAdded = true;
				}
			}

			buf += str;

			if (close) {
				if ((i < numToks-1 && tokens[i+1].constructor === String && tokens[i+1].length >= maxExcessWrapLength) ||
				    (i === numToks-2 && tokens[i+1].constructor === String))
				{
					buf += "</nowiki>";
					inNowiki = false;
				}
			}
		};

		for (var i = 0, n = tokens.length; i < n; i++) {
			var t = tokens[i],
				tsr = (t.dataAttribs || {}).tsr;

			// console.warn("SOL: " + sol + "; T[" + i + "]=" + JSON.stringify(t));

			switch (t.constructor) {
			case String:
				if (t.length > 0) {
					if (sol && t.match(/(^|\n) /)) {
						smartNowikier(true, true, t, i, n);
					} else {
						buf += t;
					}
					sol = false;
				}
				break;

			case pd.NlTk:
				buf += text.substring(tsr[0], tsr[1]);
				sol = true;
				break;

			case pd.CommentTk:
				// Comments are sol-transparent
				buf += text.substring(tsr[0], tsr[1]);
				break;

			case pd.TagTk:
				// Treat tokens with missing tags as self-closing tokens
				// for the purpose of minimal nowiki escaping
				var closeNowiki = tokensWithoutClosingTag.has(t.name);
				smartNowikier(true, closeNowiki, text.substring(tsr[0], tsr[1]), i, n);
				sol = false;
				break;

			case pd.EndTagTk:
				smartNowikier(false, true, text.substring(tsr[0], tsr[1]), i, n);
				sol = false;
				break;

			case pd.SelfclosingTagTk:
				smartNowikier(true, true, text.substring(tsr[0], tsr[1]), i, n);
				sol = false;
				break;
			}
		}

		// close any unclosed nowikis
		if (inNowiki) {
			buf += "</nowiki>";
		}

		// Make sure nowiki is always added
		// Ex: "foo]]" won't tokenize into tags at all
		if (!nowikisAdded) {
			buf = '';
			buf += "<nowiki>";
			buf += text;
			buf += "</nowiki>";
		}

		buf += nls;
		return buf;
	}
};

WSP.serializeHTML = function(opts, html) {
	return (new WikitextSerializer(opts)).serializeDOM(DU.parseHTML(html).body);
};

WSP.getAttributeKey = function(node, key) {
	var dataMW = node.getAttribute("data-mw");
	if (dataMW) {
		dataMW = JSON.parse(dataMW);
		var tplAttrs = dataMW.attribs;
		if (tplAttrs) {
			// If this attribute's key is generated content,
			// serialize HTML back to generator wikitext.
			for (var i = 0; i < tplAttrs.length; i++) {
				if (tplAttrs[i][0].txt === key && tplAttrs[i][0].html) {
					return this.serializeHTML({ env: this.env, onSOL: false }, tplAttrs[i][0].html);
				}
			}
		}
	}

	return key;
};

// SSS FIXME: data-mw html attribute is repeatedly fetched and parsed
// when multiple attrs are fetched on the same node
WSP.getAttrValFromDataMW = function(node, key, value) {
	var dataMW = node.getAttribute("data-mw");
	if (dataMW) {
		dataMW = JSON.parse(dataMW);
		var tplAttrs = dataMW.attribs;
		if (tplAttrs) {
			// If this attribute's value is generated content,
			// serialize HTML back to generator wikitext.
			for (var i = 0; i < tplAttrs.length; i++) {
				var a = tplAttrs[i];
				if (a[0] === key || a[0].txt === key && a[1].html !== null) {
					return this.serializeHTML({ env: this.env, onSOL: false }, a[1].html);
				}
			}
		}
	}

	return value;
};

WSP.serializedAttrVal = function(node, name) {
	var v = this.getAttrValFromDataMW(node, name, null);
	if (v) {
		return {
			value: v,
			modified: false,
			fromsrc: true,
			fromDataMW: true
		};
	} else {
		return DU.getAttributeShadowInfo(node, name);
	}
};

WSP.serializedImageAttrVal = function(dataMWnode, htmlAttrNode, key) {
	var v = this.getAttrValFromDataMW(dataMWnode, key, null);
	if (v) {
		return {
			value: v,
			modified: false,
			fromsrc: true,
			fromDataMW: true
		};
	} else {
		return DU.getAttributeShadowInfo(htmlAttrNode, key);
	}
};

WSP.tokenizeStr = function(state, str, sol) {
	var p = new PegTokenizer( state.env ), tokens = [];
	p.on('chunk', function ( chunk ) {
		// Avoid a stack overflow if chunk is large,
		// but still update token in-place
		for ( var ci = 0, l = chunk.length; ci < l; ci++ ) {
			tokens.push(chunk[ci]);
		}
	});
	p.on('end', function(){ });

	// Init sol state
	p.savedSOL = sol;

	// The code below will break if use async tokenization.
	p.processSync(str);
	return tokens;
};

WSP.escapeWikiText = function ( state, text, opts ) {
	if (this.traceWTE) {
		console.warn("EWT: " + JSON.stringify(text));
	}

	/* -----------------------------------------------------------------
	 * General strategy: If a substring requires escaping, we can escape
	 * the entire string without further analysis of the rest of the string.
	 * ----------------------------------------------------------------- */

	// SSS FIXME: Move this somewhere else
	var urlTriggers = /(?:^|\s)(RFC|ISBN|PMID)(?=$|\s)/;
	var fullCheckNeeded = !state.inLink && urlTriggers.test(text);

	// Quick check for the common case (useful to kill a majority of requests)
	//
	// Pure white-space or text without wt-special chars need not be analyzed
	if (!fullCheckNeeded && !/(^|\n) +[^\s]+|[<>\[\]\-\+\|\'!=#\*:;~{}]|__[^_]*__/.test(text)) {
		if (this.traceWTE) {
			console.warn("---No-checks needed---");
		}
		return text;
	}

	// Context-specific escape handler
	var wteHandler = state.wteHandlerStack.last();
	if (wteHandler && wteHandler(state, text, opts)) {
		if (this.traceWTE) {
			console.warn("---Context-specific escape handler---");
		}
		return this.escapedText(state, false, text, true);
	}

	// Template and template-arg markers are escaped unconditionally!
	// Conditional escaping requires matching brace pairs and knowledge
	// of whether we are in template arg context or not.
	if (text.match(/\{\{\{|\{\{|\}\}\}|\}\}/)) {
		if (this.traceWTE) {
			console.warn("---Unconditional: transclusion chars---");
		}
		return this.escapedText(state, false, text, fullCheckNeeded);
	}

	var sol = state.onSOL && !state.inIndentPre && !state.inPHPBlock,
		hasNewlines = text.match(/\n./),
		hasTildes = text.match(/~{3,5}/);

	this.trace('sol', sol, text);

	if (!fullCheckNeeded && !hasNewlines && !hasTildes) {
		// {{, {{{, }}}, }} are handled above.
		// Test 1: '', [], <> need escaping wherever they occur
		//         = needs escaping in end-of-line context
		// Test 2: {|, |}, ||, |-, |+,  , *#:;, ----, =*= need escaping only in SOL context.
		if (!sol && !text.match(/''|[<>]|\[.*\]|\]|(=[ ]*(\n|$))/)) {
			// It is not necessary to test for an unmatched opening bracket ([)
			// as long as we always escape an unmatched closing bracket (]).
			if (this.traceWTE) {
				console.warn("---Not-SOL and safe---");
			}
			return text;
		}

		// Quick checks when on a newline
		// + can only occur as "|+" and - can only occur as "|-" or ----
		if (sol && !text.match(/(^|\n)[ #*:;=]|[<\[\]>\|'!]|\-\-\-\-|__[^_]*__/)) {
			if (this.traceWTE) {
				console.warn("---SOL and safe---");
			}
			return text;
		}
	}

	// The front-end parser eliminated pre-tokens in the tokenizer
	// and moved them to a stream handler. So, we always conservatively
	// escape text with ' ' in sol posn with two caveats
	// * indent-pres are disabled in ref-bodies (See ext.core.PreHandler.js)
	// * and when the current line has block tokens
	if ( sol &&
		 this.options.extName !== 'ref' &&
		 text.match(/(^|\n) +[^\s]+/) &&
		 !hasBlocksOnLine( state.currLine.firstNode, true )
	) {

		if (this.traceWTE) {
			console.warn("---SOL and pre---");
		}
		return this.escapedText(state, sol, text, fullCheckNeeded);

	}

	// escape nowiki tags
	text = text.replace(/<(\/?nowiki\s*\/?\s*)>/gi, '&lt;$1&gt;');

	// Use the tokenizer to see if we have any wikitext tokens
	//
	// Ignores headings & entities -- headings have additional
	// EOL matching requirements which are not captured by the
	// hasWikitextTokens check
	if (this.wteHandlers.hasWikitextTokens(state, sol, this.options, text) || hasTildes) {
		if (this.traceWTE) {
			console.warn("---Found WT tokens---");
		}
		return this.escapedText(state, sol, text, fullCheckNeeded);
	} else if (state.onSOL) {
		if (text.match(/(^|\n)=+[^\n=]+=+[ \t]*\n/)) {
			if (this.traceWTE) {
				console.warn("---SOL: heading (easy test)---");
			}
			return this.escapedText(state, sol, text, fullCheckNeeded);
		} else if (text.match(/(^|\n)=+[^\n=]+=+[ \t]*$/)) {
			/* ---------------------------------------------------------------
			 * '$' is only specific to 'text' and not the entire line.
			 * So, verify that there is no other non-sep element on the
			 * current line before escaping this text.
			 *
			 * This will still lead to conservative nowiki escaping in
			 * certain scenarios because the current-line may extend
			 * beyond state.currLine.firstNode.parentNode (ex: the p-tag
			 * in the example below).
			 *
			 * Ex: "<p>=a=</p><div>b</div>"
			 *
			 * However, such examples should hopefully be rare (it will be
			 * rare if VE and other clients insert a newline after p-tags).
			 *
			 * However, it is not sufficient to just check that nonSepSibling
			 * is null below. Consider "=a= <!--c--> \nb". For this example,
			 *
			 *   text: "=a= "
			 *   state.currLine.firstNode: #TEXT("=a= ")
			 *   nonSepsibling: #TEXT(" \nb")
			 *
			 * Hence the need for the more complex check below.
			 * --------------------------------------------------------------- */
			var nonSepSibling = DU.nextNonSepSibling(state.currLine.firstNode);
			if (!nonSepSibling ||
				DU.isText(nonSepSibling) && nonSepSibling.nodeValue.match(/^\s*\n/))
			{
				if (this.traceWTE) {
					console.warn("---SOL: heading (complex single-line test)---");
				}
				return this.escapedText(state, sol, text, fullCheckNeeded);
			} else {
				if (this.traceWTE) {
					console.warn("---SOL: no-heading (complex single-line test)---");
				}
				return text;
			}
		} else {
			if (this.traceWTE) {
				console.warn("---SOL: no-heading---");
			}
			return text;
		}
	} else {
		// Detect if we have open brackets or heading chars -- we use 'processed' flag
		// as a performance opt. to run this detection only if/when required.
		//
		// FIXME: Even so, it is reset after after every emitted text chunk.
		// Could be optimized further by figuring out a way to only test
		// newer chunks, but not sure if it is worth the trouble and complexity
		var cl = state.currLine;
		if (!cl.processed) {
			cl.processed = true;
			cl.hasOpenHeadingChar = false;
			cl.hasOpenBrackets = false;

			// If accumulated text starts with a '=', verify that that
			// the opening bit came from one of two places:
			// - a text node: (Ex: <p>=foo=</p>)
			// - the first child of a heading node: (Ex: <h1>=foo=</h1>)
			if (cl.text.match(/^=/) &&
				(DU.isText(DU.firstNonSepChildNode(cl.firstNode.parentNode)) ||
				cl.firstNode.nodeName.match(/^H/) && cl.firstNode.firstChild && DU.isText(cl.firstNode.firstChild)))
			{
				cl.hasOpenHeadingChar = true;
			}

			// Does cl.text have an open '['?
			if (cl.text.match(/\[[^\]]*$/)) {
				cl.hasOpenBrackets = true;
			}
		}

		// Escape text if:
		// 1. we have an open heading char, and
		//    - text ends in a '='
		//    - text comes from the last child
		// 2. we have an open bracket, and
		//    - text has an unmatched bracket
		//    - the combined text will get parsed as a link (expensive check)
		//
		// NOTE: Escaping the "=" char in the regexp because JSHint complains that
		// it can be confused by other developers.
		// See http://jslinterrors.com/a-regular-expression-literal-can-be-confused-with/
		if (cl.hasOpenHeadingChar && opts.isLastChild && text.match(/\=$/) ||
		    cl.hasOpenBrackets && text.match(/^[^\[]*\]/) &&
				this.wteHandlers.hasWikitextTokens(state, sol, this.options, cl.text + text, true))
		{
			if (this.traceWTE) {
				console.warn("---Wikilink chars: complex single-line test---");
			}
			return this.escapedText(state, sol, text, fullCheckNeeded);
		} else {
			if (this.traceWTE) {
				console.warn("---All good!---");
			}
			return text;
		}
	}
};

/**
 * General strategy:
 *
 * Tokenize the arg wikitext.  Anything that parses as tags
 * are good and we need not bother with those. Check for harmful
 * characters "[]{}|" or additonally '=' in positional parameters and escape
 * those fragments since these characters could change semantics of the entire
 * template transclusion.
 *
 * This function makes a couple of assumptions:
 *
 * 1. The tokenizer sets tsr on all non-string tokens.
 * 2. The tsr on TagTk and EndTagTk corresponds to the
 *    width of the opening and closing wikitext tags and not
 *    the entire DOM range they span in the end.
 */
WSP.escapeTplArgWT = function(state, arg, opts) {
	var serializeAsNamed = opts.serializeAsNamed,
		errors;

	function escapeStr(str, pos) {
		var bracketPairStrippedStr = str.replace(/\[([^\[\]]*)\]/g, '_$1_'),
			genericMatch = pos.start && /^\{/.test(str) ||
				pos.end && /\}$/.test(str) ||
				/\{\{|\}\}|[\[\]\|]/.test(bracketPairStrippedStr);

		// '=' is not allowed in positional parameters.  We can either
		// nowiki escape it or convert the named parameter into a
		// positional param to avoid the escaping.
		if (opts.isTemplate && !serializeAsNamed && /[=]/.test(str)) {
			// In certain situations, it is better to add a nowiki escape
			// rather than convert this to a named param.
			//
			// Ex: Consider: {{funky-tpl|a|b|c|d|e|f|g|h}}
			//
			// If an editor changes 'a' to 'f=oo' and we convert it to
			// a named param 1=f=oo, we are effectively converting all
			// the later params into named params as well and we get
			// {{funky-tpl|1=f=oo|2=b|3=c|...|8=h}} instead of
			// {{funky-tpl|<nowiki>f=oo</nowiki>|b|c|...|h}}
			//
			// The latter is better in this case. This is a real problem
			// in production.
			//
			// For now, we use a simple heuristic below and can be
			// refined later, if necessary
			//
			// 1. Either there were no original positional args
			// 2. Or, only the last positional arg uses '='
			if (opts.numPositionalArgs === 0 ||
				opts.numPositionalArgs === opts.argIndex)
			{
				serializeAsNamed = true;
			}
		}

		var buf = '';
		if (genericMatch || (!serializeAsNamed && /[=]/.test(str))) {
			buf += "<nowiki>";
			buf += str;
			buf += "</nowiki>";
		} else {
			buf += str;
		}
		return buf;
	}

	var tokens = this.tokenizeStr(state, arg, false);
	var buf = '';
	for (var i = 0, n = tokens.length; i < n; i++) {
		var t = tokens[i], da = t.dataAttribs;

		// For mw:Entity spans, the opening and closing tags have 0 width
		// and the enclosed content is the decoded entity. Hence the
		// special case to serialize back the entity's source.
		if (t.constructor === pd.TagTk) {
			var type = t.getAttribute("typeof");
			if (type === "mw:Entity" || type === "mw:Placeholder") {
				i += 2;
				buf += arg.substring(da.tsr[0], tokens[i].dataAttribs.tsr[1]);
				continue;
			} else if (type === "mw:Nowiki") {
				i++;
				while (i < n && (tokens[i].constructor !== pd.EndTagTk || tokens[i].getAttribute("typeof") !== "mw:Nowiki")) {
					i++;
				}
				buf += arg.substring(da.tsr[0], tokens[i].dataAttribs.tsr[1]);
				continue;
			}
		}

		switch (t.constructor) {
			case pd.TagTk:
			case pd.EndTagTk:
			case pd.NlTk:
			case pd.CommentTk:
				if (!da.tsr) {
					errors = ["Missing tsr for: " + JSON.stringify(t)];
					errors.push("Arg : " + JSON.stringify(arg));
					errors.push("Toks: " + JSON.stringify(tokens));
					this.env.log("error", errors.join("\n"));
				}
				buf += arg.substring(da.tsr[0], da.tsr[1]);
				break;

			case pd.SelfclosingTagTk:
				if (!da.tsr) {
					errors = ["Missing tsr for: " + JSON.stringify(t)];
					errors.push("Arg : " + JSON.stringify(arg));
					errors.push("Toks: " + JSON.stringify(tokens));
					this.env.log("error", errors.join("\n"));
				}
				var tkSrc = arg.substring(da.tsr[0], da.tsr[1]);
				// Replace pipe by an entity. This is not completely safe.
				if (t.name === 'extlink' || t.name === 'urllink') {
					var tkBits = tkSrc.split(/(\{\{[^]*?\}\})/g);
					/* jshint loopfunc: true */ // yes, this function is in a loop
					tkBits.forEach(function(bit) {
						if (/^\{\{[^]+\}\}$/.test(bit)) {
							buf += bit;
						} else {
							buf += bit.replace(/\|/g, '&#124;');
						}
					});
				} else {
					buf += tkSrc;
				}
				break;

			case String:
				var pos = {
					atStart: i === 0,
					atEnd: i === tokens.length - 1
				};
				buf += escapeStr(t, pos);
				break;

			case pd.EOFTk:
				break;
		}
	}

	return { serializeAsNamed: serializeAsNamed, v: buf };
};

/**
 * DOM-based figure handler
 */
WSP.figureHandler = function(node, state, cb) {
	this.handleImage( node, state, cb );
};

WSP._serializeTableTag = function ( symbol, endSymbol, state, node, wrapperUnmodified ) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid( node ).dsr;
		return state.getOrigSrc(dsr[0], dsr[0]+dsr[2]);
	} else {
		var token = DU.mkTagTk(node);
		var sAttribs = this._serializeAttributes(state, node, token);
		if (sAttribs.length > 0) {
			// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the '' string
			// is a falsy value and we want to treat it as a truthy value.
			return symbol + ' ' + sAttribs + (endSymbol !== null ? endSymbol : ' |');
		} else {
			return symbol + (endSymbol || '');
		}
	}
};

WSP._serializeTableElement = function ( symbol, endSymbol, state, node ) {
	var token = DU.mkTagTk(node);

	var sAttribs = this._serializeAttributes(state, node, token);
	if (sAttribs.length > 0) {
		// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the '' string
		// is a falsy value and we want to treat it as a truthy value.
		return symbol + ' ' + sAttribs + (endSymbol !== null ? endSymbol : ' |');
	} else {
		return symbol + (endSymbol || '');
	}
};

WSP._serializeHTMLTag = function ( state, node, wrapperUnmodified ) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid( node ).dsr;
		return state.getOrigSrc(dsr[0], dsr[0]+dsr[2]);
	}

	var token = DU.mkTagTk(node);
	var da = token.dataAttribs;
	if ( token.name === 'pre' ) {
		// html-syntax pre is very similar to nowiki
		state.inHTMLPre = true;
	}

	if (da.autoInsertedStart) {
		return '';
	}

	var close = '';
	if ( (Util.isVoidElement( token.name ) && !da.noClose) || da.selfClose ) {
		close = ' /';
	}

	var sAttribs = this._serializeAttributes(state, node, token),
		tokenName = da.srcTagName || token.name;
	if (sAttribs.length > 0) {
		return '<' + tokenName + ' ' + sAttribs + close + '>';
	} else {
		return '<' + tokenName + close + '>';
	}
};

WSP._serializeHTMLEndTag = function ( state, node, wrapperUnmodified ) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid( node ).dsr;
		return state.getOrigSrc(dsr[1]-dsr[3], dsr[1]);
	}

	var token = DU.mkEndTagTk(node);
	if ( token.name === 'pre' ) {
		state.inHTMLPre = false;
	}
	if ( !token.dataAttribs.autoInsertedEnd &&
		 !Util.isVoidElement( token.name ) &&
		 !token.dataAttribs.selfClose  )
	{
		return '</' + (token.dataAttribs.srcTagName || token.name) + '>';
	} else {
		return '';
	}
};

var splitLinkContentString = function (contentString, dp, target) {
	var tail = dp.tail,
		prefix = dp.prefix;
	if (dp.pipetrick) {
		// Drop the content completely..
		return { contentString: '', tail: tail || '', prefix: prefix || '' };
	} else {
		if ( tail && contentString.substr( contentString.length - tail.length ) === tail ) {
			// strip the tail off the content
			contentString = Util.stripSuffix( contentString, tail );
		} else if ( tail ) {
			tail = '';
		}

		if ( prefix && contentString.substr( 0, prefix.length ) === prefix ) {
			contentString = contentString.substr( prefix.length );
		} else if ( prefix ) {
			prefix = '';
		}

		return {
			contentString: contentString || '',
			tail: tail || '',
			prefix: prefix || ''
		};
	}
};

// Helper function for getting RT data from the tokens
var getLinkRoundTripData = function( env, node, state ) {
	var dp = DU.getDataParsoid( node );
	var rtData = {
		type: null,
		target: null, // filled in below
		tail: dp.tail || '',
		prefix: dp.prefix || '',
		content: {} // string or tokens
	};

	// Figure out the type of the link
	var rel = node.getAttribute('rel');
	if ( rel ) {
		var typeMatch = rel.match( /(?:^|\s)(mw:[^\s]+)/ );
		if ( typeMatch ) {
			rtData.type = typeMatch[1];
		}
	}

	var href = node.getAttribute('href') || '';

	// Save the token's "real" href for comparison
	rtData.href = href.replace( /^(\.\.?\/)+/, '' );

	// Now get the target from rt data
	rtData.target = state.serializer.serializedAttrVal(node, 'href', {});

	// Check if the link content has been modified
	// FIXME: This will only work with selser of course. Hard to test without
	// selser.
	var pd = DU.loadDataAttrib(node, "parsoid-diff", {});
	var changes = pd.diff || [];
	if (changes.indexOf('subtree-changed') !== -1) {
		rtData.contentModified = true;
	}

	// Get the content string or tokens
	var contentParts;
	if (node.childNodes.length >= 1 && DU.allChildrenAreText(node)) {
		var contentString = node.textContent;
		if (rtData.target.value && rtData.target.value !== contentString && !dp.pipetrick) {
			// Try to identify a new potential tail
			contentParts = splitLinkContentString(contentString, dp, rtData.target);
			rtData.content.string = contentParts.contentString;
			rtData.tail = contentParts.tail;
			rtData.prefix = contentParts.prefix;
		} else {
			rtData.tail = '';
			rtData.prefix = '';
			rtData.content.string = contentString;
		}
	} else if ( node.childNodes.length ) {
		rtData.contentNode = node;
	} else if ( /^mw:PageProp\/redirect$/.test( rtData.type ) ) {
		rtData.isRedirect = true;
		rtData.prefix = dp.src ||
			( ( env.conf.wiki.mwAliases.redirect[0] || '#REDIRECT' ) + ' ' );
	}

	return rtData;
};

function escapeWikiLinkContentString ( contentString, state, contentNode ) {
	// First, entity-escape the content.
	contentString = Util.escapeEntities(contentString);

	// Wikitext-escape content.
	//
	// When processing link text, we are no longer in newline state
	// since that will be preceded by "[[" or "[" text in target wikitext.
	state.onSOL = false;
	state.wteHandlerStack.push(state.serializer.wteHandlers.wikilinkHandler);
	state.inLink = true;
	state.inTable = DU.inTable(contentNode);
	var res = state.serializer.escapeWikiText(state, contentString, { node: contentNode });
	state.inLink = false;
	state.wteHandlerStack.pop();
	return res;
}

/**
 * Check if textNode follows/precedes a link that requires
 * <nowiki/> escaping to prevent unwanted link prefix/trail parsing.
 */
WSP.getLinkPrefixTailEscapes = function (textNode, env) {
	var node,
		escapes = {
			prefix: '',
			tail: ''
		};

	if (env.conf.wiki.linkTrailRegex &&
		!textNode.nodeValue.match(/^\s/) &&
		env.conf.wiki.linkTrailRegex.test(textNode.nodeValue))
	{
		// Skip past deletion markers
		node = DU.previousNonDeletedSibling(textNode);
		if (node && DU.isElt(node) && node.nodeName === 'A' &&
			/mw:WikiLink/.test(node.getAttribute("rel")))
		{
			escapes.tail = '<nowiki/>';
		}
	}

	if (env.conf.wiki.linkPrefixRegex &&
		!textNode.nodeValue.match(/\s$/) &&
		env.conf.wiki.linkPrefixRegex.test(textNode.nodeValue))
	{
		// Skip past deletion markers
		node = DU.nextNonDeletedSibling(textNode);
		if (node && DU.isElt(node) && node.nodeName === 'A' &&
			/mw:WikiLink/.test(node.getAttribute("rel")))
		{
			escapes.prefix = '<nowiki/>';
		}
	}

	return escapes;
};

WSP.handleImage = function ( node, state, cb ) {
	var env = state.env,
		mwAliases = env.conf.wiki.mwAliases;
	// All figures have a fixed structure:
	//
	// <figure or span typeof="mw:Image...">
	//  <a or span><img ...><a or span>
	//  <figcaption or span>....</figcaption>
	// </figure or span>
	//
	// Pull out this fixed structure, being as generous as possible with
	// possibly-broken HTML.
	var outerElt = node;
	var imgElt = node.querySelector('IMG'); // first IMG tag
	var linkElt = null;
	// parent of img is probably the linkElt
	if (imgElt &&
		imgElt.parentElement !== outerElt &&
		/^(A|SPAN)$/.test(imgElt.parentElement.tagName)) {
		linkElt = imgElt.parentElement;
	}
	// FIGCAPTION or last child (which is not the linkElt) is the caption.
	var captionElt = node.querySelector('FIGCAPTION');
	if (!captionElt) {
		for (captionElt = node.lastElementChild;
			 captionElt;
			 captionElt = captionElt.previousElementSibling) {
			if (captionElt !== linkElt && captionElt !== imgElt &&
				/^(SPAN|DIV)$/.test(captionElt.tagName)) {
				break;
			}
		}
	}
	// special case where `node` is the IMG tag itself!
	if (node.tagName === 'IMG') {
		linkElt = captionElt = null;
		outerElt = imgElt = node;
	}

	// The only essential thing is the IMG tag!
	if (!imgElt) {
		this.env.log("error", "In WSP.handleImage, node does not have any img elements:", node.outerHTML );
		return cb( '', node );
	}

	var outerDP = (outerElt && outerElt.hasAttribute( 'data-parsoid' )) ?
		DU.getDataParsoid(outerElt) : {};

	// Try to identify the local title to use for this image
	var resource = this.serializedImageAttrVal( outerElt, imgElt, 'resource' );
	if (resource.value === null) {
		// from non-parsoid HTML: try to reconstruct resource from src?
		var src = imgElt.getAttribute( 'src' );
		if (!src) {
			this.env.log("error", "In WSP.handleImage, img does not have resource or src:", node.outerHTML);
			return cb( '', node );
		}
		if (/^https?:/.test(src)) {
			// external image link, presumably $wgAllowExternalImages=true
			return cb( src, node );
		}
		resource = {
			value: src,
			fromsrc: false,
			modified: false
		};
	}
	if ( !resource.fromsrc ) {
		resource.value = resource.value.replace( /^(\.\.?\/)+/, '' );
	}

	// Do the same for the link
	var link = null;
	if ( linkElt && linkElt.hasAttribute('href') ) {
		link = this.serializedImageAttrVal( outerElt, linkElt, 'href' );
		if ( !link.fromsrc ) {
			if (linkElt.getAttribute('href') === imgElt.getAttribute('resource'))
			{
				// default link: same place as resource
				link = resource;
			}
			link.value = link.value.replace( /^(\.\.?\/)+/, '' );
		}
	}

	// Reconstruct the caption
	var caption = null;
	if (captionElt) {
		state.inCaption = true;
		caption = state.serializeChildrenToString( captionElt, this.wteHandlers.wikilinkHandler, false );
		state.inCaption = false;
	} else if (outerElt) {
		caption = DU.getDataMw(outerElt).caption;
	}

	// Fetch the alt (if any)
	var alt = this.serializedImageAttrVal( outerElt, imgElt, 'alt' );

	// Fetch the lang (if any)
	var lang = this.serializedImageAttrVal( outerElt, imgElt, 'lang' );

	// Ok, start assembling options, beginning with link & alt & lang
	var nopts = [];
	[ { name: 'link', value: link, cond: !(link && link.value === resource.value) },
	  { name: 'alt',  value: alt,  cond: alt.value !== null },
	  { name: 'lang', value: lang, cond: lang.value !== null }
	].forEach(function(o) {
		if (!o.cond) { return; }
		if (o.value && o.value.fromsrc) {
			nopts.push( {
				ck: o.name,
				ak: [ o.value.value ]
			} );
		} else {
			nopts.push( {
				ck: o.name,
				v: o.value ? o.value.value : '',
				ak: mwAliases['img_' + o.name]
			} );
		}
	});

	// Handle class-signified options
	var classes = outerElt ? outerElt.classList : [];
	var extra = []; // 'extra' classes
	var val;

	// work around a bug in domino <= 1.0.13
	if (!outerElt.hasAttribute('class')) { classes = []; }

	for ( var ix = 0; ix < classes.length; ix++ ) {

		switch ( classes[ix] ) {
			case 'mw-halign-none':
			case 'mw-halign-right':
			case 'mw-halign-left':
			case 'mw-halign-center':
				val = classes[ix].replace( /^mw-halign-/, '' );
				nopts.push( {
					ck: val,
					ak: mwAliases['img_' + val]
				} );
				break;

			case 'mw-valign-top':
			case 'mw-valign-middle':
			case 'mw-valign-baseline':
			case 'mw-valign-sub':
			case 'mw-valign-super':
			case 'mw-valign-text-top':
			case 'mw-valign-bottom':
			case 'mw-valign-text-bottom':
				val = classes[ix].replace( /^mw-valign-/, '' ).
					replace(/-/g, '_');
				nopts.push( {
					ck: val,
					ak: mwAliases['img_' + val]
				} );
				break;

			case 'mw-image-border':
				nopts.push( {
					ck: 'border',
					ak: mwAliases.img_border
				} );
				break;

			case 'mw-default-size':
				// handled below
				break;

			default:
				extra.push(classes[ix]);
				break;
		}
	}
	if (extra.length) {
		nopts.push( {
			ck: 'class',
			v: extra.join(' '),
			ak: mwAliases.img_class
		} );
	}

	// Handle options signified by typeof attribute
	var type = (outerElt.getAttribute('typeof') || '').
		match(/(?:^|\s)(mw:Image\S*)/);
	type = type ? type[1] : null;
	var framed = false;

	switch ( type ) {
		case 'mw:Image/Thumb':
			nopts.push( {
				ck: 'thumbnail',
				ak: this.getAttrValFromDataMW(outerElt, 'thumbnail', mwAliases.img_thumbnail)
			} );
			break;

		case 'mw:Image/Frame':
			framed = true;
			nopts.push( {
				ck: 'framed',
				ak: this.getAttrValFromDataMW(outerElt, 'framed', mwAliases.img_framed)
			} );
			break;

		case 'mw:Image/Frameless':
			nopts.push( {
				ck: 'frameless',
				ak: this.getAttrValFromDataMW(outerElt, 'frameless', mwAliases.img_frameless)
			} );
			break;
	}

	// XXX handle page
	// XXX handle manualthumb


	// Handle width and height

	// Get the user-specified width/height from wikitext
	var wh = this.serializedImageAttrVal( outerElt, imgElt, 'height' ),
		ww = this.serializedImageAttrVal( outerElt, imgElt, 'width' ),
		getOpt = function(key) {
			if (!outerDP.optList) {
				return null;
			}
			return outerDP.optList.find(function(o) { return o.ck === key; });
		},
		getLastOpt = function(key) {
			var o = outerDP.optList || [], i;
			for (i=o.length-1; i>=0; i--) {
				if (o[i].ck === key) {
					return o[i];
				}
			}
			return null;
		},
		sizeUnmodified = ww.fromDataMW || (!ww.modified && !wh.modified),
		upright = getOpt('upright');

	// XXX: Infer upright factor from default size for all thumbs by default?
	// Better for scaling with user prefs, but requires knowledge about
	// default used in VE.
	if (sizeUnmodified && upright
			// Only serialize upright where it is actually respected
			// This causes some dirty diffs, but makes sure that we don't
			// produce nonsensical output after a type switch.
			// TODO: Only strip if type was actually modified.
			&& type in {'mw:Image/Frameless':1, 'mw:Image/Thumb':1})
	{
		// preserve upright option
		nopts.push({
			ck: upright.ck,
			ak: [upright.ak] // FIXME: don't use ak here!
		});
	}

	if ( !(outerElt && outerElt.classList.contains('mw-default-size')) ) {
		var size = getLastOpt('width'),
			sizeString = (size && size.ak) || (ww.fromDataMW && ww.value);
		if (sizeUnmodified && sizeString) {
			// preserve original width/height string if not touched
			nopts.push( {
				ck: 'width',
				v: sizeString, // original size string
				ak: ['$1'] // don't add px or the like
			} );
		} else {
			var bbox = null;
			// Serialize to a square bounding box
			if (ww.value!==null && ww.value!=='') {
				//val += ww.value;
				try {
					bbox = Number(ww.value);
				} catch (e) {}
			}
			if (wh.value!==null && wh.value!=='') {
				//val += 'x' + wh.value;
				try {
					var height = Number(wh.value);
					if (bbox === null || framed || height > bbox) {
						bbox = height;
					}
				} catch (e) {}
			}
			nopts.push( {
				ck: 'width',
				// MediaWiki interprets 100px as a width restriction only, so
				// we need to make the bounding box explicitly square
				// (100x100px). The 'px' is added by the alias though, and can
				// be localized.
				v:  bbox + 'x' + bbox,
				ak: mwAliases.img_width // adds the 'px' suffix
			} );
		}
	}

	// Put the caption last, by default.
	if (typeof(caption) === 'string') {
		nopts.push( {
			ck: 'caption',
			ak: [caption]
		} );
	}

	// ok, sort the new options to match the order given in the old optlist
	// and try to match up the aliases used
	var opts = outerDP.optList || []; // original wikitext options
	nopts.forEach(function(no) {
		// Make sure we have an array here. Default in data-parsoid is
		// actually a string.
		// FIXME: don't reuse ak for two different things!
		if ( !Array.isArray(no.ak) ) {
			no.ak = [no.ak];
		}

		no.sortId = opts.length;
		var idx = opts.findIndex(function(o) { return o.ck === no.ck; });
		if (idx < 0) {
			// New option, default to English localization for most languages
			// TODO: use first alias (localized) instead for RTL languages (bug
			// 51852)
			no.ak = no.ak.last();
			return; /* new option */
		}

		no.sortId = idx;
		// use a matching alias, if there is one
		var a = no.ak.find(function(a) {
			// note the trim() here; that allows us to snarf eccentric
			// whitespace from the original option wikitext
			if ('v' in no) { a = a.replace( '$1', no.v ); }
			return a === String(opts[idx].ak).trim();
		});
		// use the alias (incl whitespace) from the original option wikitext
		// if found; otherwise use the last alias given (English default by
		// convention that works everywhere).
		// TODO: use first alias (localized) instead for RTL languages (bug
		// 51852)
		if (a && no.ck !== 'caption') {
			no.ak = opts[idx].ak;
			no.v = undefined; // prevent double substitution
		} else {
			no.ak = no.ak.last();
		}
	});

	// sort!
	nopts.sort(function(a, b) { return a.sortId - b.sortId; });

	// emit all the options as wikitext!
	var wikitext = '[[' + resource.value;
	nopts.forEach(function(o) {
		wikitext += '|';
		if (o.v !== undefined) {
			wikitext += o.ak.replace( '$1', o.v );
		} else {
			wikitext += o.ak;
		}
	});
	wikitext += ']]';
	cb( wikitext, node );
};

/**
 * Add a colon escape to a wikilink target string if needed.
 */
WSP._addColonEscape = function (linkTarget, linkData) {
	if (linkData.target.fromsrc) {
		return linkTarget;
	}
	var linkTitle = Title.fromPrefixedText(this.env, linkTarget);
	if (linkTitle
		&& (linkTitle.ns.isCategory() || linkTitle.ns.isFile())
		&& linkData.type === 'mw:WikiLink'
		&& !/^:/.test(linkTarget))
	{
		// Escape category and file links
		return ':' + linkTarget;
	} else {
		return linkTarget;
	}
};

// Figure out if we need a piped or simple link
WSP._isSimpleWikiLink = function(env, dp, target, linkData) {

	var contentString = linkData.content.string,
		canUseSimple = false;

	// Would need to pipe for any non-string content
	// Preserve unmodified or non-minimal piped links
	if ( contentString !== undefined
		&& ( target.modified
			|| linkData.contentModified
			|| ( dp.stx !== 'piped' && !dp.pipetrick ) ))
	{
		// Strip colon escapes from the original target as that is
		// stripped when deriving the content string.
		var strippedTargetValue = target.value.replace(/^:/, ''),
			decodedTarget = Util.decodeURI(Util.decodeEntities(strippedTargetValue));

		// See if the (normalized) content matches the
		// target, either shadowed or actual.
		canUseSimple = (
			contentString === decodedTarget
			// try wrapped in forward slashes in case they were stripped
		 || ('/' + contentString + '/') === decodedTarget
		 || contentString === linkData.href
			// normalize without underscores for comparison
			// with target.value and strip any colon escape
		 || env.normalizeTitle( contentString, true ) === Util.decodeURI( strippedTargetValue )
			// Relative link
		 || ( env.conf.wiki.namespacesWithSubpages[ env.page.ns ] &&
			  ( /^\.\.\/.*[^\/]$/.test(strippedTargetValue) &&
			  contentString === env.resolveTitle(strippedTargetValue, env.page.ns) ) ||
			  ( /^\.\.\/.*?\/$/.test(strippedTargetValue) &&
			  contentString === strippedTargetValue.replace(/^(?:\.\.\/)+(.*?)\/$/, '$1') ))
			// normalize with underscores for comparison with href
		 || env.normalizeTitle( contentString ) === Util.decodeURI( linkData.href )
		);
	}

	return canUseSimple;
};

// Figure out if we need to use the pipe trick
WSP._usePipeTrick = function(env, dp, target, linkData) {

	var contentString = linkData.content.string;
	if (!dp.pipetrick) {
		return false;
	} else if (linkData.type === 'mw:PageProp/Language') {
		return true;
	} else if (contentString === undefined || linkData.type === 'mw:PageProp/Category') {
		return false;
	}

	// Strip colon escapes from the original target as that is
	// stripped when deriving the content string.
	var strippedTargetValue = target.value.replace(/^:/, ''),
		identicalTarget = function (a, b) {
			return (
				a === Util.stripPipeTrickChars(b) ||
				env.normalizeTitle(a) === env.normalizeTitle(Util.stripPipeTrickChars(Util.decodeURI(b)))
			);
		};

	// Only preserve pipe trick instances across edits, but don't
	// introduce new ones.
	return identicalTarget(contentString, strippedTargetValue)
		|| identicalTarget(contentString, linkData.href)
			// Interwiki links with pipetrick have their prefix
			// stripped, so compare against a stripped version
		|| ( linkData.isInterwiki &&
			  env.normalizeTitle( contentString ) ===
				target.value.replace(/^:?[a-zA-Z]+:/, '') );
};

WSP.linkHandler = function(node, state, cb) {
	// TODO: handle internal/external links etc using RDFa and dataAttribs
	// Also convert unannotated html links without advanced attributes to
	// external wiki links for html import. Might want to consider converting
	// relative links without path component and file extension to wiki links.
	var env = state.env,
		dp = DU.getDataParsoid( node ),
		linkData, contentParts,
		contentSrc = '',
		rel = node.getAttribute('rel') || '';

	// Get the rt data from the token and tplAttrs
	linkData = getLinkRoundTripData(env, node, state);

	if ( linkData.type !== null && linkData.target.value !== null  ) {
		// We have a type and target info

		// Temporary backwards-compatibility for types
		if (linkData.type === 'mw:WikiLink/Category') {
			linkData.type = 'mw:PageProp/Category';
		} else if (linkData.type === 'mw:WikiLink/Language') {
			linkData.type = 'mw:PageProp/Language';
		} else if (/^mw:ExtLink\//.test(linkData.type)) {
			linkData.type = 'mw:ExtLink';
		}

		var target = linkData.target,
			href = node.getAttribute('href') || '';
		if (/mw.ExtLink/.test(linkData.type)) {
			var targetVal = target.fromsrc || true ? target.value : Util.decodeURI(target.value);
			// Check if the href matches any of our interwiki URL patterns
				var interWikiMatch = env.conf.wiki.InterWikiMatcher.match(href);
			if (interWikiMatch &&
					// Remaining target
					// 1) is not just a fragment id (#foo), and
					// 2) does not contain a query string.
					// Both are not supported by wikitext syntax.
					!/^#|\?./.test(interWikiMatch[1]) &&
					(dp.isIW || target.modified || linkData.contentModified)) {
				//console.log(interWikiMatch);
				// External link that is really an interwiki link. Convert it.
				linkData.type = 'mw:WikiLink';
				linkData.isInterwiki = true;
				var oldPrefix = target.value.match(/^(:?[^:]+):/);
				if (oldPrefix && (
						oldPrefix[1].toLowerCase() === interWikiMatch[0].toLowerCase() ||
						// Check if the old prefix mapped to the same URL as
						// the new one. Use the old one if that's the case.
						// Example: [[w:Foo]] vs. [[:en:Foo]]
						(env.conf.wiki.interwikiMap[oldPrefix[1].toLowerCase()] || {}).url ===
						(env.conf.wiki.interwikiMap[interWikiMatch[0].replace(/^:/, '')] || {}).url
						))
				{
					// Reuse old prefix capitalization
					if (Util.decodeEntities(target.value.substr(oldPrefix[1].length+1)) !== interWikiMatch[1])
					{
						// Modified, update target.value.
						target.value = oldPrefix[1] + ':' + interWikiMatch[1];
					}
					// Else: preserve old encoding
					//console.log(oldPrefix[1], interWikiMatch);
				} else {
					target.value = interWikiMatch.join(':');
				}
			}
		}

		if (/^mw:WikiLink$/.test( linkData.type ) ||
		    /^mw:PageProp\/(?:redirect|Category|Language)$/.test( linkData.type ) ) {
			// Decode any link that did not come from the source
			if (! target.fromsrc) {
				target.value = Util.decodeURI(target.value);
			}

			// Special-case handling for category links
			if ( linkData.type === 'mw:WikiLink/Category' ||
					linkData.type === 'mw:PageProp/Category' ) {
				// Split target and sort key
				var targetParts = target.value.match( /^([^#]*)#(.*)/ );
				if ( targetParts ) {
					target.value = targetParts[1]
						.replace( /^(\.\.?\/)*/, '' )
						.replace(/_/g, ' ');
					contentParts = splitLinkContentString(
							Util.decodeURI( targetParts[2] )
								.replace( /%23/g, '#' )
								// gwicke: verify that spaces are really
								// double-encoded!
								.replace( /%20/g, ' '),
							dp );
					linkData.content.string = contentParts.contentString;
					dp.tail = linkData.tail = contentParts.tail;
					dp.prefix = linkData.prefix = contentParts.prefix;
				} else if ( dp.pipetrick ) {
					// Handle empty sort key, which is not encoded as fragment
					// in the LinkHandler
					linkData.content.string = '';
				} else { // No sort key, will serialize to simple link
					linkData.content.string = target.value;
				}

				// Special-case handling for template-affected sort keys
				// FIXME: sort keys cannot be modified yet, but if they are,
				// we need to fully shadow the sort key.
				//if ( ! target.modified ) {
					// The target and source key was not modified
					var sortKeySrc = this.serializedAttrVal(node, 'mw:sortKey', {});
					if ( sortKeySrc.value !== null ) {
						linkData.contentNode = undefined;
						linkData.content.string = sortKeySrc.value;
						// TODO: generalize this flag. It is already used by
						// getAttributeShadowInfo. Maybe use the same
						// structure as its return value?
						linkData.content.fromsrc = true;
					}
				//}
			} else if ( linkData.type === 'mw:PageProp/Language' ) {
				// Fix up the the content string
				// TODO: see if linkData can be cleaner!
				if (linkData.content.string === undefined) {
					linkData.content.string = Util.decodeURI(Util.decodeEntities(target.value));
				}
			}

			// The string value of the content, if it is plain text.
			var linkTarget;

			if ( linkData.isRedirect ) {
				linkTarget = target.value;
				if (target.modified || !target.fromsrc) {
					linkTarget = linkTarget.replace(/^(\.\.?\/)*/, '').replace(/_/g, ' ');
					linkTarget = escapeWikiLinkContentString(linkTarget,
						state, linkData.contentNode);
				}
				cb( linkData.prefix + '[[' + linkTarget + ']]', node );
				return;
			} else if ( this._isSimpleWikiLink(env, dp, target, linkData) ) {
				// Simple case
				if (!target.modified && !linkData.contentModified) {
					linkTarget = target.value;
				} else {
					linkTarget = escapeWikiLinkContentString(linkData.content.string,
							state, linkData.contentNode);
					linkTarget = this._addColonEscape(linkTarget, linkData);
				}

				cb( linkData.prefix + '[[' + linkTarget + ']]' + linkData.tail, node );
				return;
			} else {
				var usePipeTrick = this._usePipeTrick(env, dp, target, linkData);

				// First get the content source
				if ( linkData.contentNode ) {
					contentSrc = state.serializeLinkChildrenToString(
							linkData.contentNode,
							this.wteHandlers.wikilinkHandler, false);
					// strip off the tail and handle the pipe trick
					contentParts = splitLinkContentString(contentSrc, dp);
					contentSrc = contentParts.contentString;
					dp.tail = contentParts.tail;
					linkData.tail = contentParts.tail;
					dp.prefix = contentParts.prefix;
					linkData.prefix = contentParts.prefix;
				} else if ( !usePipeTrick ) {
					if (linkData.content.fromsrc) {
						contentSrc = linkData.content.string;
					} else {
						contentSrc = escapeWikiLinkContentString(linkData.content.string || '',
								state, linkData.contentNode);
					}
				}

				if ( contentSrc === '' && !usePipeTrick &&
						linkData.type !== 'mw:PageProp/Category' ) {
					// Protect empty link content from PST pipe trick
					contentSrc = '<nowiki/>';
				}
				linkTarget = target.value;
				linkTarget = this._addColonEscape(linkTarget, linkData);

				cb( linkData.prefix + '[[' + linkTarget + '|' + contentSrc + ']]' +
						linkData.tail, node );
				return;
			}
		} else if ( linkData.type === 'mw:ExtLink' ) {
			// Get plain text content, if any
			var contentStr = node.childNodes.length === 1 &&
								node.firstChild.nodeType === node.TEXT_NODE &&
								node.firstChild.nodeValue;
			// First check if we can serialize as an URL link
			if ( contentStr &&
					// Can we minimize this?
					( target.value === contentStr  ||
					node.getAttribute('href') === contentStr) &&
					// But preserve non-minimal encoding
					(target.modified || linkData.contentModified || dp.stx === 'url'))
			{
				// Serialize as URL link
				cb(target.value, node);
				return;
			} else {
				// TODO: match vs. interwikis too
				var extLinkResourceMatch = env.conf.wiki.ExtResourceURLPatternMatcher
												.match(href);
				// Fully serialize the content
				contentStr = state.serializeLinkChildrenToString(node,
						this.wteHandlers.aHandler, false);

				// First check for ISBN/RFC/PMID links. We rely on selser to
				// preserve non-minimal forms.
				if (extLinkResourceMatch) {
					var protocol = extLinkResourceMatch[0],
						serializer = env.conf.wiki.ExtResourceSerializer[protocol];

					cb(serializer(extLinkResourceMatch, target.value, contentStr), node);
					return;
				// There is an interwiki for RFCs, but strangely none for PMIDs.
				} else if (!contentStr) {
					// serialize as auto-numbered external link
					// [http://example.com]
					cb( '[' + target.value + ']', node);
					return;
				} else {

					// We expect modified hrefs to be percent-encoded already, so
					// don't need to encode them here any more. Unmodified hrefs are
					// just using the original encoding anyway.
					cb( '[' + target.value + ' ' + contentStr + ']', node );
					return;
				}
			}
		} else if ( linkData.type.match( /mw:ExtLink\/(?:RFC|PMID)/ ) ||
					/mw:(?:Wiki|Ext)Link\/ISBN/.test(rel) ) {
			// FIXME: Handle RFC/PMID in generic ExtLink handler by matching prefixes!
			// FIXME: Handle ISBN in generic WikiLink handler by looking for
			// Special:BookSources!
			cb( node.firstChild.nodeValue, node );
			return;
		} else if ( /(?:^|\s)mw:Image/.test(linkData.type) ) {
			this.handleImage( node, state, cb );
			return;
		} else {
			// Unknown rel was set
			//this._htmlElementHandler(node, state, cb);
			if ( target.modified ) {
				// encodeURI only encodes spaces and the like
				target.value = encodeURI(target.value);
			}
			cb( '[' + target.value + ' ' +
				state.serializeLinkChildrenToString(node, this.wteHandlers.aHandler, false) +
				']', node );
			return;
		}
	} else {
		// TODO: default to extlink for simple links with unknown rel set
		// switch to html only when needed to support attributes

		var isComplexLink = function ( attributes ) {
			for ( var i=0; i < attributes.length; i++ ) {
				var attr = attributes.item(i);
				// XXX: Don't drop rel and class in every case once a tags are
				// actually supported in the MW default config?
				if ( attr.name && ! ( attr.name in { href: 1, rel:1, 'class':1 } ) ) {
					return true;
				}
			}
			return false;
		};

		if ( isComplexLink ( node.attributes ) ) {
			// Complex attributes we can't support in wiki syntax
			this._htmlElementHandler(node, state, cb);
			return;
		} else {
			// encodeURI only encodes spaces and the like
			var hrefStr = encodeURI(node.getAttribute('href'));
			cb( '[' + hrefStr + ' ' +
				state.serializeLinkChildrenToString(node, this.wteHandlers.aHandler, false) +
				']', node );
			return;
		}
	}
};

WSP.genContentSpanTypes = {
	'mw:Nowiki':1,
	'mw:Image': 1,
	'mw:Image/Frameless': 1,
	'mw:Image/Frame': 1,
	'mw:Image/Thumb': 1,
	'mw:Entity': 1,
	'mw:DiffMarker': 1
};

WSP.isRecognizedSpanWrapper = function(type) {
	var contentTypes = this.genContentSpanTypes;
	return type &&
		type.split(/\s/).find(function(t) { return contentTypes[t] === 1; }) !== undefined;
};

function id(v) {
	return function() {
		return v;
	};
}

function buildHeadingHandler(headingWT) {
	return {
		handle: function(node, state, cb) {
			// For new elements, for prettier wikitext serialization,
			// emit a space after the last '=' char.
			var space = '';
			if (DU.isNewElt(node)) {
				var fc = node.firstChild;
				if (fc && (!DU.isText(fc) || !fc.nodeValue.match(/^\s/))) {
					space = ' ';
				}
			}

			cb(headingWT + space, node);
			if (node.childNodes.length) {
				var headingHandler = state.serializer
					.wteHandlers.headingHandler.bind(state.serializer.wteHandlers, node);
				state.serializeChildren(node, cb, headingHandler);
			} else {
				// Deal with empty headings
				cb('<nowiki/>', node);
			}

			// For new elements, for prettier wikitext serialization,
			// emit a space before the first '=' char.
			space = '';
			if (DU.isNewElt(node)) {
				var lc = node.lastChild;
				if (lc && (!DU.isText(lc) || !lc.nodeValue.match(/\s$/))) {
					space = ' ';
				}
			}
			cb(space + headingWT, node);
		},
		sepnls: {
			before: function (node, otherNode) {
				if (DU.isNewElt(node) && DU.previousNonSepSibling(node)) {
					// Default to two preceding newlines for new content
					return {min:2, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: id({min:1, max:2})
		}
	};
}

// XXX refactor: move to DOM handlers!
// Newly created elements/tags in this list inherit their default
// syntax from their parent scope
var inheritSTXTags = { tbody:1, tr: 1, td: 1, li: 1, dd: 1, dt: 1 },
	// These reset the inherited syntax no matter what
	setSTXTags = { table: 1, ul: 1, ol: 1, dl: 1 },
	// These (and inline elements) reset the default syntax to
	// undefined
	noHTMLSTXTags = {p: 1};


/**
 * List helper: DOM-based list bullet construction
 */
WSP._getListBullets = function(node) {
	var listTypes = {
		ul: '*',
		ol: '#',
		dl: '',
		li: '',
		dt: ';',
		dd: ':'
	}, res = '';

	// For new elements, for prettier wikitext serialization,
	// emit a space after the last bullet (if required)
	var space = '';
	if (DU.isNewElt(node)) {
		var fc = node.firstChild;
		if (fc && (!DU.isText(fc) || !fc.nodeValue.match(/^\s/))) {
			space = ' ';
		}
	}

	while (node) {
		var nodeName = node.nodeName.toLowerCase(),
			dp = DU.getDataParsoid( node );

		if (dp.stx !== 'html' && nodeName in listTypes) {
			res = listTypes[nodeName] + res;
		} else if (dp.stx !== 'html' || !dp.autoInsertedStart || !dp.autoInsertedEnd) {
			break;
		}

		node = node.parentNode;
	}

	return res + space;
};

/**
 * Bold/italic helper: Get a preceding quote/italic element or a '-char
 */
WSP._getPrecedingQuoteElement = function(node, state) {
	if (!state.sep.lastSourceNode) {
		// A separator was emitted before some other non-empty wikitext
		// string, which means that we can't be directly preceded by quotes.
		return null;
	}

	var prev = DU.previousNonDeletedSibling(node);
	if (prev && DU.isText(prev) && prev.nodeValue.match(/'$/)) {
		return prev;
	}

	// Move up first until we have a sibling
	while (node && !DU.previousNonDeletedSibling(node)) {
		node = node.parentNode;
	}

	if (node) {
		node = node.previousSibling;
	}

	// Now move down the lastChilds to see if there are any italics / bolds
	while (node && DU.isElt(node)) {
		if (DU.isQuoteElt(node) && DU.isQuoteElt(node.lastChild)) {
			return state.sep.lastSourceNode === node ? node.lastChild : null;
		} else if (state.sep.lastSourceNode === node) {
			// If a separator was already emitted, or an outstanding separator
			// starts at another node that produced output, we are not
			// directly preceded by quotes in the wikitext.
			return null;
		}
		node = node.lastChild;
	}
	return null;
};

WSP._quoteTextFollows = function(node, state) {
	var next = DU.nextNonDeletedSibling(node);
	return next && DU.isText(next) && next.nodeValue[0] === "'";
};

function wtEOL(node, otherNode) {
	if (DU.isElt(otherNode) &&
		(DU.getDataParsoid( otherNode ).stx === 'html' || DU.getDataParsoid( otherNode ).src))
	{
		return {min:0, max:2};
	} else {
		return {min:1, max:2};
	}
}

function wtListEOL(node, otherNode) {
	if (otherNode.nodeName === 'BODY' ||
		!DU.isElt(otherNode) ||
		DU.isFirstEncapsulationWrapperNode(otherNode))
	{
		return {min:0, max:2};
	}

	var nextSibling = DU.nextNonSepSibling(node);
	var dp = DU.getDataParsoid( otherNode );
	if ( nextSibling === otherNode && dp.stx === 'html' || dp.src ) {
		return {min:0, max:2};
	} else if (nextSibling === otherNode && DU.isListOrListItem(otherNode)) {
		if (DU.isList(node) && otherNode.nodeName === node.nodeName) {
			// Adjacent lists of same type need extra newline
			return {min: 2, max:2};
		} else if (DU.isListItem(node) || node.parentNode.nodeName in {LI:1, DD:1}) {
			// Top-level list
			return {min:1, max:1};
		} else {
			return {min:1, max:2};
		}
	} else if (DU.isList(otherNode) ||
			(DU.isElt(otherNode) && dp.stx === 'html'))
	{
		// last child in ul/ol (the list element is our parent), defer
		// separator constraints to the list.
		return {};
	} else {
		return {min:1, max:2};
	}
}

function buildListHandler(firstChildNames) {
	function isBuilderInsertedElt(node) {
		var dp = DU.getDataParsoid( node );
		return dp && dp.autoInsertedStart && dp.autoInsertedEnd;
	}

	return {
		handle: function (node, state, cb) {
			var firstChildElt = DU.firstNonSepChildNode(node);

			// Skip builder-inserted wrappers
			// Ex: <ul><s auto-inserted-start-and-end-><li>..</li><li>..</li></s>...</ul>
			// output from: <s>\n*a\n*b\n*c</s>
			while (firstChildElt && isBuilderInsertedElt(firstChildElt)) {
				firstChildElt = DU.firstNonSepChildNode(firstChildElt);
			}

			if (!firstChildElt || ! (firstChildElt.nodeName in firstChildNames)) {
				cb(state.serializer._getListBullets(node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler.bind(state.serializer.wteHandlers, node);
			state.serializeChildren(node, cb, liHandler);
		},
		sepnls: {
			before: function (node, otherNode) {
				// SSS FIXME: Thoughts about a fix (abandoned in this patch)
				//
				// Checking for otherNode.nodeName === 'BODY' and returning
				// {min:0, max:0} should eliminate the annoying leading newline
				// bug in parser tests, but it seems to cause other niggling issues
				// <ul> <li>foo</li></ul> serializes to " *foo" which is buggy.
				// So, we may need another constraint/flag/test in makeSeparator
				// about the node and its context so that leading pre-inducing WS
				// can be stripped

				if (otherNode.nodeName === 'BODY') {
					return {min:0, max:0};
				} else if (DU.isText(otherNode) && DU.isListItem(node.parentNode)) {
					// A list nested inside a list item
					// <li> foo <dl> .. </dl></li>
					return {min:1, max:1};
				} else {
					return {min:1, max:2};
				}
			},
			after: wtListEOL //id({min:1, max:2})
		}
	};
}

/* currentNode is being processed and line has information
 * about the wikitext line emitted so far. This function checks
 * if the DOM has a block node emitted on this line till currentNode */
function currWikitextLineHasBlockNode(line, currentNode) {
	var n = line.firstNode;
	while (n && n !== currentNode) {
		if (DU.isBlockNode(n)) {
			return true;
		}
		n = n.nextSibling;
	}
	return false;
}

WSP.tagHandlers = {
	dl: buildListHandler({DT:1, DD:1}),
	ul: buildListHandler({LI:1}),
	ol: buildListHandler({LI:1}),

	li: {
		handle: function (node, state, cb) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement)) {
				cb(state.serializer._getListBullets(node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler.bind(state.serializer.wteHandlers, node);
			state.serializeChildren(node, cb, liHandler);
		},
		sepnls: {
			before: function (node, otherNode) {
				if ((otherNode === node.parentNode && otherNode.nodeName in {UL:1, OL:1}) ||
					(DU.isElt(otherNode) && DU.getDataParsoid( otherNode ).stx === 'html'))
				{
					return {}; //{min:0, max:1};
				} else {
					return {min:1, max:2};
				}
			},
			after: wtListEOL,
			firstChild: function (node, otherNode) {
				if (!DU.isList(otherNode)) {
					return {min:0, max: 0};
				} else {
					return {};
				}
			}
		}
	},

	dt: {
		handle: function (node, state, cb) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement)) {
				cb(state.serializer._getListBullets(node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler.bind(state.serializer.wteHandlers, node);
			state.serializeChildren(node, cb, liHandler);
		},
		sepnls: {
			before: id({min:1, max:2}),
			after: function (node, otherNode) {
				if (otherNode.nodeName === 'DD' && DU.getDataParsoid( otherNode ).stx === 'row') {
					return {min:0, max:0};
				} else {
					return wtListEOL(node, otherNode);
				}
			},
			firstChild: function (node, otherNode) {
				if (!DU.isList(otherNode)) {
					return {min:0, max: 0};
				} else {
					return {};
				}
			}
		}
	},

	dd: {
		handle: function (node, state, cb) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement)) {
				// XXX: handle stx: row
				if ( DU.getDataParsoid( node ).stx === 'row' ) {
					cb(':', node);
				} else {
					cb(state.serializer._getListBullets(node), node);
				}
			}
			var liHandler = state.serializer.wteHandlers.liHandler.bind(state.serializer.wteHandlers, node);
			state.serializeChildren(node, cb, liHandler);
		},
		sepnls: {
			before: function(node, othernode) {
				// Handle single-line dt/dd
				if ( DU.getDataParsoid( node ).stx === 'row' ) {
					return {min:0, max:0};
				} else {
					return {min:1, max:2};
				}
			},
			after: wtListEOL,
			firstChild: function (node, otherNode) {
				if (!DU.isList(otherNode)) {
					return {min:0, max: 0};
				} else {
					return {};
				}
			}
		}
	},


	// XXX: handle options
	table: {
		handle: function (node, state, cb, wrapperUnmodified) {
			var dp = DU.getDataParsoid( node );
			var wt = dp.startTagSrc || "{|";
			cb(state.serializer._serializeTableTag(wt, '', state, node, wrapperUnmodified), node);
			state.serializeChildren(node, cb);
			if (!state.sep.constraints) {
				// Special case hack for "{|\n|}" since state.sep is cleared
				// in emitSep after a separator is emitted. However, for {|\n|},
				// the <table> tag has no element children which means lastchild -> parent
				// constraint is never computed and set here.
				state.sep.constraints = {a:{}, b:{}, min:1, max:2};
			}
			emitEndTag( dp.endTagSrc || "|}", node, state, cb );
		},
		sepnls: {
			before: function(node, otherNode) {
				// Handle special table indentation case!
				if (node.parentNode === otherNode && otherNode.nodeName === 'DD') {
					return {min:0, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: function (node, otherNode) {
				if (DU.isNewElt(node) ||
						(DU.isElt(otherNode) && DU.isNewElt(otherNode)))
				{
					return {min:1, max:2};
				} else {
					return {min:0, max:2};
				}
			},
			firstChild: id({min:1, max:2}),
			lastChild: id({min:1, max:2})
		}
	},
	tbody: {
		handle: function (node, state, cb) {
			// Just serialize the children, ignore the (implicit) tbody
			state.serializeChildren(node, cb);
		}
	},
	tr: {
		handle: function (node, state, cb, wrapperUnmodified) {
			// If the token has 'startTagSrc' set, it means that the tr was present
			// in the source wikitext and we emit it -- if not, we ignore it.
			var dp = DU.getDataParsoid( node );
			// ignore comments and ws
			if (DU.previousNonSepSibling(node) || dp.startTagSrc) {
				var res = state.serializer._serializeTableTag(dp.startTagSrc || "|-", '', state,
							node, wrapperUnmodified );
				emitStartTag(res, node, state, cb);
			}
			state.serializeChildren(node, cb);
		},
		sepnls: {
			before: function(node, othernode) {
				if ( !DU.previousNonDeletedSibling(node) && !DU.getDataParsoid( node ).startTagSrc ) {
					// first line
					return {min:0, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: function(node, othernode) {
				return {min:0, max:2};
			}
		}
	},
	th: {
		handle: function (node, state, cb, wrapperUnmodified) {
			var dp = DU.getDataParsoid( node ), res;
			if ( dp.stx_v === 'row' ) {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "!!",
							dp.attrSepSrc || null, state, node, wrapperUnmodified);
			} else {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "!", dp.attrSepSrc || null,
						state, node, wrapperUnmodified);
			}
			emitStartTag(res, node, state, cb);
			state.serializeChildren(node, cb, state.serializer.wteHandlers.thHandler);
		},
		sepnls: {
			before: function(node, otherNode) {
				if ( DU.getDataParsoid( node ).stx_v === 'row' ) {
					// force single line
					return {min:0, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: id({min: 0, max:2})
		}
	},
	td: {
		handle: function (node, state, cb, wrapperUnmodified) {
			var dp = DU.getDataParsoid( node ), res;
			if ( dp.stx_v === 'row' ) {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "||",
						dp.attrSepSrc || null, state, node, wrapperUnmodified);
			} else {
				// If the HTML for the first td is not enclosed in a tr-tag,
				// we start a new line.  If not, tr will have taken care of it.
				res = state.serializer._serializeTableTag(dp.startTagSrc || "|",
						dp.attrSepSrc || null, state, node, wrapperUnmodified);

			}
			// FIXME: bad state hack!
			if(res.length > 1) {
				state.inWideTD = true;
			}
			emitStartTag(res, node, state, cb);
			state.serializeChildren(node, cb,
				state.serializer.wteHandlers.tdHandler.bind(state.serializer.wteHandlers, node));
			// FIXME: bad state hack!
			state.inWideTD = undefined;
		},
		sepnls: {
			before: function(node, otherNode) {
				return DU.getDataParsoid( node ).stx_v === 'row' ?
					{min: 0, max:2} : {min:1, max:2};
			},
			//after: function(node, otherNode) {
			//	return otherNode.data.parsoid.stx_v === 'row' ?
			//		{min: 0, max:2} : {min:1, max:2};
			//}
			after: id({min: 0, max:2})
		}
	},
	caption: {
		handle: function (node, state, cb, wrapperUnmodified) {
			var dp = DU.getDataParsoid( node );
			// Serialize the tag itself
			var res = state.serializer._serializeTableTag(
					dp.startTagSrc || "|+", null, state, node, wrapperUnmodified);
			emitStartTag(res, node, state, cb);
			state.serializeChildren(node, cb);
		},
		sepnls: {
			before: function(node, otherNode) {
				return otherNode.nodeName !== 'TABLE' ?
					{min: 1, max: 2} : {min:0, max: 2};
			},
			after: id({min: 1, max: 2})
		}
	},
	// Insert the text handler here too?
	'#text': { },
	p: {
		handle: function(node, state, cb) {
			// XXX: Handle single-line mode by switching to HTML handler!
			state.serializeChildren(node, cb, null);
		},
		sepnls: {
			before: function(node, otherNode, state) {

				var otherNodeName = otherNode.nodeName,
					tdOrBody = JSUtils.arrayToSet(['TD', 'BODY']);
				if (node.parentNode === otherNode &&
					DU.isListItem(otherNode) || tdOrBody.has(otherNodeName))
				{
					if (tdOrBody.has(otherNodeName)) {
						return {min: 0, max: 1};
					} else {
						return {min: 0, max: 0};
					}
				} else if (
					otherNode === DU.previousNonDeletedSibling(node) &&
					// p-p transition
					(otherNodeName === 'P' && DU.getDataParsoid( otherNode ).stx !== 'html') ||
					// Treat text/p similar to p/p transition
					(
						DU.isText(otherNode) &&
						otherNode === DU.previousNonSepSibling(node) &&
						!currWikitextLineHasBlockNode(state.currLine, otherNode)
					)
				) {
					return {min: 2, max: 2};
				} else {
					return {min: 1, max: 2};
				}
			},
			after: function(node, otherNode) {
				if (!(node.lastChild && node.lastChild.nodeName === 'BR') &&
					otherNode.nodeName === 'P' && DU.getDataParsoid( otherNode ).stx !== 'html') /* || otherNode.nodeType === node.TEXT_NODE*/
				{
					return {min: 2, max: 2};
				} else {
					// When the other node is a block-node, we want it
					// to be on a different line from the implicit-wikitext-p-tag
					// because the p-wrapper in the parser will suppress a html-p-tag
					// if it sees the block tag on the same line as a text-node.
					return {min: DU.isBlockNode(otherNode) ? 1 : 0, max: 2};
				}
			}
		}
	},
	pre: {
		handle: function(node, state, cb) {
			// Handle indent pre

			// XXX: Use a pre escaper?
			state.inIndentPre = true;
			var content = state.serializeChildrenToString(node);

			// Strip (only the) trailing newline
			var trailingNL = content.match(/\n$/);
			content = content.replace(/\n$/, '');

			// Insert indentation
			content = ' ' + content.replace(/(\n(<!--(?:[^\-]|\-(?!\->))*\-\->)*)/g, '$1 ');

			// But skip "empty lines" (lines with 1+ comment and optional whitespace)
			// since empty-lines sail through all handlers without being affected.
			// See empty_line_with_comments production in pegTokenizer.pegjs.txt
			//
			// We could use 'split' to split content into lines and selectively add
			// indentation, but the code will get unnecessarily complex for questionable
			// benefits. So, going this route for now.
			content = content.replace(/(^|\n) ((?:[ \t]*<!--(?:[^\-]|\-(?!\->))*\-\->[ \t]*)+)(?=\n|$)/, '$1$2');

			cb(content, node);

			// Preserve separator source
			state.sep.src = trailingNL && trailingNL[0] || '';
			state.inIndentPre = false;
		},
		sepnls: {
			before: function(node, otherNode) {
				if ( DU.getDataParsoid( node ).stx === 'html' ) {
					return {};
				} else if (otherNode.nodeName === 'PRE' &&
					DU.getDataParsoid( otherNode ).stx !== 'html')
				{
					return {min:2};
				} else {
					return {min:1};
				}
			},
			after: function(node, otherNode) {
				if ( DU.getDataParsoid( node ).stx === 'html' ) {
					return {};
				} else if (otherNode.nodeName === 'PRE' &&
					DU.getDataParsoid( otherNode ).stx !== 'html')
				{
					return {min:2};
				} else {
					return {min:1};
				}
			}
		}
	},
	meta: {
		handle: function (node, state, cb) {
			var type = node.getAttribute('typeof'),
				content = node.getAttribute('content'),
				property = node.getAttribute('property'),
				dp = DU.getDataParsoid( node );

			// Check for property before type so that page properties with templated attrs
			// roundtrip properly.  Ex: {{DEFAULTSORT:{{echo|foo}} }}
			if ( property ) {
				var switchType = property.match( /^mw\:PageProp\/(.*)$/ );
				if ( switchType ) {
					var out = switchType[1];
					if (out === 'categorydefaultsort') {
						if (dp.src) {
							// Use content so that VE modifications are preserved
							var contentInfo = state.serializer.serializedAttrVal(node, "content", {});
							out = dp.src.replace(/^([^:]+:)(.*)$/, "$1" + contentInfo.value + "}}");
						} else {
							state.env.log("error", 'defaultsort is missing source. Rendering as DEFAULTSORT magicword');
							out = "{{DEFAULTSORT:" + content + "}}";
						}
					} else {
						out = state.env.conf.wiki.getMagicWordWT( switchType[1], dp.magicSrc ) || '';
					}
					cb(out, node);
				}
			} else if ( type ) {
				switch ( type ) {
					case 'mw:tag':
							 // we use this currently for nowiki and co
							 if ( content === 'nowiki' ) {
								 state.inNoWiki = true;
							 } else if ( content === '/nowiki' ) {
								 state.inNoWiki = false;
							 } else {
								state.env.log("error", JSON.stringify(node.outerHTML));
							 }
							 cb('<' + content + '>', node);
							 break;
					case 'mw:Includes/IncludeOnly':
							 cb(dp.src, node);
							 break;
					case 'mw:Includes/IncludeOnly/End':
							 // Just ignore.
							 break;
					case 'mw:Includes/NoInclude':
							 cb(dp.src || '<noinclude>', node);
							 break;
					case 'mw:Includes/NoInclude/End':
							 cb(dp.src || '</noinclude>', node);
							 break;
					case 'mw:Includes/OnlyInclude':
							 cb(dp.src || '<onlyinclude>', node);
							 break;
					case 'mw:Includes/OnlyInclude/End':
							 cb(dp.src || '</onlyinclude>', node);
							 break;
					case 'mw:DiffMarker':
					case 'mw:Separator':
							 // just ignore it
							 //cb('');
							 break;
					default:
							 state.serializer._htmlElementHandler(node, state, cb);
							 break;
				}
			} else {
				state.serializer._htmlElementHandler(node, state, cb);
			}
		},
		sepnls: {
			before: function(node, otherNode) {
				var type = node.getAttribute( 'typeof' ) || node.getAttribute( 'property' );
				if ( type && type.match( /mw:PageProp\/categorydefaultsort/ ) ) {
					if ( otherNode.nodeName === 'P' && DU.getDataParsoid( otherNode ).stx !== 'html' ) {
						// Since defaultsort is outside the p-tag, we need 2 newlines
						// to ensure that it go back into the p-tag when parsed.
						return { min: 2 };
					} else {
						return { min: 1 };
					}
				} else if (DU.isNewElt(node)) {
					return { min: 1 };
				} else {
					return {};
				}
			},
			after: function(node, otherNode) {
				// No diffs
				if (DU.isNewElt(node)) {
					return { min: 1 };
				} else {
					return {};
				}
			}
		}
	},
	span: {
		handle: function(node, state, cb) {
			var type = node.getAttribute('typeof');
			if (state.serializer.isRecognizedSpanWrapper(type)) {
				if (type === 'mw:Nowiki') {
					cb('<nowiki>', node);
					if (node.childNodes.length === 1 && node.firstChild.nodeName === 'PRE') {
						state.serializeChildren(node, cb);
					} else {
						var child = node.firstChild;
						while(child) {
							if (DU.isElt(child)) {
								/* jshint noempty: false */
								if (DU.isMarkerMeta(child, "mw:DiffMarker")) {
									// nothing to do
								} else if (child.nodeName === 'SPAN' &&
										child.getAttribute('typeof') === 'mw:Entity')
								{
									state.serializer._serializeNode(child, state, cb);
								} else {
									cb(child.outerHTML, node);
								}
							} else if (DU.isText(child)) {
								cb(child.nodeValue.replace(/<(\/?nowiki)>/g, '&lt;$1&gt;'), child);
							} else {
								state.serializer._serializeNode(child, state, cb);
							}
							child = child.nextSibling;
						}
					}
					emitEndTag('</nowiki>', node, state, cb);
				} else if ( /(?:^|\s)mw\:Image(\/(Frame|Frameless|Thumb))?/.test(type) ) {
					state.serializer.handleImage( node, state, cb );
				} else if ( /(?:^|\s)mw\:Entity/.test(type) && node.childNodes.length === 1 ) {
					// handle a new mw:Entity (not handled by selser) by
					// serializing its children
					state.serializeChildren(node, cb);
				}

			} else {
				// Fall back to plain HTML serialization for spans created
				// by the editor
				state.serializer._htmlElementHandler(node, state, cb);
			}
		}
	},
	figure: {
		handle: function(node, state, cb) {
			return state.serializer.figureHandler(node, state, cb);
		},
		sepnls: {
			// TODO: Avoid code duplication
			before: function (node) {
				if (
					DU.isNewElt(node) &&
					node.parentNode &&
					node.parentNode.nodeName === 'BODY'
				) {
					return { min: 1 };
				}
				return {};
			},
			after: function (node) {
				if (
					DU.isNewElt(node) &&
					node.parentNode &&
					node.parentNode.nodeName === 'BODY'
				) {
					return { min: 1 };
				}
				return {};
			}
		}
	},
	img: {
		handle: function (node, state, cb) {
			if ( node.getAttribute('rel') === 'mw:externalImage' ) {
				state.serializer.emitWikitext(node.getAttribute('src') || '', state, cb, node);
			}
		}
	},
	hr: {
		handle: function (node, state, cb) {
			cb(Util.charSequence("----", "-", DU.getDataParsoid( node ).extra_dashes), node);
		},
		sepnls: {
			before: id({min: 1, max: 2}),
			// XXX: Add a newline by default if followed by new/modified content
			after: id({min: 0, max: 2})
		}
	},
	h1: buildHeadingHandler("="),
	h2: buildHeadingHandler("=="),
	h3: buildHeadingHandler("==="),
	h4: buildHeadingHandler("===="),
	h5: buildHeadingHandler("====="),
	h6: buildHeadingHandler("======"),
	br: {
		handle: function(node, state, cb) {
			if (DU.getDataParsoid( node ).stx === 'html' || node.parentNode.nodeName !== 'P') {
				cb('<br>', node);
			} else {
				// Trigger separator
				if (state.sep.constraints && state.sep.constraints.min === 2 &&
						node.parentNode.childNodes.length === 1) {
					// p/br pair
					// Hackhack ;)

					// SSS FIXME: With the change I made, the above check can be simplified
					state.sep.constraints.min = 2;
					state.sep.constraints.max = 2;
					cb('', node);
				} else {
					cb('', node);
				}
			}
		},
		sepnls: {
			before: function (node, otherNode) {
				if (otherNode === node.parentNode && otherNode.nodeName === 'P') {
					return {min: 1, max: 2};
				} else {
					return {};
				}
			},
			after: function(node, otherNode) {
				// List items in wikitext dont like linebreaks.
				//
				// This seems like the wrong place to make this fix.
				// To handle this properly and more generically / robustly,
				// * we have to buffer output of list items,
				// * on encountering list item close, post-process the buffer
				//   to eliminate any newlines.
				if (DU.isListItem(node.parentNode)) {
					return {};
				} else {
					return id({min:1})();
				}
			}
		}

				/*,
		sepnls: {
			after: function (node, otherNode) {
				if (node.data.parsoid.stx !== 'html' || node.parentNode.nodeName === 'P') {
					// Wikitext-syntax br, force newline
					return {}; //{min:1};
				} else {
					// HTML-syntax br.
					return {};
				}
			}

		}*/
	},
	b:  {
		handle: function(node, state, cb) {
			var q1 = state.serializer._getPrecedingQuoteElement(node, state);
			var q2 = state.serializer._quoteTextFollows(node, state);
			if (q1 && (q2 || DU.isElt(q1))) {
				emitStartTag('<nowiki/>', node, state, cb);
			}
			emitStartTag("'''", node, state, cb);
			state.serializeChildren(node, cb, state.serializer.wteHandlers.quoteHandler);
			emitEndTag("'''", node, state, cb);
			if (q2) {
				emitEndTag('<nowiki/>', node, state, cb);
			}
		}
	},
	i:  {
		handle: function(node, state, cb) {
			var q1 = state.serializer._getPrecedingQuoteElement(node, state);
			var q2 = state.serializer._quoteTextFollows(node, state);
			if (q1 && (q2 || DU.isElt(q1))) {
				emitStartTag('<nowiki/>', node, state, cb);
			}
			emitStartTag("''", node, state, cb);
			state.serializeChildren(node, cb, state.serializer.wteHandlers.quoteHandler);
			emitEndTag("''", node, state, cb);
			if (q2) {
				emitEndTag('<nowiki/>', node, state, cb);
			}
		}
	},
	a:  {
		handle: function(node, state, cb) {
			return state.serializer.linkHandler(node, state, cb);
		}
		// TODO: Implement link tail escaping with nowiki in DOM handler!
	},
	link:  {
		handle: function(node, state, cb) {
			return state.serializer.linkHandler(node, state, cb);
		},
		sepnls: {
			before: function (node, otherNode) {
				var type = node.getAttribute('rel');
				if (/(?:^|\s)mw:(PageProp|WikiLink)\/(Category|redirect)(?=$|\s)/.test(type) &&
						DU.isNewElt(node) ) {
					// Fresh category link: Serialize on its own line
					return {min: 1};
				} else {
					return {};
				}
			},
			after: function (node, otherNode) {
				var type = node.getAttribute('rel');
				if (/(?:^|\s)mw:(PageProp|WikiLink)\/Category(?=$|\s)/.test(type) &&
						DU.isNewElt(node) &&
						otherNode.nodeName !== 'BODY')
				{
					// Fresh category link: Serialize on its own line
					return {min: 1};
				} else {
					return {};
				}
			}
		}
	},
	body: {
		handle: function(node, state, cb) {
			// Just serialize the children
			state.serializeChildren(node, cb);
		},
		sepnls: {
			firstChild: id({min:0, max:1}),
			lastChild: id({min:0, max:1})
		}
	},
	blockquote: {
		sepnls: {
			// Dirty trick: Suppress newline inside blockquote to avoid a
			// paragraph, at least for the first line.
			// TODO: Suppress paragraphs inside blockquotes in the paragraph
			// handler instead!
			firstChild: id({max:0})
		}
	}
};

WSP._serializeAttributes = function (state, node, token) {
	function hasExpandedAttrs(tokType) {
		return (/(?:^|\s)mw:ExpandedAttrs\/[^\s]+/).test(tokType);
	}

	var tokType = token.getAttribute("typeof"),
		attribs = token.attribs;

	var out = [],
		// Strip Parsoid generated values
		keysWithParsoidValues = {
			'about': /^#mwt\d+$/,
			'typeof': /(^|\s)mw:[^\s]+/g
		},
		ignoreKeys = {
			'data-mw': 1,
			// The following should be filtered out earlier,
			// but we ignore them here too just to make sure.
			'data-parsoid': 1,
			'data-ve-changed': 1,
			'data-parsoid-changed': 1,
			'data-parsoid-diff': 1,
			'data-parsoid-serialize': 1
		};

	var kv, k, vInfo, v, tplKV, tplK, tplV;
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		kv = attribs[i];
		k = kv.k;

		// Unconditionally ignore
		if (ignoreKeys[k]) {
			continue;
		}

		// Strip Parsoid-values
		//
		// FIXME: Given that we are currently escaping about/typeof keys
		// that show up in wikitext, we could unconditionally strip these
		// away right now.
		if (keysWithParsoidValues[k] && kv.v.match(keysWithParsoidValues[k])) {
			v = kv.v.replace(keysWithParsoidValues[k], '');
			if (v) {
				out.push(k + '=' + '"' + v + '"');
			}
			continue;
		}

		if (k.length > 0) {
			vInfo = token.getAttributeShadowInfo(k);
			v = vInfo.value;

			// Deal with k/v's that were template-generated
			k = this.getAttributeKey(node, k);

			// Pass in kv.k, not k since k can potentially
			// be original wikitext source for 'k' rather than
			// the string value of the key.
			v = this.getAttrValFromDataMW(node, kv.k, v);

			// Remove encapsulation from protected attributes
			// in pegTokenizer.pegjs.txt:generic_newline_attribute
			k = k.replace( /^data-x-/i, '' );

			if (v.length > 0) {
				if (!vInfo.fromsrc) {
					// Escape HTML entities
					v = Util.escapeEntities(v);
				}
				out.push(k + '=' + '"' + v.replace( /"/g, '&quot;' ) + '"');
			} else if (k.match(/[{<]/)) {
				// Templated, <*include*>, or <ext-tag> generated
				out.push(k);
			} else {
				out.push(k + '=""');
			}
		} else if ( kv.v.length ) {
			// not very likely..
			out.push( kv.v );
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
		var aKeys = Object.keys(dataAttribs.a);
		for (i = 0, l = aKeys.length; i < l; i++) {
			k = aKeys[i];
			// Attrib not present -- sanitized away!
			if (!Util.lookupKV(attribs, k)) {
				v = dataAttribs.sa[k];
				if (v) {
					out.push(k + '=' + '"' + v.replace( /"/g, '&quot;' ) + '"');
				} else {
					// at least preserve the key
					out.push(k);
				}
			}
		}
	}

	// XXX: round-trip optional whitespace / line breaks etc
	return out.join(' ');
};

WSP._handleLIHackIfApplicable = function (node, cb) {
	var liHackSrc = DU.getDataParsoid( node ).liHackSrc,
	    prev = DU.previousNonSepSibling(node);

	// If we are dealing with an LI hack, then we must ensure that
	// we are dealing with either
	//
	//   1. A node with no previous sibling inside of a list.
	//
	//   2. A node whose previous sibling is a list element.
	if (liHackSrc !== undefined &&
	    ((prev === null && DU.isList(node.parentNode)) ||        // Case 1
	     (prev !== null && DU.isListItem(prev)))) {              // Case 2
		cb(liHackSrc, node);
	}
};

WSP._htmlElementHandler = function (node, state, cb, wrapperUnmodified) {
	// Wikitext supports the following list syntax:
	//
	//    * <li class="a"> hello world
	//
	// The "LI Hack" gives support for this syntax, and we need to
	// specially reconstruct the above from a single <li> tag.
	this._handleLIHackIfApplicable(node, cb);

	emitStartTag(this._serializeHTMLTag(state, node, wrapperUnmodified),
			node, state, cb);
	if (node.childNodes.length) {
		var inPHPBlock = state.inPHPBlock;
		if (Util.tagOpensBlockScope(node.nodeName.toLowerCase())) {
			state.inPHPBlock = true;
		}

		if (node.nodeName === 'PRE') {
			// Handle html-pres specially
			// 1. If the node has a leading newline, add one like it (logic copied from VE)
			// 2. If not, and it has a data-parsoid strippedNL flag, add it back.
			// This patched DOM will serialize html-pres correctly.

			var lostLine = '', fc = node.firstChild;
			if (fc && DU.isText(fc)) {
				var m = fc.nodeValue.match(/^\r\n|\r|\n/);
				lostLine = m && m[0] || '';
			}

			var shadowedNL = DU.getDataParsoid( node ).strippedNL;
			if (!lostLine && shadowedNL) {
				lostLine = shadowedNL;
			}

			cb(lostLine, node);
		}

		state.serializeChildren(node, cb);
		state.inPHPBlock = inPHPBlock;
	}
	emitEndTag(this._serializeHTMLEndTag(state, node, wrapperUnmodified),
			node, state, cb);
};

WSP._buildTemplateWT = function(node, state, srcParts) {
	function countPositionalArgs(tpl, paramInfos) {
		var res = 0;
		paramInfos.forEach(function(paramInfo) {
			var k = paramInfo.k;
			if (tpl.params[k] !== undefined && !paramInfo.named) {
				res++;
			}
		});
		return res;
	}

	var buf = '',
		serializer = this,
		dp = DU.getDataParsoid( node );

	// Workaround for VE bug https://bugzilla.wikimedia.org/show_bug.cgi?id=51150
	if (srcParts.length === 1 && srcParts[0].template &&
			srcParts[0].template.i === undefined) {
		srcParts[0].template.i = 0;
	}

	srcParts.map(function(part) {
		var tpl = part.template;
		if (tpl) { // transclusion: tpl or parser function
			var isTpl = typeof(tpl.target.href) === 'string';
			buf += "{{";

			// tpl target
			buf += tpl.target.wt;

			// tpl args
			var argBuf = [],
				keys = Object.keys(tpl.params),
				// per-parameter info for pre-existing parameters
				paramInfos = dp.pi && tpl.i !== undefined ?
								dp.pi[tpl.i] || [] : [],
				// extract the original keys in order
				origKeys = paramInfos.map( function (paramInfo) {
					return paramInfo.k;
				}),
				n = keys.length;
			if (n > 0) {
				var numericIndex = 1,
					numPositionalArgs = countPositionalArgs(tpl, paramInfos),
					pushArg = function (k, paramInfo) {
						if (!paramInfo) {
							paramInfo = {};
						}

						var v = tpl.params[k].wt,
							// Default to ' = ' spacing. Anything that matches
							// this does not remember spc explicitly.
							spc = ['', ' ', ' ', ''],
							opts = {
								serializeAsNamed: false,
								isTemplate: isTpl,
								numPositionalArgs: numPositionalArgs,
								argIndex: numericIndex
							};

						if (paramInfo.named || k !== numericIndex.toString()) {
							opts.serializeAsNamed = true;
						}

						if (paramInfo.spc) {
							spc = paramInfo.spc;
						} //else {
							// TODO: match the space style of other/ parameters!
							//spc = ['', ' ', ' ', ''];
						//}
						var res = serializer.escapeTplArgWT(state, v, opts);
						if (res.serializeAsNamed) {
							// Escape as value only
							// Trim WS
							argBuf.push(spc[0] + k + spc[1] + "=" + spc[2] + res.v.trim() + spc[3]);
						} else {
							numericIndex++;
							// Escape as positional parameter
							// No WS trimming
							argBuf.push(res.v);
						}
					};

				// first serialize out old parameters in order
				paramInfos.forEach(function(paramInfo) {
					var k = paramInfo.k;
					if (tpl.params[k] !== undefined) {
						pushArg(k, paramInfo);
					}
				});
				// then push out remaining (new) parameters
				keys.forEach(function(k) {
					// Don't allow whitespace in keys

					var strippedK = k.trim();
					if (origKeys.indexOf(strippedK) === -1) {
						if (strippedK !== k) {
							// copy over
							tpl.params[strippedK] = tpl.params[k];
						}
						pushArg(strippedK);
					}
				});

				// Now append the parameters joined by pipes
				buf += "|";
				buf += argBuf.join("|");
			}
			buf += "}}";
		} else {
			// plain wt
			buf += part;
		}
	});
	return buf;
};

WSP._buildExtensionWT = function(state, node, dataMW) {
	var extName = dataMW.name,
		srcParts = ["<", extName];

	// Serialize extension attributes in normalized form as:
	// key='value'
	var attrs = dataMW.attrs || {},
		extTok = new pd.TagTk(extName, Object.keys(attrs).map(function(k) {
			return new pd.KV(k, attrs[k]);
		})),
		about = node.getAttribute('about'),
		type = node.getAttribute('typeof'),
		attrStr;

	if (about) {
		extTok.addAttribute('about', about);
	}
	if (type) {
		extTok.addAttribute('typeof', type);
	}
	attrStr = this._serializeAttributes(state, node, extTok);

	if (attrStr) {
		srcParts.push(' ');
		srcParts.push(attrStr);
	}

	// Serialize body
	if (!dataMW.body) {
		srcParts.push(" />");
	} else {
		srcParts.push(">");
		if (typeof dataMW.body.html === 'string') {
			var wts = new WikitextSerializer({
				env: state.env,
				extName: extName
			});
			srcParts.push(wts.serializeDOM(DU.parseHTML(dataMW.body.html).body));
		} else if (dataMW.body.extsrc) {
			srcParts.push(dataMW.body.extsrc);
		} else {
			this.env.log("error", "extension src unavailable for: " + node.outerHTML );
		}
		srcParts = srcParts.concat(["</", extName, ">"]);
	}

	return srcParts.join('');
};

/**
 * Get a DOM-based handler for an element node
 */
WSP._getDOMHandler = function(node, state, cb) {
	var self = this;

	if (!node || node.nodeType !== node.ELEMENT_NODE) {
		return {};
	}

	var dp = DU.getDataParsoid( node ),
		nodeName = node.nodeName.toLowerCase(),
		handler,
		typeOf = node.getAttribute( 'typeof' ) || '';

	// XXX: Convert into separate handlers?
	if (/(?:^|\s)mw:(?:Transclusion(?=$|\s)|Param(?=$|\s)|Extension\/[^\s]+)/.test(typeOf)) {
		return {
			handle: function () {
				var src, dataMW;
				if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
					dataMW = JSON.parse(node.getAttribute("data-mw"));
					if (dataMW) {
						src = state.serializer._buildTemplateWT(node,
								state, dataMW.parts || [{ template: dataMW }]);
					} else {
						self.env.log("error", "No data-mw for" + node.outerHTML );
						src = dp.src;
					}
				} else if (/(?:^|\s)mw:Param(?=$|\s)/.test(typeOf)) {
					src = dp.src;
				} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
					dataMW = JSON.parse(node.getAttribute("data-mw"));
					src = !dataMW ? dp.src : state.serializer._buildExtensionWT(state, node, dataMW);
				} else {
					self.env.log("error", "Should not have come here!");
				}

				// FIXME: Just adding this here temporarily till we go in and
				// clean this up and strip this out if we can verify that data-mw
				// is going to be present always when necessary and indicate that
				// a missing data-mw is either a parser bug or a client error.
				//
				// Fallback: should be exercised only in exceptional situations.
				if (src === undefined && state.env.page.src && isValidDSR(dp.dsr)) {
					src = state.getOrigSrc(dp.dsr[0], dp.dsr[1]);
				}
				if (src !== undefined) {
					self.emitWikitext(src, state, cb, node);
					return DU.skipOverEncapsulatedContent(node);
				} else {
					var errors = ["No handler for: " + node.outerHTML];
					errors.push("Serializing as HTML.");
					self.env.log("error", errors.join("\n"));
					return self._htmlElementHandler(node, state, cb);
				}
			},
			sepnls: {
				// XXX: This is questionable, as the template can expand
				// to newlines too. Which default should we pick for new
				// content? We don't really want to make separator
				// newlines in HTML significant for the semantics of the
				// template content.
				before: function (node, otherNode) {
					if (DU.isNewElt(node)
							&& /(?:^|\s)mw:Extension\/references(?:\s|$)/
								.test(node.getAttribute('typeof'))
							// Only apply to plain references tags
							&& ! /(?:^|\s)mw:Transclusion(?:\s|$)/
								.test(node.getAttribute('typeof')))
					{
						// Serialize new references tags on a new line
						return {min:1, max:2};
					} else {
						return {min:0, max:2};
					}
				}
			}
		};
	}

	if ( dp.src !== undefined ) {
		//console.log(node.parentNode.outerHTML);
		if (/(^|\s)mw:Placeholder(\/\w*)?$/.test(typeOf) ||
				(typeOf === "mw:Nowiki" && node.textContent === dp.src )) {
			// implement generic src round-tripping:
			// return src, and drop the generated content
			return {
				handle: function() {
					// FIXME: Should this also check for tabs and plain space chars
					// interspersed with newlines?
					if (dp.src.match(/^\n+$/)) {
						state.sep.src = (state.sep.src || '') + dp.src;
					} else {
						self.emitWikitext(dp.src, state, cb, node);
					}
				}
			};
		} else if (typeOf === "mw:Entity") {
			var contentSrc = node.childNodes.length === 1 && node.textContent ||
								node.innerHTML;
			return  {
				handle: function () {
					if ( contentSrc === dp.srcContent ) {
						self.emitWikitext(dp.src, state, cb, node);
					} else {
						//console.log(contentSrc, dp.srcContent);
						self.emitWikitext(contentSrc, state, cb, node);
					}
				}
			};
		}
	}

	// If parent node is a list or table tag in html-syntax, then serialize
	// new elements in html-syntax rather than wiki-syntax.
	if (dp.stx === 'html' ||
		(DU.isNewElt(node) && node.parentNode &&
		DU.getDataParsoid( node.parentNode ).stx === 'html' &&
		((DU.isList(node.parentNode) && DU.isListItem(node)) ||
		 (node.parentNode.nodeName in {TABLE:1, TBODY:1, TH:1, TR:1} &&
		  node.nodeName in {TBODY:1, CAPTION:1, TH:1, TR:1, TD:1}))
		))
	{
		return {handle: self._htmlElementHandler.bind(self)};
	} else if (self.tagHandlers[nodeName]) {
		handler = self.tagHandlers[nodeName];
		if (!handler.handle) {
			return {handle: self._htmlElementHandler.bind(self), sepnls: handler.sepnls};
		} else {
			return handler || null;
		}
	} else {
		// XXX: check against element whitelist and drop those not on it?
		return {handle: self._htmlElementHandler.bind(self)};
	}
};

/**
 * Serialize the content of a text node
 */
WSP._serializeTextNode = function(node, state, cb) {
	// write out a potential separator?
	var res = node.nodeValue,
		doubleNewlineMatch = res.match(/\n([ \t]*\n)+/g),
		doubleNewlineCount = doubleNewlineMatch && doubleNewlineMatch.length || 0;

	// Deal with trailing separator-like text (at least 1 newline and other whitespace)
	var newSepMatch = res.match(/\n\s*$/);
	res = res.replace(/\n\s*$/, '');

	if (!state.inIndentPre) {
		// Don't strip two newlines for wikitext like this:
		// <div>foo
		//
		// bar</div>
		// The PHP parser won't create paragraphs on lines that also contain
		// block-level tags.
		if (node.parentNode.childNodes.length !== 1 ||
				!DU.isBlockNode(node.parentNode) ||
				//node.parentNode.data.parsoid.stx !== 'html' ||
				doubleNewlineCount !== 1)
		{
			// Strip more than one consecutive newline
			res = res.replace(/\n([ \t]*\n)+/g, '\n');
		}
		// Strip trailing newlines from text content
		//if (node.nextSibling && node.nextSibling.nodeType === node.ELEMENT_NODE) {
		//	res = res.replace(/\n$/, ' ');
		//} else {
		//	res = res.replace(/\n$/, '');
		//}

		// Strip leading newlines. They are already added to the separator source
		// in handleSeparatorText.
		res = res.replace(/^[ \t]*\n/, '');
	}

	// Always escape entities
	res = Util.escapeEntities(res);

	var escapes = this.getLinkPrefixTailEscapes(node, state.env);
	if (escapes.tail) {
		cb(escapes.tail, node);
	}

	// If not in nowiki and pre context, escape wikitext
	// XXX refactor: Handle this with escape handlers instead!
	state.escapeText = !state.inNoWiki && !state.inHTMLPre;
	cb(res, node);
	state.escapeText = false;

	if (escapes.prefix) {
		cb(escapes.prefix, node);
	}

	//console.log('text', JSON.stringify(res));

	// Move trailing newlines into the next separator
	if (newSepMatch && !state.sep.src) {
		state.sep.src = newSepMatch[0];
		state.sep.lastSourceSep = state.sep.src;
	}
};

/**
 * Emit non-separator wikitext that does not need to be escaped
 */
WSP.emitWikitext = function(text, state, cb, node) {
	// Strip leading newlines. They are already added to the separator source
	// in handleSeparatorText.
	var res = text.replace(/^\n/, '');
	// Deal with trailing newlines
	var newSepMatch = res.match(/\n\s*$/);
	res = res.replace(/\n\s*$/, '');
	cb(res, node);
	state.sep.lastSourceNode = node;
	// Move trailing newlines into the next separator
	if (newSepMatch && !state.sep.src) {
		state.sep.src = newSepMatch[0];
		state.sep.lastSourceSep = state.sep.src;
	}
};

WSP._getDOMAttribs = function( attribs ) {
	// convert to list of key-value pairs
	var out = [],
		ignoreAttribs = {
			'data-parsoid': 1,
			'data-ve-changed': 1,
			'data-parsoid-changed': 1,
			'data-parsoid-diff': 1,
			'data-parsoid-serialize': 1
		};
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		var attrib = attribs.item(i);
		if ( !ignoreAttribs[attrib.name] ) {
			out.push( { k: attrib.name, v: attrib.value } );
		}
	}
	return out;
};

/**
 * Starting on a text or comment node, collect ws text / comments between
 * elements.
 *
 * Assumptions:
 * - Called on first text / comment node
 *
 * Returns true if the node is a separator
 *
 * XXX: Support separator-transparent elements!
 */
WSP.handleSeparatorText = function ( node, state ) {
	if (!state.inIndentPre && DU.isText(node)) {
		if (node.nodeValue.match(/^\s*$/)) {
			state.sep.src = (state.sep.src || '') + node.nodeValue;
			//if (!state.sep.lastSourceNode) {
			//	// FIXME: Actually set lastSourceNode when the source is
			//	// emitted / emitSeparator is called!
			//	state.sep.lastSourceNode = node.previousSibling || node.parentNode;
			//}
			return true;
		} else {
			if (node.nodeValue.match(/^[ \t]*\n+/)) {
				state.sep.src = (state.sep.src || '') + node.nodeValue.match(/^[ \t]*\n+/)[0];
				//if (!state.sep.lastSourceNode) {
				//	// FIXME: Actually set lastSourceNode when the source is
				//	// emitted / emitSeparator is called!
				//	state.sep.lastSourceNode = node.previousSibling || node.parentNode;
				//}
			}
			return false;
		}
	} else if (node.nodeType === node.COMMENT_NODE) {
		state.sep.src = (state.sep.src || '') + commentWT(node.nodeValue);
		return true;
	} else {
		return false;
	}
};

/**
 * Clean up the constraints object to prevent excessively verbose output
 * and clog up log files / test runs
 */
WSP.loggableConstraints = function(constraints) {
	var c = {
		a: constraints.a,
		b: constraints.b,
		min: constraints.min,
		max: constraints.max
	};

	if (constraints.constraintInfo) {
		c.constraintInfo = {
			onSOL: constraints.constraintInfo.onSOL,
			sepType: constraints.constraintInfo.sepType,
			nodeA: constraints.constraintInfo.nodeA.nodeName,
			nodeB: constraints.constraintInfo.nodeB.nodeName
		};
	}

	return c;
};

/**
 * Helper for updateSeparatorConstraints
 *
 * Collects, checks and integrates separator newline requirements to a sinple
 * min, max structure.
 */
WSP.getSepNlConstraints = function(state, nodeA, sepNlsHandlerA, nodeB, sepNlsHandlerB) {
	var nlConstraints = { a:{}, b:{} };

	// Leave constraints unchanged when encountering a sol-transparent node from old wikitext
	if (DU.isElt(nodeA) && !DU.isNewElt(nodeA) && DU.emitsSolTransparentSingleLineWT(nodeA)) {
		return nlConstraints;
	}

	// Leave constraints unchanged when encountering a sol-transparent node from old wikitext
	if (DU.isElt(nodeB) && !DU.isNewElt(nodeB) && DU.emitsSolTransparentSingleLineWT(nodeB)) {
		return nlConstraints;
	}

	if (sepNlsHandlerA) {
		nlConstraints.a = sepNlsHandlerA(nodeA, nodeB, state);
		nlConstraints.min = nlConstraints.a.min;
		nlConstraints.max = nlConstraints.a.max;
	} else {
		// Anything more than two lines will trigger paragraphs, so default to
		// two if nothing is specified.
		nlConstraints.max = 2;
	}

	if (sepNlsHandlerB) {
		nlConstraints.b = sepNlsHandlerB(nodeB, nodeA, state);
		var cb = nlConstraints.b;

		// now figure out if this conflicts with the nlConstraints so far
		if (cb.min !== undefined) {
			if (nlConstraints.max !== undefined && nlConstraints.max < cb.min) {
				// Conflict, warn and let nodeB win.
				this.env.log("warning", "Incompatible constraints 1:", nodeA.nodeName,
						nodeB.nodeName, this.loggableConstraints(nlConstraints));
				nlConstraints.min = cb.min;
				nlConstraints.max = cb.min;
			} else {
				nlConstraints.min = Math.max(nlConstraints.min || 0, cb.min);
			}
		}

		if (cb.max !== undefined) {
			if (nlConstraints.min !== undefined && cb.max !== undefined &&
					nlConstraints.min > cb.max) {
				// Conflict, warn and let nodeB win.
				this.env.log("warning", "Incompatible constraints 2:", nodeA.nodeName,
						nodeB.nodeName, this.loggableConstraints(nlConstraints));
				nlConstraints.min = cb.max;
				nlConstraints.max = cb.max;
			} else if (nlConstraints.max !== undefined) {
				nlConstraints.max = Math.min(nlConstraints.max, cb.max);
			} else {
				nlConstraints.max = cb.max;
			}
		}
	}

	return nlConstraints;
};

/**
 * Create a separator given a (potentially empty) separator text and newline
 * constraints
 */
WSP.makeSeparator = function(sep, nlConstraints, state) {
	var origSep = sep;

	// TODO: Move to Util?
	var commentRe = '<!--(?:[^-]|-(?!->))*-->',
		// Split on comment/ws-only lines, consuming subsequent newlines since
		// those lines are ignored by the PHP parser
		// Ignore lines with ws and a single comment in them
		splitReString = '(?:\n(?:[ \t]*?' + commentRe + '[ \t]*?)+(?=\n))+|' + commentRe,
		splitRe = new RegExp(splitReString),
		sepMatch = sep.split(splitRe).join('').match(/\n/g),
		sepNlCount = sepMatch && sepMatch.length || 0,
		minNls = nlConstraints.min || 0;

	if (state.atStartOfOutput && ! nlConstraints.a.min && minNls > 0) {
		// Skip first newline as we are in start-of-line context
		minNls--;
	}

	if (minNls > 0 && sepNlCount < minNls) {
		// Append newlines
		var nlBuf = [];
		for (var i = 0; i < (minNls - sepNlCount); i++) {
			nlBuf.push('\n');
		}

		// In a parent-child separator scenario where the the first
		// child is not an element, that element could have contributed
		// to the separator. In that case, the newlines should be prepended
		// because they usually correspond to the parent's constraints,
		// and the separator was plucked from the child.
		//
		// FIXME: In reality, this is more complicated since the separator
		// might have been combined from the parent's previous sibling and
		// from parent's first child, and the newlines should be spliced
		// in between. But, we dont really track that scenario carefully
		// enough to implement that. So, this is just the next best scenario.
		//
		// The most common case seem to be situations like this:
		//
		// echo "a<p><!--c-->b</p>" | node parse --html2wt
		var constraintInfo = nlConstraints.constraintInfo || {},
			sepType = constraintInfo.sepType,
			nodeA = constraintInfo.nodeA;
		if (sepType === 'parent-child' && !DU.isElt(nodeA.firstChild)) {
			sep = nlBuf.join('') + sep;
		} else {
			sep = sep + nlBuf.join('');
		}
	} else if (nlConstraints.max !== undefined && sepNlCount > nlConstraints.max) {
		// Strip some newlines outside of comments
		// Capture separators in a single array with a capturing version of
		// the split regexp, so that we can work on the non-separator bits
		// when stripping newlines.
		var allBits = sep.split(new RegExp('(' + splitReString + ')')),
			newBits = [],
			n = sepNlCount;

		while (n > nlConstraints.max) {
			var bit = allBits.pop();
			while (bit && bit.match(splitRe)) {
				// skip comments
				newBits.push(bit);
				bit = allBits.pop();
			}
			while(n > nlConstraints.max && bit.match(/\n/)) {
				bit = bit.replace(/\n([^\n]*)/, '$1');
				n--;
			}
			newBits.push(bit);
		}
		newBits.reverse();
		newBits = allBits.concat(newBits);
		sep = newBits.join('');
	}

	if (this.debugging) {
		var constraints = Util.clone(nlConstraints);
		constraints.constraintInfo = undefined;
		this.trace('makeSeparator', sep, origSep, minNls, sepNlCount, constraints);
	}

	return sep;
};

/**
 * Merge two constraints, with the newer constraint winning in case of
 * conflicts.
 *
 * XXX: Use nesting information for conflict resolution / switch to scoped
 * constraints?
 */
WSP.mergeConstraints = function (oldConstraints, newConstraints) {
	//console.log(oldConstraints);
	var res = {a: oldConstraints.a, b:newConstraints.b};
	res.min = Math.max(oldConstraints.min || 0, newConstraints.min || 0);
	res.max = Math.min(oldConstraints.max !== undefined ? oldConstraints.max : 2,
			newConstraints.max !== undefined ? newConstraints.max : 2);
	if (res.min > res.max) {
		// let newConstraints win, but complain
		if (newConstraints.max !== undefined && newConstraints.max > res.min) {
			res.max = newConstraints.max;
		} else if (newConstraints.min && newConstraints.min < res.min) {
			res.min = newConstraints.min;
		}

		res.max = res.min;
		this.env.log("warning", 'Incompatible constraints (merge):', res, this.loggableConstraints(oldConstraints), this.loggableConstraints(newConstraints));
	}
	return res;
};

/**
 * Figure out separator constraints and merge them with existing constraints
 * in state so that they can be emitted when the next content emits source.
 *
 * node handlers:
 *
 * body: {
 *	handle: function(node, state, cb) {},
 *		// responsible for calling
 *	sepnls: {
 *		before: function(node) -> {min: 1, max: 2}
 *		after: function(node)
 *		firstChild: function(node)
 *		lastChild: function(node)
 *	}
 * }
 */
WSP.updateSeparatorConstraints = function( state, nodeA, handlerA, nodeB, handlerB) {
	var nlConstraints,
		sepHandlerA = handlerA && handlerA.sepnls || {},
		sepHandlerB = handlerB && handlerB.sepnls || {},
		sepType = null;
	if ( nodeA.nextSibling === nodeB ) {
		// sibling separator
		sepType = "sibling";
		nlConstraints = this.getSepNlConstraints(state, nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.before);
	} else if ( nodeB.parentNode === nodeA ) {
		sepType = "parent-child";
		// parent-child separator, nodeA parent of nodeB
		nlConstraints = this.getSepNlConstraints(state, nodeA, sepHandlerA.firstChild,
											nodeB, sepHandlerB.before);
	} else if ( nodeA.parentNode === nodeB ) {
		sepType = "child-parent";
		// parent-child separator, nodeB parent of nodeA
		nlConstraints = this.getSepNlConstraints(state, nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.lastChild);
	} else {
		// sibling separator
		sepType = "sibling";
		nlConstraints = this.getSepNlConstraints(state, nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.before);
	}

	if (nodeA.nodeName === undefined) {
		console.trace();
	}

	if (this.debugging) {
		this.trace('hSep', nodeA.nodeName, nodeB.nodeName,
				sepType,
				nlConstraints,
				(nodeA.outerHTML || nodeA.nodeValue || '').substr(0,40),
				(nodeB.outerHTML || nodeB.nodeValue || '').substr(0,40)
				);
	}

	if(state.sep.constraints) {
		// Merge the constraints
		state.sep.constraints = this.mergeConstraints(state.sep.constraints, nlConstraints);
		//if (state.sep.lastSourceNode && state.sep.lastSourceNode.nodeType === nodeA.TEXT_NODE) {
		//	state.sep.lastSourceNode = nodeA;
		//}
	} else {
		state.sep.constraints = nlConstraints;
		//state.sep.lastSourceNode = state.sep.lastSourceNode || nodeA;
	}

	state.sep.constraints.constraintInfo = {
		onSOL: state.onSOL,
		sepType: sepType,
		nodeA: nodeA,
		nodeB: nodeB
	};

	//console.log('nlConstraints', state.sep.constraints);
};

WSP.makeSepIndentPreSafe = function(sep, nlConstraints, state) {
	var constraintInfo = nlConstraints.constraintInfo || {},
		sepType = constraintInfo.sepType,
		nodeA = constraintInfo.nodeA,
		nodeB = constraintInfo.nodeB;

	// Ex: "<div>foo</div>\n <span>bar</span>"
	//
	// We also should test for onSOL state to deal with HTML like
	// <ul> <li>foo</li></ul>
	// and strip the leading space before non-indent-pre-safe tags
	if (!state.inIndentPre &&
		(sep.match(/\n+ +(<!--(?:[^\-]|-(?!->))*-->[^\n]*)?$/g) || (
		(constraintInfo.onSOL && sep.match(/ +(<!--(?:[^\-]|-(?!->))*-->[^\n]*)?$/g)))))
	{
		// 'sep' is the separator before 'nodeB' and it has leading spaces on a newline.
		// We have to decide whether that leading space will trigger indent-pres in wikitext.
		// The decision depends on where this separator will be emitted relative
		// to 'nodeA' and 'nodeB'.

		var isIndentPreSafe = false;

		// Example sepType scenarios:
		//
		// 1. sibling
		//    <div>foo</div>
		//     <span>bar</span>
		//    The span will be wrapped in an indent-pre if the leading space
		//    is not stripped since span is not a block tag
		//
		// 2. child-parent
		//    <span>foo
		//     </span>bar
		//    The " </span>bar" will be wrapped in an indent-pre if the
		//    leading space is not stripped since span is not a block tag
		//
		// 3. parent-child
		//    <div>foo
		//     <span>bar</span>
		//    </div>
		//
		// In all cases, only block-tags prevent indent-pres.
		// (except for a special case for <br> nodes)
		if (sepType && DU.precedingSpaceSuppressesIndentPre(nodeB)) {
			isIndentPreSafe = true;
		} else if (sepType === 'sibling' || nodeA && nodeA.nodeName === 'BODY') {
			console.assert(nodeA.nodeName !== 'BODY' || sepType === 'parent-child');

			// 'nodeB' is the first non-separator child of 'nodeA'.
			//
			// Walk past sol-transparent nodes in the right-sibling chain
			// of 'nodeB' till we establish indent-pre safety.
			while (nodeB && DU.emitsSolTransparentSingleLineWT(nodeB)) {
				nodeB = nodeB.nextSibling;
			}

			isIndentPreSafe = !nodeB ||
				DU.precedingSpaceSuppressesIndentPre(nodeB) ||
				// If the text node itself has a leading space that
				// could trigger indent-pre, no need to worry about
				// leading space in the separator.
				(DU.isText(nodeB) && nodeB.nodeValue.match(/^[ \t]/));
		} else if (sepType === 'parent-child') {
			// 'nodeB' is the first non-separator child of 'nodeA'.
			//
			// Walk up past zero-wikitext width nodes in the ancestor chain
			// of 'nodeA' till we establish indent-pre safety.
			while (Consts.ZeroWidthWikitextTags.has(nodeA.nodeName)) {
				nodeA = nodeA.parentNode;
			}

			// Deal with weak/strong indent-pre suppressing tags
			if (Consts.WeakIndentPreSuppressingTags.has(nodeA.nodeName)) {
				isIndentPreSafe = true;
			} else {
				// Strong indent-pre suppressing tags suppress indent-pres
				// in entire DOM subtree rooted at that node
				while (nodeA.nodeName !== 'BODY') {
					if (Consts.StrongIndentPreSuppressingTags.has(nodeA.nodeName)) {
						isIndentPreSafe = true;
					}
					nodeA = nodeA.parentNode;
				}
			}
		}

		if (!isIndentPreSafe) {
			// Strip non-nl ws from last line, but preserve comments.
			// This avoids triggering indent-pres.
			sep = sep.replace(/ +(<!--(?:[^\-]|-(?!->))*-->[^\n]*)?$/g, '$1');
		}
	}

	if (this.debugging) {
		var constraints = Util.clone(nlConstraints);
		constraints.constraintInfo = undefined;
		this.trace('makePreSafe  ', sep, constraints);
	}

	return sep;
};

/**
 * Emit a separator based on the collected (and merged) constraints
 * and existing separator text. Called when new output is triggered.
 */
WSP.emitSeparator = function(state, cb, node) {

	var sep,
		origNode = node,
		src = state.env.page.src,
		prevNode = state.sep.lastSourceNode,
		dsrA, dsrB;

	// We can use original source only if:
	// * We have access to original wikitext
	// * If we are in rt-testing mode (NO edits in that scenario)
	// * If we are in selser mode AND this node is not part of a subtree
	//   that has been marked 'modified' (massively edited, either in actuality
	//   or because DOMDiff is not smart enough).
	//
	// In other scenarios, DSR values on "adjacent" nodes in the edited DOM
	// may not reflect deleted content between them.
	var origSepUsable = src && (state.rtTesting || state.selserMode) && !state.inModifiedContent;
	if (origSepUsable && node && prevNode && node !== prevNode) {
		if (!DU.isElt(prevNode)) {
			// Check if this is the last child of a zero-width element, and use
			// that for dsr purposes instead. Typical case: text in p.
			if (!prevNode.nextSibling &&
				prevNode.parentNode &&
				prevNode.parentNode !== node &&
				DU.getDataParsoid( prevNode.parentNode ).dsr &&
				DU.getDataParsoid( prevNode.parentNode ).dsr[3] === 0)
			{
				dsrA = DU.getDataParsoid( prevNode.parentNode ).dsr;
			} else if (prevNode.previousSibling &&
					prevNode.previousSibling.nodeType === prevNode.ELEMENT_NODE &&
					// FIXME: Not sure why we need this check because data-parsoid
					// is loaded on all nodes. mw:Diffmarker maybe? But, if so, why?
					// Should be fixed.
					DU.getDataParsoid( prevNode.previousSibling ).dsr &&
					// Don't extrapolate if the string was potentially changed
					// or we didn't diff (selser disabled)
					(state.rtTesting || // no changes in rt testing
					 // diffed and no change here
					 (state.selserMode && !DU.directChildrenChanged(node.parentNode, this.env)))
				 )
			{
				var endDsr = DU.getDataParsoid( prevNode.previousSibling ).dsr[1],
					correction;
				if (typeof(endDsr) === 'number') {
					if (prevNode.nodeType === prevNode.COMMENT_NODE) {
						correction = prevNode.nodeValue.length + 7;
					} else {
						correction = prevNode.nodeValue.length;
					}
					dsrA = [endDsr, endDsr + correction + DU.indentPreDSRCorrection(prevNode), 0, 0];
				}
			} else {
				/* jshint noempty: false */
				//console.log( prevNode.nodeValue, prevNode.parentNode.outerHTML);
			}
		} else {
			dsrA = DU.getDataParsoid( prevNode ).dsr;
		}

		if (!dsrA) {
			/* jshint noempty: false */
			// nothing to do -- no reason to compute dsrB if dsrA is null
		} else if (!DU.isElt(node)) {
			// If this is the child of a zero-width element
			// and is only preceded by separator elements, we
			// can use the parent for dsr after correcting the dsr
			// with the separator run length.
			//
			// 1. text in p.
			// 2. ws-only child of a node with auto-inserted start tag
			//    Ex: "<span> <s>x</span> </s>" --> <span> <s>x</s*></span><s*> </s>
			// 3. ws-only children of a node with auto-inserted start tag
			//    Ex: "{|\n|-\n <!--foo--> \n|}"

			var npDP = DU.getDataParsoid( node.parentNode );
			if ( node.parentNode !== prevNode && npDP.dsr && npDP.dsr[2] === 0 ) {
				var sepTxt = precedingSeparatorTxt(node);
				if (sepTxt !== null) {
					dsrB = npDP.dsr;
					if (typeof(dsrB[0]) === 'number' && sepTxt.length > 0) {
						dsrB = Util.clone(dsrB);
						dsrB[0] += sepTxt.length;
					}
				}
			}
		} else {
			if (prevNode.parentNode === node) {
				// FIXME: Maybe we shouldn't set dsr in the dsr pass if both aren't valid?
				//
				// When we are in the lastChild sep scenario and the parent doesn't have
				// useable dsr, if possible, walk up the ancestor nodes till we find
				// a dsr-bearing node
				//
				// This fix is needed to handle trailing newlines in this wikitext:
				// [[File:foo.jpg|thumb|300px|foo\n{{echo|A}}\n{{echo|B}}\n{{echo|C}}\n\n]]
				while (!node.nextSibling && node.nodeName !== 'BODY' &&
					(!DU.getDataParsoid( node ).dsr ||
					DU.getDataParsoid( node ).dsr[0] === null ||
					DU.getDataParsoid( node ).dsr[1] === null))
				{
					node = node.parentNode;
				}
			}

			dsrB = DU.getDataParsoid( node ).dsr;
		}

		// FIXME: Maybe we shouldn't set dsr in the dsr pass if both aren't valid?
		if (isValidDSR(dsrA) && isValidDSR(dsrB)) {
			//console.log(prevNode.data.parsoid.dsr, node.data.parsoid.dsr);
			// Figure out containment relationship
			if (dsrA[0] <= dsrB[0]) {
				if (dsrB[1] <= dsrA[1]) {
					if (dsrA[0] === dsrB[0] && dsrA[1] === dsrB[1]) {
						// Both have the same dsr range, so there can't be any
						// separators between them
						sep = '';
					} else if (dsrA[2] !== null) {
						// B in A, from parent to child
						sep = src.substring(dsrA[0] + dsrA[2], dsrB[0]);
					}
				} else if (dsrA[1] <= dsrB[0]) {
					// B following A (siblingish)
					sep = src.substring(dsrA[1], dsrB[0]);
				} else if (dsrB[3] !== null) {
					// A in B, from child to parent
					sep = src.substring(dsrA[1], dsrB[1] - dsrB[3]);
				}
			} else if (dsrA[1] <= dsrB[1]) {
				if (dsrB[3] !== null) {
					// A in B, from child to parent
					sep = src.substring(dsrA[1], dsrB[1] - dsrB[3]);
				}
			} else {
				this.env.log("warning","dsr backwards: should not happen!");
			}

			if (state.sep.lastSourceSep) {
				//console.log('lastSourceSep', state.sep.lastSourceSep);
				sep = state.sep.lastSourceSep + sep;
			}
		}
	}

	if (this.debugging) {
		this.trace('emitSeparator',
			'node: ', (origNode ? origNode.nodeName : '--none--'),
			'prev: ', (prevNode ? prevNode.nodeName : '--none--'),
			'sep: ', sep, 'state.sep.src: ', state.sep.src);
	}

	// 1. Verify that the separator is really one (has to be whitespace and comments)
	// 2. If the separator is being emitted before a node that emits sol-transparent WT,
	//    go through makeSeparator to verify indent-pre constraints are met.
	var sepConstraints = state.sep.constraints || {a:{},b:{}, max:0};
	if (sep === undefined ||
		!isValidSep(sep) ||
		(state.sep.src && state.sep.src !== sep))
	{
		if (state.sep.constraints || state.sep.src) {
			// TODO: set modified flag if start or end node (but not both) are
			// modified / new so that the selser can use the separator
			sep = this.makeSeparator(state.sep.src || '', sepConstraints, state);
		} else {
			sep = undefined;
		}
	}

	if (sep !== undefined) {
		sep = this.makeSepIndentPreSafe(sep, sepConstraints, state);
		state.emitSep(sep, origNode, cb, 'SEP:');
	}
};

WSP._getPrevSeparatorElement = function (node) {
	return DU.previousNonSepSibling(node) || node.parentNode;
};

WSP._getNextSeparatorElement = function (node) {
	return DU.nextNonSepSibling(node) || node.parentNode;
};

/**
 * Internal worker. Recursively serialize a DOM subtree.
 */
WSP._serializeNode = function( node, state, cb) {
	cb = cb || state.chunkCB;
	var prev, next, nextNode;

	// serialize this node
	switch( node.nodeType ) {
		case node.ELEMENT_NODE:
			// Ignore DiffMarker metas, but clear unmodified node state
			if (DU.isMarkerMeta(node, "mw:DiffMarker")) {
				state.prevNodeUnmodified = state.currNodeUnmodified;
				state.currNodeUnmodified = false;
				state.sep.lastSourceNode = node;
				return node;
			}

			if (state.selserMode) {
				this.trace("NODE: ", node.nodeName,
					"; prev-flag: ", state.prevNodeUnmodified,
					"; curr-flag: ", state.currNodeUnmodified);
			}

			var dp = DU.getDataParsoid( node );
			dp.dsr = dp.dsr || [];

			// Update separator constraints
			var domHandler = this._getDOMHandler(node, state, cb);
			prev = this._getPrevSeparatorElement(node);
			if (prev) {
				this.updateSeparatorConstraints(state,
						prev,  this._getDOMHandler(prev, state, cb),
						node,  domHandler);
			}

			var handled = false, wrapperUnmodified = false;

			// WTS should not be in a subtree with a modification flag that applies
			// to every node of a subtree (rather than an indication that some node
			// in the subtree is modified).
			if (state.selserMode && !state.inModifiedContent &&
				dp && isValidDSR(dp.dsr) && (dp.dsr[1] > dp.dsr[0] || dp.fostered || dp.misnested)) {
				// To serialize from source, we need 3 things of the node:
				// -- it should not have a diff marker
				// -- it should have valid, usable DSR
				// -- it should have a non-zero length DSR
				//    (this is used to prevent selser on synthetic content,
				//     like the category link for '#REDIRECT [[Category:Foo]]')
				//
				// SSS FIXME: Additionally, we can guard against buggy DSR with
				// some sanity checks. We can test that non-sep src content
				// leading wikitext markup corresponds to the node type.
				//
				//  Ex: If node.nodeName is 'UL', then src[0] should be '*'
				//
				//  TO BE DONE
				//
				if (!DU.hasCurrentDiffMark(node, this.env)) {
					state.currNodeUnmodified = true;
					handled = true;

					// If this HTML node will disappear in wikitext because of zero width,
					// then the separator constraints will carry over to the node's children.
					//
					// Since we dont recurse into 'node' in selser mode, we update the
					// separator constraintInfo to apply to 'node' and its first child.
					//
					// We could clear constraintInfo altogether which would be correct (but
					// could normalize separators and introduce dirty diffs unnecessarily).
					if (Consts.ZeroWidthWikitextTags.has(node.nodeName) &&
						node.childNodes.length > 0 &&
						state.sep.constraints.constraintInfo.sepType === 'sibling')
					{
						state.sep.constraints.constraintInfo.onSOL = state.onSOL;
						state.sep.constraints.constraintInfo.sepType = 'parent-child';
						state.sep.constraints.constraintInfo.nodeA = node;
						state.sep.constraints.constraintInfo.nodeB = node.firstChild;
					}

					var out = state.getOrigSrc(dp.dsr[0], dp.dsr[1]);

					// console.warn("USED ORIG");
					this.trace("ORIG-src with DSR[", dp.dsr[0], dp.dsr[1], "]", out);
					cb(out, node);

					// Skip over encapsulated content since it has already been serialized
					var typeOf = node.getAttribute( 'typeof' ) || '';
					if (/(?:^|\s)mw:(?:Transclusion(?=$|\s)|Param(?=$|\s)|Extension\/[^\s]+)/.test(typeOf)) {
						nextNode = DU.skipOverEncapsulatedContent(node);
					}
				} else if (DU.onlySubtreeChanged(node, this.env) &&
					hasValidTagWidths(dp.dsr) &&
					// In general, we want to avoid nodes with auto-inserted start/end tags
					// since dsr for them might not be entirely trustworthy. But, since wikitext
					// does not have closing tags for tr/td/th in the first place, dsr for them
					// can be trusted.
					//
					// SSS FIXME: I think this is only for b/i tags for which we do dsr fixups.
					// It maybe okay to use this for other tags.
					((!dp.autoInsertedStart && !dp.autoInsertedEnd) || (node.nodeName in {TR:1,TH:1,TD:1})))
				{
					wrapperUnmodified = true;
				}
			}

			if ( !handled ) {
				state.prevNodeUnmodified = state.currNodeUnmodified;
				state.currNodeUnmodified = false;
				// console.warn("USED NEW");
				if ( domHandler && domHandler.handle ) {
					// DOM-based serialization
					try {
						if (state.selserMode && DU.hasInsertedOrModifiedDiffMark(node, this.env)) {
							state.inModifiedContent = true;
							nextNode = domHandler.handle(node, state, cb, wrapperUnmodified);
							state.inModifiedContent = false;
						} else {
							nextNode = domHandler.handle(node, state, cb, wrapperUnmodified);
						}
					} catch(e) {
						this.env.log("error", e);
						this.env.log("error", node.nodeName, domHandler);
					}
					// The handler is responsible for serializing its children
				} else {
					// Used to be token-based serialization
					this.env.log("error", 'No dom handler found for', node.outerHTML);
				}
			}

			// Update end separator constraints
			next = this._getNextSeparatorElement(node);
			if (next) {
				this.updateSeparatorConstraints(state,
						node, domHandler,
						next, this._getDOMHandler(next, state, cb));
			}

			break;
		case node.TEXT_NODE:
			state.prevNodeUnmodified = state.currNodeUnmodified;
			state.currNodeUnmodified = false;

			this.trace("TEXT: ", node.nodeValue);

			if (!this.handleSeparatorText(node, state)) {
				// Text is not just whitespace
				prev = this._getPrevSeparatorElement(node);
				if (prev) {
					this.updateSeparatorConstraints(state,
							prev, this._getDOMHandler(prev, state, cb),
							node, {});
				}
				// regular serialization
				this._serializeTextNode(node, state, cb );
				next = this._getNextSeparatorElement(node);
				if (next) {
					//console.log(next.outerHTML);
					this.updateSeparatorConstraints(state,
							node, {},
							next, this._getDOMHandler(next, state, cb));
				}
			}
			break;
		case node.COMMENT_NODE:
			state.prevNodeUnmodified = state.currNodeUnmodified;
			state.currNodeUnmodified = false;

			this.trace("COMMENT: ", "<!--" + node.nodeValue + "-->");

			// delay the newline creation until after the comment
			if (!this.handleSeparatorText(node, state)) {
				cb(commentWT(node.nodeValue), node);
			}
			break;
		default:
			this.env.log("error", "Unhandled node type:", node.outerHTML);
			break;
	}

	// If handlers didn't provide a valid next node,
	// default to next sibling
	if (nextNode === undefined) {
		nextNode = node.nextSibling;
	}

	return nextNode;
};

/**
 * Serialize an HTML DOM document.
 */
WSP.serializeDOM = function( body, chunkCB, finalCB, selserMode ) {
	if (this.debugging) {
		if (selserMode) {
			console.warn("-----------------selser-mode-----------------");
		} else {
			console.warn("-----------------WTS-mode-----------------");
		}
	}
	var state = Util.extendProps({},
		// Make sure these two are cloned, so we don't alter the initial
		// state for later serializer runs.
		Util.clone(this.options),
		Util.clone(this.initialState));

	// Record the serializer
	state.serializer = this;

	try {
		state.selserMode = selserMode || false;

		// Normalize the DOM (coalesces adjacent text body)
		// FIXME: Disabled as this strips empty comments (<!---->).
		//body.normalize();

		// Minimize I/B tags
		minimizeWTQuoteTags(body);

		// Don't serialize the DOM if debugging is disabled
		if (this.debugging) {
			this.trace(" DOM ==> \n", body.outerHTML);
		}

		var chunkCBWrapper = function (cb, chunk, node) {
			state.emitSepAndOutput(chunk, node, cb);

			if (state.serializer.debugging) {
				console.log("OUT:", JSON.stringify(chunk), node && node.nodeName || 'noNode');
			}

			state.atStartOfOutput = false;
		};

		var out = '';
	    if ( ! chunkCB ) {
			state.chunkCB = function(chunk, node) {
				var cb = function ( chunk ) {
					out += chunk;
				};
				chunkCBWrapper(cb, chunk, node);
			};
		} else {
			state.chunkCB = function(chunk, node) {
				chunkCBWrapper(chunkCB, chunk, node);
			};
		}

		state.sep.lastSourceNode = body;
		state.currLine.firstNode = body.firstChild;
		if (body.nodeName !== 'BODY') {
			// FIXME: Do we need this fallback at all?
			this._serializeNode( body, state );
		} else {
			state.serializeChildren(body, state.chunkCB);
		}

		// Handle EOF
		//this.emitSeparator(state, state.chunkCB, body);
		state.chunkCB( '', body );

		if ( finalCB && typeof finalCB === 'function' ) {
			finalCB();
		}

		return chunkCB ? '' : out;
	} catch (e) {
		state.env.log("fatal", e);
		throw e;
	}
};

if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
