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

function previousNonSepSibling (node) {
	var prev = node.previousSibling;
	while (prev && (prev.nodeType === node.COMMENT_NODE || DU.isIEW(prev))) {
		prev = prev.previousSibling;
	}
	return prev;
}

function nextNonSepSibling (node) {
	var next = node.nextSibling;
	while (next && (next.nodeType === node.COMMENT_NODE || DU.isIEW(next))) {
		next = next.nextSibling;
	}
	return next;
}

var WikitextEscapeHandlers = function() { };

var WEHP = WikitextEscapeHandlers.prototype;

WEHP.urlParser = new PegTokenizer();

WEHP.headingHandler = function(state, text) {
	// replace heading-handler with the default handler
	// only "=" at the extremities trigger escaping

	if (state.currLine && !state.currLine.seen) {
		var line = state.currLine.text,
			len  = line ? line.length : 0;
		return (line && len > 2 && (line[0] === '=') && (line[len-1] === '='));
	} else {
		return false;
	}
};

WEHP.liHandler = function(state, text) {
	// replace li-handler with the default handler
	// only bullets at the beginning of the list trigger escaping
	if (state.currLine && !state.currLine.seen) {
		return text.match(/^[#\*:;]/);
	} else {
		return false;
	}
};

WEHP.linkHandler = function(state, text) {
	return text.match(/\]|\[.*?\]/);
};

WEHP.quoteHandler = function(state, text) {
	// SSS FIXME: Can be refined
	return text.match(/^'|'$/);
};

WEHP.thHandler = function(state, text) {
	return text.match(/!!/);
};

WEHP.wikilinkHandler = function(state, text) {
	return text.match(/^\||\]$/);
};

WEHP.aHandler = function(state, text) {
	return text.match(/\]$/);
};

WEHP.tdHandler = function(state, text) {
		return text.match(/\|/) ||
			(state.currLine && !state.currLine.seen && text.match(/^[\-+]/) &&
			!state.inWideTD);
		// &&
		//isTd(tok) &&
		//(!tok.dataAttribs.dsr || tok.dataAttribs.dsr[2] === 1) &&
		//tok.dataAttribs.stx_v !== 'row' &&
		//tok.attribs.length === 0);
};

WEHP.hasWikitextTokens = function ( state, onNewline, text, linksOnly ) {
	// console.warn("---EWT:DBG0---");
	// console.warn("---HWT---:onl:" + onNewline + ":" + text);
	// tokenize the text

	// this is synchronous for now, will still need sync version later, or
	// alternatively make text processing in the serializer async

	var prefixedText = text;
	if (!onNewline) {
		// Prefix '_' so that no start-of-line wiki syntax matches.
		// Later, strip it from the result.
		// Ex: Consider the DOM:  <ul><li> foo</li></ul>
		// We don't want ' foo' to be converted to a <pre>foo</pre>
		// because of the leading space.
		prefixedText = '_' + text;
	}

	if ( state.inIndentPre || state.inPHPBlock ) {
		prefixedText = prefixedText.replace(/(\r?\n)/g, '$1_');
	}

	var p = new PegTokenizer( state.env ), tokens = [];
	p.on('chunk', function ( chunk ) {
		// Avoid a stack overflow if chunk is large, but still update token
		// in-place
		for ( var ci = 0, l = chunk.length; ci < l; ci++ ) {
			tokens.push(chunk[ci]);
		}
	});
	p.on('end', function(){ });

	// The code below will break if use async tokenization.
	p.processSync( prefixedText );

	// If the token stream has a pd.TagTk, pd.SelfclosingTagTk, pd.EndTagTk or pd.CommentTk
	// then this text needs escaping!
	var tagWhiteList = getTagWhiteList();
	var numEntities = 0;
	for (var i = 0, n = tokens.length; i < n; i++) {
		var t = tokens[i];

		// Ignore non-whitelisted html tags
		if (t.isHTMLTag() && !tagWhiteList[t.name.toLowerCase()]) {
			continue;
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

		if (!linksOnly && tc === pd.TagTk) {
			// mw:Entity tokens
			if (t.name === 'span' && t.getAttribute('typeof') === 'mw:Entity') {
				numEntities++;
				continue;
			}

			return true;
		}

		if (!linksOnly && tc === pd.EndTagTk) {
			// mw:Entity tokens
			if (numEntities > 0 && t.name === 'span') {
				numEntities--;
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
	this.options = Util.extendProps( {
		// defaults
	}, options || {} );

	this.env = options.env;
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
};

var WSP = WikitextSerializer.prototype;

/* *********************************************************************
 * Here is what the state attributes mean:
 *
 * sep
 *    Separator information:
 *    - constraints: min/max number of newlines
 *    - text: collected separator text from DOM text/comment nodes
 *    - lastSourceNode: -- to be documented --
 *
 * singleLineMode
 *    - if (> 0), we cannot emit any newlines.
 *    - this value changes as we entire/exit dom subtrees that require
 *      single-line wikitext output. WSP._tagHandlers specify single-line
 *      mode for individual tags.
 *
 * wteHandlerStack
 *    stack of wikitext escaping handlers -- these handlers are responsible
 *    for smart escaping when the surrounding wikitext context is known.
 *
 * tplAttrs
 *    tag attributes that came from templates in source wikitext -- these
 *    are collected upfront from the DOM from mw-marked nodes.
 *
 * currLine
 *    This object is used by the wikitext escaping algorithm -- represents
 *    a "single line" of output wikitext as represented by a block node in
 *    the DOM.
 *
 *    - seen           : -- to be documented --
 *    - ancestor       : -- to be documented --
 *    - text           : accumulated text from all text nodes on the current line
 *    - processed      : have we analyzed the text so far?
 *    - hasBracketPair : does the line have bracket wikitext token pairs?
 *    - hasHeadingPair : does the line have heading wikitext token pairs?
 * ********************************************************************* */

WSP.initialState = {
	// TODO: default to false for anything that could involve edits to the DOM
	rtTesting: true,
	sep: {},
	atStartOfOutput: true,
	inIndentPre: false,
	inPHPBlock: false,
	singleLineMode: 0,
	wteHandlerStack: [],
	tplAttrs: {},
	// XXX: replace with DOM handler?
	currLine: {
		text: null,
		seen: false,
		processed: false,
		hasBracketPair: false,
		hasHeadingPair: false
	},
	selser: {
		serializeInfo: null
	},

	/////////////////////////////////////////////////////////////////
	// End of state
	/////////////////////////////////////////////////////////////////
	resetCurrLine: function () {
		this.currLine = {
			text: null,
			seen: false,
			processed: false,
			hasBracketPair: false,
			hasHeadingPair: false
		};
	},

	// Serialize the children of a DOM node, sharing the global serializer
	// state. Typically called by a DOM-based handler to continue handling its
	// children.
	serializeChildren: function(node, chunkCB, wtEscaper, forceSep) {
		var oldCB = this.chunkCB,
			oldSep = this.sep,
			children = node.childNodes,
			child = children[0],
			nextChild;

		this.chunkCB = chunkCB;
		if ( wtEscaper ) {
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

		if (forceSep && oldSep === this.sep) {
			// Force separator out
			if (children.length) {
				chunkCB('', children.last());
			} else {
				chunkCB('', {nodeName: 'fooobar'});
			}
		}

		this.chunkCB = oldCB;
		if ( wtEscaper ) {
			this.wteHandlerStack.pop();
		}
	},

	/**
	 * Serialize children to a string. Assumes non-start-of-line context and
	 * does not affect the separator state.
	 */
	serializeChildrenToString: function(node, wtEscaper) {
		// FIXME: Make sure that the separators emitted here conform to the
		// syntactic constraints of syntactic context.
		var bits = [],
			sepState = this.sep,
			self = this,
			cb = function(res, node) {
				if(res) {
					self.serializer.emitSeparator(self, function(sep) { bits.push(sep); }, node);
				}
				self.sep.lastSourceNode = node;
				self.sep.lastSourceSep = self.sep.src;
				bits.push(res);
			};
		this.sep = {};
		this.serializeChildren(node, cb, wtEscaper);
		self.serializer.emitSeparator(this, cb, node);
		// restore the separator state
		this.sep = sepState;
		return bits.join('');
	}
};

// Make sure the initialState is never modified
Util.deepFreeze( WSP.initialState );

var openHeading = function(v) {
	return function( state ) {
		return v;
	};
};

var closeHeading = function(v) {
	return function(state, token) {
		var prevToken = state.prevToken;
		// Deal with empty headings. Ex: <h1></h1>
		if (prevToken.constructor === pd.TagTk && prevToken.name === token.name) {
			return "<nowiki></nowiki>" + v;
		} else {
			return v;
		}
	};
};


function escapedText(text) {
	var match = text.match(/^((?:.*?|[\r\n]+[^\r\n]|[~]{3,5})*?)((?:\r?\n)*)$/);
	return ["<nowiki>", match[1], "</nowiki>", match[2]].join('');
}

WSP.escapeWikiText = function ( state, text ) {
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
		state.currLine.seen = true;
		return text;
	}

	// Context-specific escape handler
	var wteHandler = state.wteHandlerStack.last();
	if (wteHandler && wteHandler(state,text)) {
		// console.warn("---EWT:F2---");
		state.currLine.seen = true;
		return escapedText(text);
	}
	state.currLine.seen = true;

	// Template and template-arg markers are escaped unconditionally!
	// Conditional escaping requires matching brace pairs and knowledge
	// of whether we are in template arg context or not.
	if (text.match(/\{\{\{|\{\{|\}\}\}|\}\}/)) {
		// console.warn("---EWT:F3---");
		return escapedText(text);
	}

	var nlSep = state.sep.src && state.sep.src.match(/\n$/) !== null,
		pendingNewline = (state.sep.constraints && state.sep.constraints.min > 0) ||
			// No constraints, but a separator ending in a newline
			( !state.sep.constraints && nlSep ),
		noIndentSepSrc = !state.sep.src ||
				!state.sep.src.replace(/<!--(?:[^\-]|-(?!->))*-->/g, '') ||
				state.sep.src.replace(/<!--(?:[^\-]|-(?!->))*-->/g, '').match(/\n$/);

	var sol = (pendingNewline ||
			(state.atStartOfOutput && noIndentSepSrc)) &&
				// Newlines will be emitted if required
			!state.inIndentPre &&
			!state.inPHPBlock &&
			!wteHandler,
		hasNewlines = text.match(/\n./),
		hasTildes = text.match(/~{3,5}/);
	this.trace('sol', sol, {inphp: state.inPHPBlock, inPre: state.inIndentPre},
			state.sep.constraints, state.sep.src, text);

	if (!fullCheckNeeded && !hasNewlines && !hasTildes) {
		// {{, {{{, }}}, }} are handled above.
		// Test 1: '', [], <> need escaping wherever they occur
		// Test 2: {|, |}, ||, |-, |+,  , *#:;, ----, =*= need escaping only in SOL context.
		if (!sol && !text.match(/''|[<>]|\[.*\]|\]/)) {
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
	if (this.wteHandlers.hasWikitextTokens(state, sol, text) || hasTildes) {
		// console.warn("---EWT:DBG1---");
		return escapedText(text);
	} else if (state.currLine.numPieces > 1) {
		// console.warn("---EWT:DBG2---");
		// Last resort -- process current line text ignoring all embedded tags
		// If it has wikitext tokens, we escape conservatively
		var cl = state.currLine;
		if (!cl.processed) {
			/* --------------------------------------------------------
			 * Links and headings are the only single-line paired-token
			 * wikitext-constructs  that can be split by html tags
			 *
			 * Links occur anywhere on a line.
			 *
			 *    Ex 1: .. [[ .. <i>..... ]] .. </i> ..
			 *    Ex 2: .. [[ .. <i>..... </i> .. ]] ..
			 *
			 * Headings are constrained to be on the extremities
			 *
			 *    Ex: = ... <i> ... </i> .. =
			 *
			 * So no need to tokenize -- just check for these patterns
			 *
			 * NOTE: [[[ ... ]]] does not need escaping, it appears.
			 * So, the regexp checks for 1 or 2 of those.
			 * -------------------------------------------------------- */
			cl.processed = true;
			cl.hasHeadingPair = cl.text.match(/^=.*=\n*$/);
			if (this.wteHandlers.hasWikitextTokens(state, sol, cl.text, true)) {
				cl.hasBracketPair = true;
			}
		}

		// If the current line has a wikitext token pair, and the current
		// piece of text has one of the pairs ^=,],]], assume the worst and escape it.
		// NOTE: It is sufficient to escape just one of the pairs.
		if ((cl.hasHeadingPair && text.match(/^=/)) ||
			(cl.hasBracketPair && text.match(/(\]\]?)([^\]]|$)/)))
		{
			return escapedText(text);
		} else {
			return text;
		}
	} else {
		// console.warn("---EWT:DBG3---");
		return text;
	}
};


/**
 * DOM-based figure handler
 */
WSP.figureHandler = function(node, state, cb) {

	var img, caption,
		dp = node.data.parsoid,
		env = state.env;
	try {
		img = node.firstChild.firstChild;
		if ( img.nodeType !== img.ELEMENT_NODE ) {
			throw('No img found!');
		}

		caption = node.lastChild;
	} catch (e) {
		console.error('ERROR in figureHandler: no img or caption found!');
		return cb('', node);
	}

	// Captions dont start on a new line
	//
	// So, even though the figure might be in a sol-state, serialize the
	// caption in a no-sol state and restore old state.  This is required
	// to prevent spurious wikitext escaping for this example:
	//
	// [[File:foo.jpg|thumb| bar]] ==> [[File:foo.jpg|thumb|<nowiki> bar</nowiki>]]
	//
	// In sol state, text " bar" should be nowiki escaped to prevent it from
	// parsing to an indent-pre.  But, not in figure captions.

	// XXX: don't use serializeChildrenToString here as that messes up the
	// global separator state?
	var captionSrc;
	captionSrc = state.serializeChildrenToString(caption, this.wteHandlers.aHandler);

	var imgResource = (img && img.getAttribute('resource') || '').replace(/(^\[:)|(\]$)/g, ''),
		outBits = [imgResource],
		figAttrs = dp.optionList,
		optNames = dp.optNames,
		simpleImgOptions = WikitextConstants.Image.SimpleOptions,
		prefixImgOptionsRM = WikitextConstants.Image.PrefixOptionsReverseMap,
		sizeOptions = {"width": 1, "height": 1},
		size = { width: null };

	for (var i = 0, n = figAttrs.length; i < n; i++) {
		// figAttr keys are the parsoid 'group' for the property,
		// as given by the *values* in the WikitextConstants.Image
		// maps. figAttr values are either "short canonical" property
		// names (see WikiLinkHandler.renderFile) or the literal
		// value (for prefix properties)
		// both sides are not localized; the localized version will
		// be found in the optNames map, which maps short canonical
		// names to the localized string.
		var a = figAttrs[i],
			k = a.k, v = a.v;
		var shortCanonical;
		if (sizeOptions[k]) {
			// Since width and height have to be output as a pair,
			// collect both of them.
			size[k] = v;
		} else {
			// If we have width set, it got set in the most recent iteration
			// Output height and width now (one iteration later).
			var w = size.width;
			if (w!==null) {
				outBits.push(w + (size.height ? "x" + size.height : '') + "px");
				size.width = null;
			}

			if (k === "caption") {
				outBits.push(v === null ? captionSrc : v);
			} else if ( prefixImgOptionsRM[k] ) {
				var canonical = prefixImgOptionsRM[k];
				shortCanonical = canonical.replace(/^img_/,'');
				outBits.push( env.conf.wiki.replaceInterpolatedMagicWord( optNames[shortCanonical], v ) );
			} else if (simpleImgOptions['img_'+v] === k) {
				shortCanonical = v;
				// The values and keys in the parser attributes are a flip
				// of how they are in the wikitext constants image hash
				// Hence the indexing by 'v' instead of 'k'
				outBits.push(optNames[shortCanonical]);
			} else {
				console.warn("Unknown image option encountered: " + JSON.stringify(a));
			}
		}
	}

	// Handle case when size is the last element which has accumulated
	// in the size object.  Since size attribute is output one iteration
	// after which it showed up, we have to handle this specially when
	// size is the last element of the figAttrs array.  An alternative fix
	// for this edge case is to fix the parser to not split up height
	// and width into different attrs.
	if (size.width) {
		outBits.push(size.width + (size.height ? "x" + size.height : '') + "px");
	}

	cb( "[[" + outBits.join('|') + "]]", node );
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
var getLinkRoundTripData = function( node, state ) {
	var tplAttrs = state.tplAttrs,
		dp = node.data.parsoid,
		attribs = node.attributes;
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

	// Get the content string or tokens
	var contentParts;
	if (node.childNodes.length >= 1 && DU.allChildrenAreText(node)) {
		var contentString = node.textContent;
		if ( ! rtData.target.modified && rtData.tail &&
				contentString.substr(- rtData.tail.length) === rtData.tail ) {
			rtData.content.string = Util.stripSuffix( contentString, rtData.tail );
		} else if (rtData.target.string && rtData.target.string !== contentString) {
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
	}

	return rtData;
};


function escapeWikiLinkContentString ( contentString, state ) {
	// Wikitext-escape content.
	//
	// When processing link text, we are no longer in newline state
	// since that will be preceded by "[[" or "[" text in target wikitext.
	state.wteHandlerStack.push(state.serializer.wteHandlers.wikilinkHandler);
	var res = state.serializer.escapeWikiText(state, contentString);
	state.wteHandlerStack.pop();
	return res;
}

// SSS FIXME: This doesn't deal with auto-inserted start/end tags.
// To handle that, we have to split every 'return ...' statement into
// openTagSrc = ...; endTagSrc = ...; and at the end of the function,
// check for autoInsertedStart and autoInsertedEnd attributes and
// supress openTagSrc or endTagSrc appropriately.
WSP.linkHandler = function(node, state, cb) {
	//return '[[';
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
	linkData = getLinkRoundTripData(node, state);


	if ( linkData.type !== null && linkData.target.value !== null  ) {
		// We have a type and target info

		var target = linkData.target;

		if (linkData.type.match(/^mw:WikiLink(\/(Category|Language|Interwiki))?$/)) {
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

			// figure out if we need a piped or simple link
			var canUseSimple =  // Would need to pipe for any non-string content
								linkData.content.string !== undefined &&
								// See if the (normalized) content matches the
								// target, either shadowed or actual.
								(	linkData.content.string === target.value ||
									linkData.content.string === linkData.href ||
									// normalize without underscores for comparison with target.value
									env.normalizeTitle( linkData.content.string, true ) ===
										Util.decodeURI( target.value ) ||
									// normalize with underscores for comparison with href
									env.normalizeTitle( linkData.content.string ) ===
										Util.decodeURI( linkData.href ) ||
									linkData.href === linkData.content.string ) &&
								// but preserve non-minimal piped links
								! ( ! target.modified &&
										( dp.stx === 'piped' || dp.pipetrick ) ),
				canUsePipeTrick = linkData.content.string !== undefined &&
					linkData.type !== 'mw:WikiLink/Category' &&
					(
						Util.stripPipeTrickChars(target.value) ===
							linkData.content.string ||
						Util.stripPipeTrickChars(linkData.href) ===
							linkData.content.string ||
						env.normalizeTitle(Util.stripPipeTrickChars(
								Util.decodeURI(target.value))) ===
							env.normalizeTitle(linkData.content.string) ||
						env.normalizeTitle(
							Util.stripPipeTrickChars(Util.decodeURI(linkData.href))) ===
							env.normalizeTitle(linkData.content.string)
						// XXX: try more pairs similar to the canUseSimple
						// test above?
					),
				// Only preserve pipe trick instances across edits, but don't
				// introduce new ones.
				willUsePipeTrick = canUsePipeTrick && dp.pipetrick;
			//console.log(linkData.content.string, canUsePipeTrick);

			if ( canUseSimple ) {
				// Simple case
				if ( ! target.modified ) {
					cb( linkData.prefix + '[[' + target.value + ']]' + linkData.tail, node );
					return;
				} else {
					contentSrc = escapeWikiLinkContentString(linkData.content.string, state);
					cb( linkData.prefix + '[[' + contentSrc + ']]' + linkData.tail, node );
					return;
				}
			} else {

				// First get the content source
				if ( linkData.contentNode ) {
					contentSrc = state.serializeChildrenToString(
							linkData.contentNode,
							this.wteHandlers.wikilinkHandler);
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

				cb( linkData.prefix + '[[' + linkData.target.value + '|' + contentSrc + ']]' + linkData.tail, node );
				return;
			}
		} else if ( rel === 'mw:ExtLink' ) {
			if ( target.modified ) {
				// encodeURI only encodes spaces and the like
				target.value = encodeURI(target.value);
			}

			cb( '[' + target.value + ' ' +
				state.serializeChildrenToString(node, this.wteHandlers.aHandler) +
				']', node );
		} else if ( rel.match( /mw:ExtLink\/(?:ISBN|RFC|PMID)/ ) ) {
			cb( node.firstChild.nodeValue, node );
		} else if ( rel === 'mw:ExtLink/URL' ) {
			cb( linkData.target.value, node );
		} else if ( rel === 'mw:ExtLink/Numbered' ) {
			// XXX: Use shadowed href? Storing serialized tokens in
			// data-parsoid seems to be... wrong.
			cb( '[' + Util.tokensToString(linkData.target.value) + ']', node);
		} else if ( rel === 'mw:Image' ) {
			// simple source-based round-tripping for now..
			// TODO: properly implement!
			if ( dp.src ) {
				cb( dp.src, node );
			}
		} else {
			// Unknown rel was set
			//this._htmlElementHandler(node, state, cb);
			if ( target.modified ) {
				// encodeURI only encodes spaces and the like
				target.value = encodeURI(target.value);
			}
			cb( '[' + target.value + ' ' +
				state.serializeChildrenToString(node, this.wteHandlers.aHandler) +
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
				state.serializeChildrenToString(node, this.wteHandlers.aHandler) +
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
				state.serializeChildren(node, cb, state.serializer.wteHandlers.headingHandler);
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

// XXX refactor: move to dedicated template handler that consumes siblings
//		if (state.activeTemplateId &&
//			state.activeTemplateId === node.getAttribute("about"))
//		{
//			// skip -- template content
//			return;
//		} else {
//			state.activeTemplateId = null;
//		}
//
//		if (!state.activeTemplateId) {
//			// Check if this node marks the start of template output
//			// NOTE: Since we are deleting all mw:Object/**/End markers,
//			// we need not verify if it is an End marker
//			var typeofVal = node.getAttribute("typeof");
//			if (typeofVal && typeofVal.match(/\bmw:Object(\/[^\s]+|\b)/)) {
//				state.activeTemplateId = node.getAttribute("about") || "";
//				var attrs = [ new pd.KV("typeof", "mw:TemplateSource") ];
//				var dps = node.getAttribute("data-parsoid-serialize");
//				if (dps) {
//					attrs.push(new pd.KV("data-parsoid-serialize", dps));
//				}
//				var dummyToken = new pd.SelfclosingTagTk("meta",
//					attrs,
//					{ src: this._getDOMRTInfo(node).src }
//				);
//
//				if ( dps ) {
//					state.selser.serializeInfo = dps;
//				}
//				this._serializeToken(state, dummyToken);
//				return;
//			}
//		}
//	} else if (node.nodeType !== node.COMMENT_NODE) {
//		state.activeTemplateId = null;
//	}
//


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
	},
	res = '';
	var nodeName = node.nodeName.toLowerCase();
	while (nodeName in listTypes && node.data.parsoid.stx !== 'html') {
		res = listTypes[nodeName] + res;
		node = node.parentNode;
		nodeName = node.nodeName.toLowerCase();
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
	var nextSibling = nextNonSepSibling(node);
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
	} else {
		return {min:1, max:2};
	}
}

function buildListHandler(firstChildNames) {
	return {
		handle: function (node, state, cb) {
			var firstChildElement = DU.getFirstNonSepChildNode(node);
			if (!firstChildElement || ! (firstChildElement.nodeName in firstChildNames))
			{
				cb(state.serializer._getListBullets(node), node);
			}
			// Just serialize the children, ignore the (implicit) tbody
			state.serializeChildren(node, cb, state.serializer.wteHandlers.liHandler, true);
		},
		sepnls: {
			before: function (node, otherNode) {
				if (otherNode.nodeType === node.TEXT_NODE && DU.isListElt(node.parentNode)) {
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
			var firstChildElement = DU.getFirstNonSepChildNode(node),
				forceSep = false;
			if (!DU.isList(firstChildElement)) {
				cb(state.serializer._getListBullets(node), node);
				forceSep = true;
			}
			state.serializeChildren(node, cb, state.serializer.wteHandlers.liHandler, forceSep);
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
			var firstChildElement = DU.getFirstNonSepChildNode(node);
			if (!DU.isList(firstChildElement)) {
				cb(state.serializer._getListBullets(node), node);
			}
			state.serializeChildren(node, cb, state.serializer.wteHandlers.liHandler);
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
			var firstChildElement = DU.getFirstNonSepChildNode(node),
				forceSep = false;
			if (!DU.isList(firstChildElement)) {
				// XXX: handle stx: row
				if (node.data.parsoid.stx === 'row') {
					cb(':', node);
				} else {
					cb(state.serializer._getListBullets(node), node);
				}
				forceSep = true;
			}
			state.serializeChildren(node, cb, state.serializer.wteHandlers.liHandler, forceSep);
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
			state.resetCurrLine();
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

			// Hackhackhack: Avoid an indent-pre
			if (state.sep.src && state.sep.src.match(/[ \t]$/)) {
				state.sep.src = state.sep.src.replace(/[ \t]+$/, '');
			}
			state.serializeChildren(node, cb, null, true);
		},
		sepnls: {
			before: function(node, otherNode) {
				var nodeName = otherNode.nodeName.toLowerCase();
				if( node.parentNode === otherNode &&
						isListElementName(nodeName) || nodeName in {td:1, body:1} )
				{
					if (nodeName in {td:1, body:1}) {
						return {min: 0, max: 1};
					} else {
						return {min: 0, max:0};
					}
				} else if (otherNode === node.previousSibling &&
						// p-p transition
						nodeName === 'p' ||
						// Treat text/p similar to p/p transition
						// XXX: also check if parent node and first sibling
						// serializes(|d) to single line.
						// Only a single line is
						// needed in that case. Example:
						// <div>foo</div> a
						// b
						((nodeName === '#text' &&
						  otherNode === previousNonSepSibling(node) &&
						  // FIXME HACK: Avoid forcing two newlines if the
						  // first line is a text node that ends up on the
						  // same line as a block
						  !( DU.isBlockNode(node.parentNode) ||
								otherNode.nodeValue.match(/\n(?!$)/)))))
				{
					return {min:2, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: function(node, otherNode) {
				return !(node.lastChild && node.lastChild.nodeName === 'BR') &&
					otherNode.nodeName === 'P'/* || otherNode.nodeType === node.TEXT_NODE*/ ?
					{min: 2, max: 2} : {min: 1, max: 2};
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
				if (fc.nodeType === node.TEXT_NODE) {
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

			if ( type ) {
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
			} else if ( property ) {
				var switchType = property.match( /^mw\:PageProp\/(.*)$/ );
				if ( switchType ) {
					switchType = switchType[1];
					if ( node.data.parsoid.magicSrc ) {
						switchType = node.data.parsoid.magicSrc;
					}
					cb(switchType, node);
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
				var type = node.getAttribute('typeof');
				if (type && type.match(/mw:Includes\//)) {
					return {max:0};
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
							if(child.nodeType === node.ELEMENT_NODE) {
								if (child.nodeName === 'SPAN' &&
										child.getAttribute('typeof') === 'mw:Entity')
								{
									state.serializer._serializeNode(child, state, cb);
								} else {
									cb(child.outerHTML, node);
								}
							} else if (child.nodeType === node.TEXT_NODE) {
								cb(child.nodeValue.replace(/<(\/?nowiki)>/g, '&lt;$1&gt;'), child);
							} else {
								state.serializer._serializeNode(child, state, cb);
							}
							child = child.nextSibling;
						}
					}
					emitEndTag('</nowiki>', node, state, cb);
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
			console.warn("state.tplAttrs: " + JSON.stringify(state.tplAttrs));
			console.warn("about: " + JSON.stringify(token.getAttribute("about")));
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
	var attribKVs = DU.getAttributeKVArray(node);

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

/**
 * Get a DOM-based handler for an element node
 */
WSP._getDOMHandler = function(node, state, cb) {
	var self = this;

	if (!node || node.nodeType !== node.ELEMENT_NODE) {
		return {};
	}

	DU.loadDataParsoid(node);
	DU.loadDataAttrib(node, 'parsoid-serialize', {});

	var dp = node.data.parsoid,
		nodeName = node.nodeName.toLowerCase(),
		handler,
		nodeTypeOf = node.getAttribute( 'typeof' ) || '';

//	if (state.activeTemplateId) {
//		if(node.getAttribute('about') === state.activeTemplateId) {
//			// Skip template content
//			return function(){};
//		} else {
//			state.activeTemplateId = null;
//		}
//	} else {
//		if (nodeTypeOf && nodeTypeOf.match(/\bmw:Object(\/[^\s]+|\b)/)) {
//			state.activeTemplateId = node.getAttribute('about' || null);
//
//

	// XXX: Handle siblings directly in a template content handler returning
	// the next node?
	if (state.activeTemplateId && node.getAttribute('about') === state.activeTemplateId) {
		// Ignore subsequent template content
		return {handle: function() {}};
	}

	// XXX: Convert into separate handlers?
	if ( dp.src !== undefined ) {
		//console.log(node.parentNode.outerHTML);
		if (nodeTypeOf && nodeTypeOf.match(/\bmw:Object(\/[^\s]+|\b)/)) {
			// Source-based template/extension round-tripping for now
			return {
				handle: function () {
					state.activeTemplateId = node.getAttribute('about') || null;
					self.emitWikitext(dp.src, state, cb, node);
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
		} else if (nodeTypeOf === "mw:Placeholder") {
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
		} else if (nodeTypeOf === "mw:Entity") {
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
	if (nodeName === 'span' && nodeTypeOf === 'mw:Image') {
		// Hack: forward this span to DOM-based link handler until the span
		// handler is fully DOM-based.

		// Fake regular link attributes
		// Set rel in addition to typeof
		node.setAttribute('rel', 'mw:Image');
		// And set an empty href, so that
		node.setAttribute('href', '');
		return self.tagHandlers.a || null;
	}

	if (dp.stx === 'html' ||
			( node.getAttribute('data-parsoid') === null &&
			  // SSS FIXME: if we get to the root, it wont have a parent
			  // But, why are we getting to the root?
			  nodeName !== 'meta' && node.parentNode &&
			  node.parentNode.data &&
			  node.parentNode.data.parsoid.stx === 'html' ) )
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
	// If not in nowiki and pre context, also escape wikitext
	// XXX refactor: Handle this with escape handlers instead!
	res = ( state.inNoWiki || state.inHTMLPre ) ? res
		: this.escapeWikiText( state, res );

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
	var isOnlyChild = !node.previousSibling && !node.nextSibling;
	if (!isOnlyChild) {
		if (node.nodeType === node.TEXT_NODE) {
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
	} else if (node.nodeValue.match(/^\n+/)) {
		state.sep.src = (state.sep.src || '') + node.nodeValue.match(/^\n+/)[0];
		//if (!state.sep.lastSourceNode) {
		//	// FIXME: Actually set lastSourceNode when the source is
		//	// emitted / emitSeparator is called!
		//	//state.sep.lastSourceNode = node.previousSibling || node.parentNode;
		//}
		return false;
	} else {
		// not a separator between elements
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
		var about = DU.isElt(node) ? node.getAttribute("about") || "" : "";
		var child = node.firstChild;
		var next, prev, childIsPre, str;

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
 * Helper for handleSeparator
 *
 * Collects, checks and integrates separator newline requirements to a sinple
 * min, max structure.
 */
WSP.getSepNlConstraints = function(nodeA, sepNlsHandlerA, nodeB, sepNlsHandlerB) {
	var nlConstraints = { a:{}, b:{} }, bc;
	if(sepNlsHandlerA) {
		nlConstraints.a = sepNlsHandlerA(nodeA, nodeB);
		nlConstraints.min = nlConstraints.a.min;
		nlConstraints.max = nlConstraints.a.max;
	} else {
		// Anything more than two lines will trigger paragraphs, so default to
		// two if nothing is specified.
		nlConstraints.max = 2;
	}

	if(sepNlsHandlerB) {
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
WSP.makeSeparator = function(sep, nlConstraints, state) {
	var origSep = sep;

		// TODO: Move to Util?
	var commentRe = '<!--(?:[^-]|-(?!->))*-->',
		// Split on comment/ws-only lines, consuming subsequent newlines since
		// those lines are ignored by the PHP parser
		// Ignore lines with ws and a single comment in them
		splitReString = '(?:\n[^\n]*?' + commentRe + '[^\n]*?(?=\n))+|' + commentRe,
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

	if (nlConstraints.b.min) {
		// Strip non-nl ws from last line, but preserve comments
		// This avoids triggering indent-pres
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
WSP.handleSeparator = function( state, nodeA, handlerA, nodeB, handlerB, dir) {
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
 * Emit a separator based on the collected (and merged) constraints and
 * existing separator text. Called when new output is triggered.
 */
WSP.emitSeparator = function(state, cb, node) {

	var sep,
		origNode = node,
		src = state.env.page.src,
		serializeInfo = state.selser.serializeInfo,
		constraints = state.sep.constraints,
		prevNode = state.sep.lastSourceNode;

	if (src && !state.selser.serializeInfo && node && prevNode) {
		// FIXME: Maybe we shouldn't set dsr in the dsr pass if both aren't valid?
		//
		// When we are in the lastChild sep scenario and the parent doesn't have
		// useable dsr, if possible, walk up the ancestor nodes till we find a dsr-bearing node
		if (prevNode.parentNode === node) {
			while (!node.nextSibling && node.nodeName !== 'BODY' &&
				(!node.data ||
				!node.data.parsoid.dsr ||
				node.data.parsoid.dsr[0] === null ||
				node.data.parsoid.dsr[1] === null))
			{
				node = node.parentNode;
			}
		}

		if (node && node.nodeType === node.TEXT_NODE) {
			// Check if this is the first child of a zero-width element, and use
			// that for dsr purposes instead. Typical case: text in p.
			if (!node.previousSibling &&
					node.parentNode &&
					node.parentNode !== prevNode &&
					node.parentNode.data.parsoid.dsr &&
					node.parentNode.data.parsoid.dsr[2] === 0)
			{
				node = node.parentNode;
			}
		}

		if (prevNode && prevNode.nodeType === prevNode.TEXT_NODE) {
			// Check if this is the last child of a zero-width element, and use
			// that for dsr purposes instead. Typical case: text in p.
			if (!prevNode.nextSibling &&
					prevNode.parentNode &&
					prevNode.parentNode !== node &&
					prevNode.parentNode.data.parsoid.dsr &&
					prevNode.parentNode.data.parsoid.dsr[3] === 0)
			{
				prevNode = prevNode.parentNode;
			} else if (prevNode.previousSibling &&
					prevNode.previousSibling.nodeType === prevNode.ELEMENT_NODE &&
					prevNode.previousSibling.data.parsoid.dsr)
			{
				//console.log('faking prevNode');
				var prevSiblingEndDSR = prevNode.previousSibling.data.parsoid.dsr[1];
				// create fake node
				prevNode = {
					nodeName: '#fakeelement',
					nodeType: prevNode.ELEMENT_NODE,
					data: {
						parsoid: {
							dsr: [
								prevSiblingEndDSR,
								prevSiblingEndDSR + prevNode.nodeValue.length + DU.indentPreDSRCorrection(prevNode),
								0, 0
							]
						}
					}
				};
			} else {
				//console.log( prevNode.nodeValue, prevNode.parentNode.outerHTML);
			}
		}

		if (DU.isElt(node) && DU.isElt(prevNode) &&
			!DU.isListOrListElt(node) &&
			node.data && node.data.parsoid.dsr &&
			prevNode.data && prevNode.data.parsoid.dsr)
		{
			//console.log(prevNode.data.parsoid.dsr, node.data.parsoid.dsr);
			// Figure out containment relationship
			var dsrA = prevNode.data.parsoid.dsr,
				dsrB = node.data.parsoid.dsr;
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
			'node: ', origNode.nodeName,
			'prev: ', (prevNode ? prevNode.nodeName : '--none--'),
			'sep: ', sep);
	}

	// Verify that the separator is really one.
	// It cannot be anything but whitespace and comments.
	if (sep === undefined || !sep.match(/^(\s|<!--([^\-]|-(?!->))*-->)*$/)) {
		if (state.sep.constraints) {
			// TODO: set modified flag if start or end node (but not both) are
			// modified / new so that the selser can use the separator
			sep = this.makeSeparator(state.sep.src || '',
						state.sep.constraints,
						state);
		} else if (state.sep.src) {
			//sep = state.sep.src;
			// Strip whitespace from the last line
			sep = this.makeSeparator(state.sep.src,
						{a:{},b:{}, max:0},
						state);
		}
	}

	if (sep !== undefined) {
		// Reset separator state
		state.sep = {};

		cb(sep, origNode);
		state.sep = {};

		if (sep && sep.match(/\n/)) {
			state.resetCurrLine();
		}
		//console.log('sep', constraints, JSON.stringify(sep));
	}
};


WSP._getPrevSeparatorElement = function (node, state) {
	return /* state.sep.lastSourceNode || */ previousNonSepSibling(node) || node.parentNode;
};

WSP._getNextSeparatorElement = function (node) {
	return nextNonSepSibling(node) || node.parentNode;
};

// Gather a text line for the wikitext escaper's benefit
WSP._updateCurrLine = function(node, state) {
	function firstBlockNodeAncestor(node) {
		// FIXME: Only consider line-based (non-html-syntax for example) block
		// nodes!
		while (!isHtmlBlockTag(node.nodeName.toLowerCase())) {
			node = node.parentNode;
		}
		return node;
	}

	// XXX: Can we simply use node.textContent?
	function gatherInlineText(buf, node) {
		switch (node.nodeType) {
			case node.ELEMENT_NODE:
				var name = node.nodeName.toLowerCase();
				if (isHtmlBlockTag(name)) {
					// HMM- is this safe?
					return;
				}

				/* -----------------------------------------------------------------
				 * SSS: check not needed if we are not doing a full tokenization
				 * on the gathered text
				 *
				// Ignore text for extlink/numbered
				if (name === 'a' && node.getAttribute("rel") === 'mw:ExtLink/Numbered') {
				return;
				}
				 * -----------------------------------------------------------------*/

				var children = node.childNodes;
				for (var i = 0, n = children.length; i < n; i++) {
					gatherInlineText(buf, children[i]);
				}

				return;
			case node.COMMENT_NODE:
				buf.push(commentWT(node.data));
				return;
			case node.TEXT_NODE:
				buf.push(node.data);
				return;
			default:
				return;
		}
	}

	var buf = [],
		// This is a bit hacky, as it assumes that all block
		// elements serialize to a single line. Should be
		// conservative / safe though.
		bn = firstBlockNodeAncestor(node);
	if (bn === state.currLine.ancestor) {
		//console.log('noup', node.nodeValue, bn.outerHTML);
		state.currLine.seen = true;
		return;
	}
	//console.log('up', node.nodeValue, bn.outerHTML);
	state.resetCurrLine();

	var children = bn.childNodes;
	for (var i = 0, n = children.length; i < n; i++) {
		gatherInlineText(buf, children[i]);
	}
	state.currLine.numPieces = n;
	state.currLine.text = buf.join('');
	state.currLine.ancestor = bn;
};

/**
 * Internal worker. Recursively serialize a DOM subtree.
 */
WSP._serializeNode = function( node, state, cb) {
	cb = cb || state.chunkCB;
	var prev, next;

	// serialize this node
	switch( node.nodeType ) {
		case node.ELEMENT_NODE:
			var nodeName = node.nodeName.toLowerCase(),
				tkAttribs = this._getDOMAttribs(node.attributes),
				tkRTInfo = this._getDOMRTInfo(node),
				parentSTX = state.parentSTX;

			// populate node.data.parsoid and node.data['parsoid-serialize']
			DU.loadDataParsoid(node);
			DU.loadDataAttrib(node, 'parsoid-serialize', {});

			// Insert a possible separator
			prev = this._getPrevSeparatorElement(node, state);
			var domHandler = this._getDOMHandler(node, state, cb);
			if (prev) {
				this.handleSeparator(state,
						prev,  this._getDOMHandler(prev, state, cb),
						node,  domHandler);
			}

			var serializeInfo = null;
			if ( state.selser.serializeInfo === null ) {
				serializeInfo = node.data['parsoid-serialize'];
				state.selser.serializeInfo = serializeInfo;
				cb('', node);
			}

			if ( domHandler && domHandler.handle ) {
				// DOM-based serialization
				try {
					// XXX: use a returned node to support handlers consuming
					// siblings too
					domHandler.handle(node, state, cb);
				} catch(e) {
					console.error(e.stack || e.toString());
					console.error(node.nodeName, domHandler);
				}
				// The handler is responsible for serializing its children
			} else {
				// Used to be token-based serialization
				console.error('No dom handler found for', node.outerHTML);
			}

			// Insert end separator
			if (node && node.nodeType === node.ELEMENT_NODE) {
				next = this._getNextSeparatorElement(node);
				if (next) {
					this.handleSeparator(state,
							node, domHandler,
							next, this._getDOMHandler(next, state, cb));
				}
			}
			if (state.currLine.text === null ||
					state.sep.constraints && state.sep.constraints.min > 0)
			{
				this._updateCurrLine(node, state);
			}

			break;
		case node.TEXT_NODE:
			// Gather a text line for the wikitext escaper's benefit
			if (state.currLine.text === null ||
					state.sep.constraints && state.sep.constraints.min > 0 ||
					!state.currLine.seen)
			{
				this._updateCurrLine(node, state);
			} else {
				state.currLine.seen = true;
			}
			if (!this.handleSeparatorText(node, state)) {
				// Text is not just whitespace
				prev = this._getPrevSeparatorElement(node, state);
				if (prev) {
					this.handleSeparator(state,
							prev,  this._getDOMHandler(prev, state, cb),
							node,  {});
				}
				// regular serialization
				this._serializeTextNode(node, state, cb );
				next = this._getNextSeparatorElement(node);
				if (next) {
					//console.log(next.outerHTML);
					this.handleSeparator(state,
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
	return node;
};

/**
 * Serialize an HTML DOM document.
 */
WSP.serializeDOM = function( body, chunkCB, finalCB, selser ) {
	var state = Util.extendProps({},
		// Make sure these two are cloned, so we don't alter the initial
		// state for later serializer runs.
		Util.clone(this.initialState),
		Util.clone(this.options)),
		serializeInfo = state.selser.serializeInfo;

	// Record the serializer
	state.serializer = this;

	try {
		state.selser = selser || {};

		// Normalize the DOM (coalesces adjacent text body)
		// FIXME: Disabled as this strips empty comments (<!---->).
		//body.normalize();

		// collect tpl attr tags
		this.extractTemplatedAttributes(body, state);

		// Don't serialize the DOM if debugging is disabled
		if (this.debugging) {
			this.trace(" DOM ==> \n", body.outerHTML);
		}

		var out = [];

		var chunkCBWrapper = function (cb, chunk, chunkNode) {
			if (!serializeInfo) {
				serializeInfo = state.selser.serializeInfo || null;
			}
			if (chunk) {
				state.currLine.seen = true;
			}
			state.serializer.emitSeparator(state, cb, chunkNode);
			cb(chunk, serializeInfo);
			//console.log('chunkCB', chunk,
			//			chunkNode && chunkNode.nodeName || 'noNode');
			state.sep.lastSourceNode = chunkNode;
			state.sep.lastSourceSep = state.sep.src;
			//if (state.currLine.text === null && chunk) {
			//	state.currLine.seen = true;
			//}
			state.atStartOfOutput = false;
		};

	    if ( ! chunkCB ) {
			state.chunkCB = chunkCBWrapper.bind(null, function ( chunk ) {
								out.push(chunk);
			});
		} else {
			state.chunkCB = chunkCBWrapper.bind(null, chunkCB);
		}

		state.sep.lastSourceNode = body;
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
