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
	WikitextConstants = wtConsts.WikitextConstants,
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	pd = require('./mediawiki.parser.defines.js'),
	SanitizerConstants = require('./ext.core.Sanitizer.js').SanitizerConstants,
	tagWhiteListHash;

function isValidSep(sep) {
	return sep.match(/^(\s|<!--([^\-]|-(?!->))*-->)*$/);
}

function isValidDSR(dsr) {
	return dsr &&
		typeof(dsr[0]) === 'number' && dsr[0] >= 0 &&
		typeof(dsr[1]) === 'number' && dsr[1] >= 0;
}

/**
 * Emit the start tag source when not round-trip testing, or when the node is
 * not marked with autoInsertedStart
 */
var emitStartTag = function (src, node, state, cb) {
	if (!state.rtTesting) {
		cb(src, node);
	} else if (!node.data.parsoid.autoInsertedStart) {
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
	} else if (!node.data.parsoid.autoInsertedEnd) {
		cb(src, node);
	}
	// else: drop content
};

function commentWT(comment) {
	return '<!--' + comment.replace(/-->/, '--&gt;') + '-->';
}

// SSS FIXME: Can be set up as part of an init routine
function getTagWhiteList() {
	if (!tagWhiteListHash) {
		tagWhiteListHash = Util.arrayToHash(WikitextConstants.Sanitizer.TagWhiteList);
	}
	return tagWhiteListHash;
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

function isListElementName(name) {
	return name in {li:1, dt:1, dd:1};
}

function precedingSeparatorTxt(n, rtTestMode) {
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

	var buf = [], orig = n;
	while (n) {
		if (DU.isIEW(n)) {
			buf.push(n.nodeValue);
		} else if (n.nodeType === n.COMMENT_NODE) {
			buf.push("<!--");
			buf.push(n.nodeValue);
			buf.push("-->");
		} else if (n !== orig) { // dont return if input node!
			return null;
		}

		n = n.previousSibling;
	}

	return buf.join('');
}

var WikitextEscapeHandlers = function() { };

var WEHP = WikitextEscapeHandlers.prototype;

WEHP.urlParser = new PegTokenizer();

WEHP.headingHandler = function(headingNode, state, text, opts) {
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
	// Only bullets at the beginning of the list trigger escaping
	if (liNode.nodeName === 'DT' && /:/.test(text)) {
		return true;
	} else if (state.currLine.text === '' && opts.node === liNode.firstChild) {
		return text.match(/^[#\*:;]/);
	} else {
		return false;
	}
};

WEHP.quoteHandler = function(state, text) {
	// SSS FIXME: Can be refined
	return text.match(/^'|'$/);
};

WEHP.thHandler = function(state, text) {
	return text.match(/!!|\|\|/);
};

WEHP.wikilinkHandler = function(state, text) {
	return text.match(/(^\|)|(^\[\[)|(^\]\])|(\]$)/);
};

WEHP.aHandler = function(state, text) {
	return text.match(/\]$/);
};

WEHP.tdHandler = function(state, text) {
	return text.match(/\|/) ||
		(state.currLine.text === '' && text.match(/^[\-+]/) && !state.inWideTD);
};

WEHP.hasWikitextTokens = function ( state, onNewline, text, linksOnly ) {
	// console.warn("---EWT:DBG0---");
	// console.warn("---HWT---:onl:" + onNewline + ":" + text);
	// tokenize the text

	var sol = onNewline && !(state.inIndentPre || state.inPPHPBlock);
	var tokens = state.serializer.tokenizeStr(state, text, sol);

	// If the token stream has a pd.TagTk, pd.SelfclosingTagTk, pd.EndTagTk or pd.CommentTk
	// then this text needs escaping!
	var tagWhiteList = getTagWhiteList();
	var numEntities = 0;
	for (var i = 0, n = tokens.length; i < n; i++) {
		var t = tokens[i];

		// Ignore non-whitelisted html tags
		if (t.isHTMLTag()) {
			if (/\bmw:Extension\//.test(t.getAttribute("typeof"))) {
				return true;
			}
			if (!tagWhiteList[t.name.toLowerCase()]) {
				continue;
			}
		}

		var tc = t.constructor;
		if (tc === pd.SelfclosingTagTk) {
			// Ignore extlink tokens without valid urls
			if (t.name === 'extlink' && !this.urlParser.tokenizeURL(t.getAttribute("href"))) {
				continue;
			}

			// Ignore url links
			if (t.name === 'urllink') {
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

			// </br>!
			if (SanitizerConstants.noEndTagHash[t.name.toLowerCase()]) {
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
	this.wteHandlers = new WikitextEscapeHandlers();
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
 * tplAttrs
 *    Tag attributes that came from templates in source wikitext -- these
 *    are collected upfront from the DOM from mw-marked nodes.
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
	tplAttrs: {},
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

		// Force out accumulated separator
		if (oldSep === this.sep) {
			if (children.length === 0) {
				chunkCB('', node);
			} else {
				chunkCB('', children.last());
			}
		}

		this.chunkCB = oldCB;

		if (wtEscaper) {
			this.wteHandlerStack.pop();
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
		if (this.debugging) {
			console.log(debugPrefix, JSON.stringify(sep));
		}
	},

	emitSepAndOutput: function(res, node, cb) {
		// Emit separator first
		if (this.prevNodeUnmodified && this.currNodeUnmodified) {
			var origSep = this.getOrigSrc(this.prevNode.data.parsoid.dsr[1], node.data.parsoid.dsr[0]);
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
			res = this.serializer.escapeWikiText(this, res, { node: node, isLastChild: !node.nextSibling } );
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
		var bits = [],
			oldSep = this.sep,
			// appendToBits just ignores anything returned but
			// the source, but that is fine. Selser etc is handled in
			// the top level callback at a slightly coarser level.
			appendToBits = function(out) { bits.push(out); },
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
		return bits.join('');
	}
};

// Make sure the initialState is never modified
Util.deepFreeze( WSP.initialState );

function escapedText(text) {
	var match = text.match(/^((?:.*?|[\r\n]+[^\r\n]|[~]{3,5})*?)((?:\r?\n)*)$/);
	return ["<nowiki>", match[1], "</nowiki>", match[2]].join('');
}

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
	// console.warn("---EWT:ALL1---");
    // console.warn("t: " + text);
	/* -----------------------------------------------------------------
	 * General strategy: If a substring requires escaping, we can escape
	 * the entire string without further analysis of the rest of the string.
	 * ----------------------------------------------------------------- */

	// SSS FIXME: Move this somewhere else
	var urlTriggers = /\b(RFC|ISBN|PMID)\b/;
	var fullCheckNeeded = text.match(urlTriggers);

	// Quick check for the common case (useful to kill a majority of requests)
	//
	// Pure white-space or text without wt-special chars need not be analyzed
	if (!fullCheckNeeded && !text.match(/^[ \t][^\s]+|[<>\[\]\-\+\|'!=#\*:;~{}]/)) {
		// console.warn("---EWT:F1---");
		return text;
	}

	// Context-specific escape handler
	var wteHandler = state.wteHandlerStack.last();
	if (wteHandler && wteHandler(state, text, opts)) {
		// console.warn("---EWT:F2---");
		return escapedText(text);
	}

	// Template and template-arg markers are escaped unconditionally!
	// Conditional escaping requires matching brace pairs and knowledge
	// of whether we are in template arg context or not.
	if (text.match(/\{\{\{|\{\{|\}\}\}|\}\}/)) {
		// console.warn("---EWT:F3---");
		return escapedText(text);
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
		if (!sol && !text.match(/''|[<>]|\[.*\]|\]|(=(\n|$))/)) {
			// It is not necessary to test for an unmatched opening bracket ([)
			// as long as we always escape an unmatched closing bracket (]).
			// console.warn("---EWT:F4---");
			return text;
		}

		// Quick checks when on a newline
		// + can only occur as "|+" and - can only occur as "|-" or ----
		if (sol && !text.match(/^[ \t#*:;=]|[<\[\]>\|'!]|\-\-\-\-/)) {
			// console.warn("---EWT:F5---");
			return text;
		}
	}

	// SSS FIXME: pre-escaping is currently broken since the front-end parser
	// eliminated pre-tokens in the tokenizer and moved to a stream handler.
	// So, we always conservatively escape text with ' ' in sol posn.
	if (sol && text.match(/(^ |\n )[^\s]+/)) {
		// console.warn("---EWT:F6---");
		return escapedText(text);
	}

	// escape nowiki tags
	text = text.replace(/<(\/?nowiki)>/g, '&lt;$1&gt;');

	// Use the tokenizer to see if we have any wikitext tokens
	//
	// Ignores headings & entities -- headings have additional
	// EOL matching requirements which are not captured by the
	// hasWikitextTokens check
	if (this.wteHandlers.hasWikitextTokens(state, sol, text) || hasTildes) {
		// console.warn("---EWT:DBG1---");
		return escapedText(text);
	} else if (state.onSOL) {
		if (text.match(/^=+[^=]+=+$/)) {
			// console.warn("---EWT:DBG2---");
			return escapedText(text);
		} else {
			// console.warn("---EWT:DBG3---");
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
				this.wteHandlers.hasWikitextTokens(state, sol, cl.text + text, true))
		{
			// console.warn("---EWT:DBG4---");
			return escapedText(text);
		} else {
			// console.warn("---EWT:DBG5---");
			return text;
		}
	}
};

/**
 * General strategy:
 *
 * Tokenize the arg wikitext.  Anything that parses as tags
 * are good and we need not bother with those.  Check for harmful
 * characters "[]{}|=" in any strings and escape those fragments
 * since these characters could change semantics of the entire
 * template transclusion.
 *
 * This function makes a couple of assumptions:
 *
 * 1. Each arg's wikitext has balanced opening and closing tags.
 *    The code does make some attempt to deal with unclosed opening
 *    and closing tags, but this may not work accurately in all cases.
 *
 * 2. The tokenizer sets tsr on all non-string tokens.
 */
WSP.escapeTplArgWT = function(state, arg) {
	function escapeStr(str, buf) {
		if (str.match(/[\{\[\]\}\|\=]/)) {
			buf.push("<nowiki>");
			buf.push(str);
			buf.push("</nowiki>");
		} else {
			buf.push(str);
		}
	}

	var tokens = this.tokenizeStr(state, arg, false);
	var offset = 0, openTags = [], buf = [];
	for (var i = 0, n = tokens.length; i < n; i++) {
		var t = tokens[i], da = t.dataAttribs;
		switch (t.constructor) {
			case pd.TagTk:
				if (openTags.length === 0) {
					offset = da.tsr[0];
				}
				openTags.push(t);
				break;

			case pd.EndTagTk:
				if (openTags.length > 0) {
					openTags.pop();
				}
				if (openTags.length === 0) {
					var e = da.tsr[1];
					buf.push(arg.substring(offset, e));
					offset = e;
				}
				break;

			case pd.NlTk:
			case pd.Comment:
			case pd.SelfclosingTagTk:
				var tkSrc = arg.substring(da.tsr[0], da.tsr[1]);
				// Replace pipe by an entity
				if (t.name === 'extlink' || t.name === 'urllink') {
					tkSrc = tkSrc.replace(/\|/g, '&#124;');
				}
				if (openTags.length === 0) {
					buf.push(tkSrc);
					offset = da.tsr[1];
				}
				break;

			case String:
				if (openTags.length === 0) {
					escapeStr(t, buf);
					offset += t.length;
				}
				break;

			case pd.EOFTk:
				// Deal with any unprocessed fragments (that should exist
				// only if we have unbalanced opening/closing tags).
				var str = arg.substring(offset, arg.length);
				if (openTags.length === 0) {
					buf.push(str);
				} else {
					escapeStr(str, buf);
				}
				break;
		}
	}

	return buf.join('');
};

/**
 * DOM-based figure handler
 */
WSP.figureHandler = function(node, state, cb) {
	this.handleImage( node, state, cb );
};

WSP._serializeTableTag = function ( symbol, endSymbol, state, token ) {
	var sAttribs = this._serializeAttributes(state, token);
	if (sAttribs.length > 0) {
		// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the '' string
		// is a falsy value and we want to treat it as a truthy value.
		return symbol + ' ' + sAttribs + (endSymbol !== null ? endSymbol : ' |');
	} else {
		return symbol + (endSymbol || '');
	}
};

WSP._serializeTableElement = function ( symbol, endSymbol, state, node ) {
	var token = DU.mkTagTk(node);

	var sAttribs = this._serializeAttributes(state, token);
	if (sAttribs.length > 0) {
		// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the '' string
		// is a falsy value and we want to treat it as a truthy value.
		return symbol + ' ' + sAttribs + (endSymbol !== null ? endSymbol : ' |');
	} else {
		return symbol + (endSymbol || '');
	}
};

WSP._serializeHTMLTag = function ( state, token ) {
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

	var sAttribs = this._serializeAttributes(state, token),
		tokenName = da.srcTagName || token.name;
	if (sAttribs.length > 0) {
		return '<' + tokenName + ' ' + sAttribs + close + '>';
	} else {
		return '<' + tokenName + close + '>';
	}
};

WSP._serializeHTMLEndTag = function ( state, token ) {
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
	var tplAttrs = state.tplAttrs,
	    dp = node.data.parsoid;
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
		var typeMatch = rel.match( /\bmw:[^\b]+/ );
		if ( typeMatch ) {
			rtData.type = typeMatch[0];
		}
	}

	var href = node.getAttribute('href') || '';

	// Save the token's "real" href for comparison
	rtData.href = href.replace( /^(\.\.?\/)+/, '' );

	// Now get the target from rt data
	rtData.target = DU.getAttributeShadowInfo(node, 'href', tplAttrs);

	// Check if the link content has been modified
	DU.loadDataAttrib(node, "parsoid-diff", {});
	var changes = node.data['parsoid-diff'].diff || [];
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
		rtData.tail = '';
		rtData.prefix = dp.src ||
			( ( env.conf.wiki.mwAliases.redirect || '#REDIRECT' ) + ' ' );
		rtData.content.string = dp.content || (dp.sa && dp.sa.href) || href;
	}

	return rtData;
};

function escapeWikiLinkContentString ( contentString, state ) {
	// Wikitext-escape content.
	//
	// When processing link text, we are no longer in newline state
	// since that will be preceded by "[[" or "[" text in target wikitext.
	state.onSOL = false;
	state.wteHandlerStack.push(state.serializer.wteHandlers.wikilinkHandler);
	var res = state.serializer.escapeWikiText(state, contentString);
	state.wteHandlerStack.pop();
	return res;
}

/**
 * Figure out if the link needs to be protected with <nowiki/> against
 * unwanted link prefix and -trail parsing.
 */
WSP.getLinkPrefixTailEscapes = function (node, env) {
	// Check if we need to escape against prefixes or tails
	var prefixEscape = '', tailEscape = '';
	// Check if we need to escape a link prefix
	var escapes = {
		prefix: '',
		tail: ''
	};
	if (env.conf.wiki.linkPrefixRegex &&
			node.previousSibling &&
			// TODO: Also handle zero-width content here?
			node.previousSibling.nodeType === node.TEXT_NODE &&
			env.conf.wiki.linkPrefixRegex.test(node.previousSibling.nodeValue))
	{
		escapes.prefix = '<nowiki/>';
	}

	// Check if we need to escape a link trail
	if (env.conf.wiki.linkTrailRegex &&
			node.nextSibling &&
			// TODO: Also handle zero-width content here?
			node.nextSibling.nodeType === node.TEXT_NODE &&
			env.conf.wiki.linkTrailRegex.test(node.nextSibling.nodeValue))
	{
		escapes.tail = '<nowiki/>';
	}
	return escapes;
};

/**
 * Handle an option that was recorded in the original wikitext
 *
 * @param {Node} node
 * @param {string} opt The value of the option
 * @param {string} optName The canonical name of the option
 * @param {Mixed} optVal The possible value of the option (used mostly in html2html)
 * @param {Object} state
 * @param {Function} cb
 * @param {string} cb.result The result of the serialization for this option
 */
WSP.handleOpt = function ( node, opt, optName, optVal, state, cb ) {
	var caption, val, n,
		dp = DU.getDataParsoid( node ),
		dmw = DU.getDataMw( node ),
		optNames = dp.optNames,
		rel = node.getAttribute( 'rel' ) || node.getAttribute( 'typeof' ) || '',
		imgnode = node.getElementsByTagName( 'img' )[0],
		imgdp = DU.getDataParsoid( imgnode ),
		imgdata = imgdp.img || {},
		imgwidth = imgdata.w,
		capNode = node.getElementsByTagName( 'figcaption' )[0];

	switch ( opt ) {
		case '':
			cb( '' );
			break;

		case 'caption':
			// Assume that the caption is straight text...that may not work long-term
			if ( capNode ) {
				state.inCaption = true;
				val = state.serializeChildrenToString( capNode, this.wteHandlers.wikilinkHandler, false );
				state.inCaption = false;
			} else if ( dmw.caption ) {
				//val = this.escapeWikiText( state, dmw.caption, this.wteHandlers.wikilinkHandler );
				// FIXME gwicke: Actually pass around the HTML and escape it
				// here! (and potentially rt using shadowing)!
				val = dmw.caption;
			}

			cb( val );
			break;

		case 'upright':
			val = DU.getAttributeShadowInfo( imgnode, 'width' );
			if ( val.modified ) {
				val = imgnode.getAttribute( 'width' ) / imgwidth;
			} else {
				val = val.value;
			}

			if ( rel.match( /\bmw:Image\/Frame\b/ ) && val > 1 ) {
				val = 1;
			}

			cb( optName.replace( '$1', val ) );
			break;

		case 'link':
			if ( imgnode.parentNode.tagName.toLowerCase() === 'span' ) {
				cb( optName.replace( '$1', '' ) );
			} else {
				if ( optVal === null ) {
					val = DU.getAttributeShadowInfo( imgnode.parentNode, 'href' );
					val = val.value.replace( /^(\.\.?\/)+/, '' );
				} else {
					val = optVal;
				}

				cb( optName.replace( '$1', val ) );
			}
			break;

		case 'width':
			val = DU.getAttributeShadowInfo( imgnode, 'width' );

			if ( dp.img.htset ) {
				// The height was shadowed, which means we actually had a
				// specified height. Return XxY.
				cb( optName.replace(
					'$1',
					val.value + 'x' + DU.getAttributeShadowInfo( imgnode, 'height' ).value
				) );
				break;
			}

			cb( optName.replace( '$1', val.value ) );
			break;

		case 'height':
			if ( dp.img.wdset ) {
				// We can't do height, because the width attr will handle it
				break;
			}

			val = DU.getAttributeShadowInfo( imgnode, 'height' );
			cb( optName.replace( '$1', val.value ) );
			break;

		case 'alt':
			val = DU.getAttributeShadowInfo( imgnode, 'alt' );
	                // XXX FIXME: If the value does not come from
	                // source, then we may need to escape
	                // it.  -rsmith
			cb( val.value );
			break;

		default:
			cb( optName );
	}
};

WSP.hasOpt = function ( opts, optName ) {
	var ix;

	for ( ix = 0; ix < opts.length; ix++ ) {
		if ( opts[ix].ck === optName ) {
			return true;
		}
	}
	return false;
};

// XXX: This should probably be refactored. -rsmith
WSP.handleImage = function ( node, state, cb ) {
	var isDefaultSize, imgnode, linkinfo,
		ix, curOpt, href, src,
		width, height, wrapName,
		filename, path, classes, currentClass, currentOpt,
		htAttr, wdAttr, wrapdp,
		options = [],
		wikitext = '',
		env = state.env,
		mwAliases = env.conf.wiki.mwAliases,
		rel = node.getAttribute( 'rel' ) || node.getAttribute( 'typeof' ),
		isFigure = node.tagName.toLowerCase() === 'figure',
		dp = DU.getDataParsoid( node ),
		dmw = DU.getDataMw( node ),
		opts = dp.optList || [],
		wrapNode = node.firstChild,
		capNode = node.getElementsByClassName( 'mw-figcaption' )[0];

	if (null === wrapNode) {
		console.error( "WARNING: In WSP.handleImage, the following node has no children:" );
		console.error( node.outerHTML );
		cb( '', node );
		return;
	}

	while ( wrapNode.nodeType !== wrapNode.ELEMENT_NODE ) {
		wrapNode = wrapNode.nextSibling;
	}

	wrapName = wrapNode.tagName.toLowerCase();

	if ( wrapNode.hasAttribute( 'data-parsoid' ) ) {
		wrapdp = DU.getDataParsoid( node );
	}

	if ( wrapName === 'a' ) {
		href = wrapNode.getAttribute( 'href' );
	}

	imgnode = wrapNode.getElementsByTagName( 'img' )[0];

	if (undefined === imgnode) {
		console.error( "WARNING: In WSP.handleImage, node does not have any img elements:" );
		console.error( node.outerHTML );
		cb( '', node );
		return;
	}

	src = imgnode.getAttribute( 'src' );

	// Make sure, if the option info was lost somehow, we still
	// roundtrip to something sane (maybe take out the option info
	// at some future-point)
	// First, handle link options
	if ( wrapName === 'span' && !this.hasOpt( opts, 'link' ) ) {
		opts.push( {
			ck: 'link',
			v: '',
			ak: mwAliases.img_link[0]
		} );
	} else if ( wrapName === 'a' && !this.hasOpt( opts, 'link' ) ) {
		if ( wrapdp && wrapdp.sa && wrapdp.sa.href ) {
			linkinfo = DU.getAttributeShadowInfo( wrapNode, 'href' );

			if ( linkinfo.modified || !linkinfo.value ) {
				linkinfo.value = wrapNode.getAttribute( 'href' ).replace( /^(\.\.?\/)+/, '' );
			}
		} else if ( wrapdp === undefined ) {
			linkinfo = {
				value: wrapNode.getAttribute( 'href' ).replace( /^(\.\.?\/)+/, '' ),
				modified: true
			};
		} else {
			linkinfo = { modified: false };
		}

		if ( linkinfo.modified ) {
			opts.push( {
				ck: 'link',
				v: linkinfo.value,
				ak: mwAliases.img_link[0]
			} );
		}
	}

	// Handle class-signified options
	classes = node.getAttribute( 'class' );

	classes = classes === null ? [] : classes.split( ' ' );

	var val, valign, valignPos, halignSet = false;

	for ( ix = 0; ix < classes.length; ix++ ) {
		currentClass = classes[ix];
		currentOpt = {};

		switch ( currentClass ) {
			case 'mw-halign-none':
			case 'mw-halign-right':
			case 'mw-halign-left':
			case 'mw-halign-center':
				val = currentClass.replace( /^mw-halign-/, '' );

				if ( halignSet ) {
					continue;
				}

				currentOpt.ck = val;
				currentOpt.ak = mwAliases['img_' + val];
				break;

			case 'mw-valign-top':
			case 'mw-valign-middle':
			case 'mw-valign-baseline':
			case 'mw-valign-sub':
			case 'mw-valign-super':
			case 'mw-valign-text-top':
			case 'mw-valign-bottom':
			case 'mw-valign-text-bottom':
				valign = currentClass.replace( /^mw-valign-/, '' );
				valignPos = opts.length;
				break;

			case 'mw-image-border':
				currentOpt.ck = 'border';
				currentOpt.ak = mwAliases.img_border[0];
				break;
		}

		if ( currentOpt.ck && !this.hasOpt( opts, currentOpt.ck ) ) {
			opts.push( currentOpt );
		}
	}

	// FIXME gwicke: This is a temporary round-trip fix for
	// https://bugzilla.wikimedia.org/show_bug.cgi?id=49221
	// TODO: Fix this properly by setting the option key to halign / valign
	// and the value to the aliased value.
	//if ( valign !== undefined ) {
	//	opts.splice( valignPos, 0, {
	//		ck: valign,
	//		ak: mwAliases['img_' + valign]
	//	} );
	//}

	currentOpt = {};
	switch ( rel ) {
		case 'mw:Image/Thumb':
			currentOpt.ck = 'thumbnail';
			currentOpt.ak = mwAliases.img_thumbnail[0];
			break;

		case 'mw:Image/Frame':
			currentOpt.ck = 'framed';
			currentOpt.ak = mwAliases.img_framed[0];
			break;

		case 'mw:Image/Frameless':
			currentOpt.ck = 'frameless';
			currentOpt.ak = mwAliases.img_frameless[0];
			break;
	}

	if ( currentOpt.ck && !this.hasOpt( opts, currentOpt.ck ) ) {
		opts.push( currentOpt );
	}

	// Handle width and height
	if ( !DU.hasClass( node, 'mw-default-size' ) ) {
		if ( !dp.img ) {
			dp.img = {};
		}

		htAttr = imgnode.getAttribute( 'height' );
		wdAttr = imgnode.getAttribute( 'width' );

		if ( htAttr && !this.hasOpt( opts, 'height' ) ) {
			dp.img.htset = true;

			opts.push( {
				ck: 'height',
				v: 'x' + htAttr,
				ak: mwAliases.img_width[0]
			} );
		}

		if ( wdAttr && !this.hasOpt( opts, 'width' ) ) {
			dp.img.wdset = true;

			opts.push( {
				ck: 'width',
				v: wdAttr,
				ak: mwAliases.img_width[0]
			} );
		}
	}

	// Handle caption
	if ( !this.hasOpt( opts, 'caption' ) && (
			( !isFigure && dmw.caption ) ||
			( isFigure && capNode ) ) ){
		opts.push( {
			ck: 'caption'
		} );
	}

	if ( DU.hasClass( imgnode, 'mw-default-size' ) ) {
		isDefaultSize = true;
	}

	if ( imgnode.hasAttribute( 'resource' ) ) {
		filename = DU.getAttributeShadowInfo( imgnode, 'resource' );
		if ( filename.modified || !filename.value ) {
			filename = imgnode.getAttribute( 'resource' ).replace( /^(\.\.?\/)+/, '' );
		} else {
			filename = filename.value;
		}
	}

	wikitext = '[[' + filename;

	function accumOpts( result ) {
		if ( result !== null ) {
			options.push( result );
		}
	}

	if ( opts ) {
		for ( ix = 0; ix < opts.length; ix++ ) {
			curOpt = this.handleOpt( node, opts[ix].ck, opts[ix].ak || null, opts[ix].v || null, state, accumOpts );
		}
	}

	if ( options.length > 0 ) {
		wikitext += '|';
		wikitext += options.join( '|' );
	}

	wikitext += ']]';
	cb( wikitext, node );
};

// SSS FIXME: This doesn't deal with auto-inserted start/end tags.
// To handle that, we have to split every 'return ...' statement into
// openTagSrc = ...; endTagSrc = ...; and at the end of the function,
// check for autoInsertedStart and autoInsertedEnd attributes and
// supress openTagSrc or endTagSrc appropriately.
WSP.linkHandler = function(node, state, cb) {
	// TODO: handle internal/external links etc using RDFa and dataAttribs
	// Also convert unannotated html links without advanced attributes to
	// external wiki links for html import. Might want to consider converting
	// relative links without path component and file extension to wiki links.
	var env = state.env,
		dp = node.data.parsoid,
		linkData, contentParts,
		contentSrc = '',
		rel = node.getAttribute('rel') || '';

	// Get the rt data from the token and tplAttrs
	linkData = getLinkRoundTripData(env, node, state);

	if ( linkData.type !== null && linkData.target.value !== null  ) {
		// We have a type and target info

		var target = linkData.target;

		if (/^mw:WikiLink(\/(Category|Language|Interwiki))?$/.test( linkData.type ) ||
		    /^mw:PageProp\/redirect$/.test( linkData.type ) ) {
			// Decode any link that did not come from the source
			if (! target.fromsrc) {
				target.value = Util.decodeURI(target.value);
			}

			// Special-case handling for category links
			if ( linkData.type === 'mw:WikiLink/Category' ) {
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
					dp.tail = contentParts.tail;
					linkData.tail = contentParts.tail;
					dp.prefix = contentParts.prefix;
					linkData.prefix = contentParts.prefix;
				} else if ( dp.pipetrick ) {
					// Handle empty sort key, which is not encoded as fragment
					// in the LinkHandler
					linkData.content.string = '';
				} else { // No sort key, will serialize to simple link
					linkData.content.string = target.value;
				}

				// Special-case handling for template-affected sort keys
				// FIXME: sort keys cannot be modified yet, but if they are we
				// need to fully shadow the sort key.
				//if ( ! target.modified ) {
					// The target and source key was not modified
					var sortKeySrc = DU.getAttributeShadowInfo(node, 'mw:sortKey', state.tplAttrs);
					if ( sortKeySrc.value !== null ) {
						linkData.contentNode = undefined;
						linkData.content.string = sortKeySrc.value;
						// TODO: generalize this flag. It is already used by
						// getAttributeShadowInfo. Maybe use the same
						// structure as its return value?
						linkData.content.fromsrc = true;
					}
				//}
			} else if ( linkData.type === 'mw:WikiLink/Language' ) {
				// Fix up the the content string
				// TODO: see if linkData can be cleaner!
				if (linkData.content.string === undefined) {
					linkData.content.string = target.value;
				}
			}

				// Strip colon escapes from the original target as that is
				// stripped when deriving the content string.
			var strippedTargetValue = target.value.replace(/^:/, ''),
				// Just a convenient shortcut. The string value of the
				// content, if it is plain text.
				contentString = linkData.content.string,

				// figure out if we need a piped or simple link
				canUseSimple =
					// Would need to pipe for any non-string content
					contentString !== undefined &&
					// See if the (normalized) content matches the
					// target, either shadowed or actual.
					(	contentString ===
							Util.decodeURI(Util.decodeEntities(strippedTargetValue)) ||
						contentString === linkData.href ||
						// normalize without underscores for
						// comparison with target.value and strip
						// any colon escape
						env.normalizeTitle( contentString, true ) ===
						Util.decodeURI( strippedTargetValue ) ||
						// normalize with underscores for comparison with href
						env.normalizeTitle( contentString ) ===
						Util.decodeURI( linkData.href )
					) &&
					// but preserve non-minimal piped links
					( target.modified || linkData.contentModified ||
						( dp.stx !== 'piped' && !dp.pipetrick ) ),

				canUsePipeTrick =
					linkData.type === 'mw:WikiLink/Language' ||
					contentString !== undefined &&
					linkData.type !== 'mw:WikiLink/Category' &&
					(
						Util.stripPipeTrickChars(strippedTargetValue) ===
							contentString ||
						Util.stripPipeTrickChars(linkData.href) ===
							contentString ||
						env.normalizeTitle(Util.stripPipeTrickChars(
								Util.decodeURI(strippedTargetValue))) ===
							env.normalizeTitle(contentString) ||
						env.normalizeTitle(
							Util.stripPipeTrickChars(Util.decodeURI(linkData.href))) ===
							env.normalizeTitle(contentString) ||
						// Interwiki links with pipetrick have their prefix
						// stripped, so compare against a stripped version
						( linkData.type === 'mw:WikiLink/Interwiki' &&
						  dp.pipetrick &&
						  env.normalizeTitle( contentString ) ===
							target.value.replace(/^:?[a-zA-Z]+:/, '') )
					),
				// Only preserve pipe trick instances across edits, but don't
				// introduce new ones.
				willUsePipeTrick = canUsePipeTrick && dp.pipetrick;
			//console.log(linkData.content.string, canUsePipeTrick);

			// Get <nowiki/> escapes to protect against unwanted prefix / tail
			var escapes = this.getLinkPrefixTailEscapes(node, env);

			if ( canUseSimple ) {
				// Simple case
				var linkTarget;
				if (!target.modified) {
					linkTarget = target.value;
				} else {
					linkTarget = escapeWikiLinkContentString(linkData.content.string, state);
				}

				cb( escapes.prefix + linkData.prefix + '[[' + linkTarget + ']]' +
						linkData.tail + escapes.tail, node );
				return;
			} else {

				// First get the content source
				if ( linkData.contentNode ) {
					contentSrc = state.serializeChildrenToString(
							linkData.contentNode,
							this.wteHandlers.wikilinkHandler, false);
					// strip off the tail and handle the pipe trick
					contentParts = splitLinkContentString(contentSrc, dp);
					contentSrc = contentParts.contentString;
					dp.tail = contentParts.tail;
					linkData.tail = contentParts.tail;
					dp.prefix = contentParts.prefix;
					linkData.prefix = contentParts.prefix;
				} else if ( !willUsePipeTrick ) {
					if (linkData.content.fromsrc) {
						contentSrc = linkData.content.string;
					} else {
						contentSrc = escapeWikiLinkContentString(linkData.content.string || '',
								state);
					}
				}

				if ( contentSrc === '' && ! willUsePipeTrick &&
						linkData.type !== 'mw:WikiLink/Category' ) {
					// Protect empty link content from PST pipe trick
					contentSrc = '<nowiki/>';
				}

				cb( escapes.prefix + linkData.prefix +
						'[[' + linkData.target.value + '|' + contentSrc + ']]' +
						linkData.tail + escapes.tail, node );
				return;
			}
		} else if ( rel === 'mw:ExtLink' ) {
			if ( target.modified ) {
				// encodeURI only encodes spaces and the like
				target.value = encodeURI(target.value);
			}

			cb( '[' + target.value + ' ' +
				state.serializeChildrenToString(node, this.wteHandlers.aHandler, false) +
				']', node );
		} else if ( rel.match( /mw:ExtLink\/(?:ISBN|RFC|PMID)/ ) ) {
			cb( node.firstChild.nodeValue, node );
		} else if ( rel === 'mw:ExtLink/URL' ) {
			cb( linkData.target.value, node );
		} else if ( rel === 'mw:ExtLink/Numbered' ) {
			// XXX: Use shadowed href? Storing serialized tokens in
			// data-parsoid seems to be... wrong.
			cb( '[' + Util.tokensToString(linkData.target.value) + ']', node);
		} else if ( rel.match( /\bmw:Image/ ) ) {
			this.handleImage( node, state, cb );
		} else {
			// Unknown rel was set
			//this._htmlElementHandler(node, state, cb);
			if ( target.modified ) {
				// encodeURI only encodes spaces and the like
				target.value = encodeURI(target.value);
			}
			cb( '[' + target.value + ' ' +
				state.serializeChildrenToString(node, this.wteHandlers.aHandler, false) +
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
		} else {
			// encodeURI only encodes spaces and the like
			var href = encodeURI(node.getAttribute('href'));
			cb( '[' + href + ' ' +
				state.serializeChildrenToString(node, this.wteHandlers.aHandler, false) +
				']', node );
		}
	}

	//if ( rtinfo.type === 'wikilink' ) {
	//	return '[[' + rtinfo.target + ']]';
	//} else {
	//	// external link
	//	return '[' + rtinfo.
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

function id(v) {
	return function() {
		return v;
	};
}

function buildHeadingHandler(headingWT) {
	return {
		handle: function(node, state, cb) {
			cb(headingWT, node);
			if (node.childNodes.length) {
				var headingHandler = state.serializer.wteHandlers.headingHandler.bind(state.serializer.wteHandlers, node);
				state.serializeChildren(node, cb, headingHandler);
			} else {
				// Deal with empty headings
				cb('<nowiki/>', node);
			}
			cb(headingWT, node);
		},
		sepnls: {
			before: id({min:1, max:2}),
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

	while (node) {
		var nodeName = node.nodeName.toLowerCase(),
			dp = node.data.parsoid;

		if (dp.stx !== 'html' && nodeName in listTypes) {
			res = listTypes[nodeName] + res;
		} else if (dp.stx !== 'html' || !dp.autoInsertedStart || !dp.autoInsertedEnd) {
			break;
		}

		node = node.parentNode;
	}

	return res;
};


/**
 * Bold/italic helper: Determine if an element was preceded by a
 * bold/italic combination
 */
WSP._hasPrecedingQuoteElements = function(node, state) {
	if (!state.sep.lastSourceNode) {
		// A separator was emitted before some other non-empty wikitext
		// string, which means that we can't be directly preceded by quotes.
		return false;
	}
	// Move up first until we have a sibling
	while (node && !node.previousSibling) {
		node = node.parentNode;
	}
	if (node) {
		node = node.previousSibling;
	}
	// Now move down the lastChilds to see if there are any italics / bolds
	while(node && node.nodeType === node.ELEMENT_NODE) {
		if (node.nodeName in {I:1, B:1} &&
				node.lastChild && node.lastChild.nodeName in {I:1, B:1}) {
			if (state.sep.lastSourceNode === node) {
				return true;
			} else {
				return false;
			}
		} else if (state.sep.lastSourceNode === node) {
			// If a separator was already emitted, or an outstanding separator
			// starts at another node that produced output, we are not
			// directly preceded by quotes in the wikitext.
			return false;
		}
		node = node.lastChild;
	}
	return false;
};

function wtEOL(node, otherNode) {
	if (DU.isElt(otherNode) &&
		(otherNode.data.parsoid.stx === 'html' || otherNode.data.parsoid.src))
	{
		return {min:0, max:2};
	} else {
		return {min:1, max:2};
	}
}

function wtListEOL(node, otherNode) {
	var nextSibling = DU.nextNonSepSibling(node);
	//console.log(nextSibling && nextSibling.nodeName);
	if (!DU.isElt(otherNode)) {
		return {min:0, max:2};
	} else if (nextSibling === otherNode &&
			(otherNode.data.parsoid.stx === 'html' || otherNode.data.parsoid.src))
	{
		return {min:0, max:2};
	} else if (nextSibling === otherNode && DU.isListOrListElt(otherNode)) {
		if (DU.isList(node) && otherNode.nodeName === node.nodeName) {
			// Adjacent lists of same type need extra newline
			return {min: 2, max:2};
		} else if (DU.isListElt(node) || node.parentNode.nodeName in {LI:1, DD:1}) {
			// Top-level list
			return {min:1, max:1};
		} else {
			return {min:1, max:2};
		}
	} else if (otherNode.nodeType === node.ELEMENT_NODE &&
			otherNode.nodeName in {'UL':1, 'OL':1, 'DL':1}) {
		// last child in ul/ol (the list element is our parent), defer
		// separator constraints to the list.
		return {};
	} else if (otherNode.nodeType === node.ELEMENT_NODE &&
			otherNode.nodeName === 'BODY') {
		return {min:0, max:2};
	} else {
		return {min:1, max:2};
	}
}

function buildListHandler(firstChildNames) {
	function isBuilderInsertedElt(node) {
		DU.loadDataParsoid(node);
		return node.data && node.data.parsoid && node.data.parsoid.autoInsertedStart && node.data.parsoid.autoInsertedEnd;
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
				if (DU.isText(otherNode) && DU.isListElt(node.parentNode)) {
					// DL nested inside a list item
					// <li> foo <dl> .. </dl></li>
					return {min:0, max:1};
				} else {
					return {min:1, max:2};
				}
			},
			after: wtListEOL //id({min:1, max:2})
		}
	};
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
				if (otherNode === node.parentNode &&
						otherNode.nodeName in {UL:1, OL:1})
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
				if (otherNode.nodeName === 'DD' && otherNode.data.parsoid.stx === 'row') {
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
				if (node.data.parsoid.stx === 'row') {
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
				if ( node.data.parsoid.stx === 'row' ) {
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
		handle: function (node, state, cb) {
			var wt = node.data.parsoid.startTagSrc || "{|";
			cb(state.serializer._serializeTableTag(wt, '', state, DU.mkTagTk(node)), node);
			state.serializeChildren(node, cb);
			emitEndTag(node.data.parsoid.endTagSrc || "|}", node, state, cb);
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
			after: id({min:1, max:2}),
			firstChild: id({min:1, max:2}),
			lastChild: id({min:1})
		}
	},
	tbody: {
		handle: function (node, state, cb) {
			// Just serialize the children, ignore the (implicit) tbody
			state.serializeChildren(node, cb);
		}
	},
	tr: {
		handle: function (node, state, cb) {
			// If the token has 'startTagSrc' set, it means that the tr was present
			// in the source wikitext and we emit it -- if not, we ignore it.
			var dp = node.data.parsoid;
			if (node.previousSibling || dp.startTagSrc) {
				var res = state.serializer._serializeTableTag(dp.startTagSrc || "|-", '', state,
							DU.mkTagTk(node) );
				emitStartTag(res, node, state, cb);
			}
			state.serializeChildren(node, cb);
		},
		sepnls: {
			before: function(node, othernode) {
				if (!node.previousSibling && !node.data.parsoid.startTagSrc) {
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
		handle: function (node, state, cb) {
			var dp = node.data.parsoid, res;
			if ( dp.stx_v === 'row' ) {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "!!",
							dp.attrSepSrc || null, state, DU.mkTagTk(node));
			} else {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "!", dp.attrSepSrc || null,
						state, DU.mkTagTk(node));
			}
			emitStartTag(res, node, state, cb);
			state.serializeChildren(node, cb, state.serializer.wteHandlers.thHandler);
		},
		sepnls: {
			before: function(node, otherNode) {
				if (node.data.parsoid.stx_v === 'row') {
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
		handle: function (node, state, cb) {
			var dp = node.data.parsoid, res;
			if ( dp.stx_v === 'row' ) {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "||",
						dp.attrSepSrc || null, state, DU.mkTagTk(node));
			} else {
				// If the HTML for the first td is not enclosed in a tr-tag,
				// we start a new line.  If not, tr will have taken care of it.
				res = state.serializer._serializeTableTag(dp.startTagSrc || "|",
						dp.attrSepSrc || null, state, DU.mkTagTk(node));

			}
			// FIXME: bad state hack!
			if(res.length > 1) {
				state.inWideTD = true;
			}
			emitStartTag(res, node, state, cb);
			state.serializeChildren(node, cb, state.serializer.wteHandlers.tdHandler);
			// FIXME: bad state hack!
			state.inWideTD = undefined;
		},
		sepnls: {
			before: function(node, otherNode) {
				return node.data.parsoid.stx_v === 'row' ?
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
		handle: function (node, state, cb) {
			var dp = node.data.parsoid;
			// Serialize the tag itself
			var res = state.serializer._serializeTableTag(
					dp.startTagSrc || "|+", null, state, DU.mkTagTk(node));
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
			before: function(node, otherNode) {
				var otherNodeName = otherNode.nodeName.toLowerCase();
				if( node.parentNode === otherNode &&
						isListElementName(otherNodeName) || otherNodeName in {td:1, body:1} )
				{
					if (otherNodeName in {td:1, body:1}) {
						return {min: 0, max: 1};
					} else {
						return {min: 0, max: 0};
					}
				} else if (otherNode === node.previousSibling &&
						// p-p transition
						otherNodeName === 'p' ||
						// Treat text/p similar to p/p transition
						// XXX: also check if parent node and first sibling
						// serializes(|d) to single line.
						// Only a single line is
						// needed in that case. Example:
						// <div>foo</div> a
						// b
						((otherNodeName === '#text' &&
						  otherNode === DU.previousNonSepSibling(node) &&
						  // FIXME HACK: Avoid forcing two newlines if the
						  // first line is a text node that ends up on the
						  // same line as a block
						  !( ( DU.isBlockNode(node.parentNode) && node.parentNode.nodeName !== 'BODY') ||
								otherNode.nodeValue.match(/\n(?!$)/)))))
				{
					return {min: 2, max: 2};
				} else {
					return {min: 1, max: 2};
				}
			},
			after: function(node, otherNode) {
				return !(node.lastChild && node.lastChild.nodeName === 'BR') &&
					otherNode.nodeName === 'P'/* || otherNode.nodeType === node.TEXT_NODE*/ ?
					{min: 2, max: 2} : {min: 0, max: 2};
			}
		}
	},
	pre: {
		handle: function(node, state, cb) {
			if (node.data.parsoid.stx === 'html') {
				// Handle html-pres specially
				// 1. If the node has a leading newline, add one like it (logic copied from VE)
				// 2. If not, and it has a data-parsoid strippedNL flag, add it back.
				// This patched DOM will serialize html-pres correctly.

				var lostLine = '', fc = node.firstChild;
				if (DU.isText(fc)) {
					var m = fc.nodeValue.match(/^\r\n|\r|\n/);
					lostLine = m && m[0] || '';
				}

				var shadowedNL = node.data.parsoid.strippedNL;
				if (!lostLine && shadowedNL) {
					lostLine = shadowedNL;
				}
				cb('<pre>' + lostLine +
						// escape embedded </pre>
						node.innerHTML.replace(/<\/pre( [^>]*)>/g, '&lt;/pre$1&gt'), node);
			} else {
				// Handle indent pre

				// XXX: Use a pre escaper?
				state.inIndentPre = true;
				var content = state.serializeChildrenToString(node);

				// Insert indentation
				content = ' ' +
					content.replace(/(\n(<!--(?:[^\-]|\-(?!\->))*\-\->)*)(?!$)/g, '$1 ' );

				// Strip trailing separators
				//var trailingSep = content.match(/\s*$/);
				//content = content.replace(/\s*$/, '');

				cb(content, node);

				// Preserve separator source
				//state.sep.src = trailingSep && trailingSep[0] || '';
				state.sep.src = '';
			}
			state.inIndentPre = false;
		},
		sepnls: {
			before: function(node, otherNode) {
				return node.data.parsoid.stx === 'html' ? {} : {min:1};
			},
			after: function(node, otherNode) {
				return node.data.parsoid.stx === 'html' ? {} : {min:1};
			}
		}
	},
	meta: {
		handle: function (node, state, cb) {
			var type = node.getAttribute('typeof'),
				content = node.getAttribute('content'),
				property = node.getAttribute('property');

			// Check for property before type so that page properties with templated attrs
			// roundtrip properly.  Ex: {{DEFAULTSORT:{{echo|foo}} }}
			if ( property ) {
				var switchType = property.match( /^mw\:PageProp\/(.*)$/ );
				if ( switchType ) {
					var out = switchType[1];
					if (out === 'categorydefaultsort') {
						if (node.data.parsoid.src) {
							// Use content so that VE modifications are preserved
							var contentInfo = DU.getAttributeShadowInfo(node, "content", state.tplAttrs);
							out = node.data.parsoid.src.replace(/^([^:]+:)(.*)$/, "$1" + contentInfo.value + "}}");
						} else {
							console.warn('defaultsort is missing source. Rendering as DEFAULTSORT magicword');
							out = "{{DEFAULTSORT:" + content + "}}";
						}
					} else if ( node.data.parsoid.magicSrc ) {
						out = node.data.parsoid.magicSrc;
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
								 console.warn( JSON.stringify( node.outerHTML ) );
							 }
							 cb('<' + content + '>', node);
							 break;
					case 'mw:Includes/IncludeOnly':
							 cb(node.data.parsoid.src, node);
							 break;
					case 'mw:Includes/IncludeOnly/End':
							 // Just ignore.
							 break;
					case 'mw:Includes/NoInclude':
							 cb(node.data.parsoid.src || '<noinclude>', node);
							 break;
					case 'mw:Includes/NoInclude/End':
							 cb(node.data.parsoid.src || '</noinclude>', node);
							 break;
					case 'mw:Includes/OnlyInclude':
							 cb(node.data.parsoid.src || '<onlyinclude>', node);
							 break;
					case 'mw:Includes/OnlyInclude/End':
							 cb(node.data.parsoid.src || '</onlyinclude>', node);
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
			// FIXME: really suppress newlines after these metas. Currently
			// conflicts are resolved in favor of the newer constraint.
			after: function(node, otherNode) {
				var type = node.getAttribute('typeof');
				if (type && type.match(/mw:Includes\//)) {
					return {max:0};
				} else {
					return {};
				}
			},
			before: function(node, otherNode) {
				var type = node.getAttribute( 'typeof' ) || node.getAttribute( 'property' );
				if (type && type.match(/mw:Includes\//)) {
					return {max:0};
				} else if ( type && type.match( /mw:PageProp\/categorydefaultsort/ ) ) {
					if ( otherNode.nodeName.toLowerCase() === 'p' ) {
						return { min: 2 };
					} else {
						return { min: 1 };
					}
				} else {
					return {};
				}
			}
		}
	},
	span: {
		handle: function(node, state, cb) {
			var type = node.getAttribute('typeof');
			if (type && type in state.serializer.genContentSpanTypes) {
				if (type === 'mw:Nowiki') {
					cb('<nowiki>', node);
					if (node.childNodes.length === 1 && node.firstChild.nodeName === 'PRE') {
						state.serializeChildren(node, cb);
					} else {
						var child = node.firstChild;
						while(child) {
							if (DU.isElt(child)) {
								if (child.nodeName === 'SPAN' &&
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
				} else if ( type.match( /\bmw\:Image(\/(Frame|Frameless|Thumb))?/ ) ) {
					state.serializer.handleImage( node, state, cb );
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
			cb(Util.charSequence("----", "-", node.data.parsoid.extra_dashes), node);
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
			if (node.data.parsoid.stx === 'html' || node.parentNode.nodeName !== 'P') {
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
			after: id({min:1})
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
			if (state.serializer._hasPrecedingQuoteElements(node, state)) {
				emitStartTag('<nowiki/>', node, state, cb);
			}
			emitStartTag("'''", node, state, cb);
			state.serializeChildren(node, cb, state.serializer.wteHandlers.quoteHandler);
			emitEndTag("'''", node, state, cb);
		}
	},
	i:  {
		handle: function(node, state, cb) {
			if (state.serializer._hasPrecedingQuoteElements(node, state)) {
				emitStartTag('<nowiki/>', node, state, cb);
			}
			emitStartTag("''", node, state, cb);
			state.serializeChildren(node, cb, state.serializer.wteHandlers.quoteHandler);
			emitEndTag("''", node, state, cb);
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
				if (/\bmw:WikiLink\/Category\b/.test(type) &&
						!node.getAttribute('data-parsoid')) {
					// Fresh category link: Serialize on its own line
					return {min: 1};
				} else {
					return {};
				}
			},
			after: function (node, otherNode) {
				var type = node.getAttribute('rel');
				if (/\bmw:WikiLink\/Category\b/.test(type) &&
						!node.getAttribute('data-parsoid') &&
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

WSP._serializeAttributes = function (state, token) {
	function hasExpandedAttrs(tokType) {
		return tokType && tokType.match(/\bmw:ExpandedAttrs\/[^\s]+/);
	}

	var tplAttrState = { kvs: {}, ks: {}, vs: {} },
	    tokType = token.getAttribute("typeof"),
		attribs = token.attribs;

	// Check if this token has attributes that have been
	// expanded from templates or extensions
	if (hasExpandedAttrs(tokType)) {
		tplAttrState = state.tplAttrs[token.getAttribute("about")];
		if (!tplAttrState) {
			console.error("ERROR: Missing info about tpl-affected attribute");
			console.error("-> about: " + JSON.stringify(token.getAttribute("about")));
			console.error("-> token: " + JSON.stringify(token));
			// Reset to default so we dont crash
			tplAttrState = { kvs: {}, ks: {}, vs: {} };
		}
	}

	var out = [],
		ignoreKeys = {
			about: 1, // FIXME: only strip if value starts with #mw?
			'typeof': 1, // similar: only strip values with mw: prefix
			// The following should be filtered out earlier, but we ignore
			// them here too just to make sure.
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

		// Ignore about and typeof if they are template-related
		if (ignoreKeys[k]) {
			continue;
		}

		if (k.length) {
			tplKV = tplAttrState.kvs[k];
			if (tplKV) {
				out.push(tplKV);
			} else {
				tplK = tplAttrState.ks[k],
				tplV = tplAttrState.vs[k],
				vInfo = token.getAttributeShadowInfo(k),
				v = vInfo.value;

				// Deal with k/v's that were template-generated
				if (tplK) {
					k = tplK;
				}
				if (tplV){
					v = tplV;
				}

				if (v.length ) {
					if (!vInfo.fromsrc) {
						// Escape HTML entities
						v = Util.escapeEntities(v);
					}
					out.push(k + '=' + '"' + v.replace( /"/g, '&quot;' ) + '"');
				} else {
					out.push(k);
				}
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
				// Deal with k/v's that were template-generated
				// and then sanitized away!
				tplK = tplAttrState.ks[k];
				if (tplK) {
					k = tplK;
				}

				v = dataAttribs.sa[k];
				if (v) {
					tplV = tplAttrState.vs[k];

					if (tplV){
						v = tplV;
					}

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

WSP._htmlElementHandler = function (node, state, cb) {

	emitStartTag(this._serializeHTMLTag(state, DU.mkTagTk(node)),
			node, state, cb);
	if (node.childNodes.length) {
		var inPHPBlock = state.inPHPBlock;
		if (Util.tagOpensBlockScope(node.nodeName.toLowerCase())) {
			state.inPHPBlock = true;
		}
		state.serializeChildren(node, cb);
		state.inPHPBlock = inPHPBlock;
	}
	emitEndTag(this._serializeHTMLEndTag(state, DU.mkEndTagTk(node)),
			node, state, cb);
};

WSP._buildTemplateWT = function(state, srcParts) {
	var buf = [],
		serializer = this;
	srcParts.map(function(part) {
		var tpl = part.template;
		if (tpl) {
			buf.push("{{");

			// tpl target
			buf.push(tpl.target.wt);

			// tpl args
			var argBuf = [],
				keys = Object.keys(tpl.params),
				n = keys.length;
			if (n > 0) {
				for (var i = 0; i < n; i++) {
					var k = keys[i],
						v = serializer.escapeTplArgWT(state, tpl.params[k].wt);
					if (k === (i+1).toString()) {
						argBuf.push(v);
					} else {
						argBuf.push(k + "=" + v);
					}
				}
				buf.push("|");
				buf.push(argBuf.join("|"));
			}
			buf.push("}}");
		} else {
			// plain wt
			buf.push(part);
		}
	});
	return buf.join('');
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
	attrStr = this._serializeAttributes(state, extTok);

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
			var wts = new WikitextSerializer({env: state.env});
			srcParts.push(wts.serializeDOM(Util.parseHTML(dataMW.body.html).body));
		} else if (dataMW.body.extsrc) {
			srcParts.push(dataMW.body.extsrc);
		} else {
			console.error("ERROR: extension src unavailable for: " + node.outerHTML);
		}
		srcParts = srcParts.concat(["</", extName, ">"]);
	}

	return srcParts.join('');
};

WSP.skipOverEncapsulatedContent = function(node) {
	var about = node.getAttribute('about');
	if (!about) {
		return node;
	}

	node = node.nextSibling;
	while (node && DU.isElt(node) && about === node.getAttribute('about')) {
		node = node.nextSibling;
	}

	return node;
};

/**
 * Get a DOM-based handler for an element node
 */
WSP._getDOMHandler = function(node, state, cb) {
	var self = this;

	if (!node || node.nodeType !== node.ELEMENT_NODE) {
		return {};
	}

	DU.loadDataParsoid(node);

	var dp = node.data.parsoid,
		nodeName = node.nodeName.toLowerCase(),
		handler,
		typeOf = node.getAttribute( 'typeof' ) || '';

	// XXX: Convert into separate handlers?
	if (/\bmw:(?:Transclusion\b|Param\b|Extension\/[^\s]+)/.test(typeOf)) {
		return {
			handle: function () {
				// In RT-testing mode, there will not be any edits to tpls/extensions.
				// So, use original source to eliminate spurious diffs showing up
				// in RT testing results.
				var src, dataMW;
				if (state.rtTesting && dp.src !== undefined) {
					src = dp.src;
				} else if (/\bmw:(Transclusion\b|Param\b)/.test(typeOf)) {
					dataMW = JSON.parse(node.getAttribute("data-mw"));
					if (dataMW) {
						src = state.serializer._buildTemplateWT(state, dataMW.parts || [{ template: dataMW }]);
					} else {
						console.error("ERROR: No data-mw for: " + node.outerHTML);
						src = dp.src;
					}
				} else if (/\bmw:Extension\//.test(typeOf)) {
					dataMW = JSON.parse(node.getAttribute("data-mw"));
					src = !dataMW ? dp.src : state.serializer._buildExtensionWT(state, node, dataMW);
				} else {
					console.error("ERROR: Should not have come here!");
				}

				if (src) {
					self.emitWikitext(src, state, cb, node);
					return self.skipOverEncapsulatedContent(node);
				} else {
					console.error("ERROR: No handler for: " + node.outerHTML);
					console.error("Serializing as HTML.");
					return self._htmlElementHandler(node, state, cb);
				}
			},
			sepnls: {
				// XXX: This is questionable, as the template can expand
				// to newlines too. Which default should we pick for new
				// content? We don't really want to make separator
				// newlines in HTML significant for the semantics of the
				// template content.
				before: id({min:0, max:2})
			}
		};
	}

	if ( dp.src !== undefined ) {
		// Source-based template/extension round-tripping for now
		//console.log(node.parentNode.outerHTML);
		if (/^mw:Placeholder(\/\w*)?$/.test(typeOf) ||
				(typeOf === "mw:Nowiki" && node.textContent === dp.src )) {
			// implement generic src round-tripping:
			// return src, and drop the generated content
			return {
				handle: function() {
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
		node.parentNode.data && node.parentNode.data.parsoid.stx === 'html' &&
		((DU.isList(node.parentNode) && DU.isListElt(node)) ||
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
	res = res.replace(/^\n/, '');

	// Always escape entities
	res = Util.escapeEntities(res);

	// If not in nowiki and pre context, escape wikitext
	// XXX refactor: Handle this with escape handlers instead!
	state.escapeText = !state.inNoWiki && !state.inHTMLPre;

	cb(res, node);
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

WSP._getDOMRTInfo = function( node ) {
	if ( node.hasAttribute('data-parsoid') ) {
		return JSON.parse( node.getAttribute('data-parsoid') || '{}' );
	} else {
		return {};
	}
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
	if (DU.isText(node)) {
		if (node.nodeValue.match(/^\s*$/)) {
			state.sep.src = (state.sep.src || '') + node.nodeValue;
			//if (!state.sep.lastSourceNode) {
			//	// FIXME: Actually set lastSourceNode when the source is
			//	// emitted / emitSeparator is called!
			//	state.sep.lastSourceNode = node.previousSibling || node.parentNode;
			//}
			return true;
		} else if (node.nodeValue.match(/^\n+/)) {
			state.sep.src = (state.sep.src || '') + node.nodeValue.match(/^\n+/)[0];
			//if (!state.sep.lastSourceNode) {
			//	// FIXME: Actually set lastSourceNode when the source is
			//	// emitted / emitSeparator is called!
			//	state.sep.lastSourceNode = node.previousSibling || node.parentNode;
			//}
			return false;
		} else {
			// not a separator between elements
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
 * Update state with the set of templated attributes.
 */
WSP.extractTemplatedAttributes = function(node, state) {
	if (node.nodeName.toLowerCase() === "meta") {
		var prop = node.getAttribute("property");
		if (prop && prop.match(/mw:objectAttr/)) {
			var templateId = node.getAttribute("about") || '';
			var src  = this._getDOMRTInfo(node).src;
			if (!state.tplAttrs[templateId]) {
				state.tplAttrs[templateId] = { kvs: {}, ks: {}, vs: {} };
			}

			// prop is one of:
			// "mw:ObjectAttr#foo"    -- "foo=blah" came from a template
			// "mw:objectAttrKey#foo" -- "foo" came from a template
			// "mw:objectAttrVal#foo  -- "blah" (foo's value) came from a template
			var pieces = prop.split("#");
			var attr   = pieces[1];

			if (pieces[0] === "mw:objectAttr") {
				state.tplAttrs[templateId].kvs[attr] = src;
			} else if (pieces[0] === "mw:objectAttrKey") {
				state.tplAttrs[templateId].ks[attr] = src;
			} else {
				state.tplAttrs[templateId].vs[attr] = src;
			}

			// Remove it from the DOM
			//node.parentNode.removeChild(node);
		}
	} else {
		var child = node.firstChild;
		var next, prev, childIsPre;

		while (child) {
			// Get the next sibling first thing because we may delete this child
			next = child.nextSibling, prev = child.previousSibling;
			childIsPre = DU.hasNodeName(child, "pre");

			// Descend and recurse
			this.extractTemplatedAttributes(child, state);

			child = next;
		}
	}
};

/**
 * Helper for updateSeparatorConstraints
 *
 * Collects, checks and integrates separator newline requirements to a sinple
 * min, max structure.
 */
WSP.getSepNlConstraints = function(nodeA, sepNlsHandlerA, nodeB, sepNlsHandlerB) {
	var nlConstraints = { a:{}, b:{} };
	if (sepNlsHandlerA) {
		nlConstraints.a = sepNlsHandlerA(nodeA, nodeB);
		nlConstraints.min = nlConstraints.a.min;
		nlConstraints.max = nlConstraints.a.max;
	} else {
		// Anything more than two lines will trigger paragraphs, so default to
		// two if nothing is specified.
		nlConstraints.max = 2;
	}

	if (sepNlsHandlerB) {
		nlConstraints.b = sepNlsHandlerB(nodeB, nodeA);
		var cb = nlConstraints.b;

		// now figure out if this conflicts with the nlConstraints so far
		if (cb.min !== undefined) {
			if (nlConstraints.max !== undefined && nlConstraints.max < cb.min) {
				// Conflict, warn and let nodeB win.
				console.error('Incompatible constraints 1:', nodeA.nodeName,
						nodeB.nodeName, nlConstraints);
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
				console.error('Incompatible constraints 2:', nodeA.nodeName,
						nodeB.nodeName, nlConstraints);
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
WSP.makeSeparator = function(sep, node, nlConstraints, state) {
	var origSep = sep;

		// TODO: Move to Util?
	var commentRe = '<!--(?:[^-]|-(?!->))*-->',
		// Split on comment/ws-only lines, consuming subsequent newlines since
		// those lines are ignored by the PHP parser
		// Ignore lines with ws and a single comment in them
		splitReString = '(?:\n[ \t]*?' + commentRe + '[ \t]*?(?=\n))+|' + commentRe,
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
		for (var i = 0; i < (minNls - sepNlCount); i++) {
			sep += '\n';
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

	// XXX: Disabled for now- most line-based block elements move comments
	// outside the DOM element, and still expect the comment to end up on
	// the same line. Trailing spaces on a line don't trigger pres, so
	// leave them in too in the interest of wt2wt round-tripping.
	//if (nlConstraints.a.min) {
	//	// Strip leading non-nl ws up to the first newline, but keep comments
	//	sep.replace(/^([^\n<]*<!--(?:[^\-]|-(?!->))*-->)?[^\n<]+/g, '$1');
	//}

	// Strip non-nl ws from last line, but preserve comments
	// This avoids triggering indent-pres.
	//
	// 'node' has min-nl constraint, but we dont know that 'node' is pre-safe.
	// SSS FIXME: The check for 'node.nodeName in preSafeTags' should be possible
	// at a nested level rather than just 'node'.  If 'node' is an IEW/comment,
	// we should find the "next" (at this and and ancestor levels), the non-sep
	// sibling and check if that node is one of these types.
	var preSafeTags = {'BR':1, 'TABLE':1, 'TBODY':1, 'CAPTION':1, 'TR':1, 'TD':1, 'TH':1},
		// SSS FIXME: how is it that parentNode can be null??  is body getting here?
	    parentName = node.parentNode && node.parentNode.nodeName;
	if (nlConstraints.min > 0 && !(node.nodeName in preSafeTags)) {
		sep = sep.replace(/[^\n>]+(<!--(?:[^\-]|-(?!->))*-->[^\n]*)?$/g, '$1');
	}
	this.trace('makeSeparator', sep, origSep, minNls, sepNlCount, nlConstraints);

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
		console.error('Incompatible constraints (merge):', res, oldConstraints, newConstraints);
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
WSP.updateSeparatorConstraints = function( state, nodeA, handlerA, nodeB, handlerB, dir) {
	var nlConstraints,
		sepHandlerA = handlerA && handlerA.sepnls || {},
		sepHandlerB = handlerB && handlerB.sepnls || {};
	if ( nodeA.nextSibling === nodeB ) {
		// sibling separator
		nlConstraints = this.getSepNlConstraints(nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.before);
	} else if ( nodeB.parentNode === nodeA || dir === 'prev' ) {
		// parent-child separator, nodeA parent of nodeB
		nlConstraints = this.getSepNlConstraints(nodeA, sepHandlerA.firstChild,
											nodeB, sepHandlerB.before);
	} else if ( nodeA.parentNode === nodeB || dir === 'next') {
		// parent-child separator, nodeB parent of nodeA
		nlConstraints = this.getSepNlConstraints(nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.lastChild);
	} else {
		// sibling separator
		nlConstraints = this.getSepNlConstraints(nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.before);
	}

	if (nodeA.nodeName === undefined) {
		console.trace();
	}

	if (this.debugging) {
		this.trace('hSep', nodeA.nodeName, nodeB.nodeName,
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
	//console.log('nlConstraints', state.sep.constraints);
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

	if (src && node && prevNode) {
		if (prevNode && !DU.isElt(prevNode)) {
			// Check if this is the last child of a zero-width element, and use
			// that for dsr purposes instead. Typical case: text in p.
			if (!prevNode.nextSibling &&
				prevNode.parentNode &&
				prevNode.parentNode !== node &&
				prevNode.parentNode.data.parsoid.dsr &&
				prevNode.parentNode.data.parsoid.dsr[3] === 0)
			{
				dsrA = prevNode.parentNode.data.parsoid.dsr;
			} else if (prevNode.previousSibling &&
					prevNode.previousSibling.nodeType === prevNode.ELEMENT_NODE &&
					prevNode.previousSibling.data.parsoid.dsr)
			{
				var endDsr = prevNode.previousSibling.data.parsoid.dsr[1],
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
		} else if (prevNode.data && prevNode.data.parsoid) {
			dsrA = prevNode.data.parsoid.dsr;
		}

		if (node && !DU.isElt(node)) {
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

			if (node.parentNode !== prevNode &&
				node.parentNode.data.parsoid.dsr &&
				node.parentNode.data.parsoid.dsr[2] === 0)
			{
				var sepTxt = precedingSeparatorTxt(node, state.rtTesting);
				if (sepTxt !== null) {
					dsrB = node.parentNode.data.parsoid.dsr;
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
					(!node.data ||
					!node.data.parsoid.dsr ||
					node.data.parsoid.dsr[0] === null ||
					node.data.parsoid.dsr[1] === null))
				{
					node = node.parentNode;
				}
			}

			if (node.data && node.data.parsoid) {
				dsrB = node.data.parsoid.dsr;
			}
		}

		// Do not use '!== null' checks on dsr elts since it appears that they can
		// sometimes be NaN/undefined because of arithmetic done above.  This then
		// leads to the 'dsr backwards' error.
		//
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
				console.error('dsr backwards: should not happen!');
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

	// Verify that the separator is really one.
	// It cannot be anything but whitespace and comments.
	if (sep === undefined ||
		!isValidSep(sep) ||
		(state.sep.src && state.sep.src !== sep))
	{
		if (state.sep.constraints) {
			// TODO: set modified flag if start or end node (but not both) are
			// modified / new so that the selser can use the separator
			sep = this.makeSeparator(state.sep.src || '',
						origNode,
						state.sep.constraints,
						state);
		} else if (state.sep.src) {
			//sep = state.sep.src;
			// Strip whitespace from the last line
			sep = this.makeSeparator(state.sep.src,
						origNode,
						{a:{},b:{}, max:0},
						state);
		} else {
			sep = undefined;
		}
	}

	if (sep !== undefined) {
		state.emitSep(sep, origNode, cb, 'SEP:');
	}
};

WSP._getPrevSeparatorElement = function (node, state) {
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
			// Load always, even for ignored nodes
			DU.loadDataParsoid(node);

			// Ignore DiffMarker metas, but clear unmodified node state
			if (DU.isMarkerMeta(node, "mw:DiffMarker")) {
				state.prevNodeUnmodified = state.currNodeUnmodified;
				state.currNodeUnmodified = false;
				return node;
			}

			if (state.selserMode) {
				this.trace("NODE: ", node.nodeName,
					"; prev-flag: ", state.prevNodeUnmodified,
					"; curr-flag: ", state.currNodeUnmodified);
			}

			var dp = node.data.parsoid;
			dp.dsr = dp.dsr || [];

			// Update separator constraints
			prev = this._getPrevSeparatorElement(node, state);
			var domHandler = this._getDOMHandler(node, state, cb);
			if (prev) {
				this.updateSeparatorConstraints(state,
						prev,  this._getDOMHandler(prev, state, cb),
						node,  domHandler);
			}

			var handled = false;

			// WTS should not be in a subtree with a modification flag that applies
			// to every node of a subtree (rather than an indication that some node
			// in the subtree is modified).
			if (state.selserMode && !state.inModifiedContent) {
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
				if (dp && isValidDSR(dp.dsr) &&
					(dp.dsr[1] > dp.dsr[0]) &&
					!DU.hasCurrentDiffMark(node, this.env)) {
					// Strip leading/trailing separators *ONLY IF* the previous/following
					// node will go through non-selser serialization.
					var src = state.getOrigSrc(dp.dsr[0], dp.dsr[1]),
						stripLeading = !DU.isIndentPre(node) && DU.hasCurrentDiffMark(node.previousSibling, this.env),
						stripTrailing = DU.hasCurrentDiffMark(node.nextSibling, this.env),
						leadingSepMatch = stripLeading ? src.match(/^((?:\s|<!--([^\-]|-(?!->))*-->)+)/) : null,
						trailingSepMatch = stripTrailing ? src.match(/((?:\s|<!--([^\-]|-(?!->))*-->)+)$/) : null,
						out = src,
						newSep = '',
						offset = 0;

					if (leadingSepMatch) {
						state.sep.src = (state.sep.src || '') + leadingSepMatch[0];
						offset = leadingSepMatch[0].length;
						out = out.substring(offset);
						dp.dsr[0] += offset;
					}
					if (trailingSepMatch) {
						newSep = trailingSepMatch[0];
						out = out.substring(0, trailingSepMatch.index - offset);
						dp.dsr[1] -= trailingSepMatch.index;
					}

					state.currNodeUnmodified = true;

					// console.warn("USED ORIG");
					this.trace("ORIG-src:", src, '; out:', out);
					cb(out, node);
					handled = true;

					state.sep.src = (state.sep.src || '') + newSep;

					// Skip over encapsulated content since it has already been serialized
					var typeOf = node.getAttribute( 'typeof' ) || '';
					if (/\bmw:(?:Transclusion\b|Param\b|Extension\/[^\s]+)/.test(typeOf)) {
						nextNode = this.skipOverEncapsulatedContent(node);
					}
				}
			}

			if ( !handled ) {
				state.prevNodeUnmodified = state.currNodeUnmodified;
				state.currNodeUnmodified = false;
				if (state.selserMode && DU.hasInsertedOrModifiedDiffMark(node, this.env)) {
					state.inModifiedContent = true;
				}
				// console.warn("USED NEW");
				if ( domHandler && domHandler.handle ) {
					// DOM-based serialization
					try {
						nextNode = domHandler.handle(node, state, cb);
					} catch(e) {
						console.error(e.stack || e.toString());
						console.error(node.nodeName, domHandler);
					}
					// The handler is responsible for serializing its children
				} else {
					// Used to be token-based serialization
					console.error('No dom handler found for', node.outerHTML);
				}
				state.inModifiedContent = false;
			}

			// Update end separator constraints
			if (node && node.nodeType === node.ELEMENT_NODE) {
				next = this._getNextSeparatorElement(node);
				if (next) {
					this.updateSeparatorConstraints(state,
							node, domHandler,
							next, this._getDOMHandler(next, state, cb));
				}
			}

			break;
		case node.TEXT_NODE:
			if (!this.handleSeparatorText(node, state)) {
				// Text is not just whitespace
				prev = this._getPrevSeparatorElement(node, state);
				if (prev) {
					this.updateSeparatorConstraints(state,
							prev,  this._getDOMHandler(prev, state, cb),
							node,  {});
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
			// delay the newline creation until after the comment
			if (!this.handleSeparatorText(node, state)) {
				cb(commentWT(node.nodeValue), node);
			}
			break;
		default:
			console.warn( "Unhandled node type: " +
					node.outerHTML );
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

		// collect tpl attr tags
		this.extractTemplatedAttributes(body, state);

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

		var out = [];
	    if ( ! chunkCB ) {
			state.chunkCB = chunkCBWrapper.bind(null, function ( chunk ) {
				out.push(chunk);
			});
		} else {
			state.chunkCB = chunkCBWrapper.bind(null, chunkCB);
		}

		state.sep.lastSourceNode = body;
		state.currLine.firstNode = body.firstChild;
		if (body.nodeName !== 'BODY') {
			// FIXME: Do we need this fallback at all?
			this._serializeNode( body, state );
		} else {
			DU.loadDataParsoid(body);
			state.serializeChildren(body, state.chunkCB);
		}

		// Handle EOF
		//this.emitSeparator(state, state.chunkCB, body);
		state.chunkCB( '', body );

		if ( finalCB && typeof finalCB === 'function' ) {
			finalCB();
		}

		return chunkCB ? '' : out.join('');
	} catch (e) {
		console.warn("Error in serializeDOM: " + JSON.stringify(e) + "; stack: " + e.stack);
		console.warn(e.toString());
		state.env.errCB(e);
		throw e;
	}
};

if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
