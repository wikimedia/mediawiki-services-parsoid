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
	Node = wtConsts.Node,
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	SanitizerConstants = require('./ext.core.Sanitizer.js').SanitizerConstants,
	$ = require( 'jquery' ),
	tagWhiteListHash;

var START_SEP = 1,
	IE_SEP = 2,
	END_SEP = 3;

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

var WikitextEscapeHandlers = function() { };

var WEHP = WikitextEscapeHandlers.prototype;

WEHP.urlParser = new PegTokenizer();

WEHP.headingHandler = function(state, text) {
	// replace heading-handler with the default handler
	// only "=" at the extremities trigger escaping
	state.wteHandlerStack.pop();
	state.wteHandlerStack.push(null);

	var line = state.currLine.text;
	var len  = line ? line.length : 0;
	return (line && len > 2 && (line[0] === '=') && (line[len-1] === '='));
};

WEHP.liHandler = function(state, text) {
	// replace li-handler with the default handler
	// only bullets at the beginning of the list trigger escaping
	state.wteHandlerStack.pop();
	state.wteHandlerStack.push(null);

	return isListItem(state.currTagToken) && text.match(/^[#\*:;]/);
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
	var tok = state.currTagToken;
	return text.match(/\|/) ||
		(text.match(/^[\-+]/) &&
		isTd(tok) &&
		(!tok.dataAttribs.dsr || tok.dataAttribs.dsr[2] === 1) &&
		tok.dataAttribs.stx_v !== 'row' &&
		tok.attribs.length === 0);
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

	if ( state.inIndentPre ) {
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

	// Tokenizer.process is synchronous -- this call wont return till everything is parsed.
	// The code below will break if tokenization becomes async.
	p.process( prefixedText );

	// If the token stream has a TagTk, SelfclosingTagTk, EndTagTk or CommentTk
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
		if (tc === SelfclosingTagTk) {
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

		if (!linksOnly && tc === TagTk) {
			// mw:Entity tokens
			if (t.name === 'span' && t.getAttribute('typeof') === 'mw:Entity') {
				numEntities++;
				continue;
			}

			return true;
		}

		if (!linksOnly && tc === EndTagTk) {
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
var WikitextSerializer = function( options ) {
	this.options = Util.extendProps( {
		// defaults
	}, options || {} );

	this.env = options.env;
	var trace = this.env.conf.parsoid.traceFlags && (this.env.conf.parsoid.traceFlags.indexOf("wts") !== -1);

	if ( this.env.conf.parsoid.debug || trace ) {
		WikitextSerializer.prototype.debug_pp = function () {
			Util.debug_pp.apply(Util, arguments);
		};

		WikitextSerializer.prototype.debug = function ( ) {
			this.debug_pp.apply(this, ["WTS: ", ''].concat([].slice.apply(arguments)));
		};
	} else {
		WikitextSerializer.prototype.debug_pp = function ( ) {};
		WikitextSerializer.prototype.debug = function ( ) {};
	}
};

var WSP = WikitextSerializer.prototype;

WSP.wteHandlers = new WikitextEscapeHandlers();

/* *********************************************************************
 * Here is what the state attributes mean:
 *
 * tableStack
 *    Stack of table contexts that stashes away list context since
 *    list context dont cross table boundaries.
 *
 * listStack
 *    Stack of list contexts to let us emit wikitext for nested lists.
 *    Each context keeps track of 3 values:
 *    - itemBullet: the wikitext bullet char for this list
 *    - itemCount : # of list items encountered so far for the list
 *    - bullets   : cumulative bullet prefix based on all the lists
 *                  that enclose the current list
 *
 * onNewline
 *    true on start of file or after a new line has been emitted.
 *
 * onStartOfLine
 *    true when onNewline is true, and also in other start-of-line contexts
 *    Ex: after a comment has been emitted, or after include/noinclude tokens.
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
 * bufferedSeparator
 *    Valid only when 'src' is not null.
 *
 *    Temporary buffering of normalized separators as determined by node
 *    handlers.  They are used when emitting separators from src fails
 *    and discarded if emitting separators from src suceeds.  This lets
 *    the serializer correctly handle original as well as modified content
 *    in the HTML.
 *
 * separatorEmittedFromSrc
 *    Valid only when 'src' is not null.
 *
 *    A flag that indicates if a separator has already been emitted from
 *    original wikitext src.
 *
 * currLine
 *    This object is used by the wikitext escaping algorithm -- represents
 *    a "single line" of output wikitext as represented by a block node in
 *    the DOM.
 *
 *    - text           : accumulated text from all text nodes on the current line
 *    - processed      : have we analyzed the text so far?
 *    - hasBracketPair : does the line have bracket wikitext token pairs?
 *    - hasHeadingPair : does the line have heading wikitext token pairs?
 * ********************************************************************* */

WSP.initialState = {
	tableStack: [],
	listStack: [],
	lastRes: '',
	onNewline: true,
	onStartOfLine : true,
	singleLineMode: 0,
	wteHandlerStack: [],
	tplAttrs: {},
	src: null,
	bufferedSeparator: null,
	separatorEmittedFromSrc: false,
	currLine: {
		text: null,
		processed: false,
		hasBracketPair: false,
		hasHeadingPair: false
	},
	selser: {
		serializeInfo: null
	},
	serializeTokens: function(newLineStart, wteHandler, tokens, chunkCB) {
		// newLineStart -- sets newline and sol state
		// wteHandler   -- sets wikitext context for the purpose of wikitext escaping
		var initState = {
			onNewline: newLineStart,
			onStartOfLine: newLineStart,
			tplAttrs: this.tplAttrs,
			currLine: this.currLine,
			wteHandlerStack: wteHandler ? [wteHandler] : []
		};
		return this.serializer.serializeTokens(initState, tokens, chunkCB);
	},
	emitSepChunk: function(separator, debugStr) {
		if (this.tokenCollector) {
			// If in token collection mode, convert the
			// separator into a token so that it shows up
			// in the right place in the token stream.
			this.tokenCollector.collect( this, separator );
		} else {
			if (separator.match(/\n$/)) {
				this.onNewline = true;
			}
			if (separator.match(/\n/)) {
				this.onStartOfLine = true;
			}
			WSP.debug_pp("===> ", debugStr || "sep: ", separator);
			this.chunkCB(separator, "separator");
		}
		this.bufferedSeparator = null;
	},
	emitSeparator: function(n1, n2, sepType) {
		// cannot do anything if we dont have original wikitext
		if (!this.env.page.src) {
			return;
		}

		var dsrIndex1, dsrIndex2;
		switch (sepType) {
			case START_SEP:
				dsrIndex1 = 0;
				dsrIndex2 = 0;
				break;

			case IE_SEP:
				dsrIndex1 = 1;
				dsrIndex2 = 0;
				break;

			case END_SEP:
				dsrIndex1 = 1;
				dsrIndex2 = 1;
				break;
		}

		// cannot do anything if we dont have dsr for either node
		var dsr1 = DU.dataParsoid(n1).dsr;
		if (!dsr1 || dsr1[dsrIndex1] === null) {
			return;
		}

		var dsr2 = DU.dataParsoid(n2).dsr;
		if (!dsr2 || dsr2[dsrIndex2] === null) {
			return;
		}

		var i1 = dsr1[dsrIndex1] + (sepType === START_SEP ? dsr1[2] : 0);
		var i2 = dsr2[dsrIndex2] - (sepType === END_SEP   ? dsr2[3] : 0);
		var separator = this.env.page.src.substring(i1, i2);

		if (separator.match(/^(\s|<!--([^\-]|-(?!->))*-->)*$/)) {
			// verify that the separator is really one
			this.emitSepChunk(separator);
			this.separatorEmittedFromSrc = true;
		} else {
			// something not right with the separator that we extracted!
			return;
		}
	}
};
// Make sure the initialState is never modified
Util.deepFreeze( WSP.initialState );

var endTagMatchTokenCollector = function ( tk, cb ) {
	var tokens = [tk];

	return {
		cb: cb,
		collect: function ( state, token ) {
			tokens.push( token );
			if ([TagTk, SelfclosingTagTk, EndTagTk].indexOf(token.constructor) === -1) {
				state.prevTagToken = state.currTagToken;
				state.currTagToken = token;
			}

			if ( token.constructor === EndTagTk && token.name === tk.name ) {
				// finish collection
				if ( this.cb ) {
					// abort further token processing since the cb handled it
					var res = this.cb( state, tokens );
					state.wteHandlerStack.pop();
					return res;
				} else {
					// let a handler deal with token processing
					return false;
				}
			} else {
				// continue collection
				return true;
			}
		},
		tokens: tokens
	};
};

var openHeading = function(v) {
	return function( state ) {
		return v;
	};
};

var closeHeading = function(v) {
	return function(state, token) {
		var prevToken = state.prevToken;
		// Deal with empty headings. Ex: <h1></h1>
		if (prevToken.constructor === TagTk && prevToken.name === token.name) {
			return "<nowiki></nowiki>" + v;
		} else {
			return v;
		}
	};
};

function isTd(token) {
	return token && token.constructor === TagTk && token.name === 'td';
}

function isListItem(token) {
	return token && token.constructor === TagTk &&
		['li', 'dt', 'dd'].indexOf(token.name) !== -1;
}

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
		return text;
	}

	// Context-specific escape handler
	var wteHandler = state.wteHandlerStack.last();
	if (wteHandler && wteHandler(state,text)) {
		// console.warn("---EWT:F2---");
		return escapedText(text);
	}

	// Template and template-arg markers are escaped unconditionally!
	// Conditional escaping requires matching brace pairs and knowledge
	// of whether we are in template arg context or not.
	if (text.match(/{{{|{{|}}}|}}/)) {
		// console.warn("---EWT:F3---");
		return escapedText(text);
	}

	var sol = state.onStartOfLine || state.emitNewlineOnNextToken,
		hasNewlines = text.match(/\n./),
		hasTildes = text.match(/~{3,5}/);
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

WSP._listHandler = function( handler, bullet, state, token ) {

	if ( state.singleLineMode ) {
		state.singleLineMode--;
	}

	var bullets, res;
	var stack = state.listStack;
	if (stack.length === 0) {
		bullets = bullet;
		res     = bullets;
		handler.startsLine = true;
	} else {
		var curList = stack.last();
		//console.warn(JSON.stringify( stack ));
		bullets = curList.bullets + curList.itemBullet + bullet;
		curList.itemCount++;
		// A nested list, not directly after a list item
		if (curList.itemCount > 1 && !isListItem(state.prevToken)) {
			res = bullets;
			handler.startsLine = true;
		} else {
			res = bullet;
			handler.startsLine = false;
		}
	}
	stack.push({ itemCount: 0, bullets: bullets, itemBullet: '' });
	WSP.debug_pp('lh res', '; ', bullets, res, handler );
	return res;
};

WSP._listEndHandler = function( state, token ) {
	state.listStack.pop();
	return '';
};

WSP._listItemHandler = function ( handler, bullet, state, token ) {

	function isRepeatToken(state, token) {
		return	state.prevToken.constructor === EndTagTk &&
				state.prevToken.name === token.name;
	}

	function isMultiLineDtDdPair(state, token) {
		return	token.name === 'dd' &&
				token.dataAttribs.stx !== 'row' &&
				state.prevTagToken.constructor === EndTagTk &&
				state.prevTagToken.name === 'dt';
	}

	var stack   = state.listStack;

	// This check is required to handle cases where the DOM is not well-formed.
	//
	// FIXME NOTE: This is required currently to deal with bugs in the parser
	// as it deals with complex cases.  But, in the future, we could deal with
	// this in one of the following ways:
	// (a) The serializer expects a well-formed DOM and all cleanup will be
	//     done as part of external tools/passes.
	// (b) The serializer supports a small set of exceptional cases and bare
	//     list items could be one of them
	// (c) The serializer ought to handle any DOM that is thrown at it.
	//
	// Yet to be resolved.
	if (stack.length === 0) {
		stack.push({ itemCount: 0, bullets: bullet, itemBullet: bullet});
	}

	var curList = stack[stack.length - 1];
	curList.itemCount++;
	curList.itemBullet = bullet;

	// Output bullet prefix only if:
	// - this is not the first list item
	// - we are either in:
	//    * a new line context,
	//    * seeing an identical token as the last one (..</li><li>...)
	//      (since we are in this handler on encountering a list item token,
	//       this means we are the 2nd or later item in the list, BUT without
	//       any intervening new lines or other tokens in between)
	//    * on the dd part of a multi-line dt-dd pair
	//      (The dd on a single-line dt-dd pair sticks to the dt.
	//       which means it won't get the bullets that the dt already got).
	//
	// SSS FIXME: This condition could be rephrased as:
	//
	// if (isRepeatToken(state, token) ||
	//     (curList.itemCount > 1 && (inStartOfLineContext(state) || isMultiLineDtDdPair(state, token))))
	//
	var res;
	if (curList.itemCount > 1 &&
		(	state.onStartOfLine ||
			isRepeatToken(state, token) ||
			isMultiLineDtDdPair(state, token)
		)
	)
	{
		handler.startsLine = true;
		res = curList.bullets + bullet;
	} else {
		handler.startsLine = false;
		res = bullet;
	}
	WSP.debug_pp( 'lih res', '; ', token, res, handler );
	return res;
};


WSP._figureHandler = function ( state, figTokens ) {

	// skip tokens looking for the image tag
	var img;
	var i = 1, n = figTokens.length;
	while (i < n) {
		if (figTokens[i].name === "img") {
			img = figTokens[i];
			break;
		}
		i++;
	}

	if ( !img ) {
		console.error('ERROR _figureHandler: no img ' + figTokens);
		// No image, at least don't crash below
		return '';
	}

	// skip tokens looking for the start and end caption tags
	var fcStartIndex = 0, fcEndIndex = 0;
	while (i < n) {
		if (figTokens[i].name === "figcaption") {
			if (fcStartIndex > 0) {
				fcEndIndex = i;
				break;
			} else {
				fcStartIndex = i;
			}
		}
		i++;
	}

	// Call the serializer to build the caption
	var caption = state.serializeTokens(false, WSP.wteHandlers.aHandler, figTokens.slice(fcStartIndex+1, fcEndIndex)).join('');

	// Get the image resource name
	// FIXME: file name has been capitalized -- need some fix in the parser
	var argDict = Util.KVtoHash( img.attribs );
	var imgR = (argDict.resource || '').replace(/(^\[:)|(\]$)/g, '');

	// Now, build the complete wikitext for the figure
	var outBits  = [imgR];
	var figToken = figTokens[0];
	var figAttrs = figToken.dataAttribs.optionList;

	var simpleImgOptions = WikitextConstants.Image.SimpleOptions;
	var prefixImgOptions = WikitextConstants.Image.PrefixOptions;
	var sizeOptions      = { "width": 1, "height": 1};
	var size             = {};
	for (i = 0, n = figAttrs.length; i < n; i++) {
		var a = figAttrs[i];
		var k = a.k, v = a.v;
		if (sizeOptions[k]) {
			// Since width and height have to be output as a pair,
			// collect both of them.
			size[k] = v;
		} else {
			// If we have width set, it got set in the most recent iteration
			// Output height and width now (one iteration later).
			var w = size.width;
			if (w) {
				outBits.push(w + (size.height ? "x" + size.height : '') + "px");
				size.width = null;
			}

			if (k === "aspect") {
				// SSS: Bad Hack!  Need a better solution
				// One solution is to search through prefix options hash but seems ugly.
				// Another is to flip prefix options hash and use it to search.
				if (v) {
					outBits.push("upright=" + v);
				} else {
					outBits.push("upright");
				}
			} else if (k === "caption") {
				outBits.push(v === null ? caption : v);
			} else if (simpleImgOptions[v.trim()] === k) {
				// The values and keys in the parser attributes are a flip
				// of how they are in the wikitext constants image hash
				// Hence the indexing by 'v' instead of 'k'
				outBits.push(v);
			} else if (prefixImgOptions[k.trim()]) {
				outBits.push(k + "=" + v);
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

	return "[[" + outBits.join('|') + "]]";
};

WSP._serializeTableTag = function ( symbol, optionalEndSymbol, state, token ) {
	var sAttribs = WSP._serializeAttributes(state, token);
	if (sAttribs.length > 0) {
		return symbol + ' ' + sAttribs + optionalEndSymbol;
	} else {
		return symbol;
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
		close = '/';
	}

	var sAttribs = WSP._serializeAttributes(state, token);
	var tokenName = da.srcTagName || token.name;
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
	var tail = dp.tail;
	if (dp.pipetrick) {
		// Drop the content completely..
		return { contentString: '', tail: tail || '' };
	} else {
		if ( target && contentString.substr( 0, target.length ) === target &&
				dp.stx === 'simple' ) {
			tail = contentString.substr( target.length );
			if ( !Util.isLinkTrail( tail ) ) {
				tail = dp.tail;
			}
		}
		if ( tail && contentString.substr( contentString.length - tail.length ) === tail ) {
			// strip the tail off the content
			contentString = Util.stripSuffix( contentString, tail );
		} else if ( tail ) {
			tail = '';
		}

		return {
			contentString: contentString || '',
			tail: tail || ''
		};
	}
};

// Helper function for getting RT data from the tokens
var getLinkRoundTripData = function( token, attribDict, dp, tokens, state ) {
	var tplAttrs = state.tplAttrs;
	var rtData = {
		type: null,
		target: null, // filled in below
		tail: dp.tail || '',
		content: {} // string or tokens
	};

	// Figure out the type of the link
	if ( attribDict.rel ) {
		var typeMatch = attribDict.rel.match( /\bmw:[^\b]+/ );
		if ( typeMatch ) {
			rtData.type = typeMatch[0];
		}
	}

	// Save the token's "real" href for comparison
	rtData.href = attribDict.href.replace( /^(\.\.?\/)+/, '' );

	// Now get the target from rt data
	rtData.target = token.getAttributeShadowInfo('href', tplAttrs);

	// Get the content string or tokens
	var contentParts;
	var contentString = Util.tokensToString(tokens, true);
	if (contentString.constructor === String) {
		if ( ! rtData.target.modified && rtData.tail &&
				contentString.substr(- rtData.tail.length) === rtData.tail ) {
			rtData.content.string = Util.stripSuffix( contentString, rtData.tail );
		} else if (rtData.target.string && rtData.target.string !== contentString) {
			// Try to identify a new potential tail
			contentParts = splitLinkContentString(contentString, dp, rtData.target);
			rtData.content.string = contentParts.contentString;
			rtData.tail = contentParts.tail;
		} else {
			rtData.tail = '';
			rtData.content.string = contentString;
		}
	} else {
		rtData.content.tokens = tokens;
	}

	return rtData;
};

function escapeWikiLinkContentString ( contentString, state ) {
	// Wikitext-escape content.
	//
	// When processing link text, we are no longer in newline state
	// since that will be preceded by "[[" or "[" text in target wikitext.
	state.onStartOfLine = false;
	state.emitNewlineOnNextToken = false;
	state.wteHandlerStack.push(WSP.wteHandlers.wikilinkHandler);
	var res = WSP.escapeWikiText(state, contentString);
	state.wteHandlerStack.pop();
	return res;
}

// SSS FIXME: This doesn't deal with auto-inserted start/end tags.
// To handle that, we have to split every 'return ...' statement into
// openTagSrc = ...; endTagSrc = ...; and at the end of the function,
// check for autoInsertedStart and autoInsertedEnd attributes and
// supress openTagSrc or endTagSrc appropriately.
WSP._linkHandler =  function( state, tokens ) {
	//return '[[';
	// TODO: handle internal/external links etc using RDFa and dataAttribs
	// Also convert unannotated html links without advanced attributes to
	// external wiki links for html import. Might want to consider converting
	// relative links without path component and file extension to wiki links.
	var env = state.env,
		token = tokens.shift(),
		endToken = tokens.pop(),
		attribDict = Util.KVtoHash( token.attribs ),
		dp = token.dataAttribs,
		linkData, contentParts,
		contentSrc = '';

	// Get the rt data from the token and tplAttrs
	linkData = getLinkRoundTripData(token, attribDict, dp, tokens, state);

	if ( linkData.type !== null && linkData.target.value !== null  ) {
		// We have a type and target info

		var target = linkData.target;

		if ( linkData.type === 'mw:WikiLink' ||
				linkData.type === 'mw:WikiLink/Category' ||
				linkData.type === 'mw:WikiLink/Language' ) {

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
					var sortKeySrc = token.getAttributeShadowInfo('mw:sortKey', state.tplAttrs);
					if ( sortKeySrc.value !== null ) {
						linkData.content.tokens = undefined;
						linkData.content.string = sortKeySrc.value;
						// TODO: generalize this flag. It is already used by
						// getAttributeShadowInfo. Maybe use the same
						// structure as its return value?
						linkData.content.fromsrc = true;
					}
				//}
			} else if ( linkData.type === 'mw:WikiLink/Language' ) {
				return dp.src;
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
					return '[[' + target.value + ']]' + linkData.tail;
				} else {
					contentSrc = escapeWikiLinkContentString(linkData.content.string, state);
					return '[[' + contentSrc + ']]' + linkData.tail;
				}
			} else {

				// First get the content source
				if ( linkData.content.tokens ) {
					contentSrc = state.serializeTokens(false, WSP.wteHandlers.wikilinkHandler, tokens).join('');
					// strip off the tail and handle the pipe trick
					contentParts = splitLinkContentString(contentSrc, dp);
					contentSrc = contentParts.contentString;
					dp.tail = contentParts.tail;
					linkData.tail = contentParts.tail;
				} else if ( !willUsePipeTrick ) {
					if (linkData.content.fromsrc) {
						contentSrc = linkData.content.string;
					} else {
						contentSrc = escapeWikiLinkContentString(linkData.content.string,
								state);
					}
				}

				if ( contentSrc === '' && ! willUsePipeTrick &&
						linkData.type !== 'mw:WikiLink/Category' ) {
					// Protect empty link content from PST pipe trick
					contentSrc = '<nowiki/>';
				}

				return '[[' + linkData.target.value + '|' + contentSrc + ']]' + linkData.tail;
			}
		} else if ( attribDict.rel === 'mw:ExtLink' ) {
			if ( target.modified ) {
				// encodeURI only encodes spaces and the like
				target.value = encodeURI(target.value);
			}
			return '[' + target.value + ' ' +
				state.serializeTokens(false, WSP.wteHandlers.aHandler, tokens).join('') +
				']';
		} else if ( attribDict.rel.match( /mw:ExtLink\/(?:ISBN|RFC|PMID)/ ) ) {
			return tokens.join('');
		} else if ( attribDict.rel === 'mw:ExtLink/URL' ) {
			return Util.tokensToString( linkData.target.value );
		} else if ( attribDict.rel === 'mw:ExtLink/Numbered' ) {
			return '[' + Util.tokensToString( linkData.target.value ) + ']';
		} else if ( attribDict.rel === 'mw:Image' ) {
			// simple source-based round-tripping for now..
			// TODO: properly implement!
			if ( dp.src ) {
				return dp.src;
			}
		} else {
			// Unknown rel was set
			return WSP._serializeHTMLTag( state, token );
		}
	} else {
		// TODO: default to extlink for simple links with unknown rel set
		// switch to html only when needed to support attributes

		var isComplexLink = function ( attribDict ) {
			for ( var name in attribDict ) {
				if ( name && ! ( name in { href: 1 } ) ) {
					return true;
				}
			}
			return false;
		};

		if ( true || isComplexLink ( attribDict ) ) {
			// Complex attributes we can't support in wiki syntax
			return WSP._serializeHTMLTag( state, token ) +
				state.serializeTokens(state.onNewline, null, tokens ) +
				WSP._serializeHTMLEndTag( state, endToken );
		} else {
			// TODO: serialize as external wikilink
			return '';
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
	'mw:DiffWrapper': 1,
	'mw:SerializeWrapper': 1
};

/**
 * Compare the actual content with the previous content and use
 * dataAttribs.src if it does. Return serialization of modified content
 * otherwise.
 */
WSP.compareSourceHandler = function ( state, tokens ) {
	var token = tokens.shift(),
		lastToken = tokens.pop(),
		content = Util.tokensToString( tokens, true );
	if ( content.constructor !== String ) {
		// SSS FIXME: What should the initial wikitext-context be
		// for escaping wt chars?
		return state.serializeTokens(state.onNewline, null, tokens ).join('');
	} else if ( content === token.dataAttribs.srcContent ) {
		return token.dataAttribs.src;
	} else {
		return content;
	}
};

/* *********************************************************************
 * ignore
 *     if true, the serializer pretends as if it never saw this token.
 *
 * startsLine
 *     if true, the wikitext for the dom subtree rooted
 *     at this html tag requires a new line context.
 *
 * endsLine
 *     if true, the wikitext for the dom subtree rooted
 *     at this html tag ends the line.
 *
 * solTransparent
 *     if true, this token does not change sol status after it is emitted.
 *
 * singleLine
 *     if 1, the wikitext for the dom subtree rooted at this html tag
 *     requires all content to be emitted on the same line without
 *     any line breaks. +1 sets the single-line mode (on descending
 *     the dom subtree), -1 clears the single-line mod (on exiting
 *     the dom subtree).
 * ********************************************************************* */
function id(v) {
	return function( state ) {
		return v;
	};
}

function buildHeadingHandler(headingWT) {
	return {
		start: { startsLine: true, handle: openHeading(headingWT), defaultStartNewlineCount: 2 },
		end: { endsLine: true, handle: closeHeading(headingWT) },
		wtEscapeHandler: WSP.wteHandlers.headingHandler
	};
}

function buildListHandler(listBullet) {
	// The list handler sets 'startLine' state depending
	// on whether this is the topmost list or nested list
	return {
		start: {
			handle: function ( state, token ) {
				return WSP._listHandler( this, listBullet, state, token );
			}
		},
		end: {
			handle: WSP._listEndHandler,
			endsLine: true
		}
	};
}

function buildListItemHandler(itemBullet, endTagEndsLine) {
	// The list-item handler sets 'startLine' state depending
	// on whether this is the first nested list item or not
	return {
		start: {
			singleLine: 1,
			handle: function ( state, token ) {
				return WSP._listItemHandler( this, itemBullet, state, token );
			}
		},
		end: {
			singleLine: -1,
			endsLine: endTagEndsLine
		},
		wtEscapeHandler: WSP.wteHandlers.liHandler
	};
}

function charSequence(prefix, c, numChars) {
	if (numChars && numChars > 0) {
		var buf = [prefix];
		for (var i = 0; i < numChars; i++) {
			buf.push(c);
		}
		return buf.join('');
	} else {
		return prefix;
	}
}

WSP.tagHandlers = {
	body: {
		end: {
			handle: id('')
		}
	},
	ul: buildListHandler('*'),
	ol: buildListHandler('#'),
	dl: buildListHandler(''),
	li: buildListItemHandler('',  true),
	dt: buildListItemHandler(';', false), // XXX: handle single-line vs. multi-line dls etc
	dd: buildListItemHandler(':', true),
	// XXX: handle options
	table: {
		start: {
			handle: function(state, token) {
				// If we are in a list context, don't start a new line!
				this.startsLine = state.listStack.length === 0;
				state.tableStack.push({ listStack: state.listStack, singleLine: state.singleLineMode});
				state.singleLineMode = 0;
				state.listStack = [];

				var wt = token.dataAttribs.startTagSrc || "{|";
				return WSP._serializeTableTag(wt, '', state, token);
			}
		},
		end: {
			startsLine: true,
			endsLine: true,
			handle: function(state, token) {
				var listState = state.tableStack.pop();
				state.listStack = listState.listStack;
				state.singleLineMode = listState.singleLineMode;
				if ( state.prevTagToken && state.prevTagToken.name === 'tr' ) {
					this.startsLine = true;
				} else {
					this.startsLine = false;
				}
				return token.dataAttribs.endTagSrc || "|}";
			}
		}
	},
	tbody: { start: { ignore: true }, end: { ignore: true } },
	th: {
		start: {
			handle: function ( state, token ) {
				var da = token.dataAttribs;
				var sep = " " + (da.attrSepSrc || "|");
				if ( da.stx_v === 'row' ) {
					this.startsLine = false;
					return WSP._serializeTableTag(da.startTagSrc || "!!", sep, state, token);
				} else {
					this.startsLine = true;
					return WSP._serializeTableTag(da.startTagSrc || "!", sep, state, token);
				}
			}
		},
		wtEscapeHandler: WSP.wteHandlers.thHandler
	},
	tr: {
		start: {
			startsLine: true,
			handle: function ( state, token ) {
				// If the token has 'startTagSrc' set, it means that the tr was present
				// in the source wikitext and we emit it -- if not, we ignore it.
				var da = token.dataAttribs;
				if (state.prevToken.constructor === TagTk &&
					state.prevToken.name === 'tbody' &&
					!da.startTagSrc )
				{
					return '';
				} else {
					return WSP._serializeTableTag(da.startTagSrc || "|-", '', state, token );
				}
			}
		},
		end: {
			endsLine: true,
			handle: function(state, token) {
				return '';
			}
		}
	},
	td: {
		start: {
			handle: function ( state, token ) {
				var da = token.dataAttribs;
				var sep = " " + (da.attrSepSrc || "|");
				if ( da.stx_v === 'row' ) {
					this.startsLine = false;
					return WSP._serializeTableTag(da.startTagSrc || "||", sep, state, token);
				} else {
					// If the HTML for the first td is not enclosed in a tr-tag,
					// we start a new line.  If not, tr will have taken care of it.
					this.startsLine = true;
					return WSP._serializeTableTag(da.startTagSrc || "|", sep, state, token);
				}
			}
		},
		wtEscapeHandler: WSP.wteHandlers.tdHandler
	},
	caption: {
		start: {
			startsLine: true,
			handle: WSP._serializeTableTag.bind(null, "|+", ' |')
		},
		end: {
			endsLine: true
		}
	},
	p: {
		make: function(state, token) {
			// "stx": "html" tags never get here
			// Special case handling in a list context
			// VE embeds list content in paragraph tags.
			//
			// SSS FIXME: This will *NOT* work if the list item has nested paragraph tags!
			var prevToken = state.prevToken;
			if (	token.attribs.length === 0 &&
					(	(state.listStack.length > 0 && isListItem(prevToken)) ||
						(prevToken.constructor === TagTk && prevToken.name === 'td') ||
						(state.ignorePTag && token.constructor === EndTagTk)))
			{
				state.ignorePTag = !state.ignorePTag;
				return { start: { ignore: true }, end: { ignore: true } };
			} else {
				return state.singleLineMode ? WSP.defaultHTMLTagHandler : this;
			}
		},
		start: {
			startsLine: true,
			handle: function(state, token) {
				var prevTag = state.prevTagToken;
				if (state.env.page.src || (
					prevTag && prevTag.constructor === TagTk && prevTag.name === 'body')) {
					this.emitsNL = false;
				} else {
					this.emitsNL = true;
				}
				return '';
			}
		},
		end: {
			handle: function(state, token) {
				var prevTag = state.prevToken;
				if (prevTag && ((prevTag.constructor === TagTk && prevTag.name === 'p') ||
					(prevTag.constructor === EndTagTk &&prevTag.name === 'br'))) {
					this.endsLine = true;
					this.emitsNL = false;
				} else if (state.env.page.src) {
					this.endsLine = false;
					this.emitsNL = false;
				} else {
					this.endsLine = true;
					this.emitsNL = true;
				}
				return '';
			}
		}
	},
	// XXX: support indent variant instead by registering a newline handler?
	pre: {
		start: {
			startsLine: true,
			handle: function( state, token ) {
				state.inIndentPre = true;
				state.textHandler = function( currState, t ) {
					// replace \n in the middle of the text with
					// a leading space, and start of text if
					// the serializer in at start of line state.
					var res = t.replace(/\n(?!$)/g, '\n ' );
					return currState.onStartOfLine ? ' ' + res : res;
				};

				var prevTagToken = state.prevTagToken;
				if (!state.env.page.src && prevTagToken && prevTagToken.constructor === EndTagTk &&
					prevTagToken.name === 'pre' && prevTagToken.dataAttribs.stx !== 'html')
				{
					return '\n ';
				} else {
					return ' ';
				}
			}
		},
		end: {
			handle: function( state, token) {
				state.inIndentPre = false;
				state.textHandler = null;
				return '';
			}
		}
	},
	meta: {
		start: {
			handle: function ( state, token ) {
				var switchType, argDict = Util.KVtoHash( token.attribs );

				if ( argDict['typeof'] ) {
					switch ( argDict['typeof'] ) {
						case 'mw:tag':
							// we use this currently for nowiki and co
							this.solTransparent = true;
							if ( argDict.content === 'nowiki' ) {
								state.inNoWiki = true;
							} else if ( argDict.content === '/nowiki' ) {
								state.inNoWiki = false;
							} else {
								console.warn( JSON.stringify( argDict ) );
							}
							return '<' + argDict.content + '>';
						case 'mw:IncludeOnly':
							this.solTransparent = true;
							return token.dataAttribs.src;
						case 'mw:NoInclude':
							this.solTransparent = true;
							return token.dataAttribs.src || '<noinclude>';
						case 'mw:NoInclude/End':
							return token.dataAttribs.src || '</noinclude>';
						case 'mw:OnlyInclude':
							this.solTransparent = true;
							return token.dataAttribs.src || '<onlyinclude>';
						case 'mw:OnlyInclude/End':
							return token.dataAttribs.src || '</onlyinclude>';
						case 'mw:ChangeMarker':
							// just strip it
							return '';
						default:
							this.solTransparent = false;
							return WSP._serializeHTMLTag( state, token );
					}
				} else if ( argDict.property ) {
					switchType = argDict.property.match( /^mw\:PageProp\/(.*)$/ );
					if ( switchType ) {
						return '__' + switchType[1].toUpperCase() + '__';
					}
				} else {
					return WSP._serializeHTMLTag( state, token );
				}
			}
		}
	},
	span: {
		start: {
			handle: function( state, token ) {
				var argDict = Util.KVtoHash( token.attribs );
				if ( argDict['typeof'] in WSP.genContentSpanTypes ) {
					if ( argDict['typeof'] === 'mw:Nowiki' ) {
						state.inNoWiki = true;
						return '<nowiki>';
					} else if ( token.dataAttribs.src ) {
						// FIXME: compare content with original content
						// after collection
						state.tokenCollector = new endTagMatchTokenCollector(
							token,
							WSP.compareSourceHandler,
							this );
						return '';
					} else {
						return '';
					}
				} else {
					// Fall back to plain HTML serialization for spans created
					// by the editor
					return WSP._serializeHTMLTag( state, token );
				}
			}
		},
		end: {
			handle: function ( state, token ) {
				var argDict = Util.KVtoHash( token.attribs );
				if ( argDict['typeof'] in WSP.genContentSpanTypes ) {
					if ( argDict['typeof'] === 'mw:Nowiki' ) {
						state.inNoWiki = false;
						return '</nowiki>';
					} else {
						return '';
					}
				} else {
					// Fall back to plain HTML serialization for spans created
					// by the editor
					return WSP._serializeHTMLEndTag( state, token );
				}
			}
		}
	},
	figure: {
		start: {
			handle: function ( state, token ) {
				state.tokenCollector = endTagMatchTokenCollector( token, WSP._figureHandler );
				// Set the handler- not terribly useful since this one doesn't
				// have any flags, but still useful for general testing
				state.tokenCollector.handler = this;
				return '';
			}
		},
		wtEscapeHandler: WSP.wteHandlers.linkHandler
	},
	img: {
		start: {
			handle: function ( state, token ) {
				if ( token.getAttribute('rel') === 'mw:externalImage' ) {
					return token.getAttribute('src');
				} else {
					return '';
				}
			}
		}
	},
	hr: {
		start: {
			startsLine: true,
			handle: function(state, token) {
				return charSequence("----", "-", token.dataAttribs.extra_dashes);
			}
		},
		end: {
			handle: function(state, token) {
				// Default to ending the line, but omit it if the source did
				// not have one.
				this.endsLine = ! token.dataAttribs.lineContent;
				return '';
			}
		}
	},
	h1: buildHeadingHandler("="),
	h2: buildHeadingHandler("=="),
	h3: buildHeadingHandler("==="),
	h4: buildHeadingHandler("===="),
	h5: buildHeadingHandler("====="),
	h6: buildHeadingHandler("======"),
	br: {
		start: {
			handle: id('\n')
		}
	},
	b:  {
		start: {
			handle: function (state, token) {
				return state.lastRes.match(/'''''$/ ) ? "<nowiki/>'''" : "'''";
			}
		},
		end: { handle: id("'''") },
		wtEscapeHandler: WSP.wteHandlers.quoteHandler
	},
	i:  {
		start: {
			handle: function (state, token) {
				return state.lastRes.match(/'''''$/ ) ? "<nowiki/>''" : "''";
			}
		},
		end: {
			handle: id("''")
		},
		wtEscapeHandler: WSP.wteHandlers.quoteHandler
	},
	a:  {
		start: {
			handle: function(state, token) {
				state.tokenCollector = new endTagMatchTokenCollector(
					token,
					WSP._linkHandler,
					WSP);
				return '';
			}
		},
		wtEscapeHandler: WSP.wteHandlers.linkHandler
	},
	link:  {
		start: {
			handle: function(state, token) {
				state.tokenCollector = new endTagMatchTokenCollector(
					token,
					WSP._linkHandler,
					WSP);
				return '';
			}
		},
		wtEscapeHandler: WSP.wteHandlers.linkHandler
	}
};

function hasExpandedAttrs(tokType) {
	return tokType && tokType.match(/\bmw:ExpandedAttrs\/[^\s]+/);
}

WSP._serializeAttributes = function (state, token) {
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
			'data-parsoid-diff': 1,
			'data-parsoid-serialize': 1
		};

	var kv, k, v, tplKV, tplK, tplV;
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		kv = attribs[i];
		k = kv.k;

		// Ignore about and typeof if they are template-related
		if (tokType && ignoreKeys[k]) {
			continue;
		}

		if (k.length) {
			tplKV = tplAttrState.kvs[k];
			if (tplKV) {
				out.push(tplKV);
			} else {
				tplK = tplAttrState.ks[k],
				tplV = tplAttrState.vs[k],
				v    = token.getAttributeShadowInfo(k).value;

				// Deal with k/v's that were template-generated
				if (tplK) {
					k = tplK;
				}
				if (tplV){
					v = tplV;
				}

				if (v.length ) {
					// Escape HTML entities
					v = Util.escapeEntities(v);
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

/**
 * Serialize a chunk of tokens
 */
WSP.serializeTokens = function(startState, tokens, chunkCB ) {
	var i, l,
		state = Util.extendProps(startState || {},
			// Make sure these two are cloned, so we don't alter the initial
			// state for later serializer runs.
			Util.clone(this.initialState),
			Util.clone(this.options));
	state.serializer = this;
	if ( chunkCB === undefined ) {
		var out = [];
		state.chunkCB = function ( chunk, serializeID ) {
			// Keep a sliding buffer of the last emitted source
			state.lastRes = (state.lastRes + chunk).substr(-100);
			out.push( chunk );
		};
		for ( i = 0, l = tokens.length; i < l; i++ ) {
			this._serializeToken( state, tokens[i] );
		}
		return out;
	} else {
		state.chunkCB = function ( chunk, serializeID ) {
			// Keep a sliding buffer of the last emitted source
			state.lastRes = (state.lastRes + chunk).substr(-100);
			chunkCB(chunk, serializeID);
		};
		for ( i = 0, l = tokens.length; i < l; i++ ) {
			this._serializeToken( state, tokens[i] );
		}
	}
};

WSP.defaultHTMLTagHandler = {
	start: { handle: WSP._serializeHTMLTag },
	end  : { handle: WSP._serializeHTMLEndTag }
};

WSP._getTokenHandler = function(state, token) {
	var handler;
	if (token.dataAttribs.src !== undefined)  {
		var tokTypeof = Util.lookup( token.attribs, 'typeof' );
		if (tokTypeof === "mw:TemplateSource") {
			return {
				handle: id( token.dataAttribs.src ),
				isTemplateSrc: true
			};
		} else if (tokTypeof === "mw:Placeholder") {
			// implement generic src round-tripping:
			// return src, and drop the generated content
			if ( token.constructor === TagTk ) {
				state.tokenCollector = endTagMatchTokenCollector( token );
				return { handle: id( token.dataAttribs.src ) };
			} else if ( token.constructor === SelfclosingTagTk ) {
				return { handle: id( token.dataAttribs.src ) };
			} else { // EndTagTk
				state.tokenCollector = null;
				return { handle: id('') };
			}
		}
	}

	if (token.isHTMLTag() ||
			(
			 // Inherit stx: html for new elements from parent in some cases
				( token.constructor === TagTk || token.constructor === EndTagTk ) &&
				// new element
				Object.keys(token.dataAttribs).length === 0 &&
				state.parentSTX === 'html' ) )
	{
		handler = this.defaultHTMLTagHandler;
	} else {
		var tname = token.name;
		handler = this.tagHandlers[tname];
		if ( handler && handler.make ) {
			handler = handler.make(state, token);
		}
	}

	if ( ! handler ) {
		handler = this.defaultHTMLTagHandler;
	}
	if ( token.constructor === TagTk || token.constructor === SelfclosingTagTk ) {
		state.wteHandlerStack.push(handler.wtEscapeHandler || null);
		return handler.start || {};
	} else {
		return handler.end || {};
	}
};

/**
 * Serialize a token.
 */
WSP._serializeToken = function ( state, token ) {
	function emitNLs(nls, debugStr, dontBuffer) {
		// Skip emitting newlines if we used original source
		// to emit separators.
		if (!state.separatorEmittedFromSrc) {
			var sep = (state.bufferedSeparator || "") + nls;
			if (state.env.page.src && !dontBuffer) {
				// Buffer this till we know we cannot emit
				// separator from source in emitSeparator
				state.bufferedSeparator = sep;
				WSP.debug_pp("BUFFERED: " + JSON.stringify(sep) + " from " + debugStr);
			} else {
				state.emitSepChunk(sep, debugStr);
			}
		}
	}

	var res = '',
		collectorResult = false,
		handler = {};

	if (state.tokenCollector) {
		collectorResult = state.tokenCollector.collect( state, token );
		if ( collectorResult === true ) {
			// continue collecting
			return;
		} else if ( collectorResult !== false ) {
			res = collectorResult;
			if ( state.tokenCollector.handler ) {
				handler = state.tokenCollector.handler;
			}
			state.tokenCollector = null;
		}
	}

	var suppressOutput = false;

	if ( collectorResult === false ) {
		state.prevToken = state.curToken;
		state.curToken  = token;

		// Important: get this before running handlers
		var textHandler = state.textHandler;

		switch( token.constructor ) {
			case TagTk:
			case SelfclosingTagTk:
				handler = WSP._getTokenHandler( state, token );
				if ( ! handler.ignore ) {
					state.prevTagToken = state.currTagToken;
					state.currTagToken = token;
					res = handler.handle ? handler.handle( state, token ) : '';
					if (textHandler) {
						res = textHandler( state, res );
					}

					// suppress output
					if (token.dataAttribs.autoInsertedStart) {
						suppressOutput = true;
					}
				}

				// SSS FIXME: There are no SelfclosingTagTk types constructed
				// right now and can be removed to simplify the code and logic.
				if (token.constructor === SelfclosingTagTk) {
					state.wteHandlerStack.pop();
				}
				break;
			case EndTagTk:
				handler = WSP._getTokenHandler( state, token );
				state.wteHandlerStack.pop();
				if ( ! handler.ignore ) {
					state.prevTagToken = state.currTagToken;
					state.nlsSinceLastEndTag = 0;
					state.currTagToken = token;
					if ( handler.singleLine < 0 && state.singleLineMode ) {
						state.singleLineMode--;
					}
					res = handler.handle ? handler.handle( state, token ) : '';

					// suppress output
					if (token.dataAttribs.autoInsertedEnd) {
						suppressOutput = true;
					}
				}

				break;
			case String:
				// Always escape entities
				res = Util.escapeEntities(token);
				// If not in nowiki and pre context, also escape wikitext
				res = ( state.inNoWiki || state.inHTMLPre ) ? res
					: this.escapeWikiText( state, res );
				if (textHandler) {
					res = textHandler( state, res );
				}
				break;
			case CommentTk:
				res = '<!--' + token.value + '-->';
				// don't consider comments for changes of the onStartOfLine status
				// XXX: convert all non-tag handlers to a similar handler
				// structure as tags?
				handler = { solTransparent: true };
				break;
			case NlTk:
				res = textHandler ? textHandler( state, '\n' ) : '\n';
				break;
			case EOFTk:
				res = '';
				state.chunkCB( res, state.selser.serializeInfo );
				break;
			default:
				res = '';
				console.warn( 'Unhandled token type ' + JSON.stringify( token ) );
				console.trace();
				break;
		}
	}

	// FIXME: figure out where the non-string res comes from
	if ( res === undefined || res === null || res.constructor !== String ) {
		console.error("-------- Warning: Serializer error --------");
		console.error("TOKEN: " + JSON.stringify(token));
		console.error(state.env.page.name + ": res was undefined or not a string!");
		console.error(JSON.stringify(res));
		console.trace();
		res = '';
	}

	this.debug(  "nl:", state.onNewline,
				", sol:", state.onStartOfLine,
				", sl-mode:", state.singleLineMode,
				", res:", res,
				", T:", token);

	// start-of-line processing
	if (handler.startsLine && !state.onStartOfLine && !suppressOutput && !state.singleLineMode) {
		// Emit newlines separately from regular content
		// for the benefit of the selective serializer.
		//
		// Dont buffer newlines if separater hasn't been
		// emitted from original source -- emit nls right
		// away since these are SOL nls
		emitNLs('\n', "sol: ", false);
	}

	// SSS FIXME: Questionable avoidance of newline in single-line mode
	// but seems to affect about 7 wt2wt tests right now.  An example
	// wikitext that is impacted is:
	//
	//   :i1
	//   ::i2
	//
	// which parses as:
	//
	//   <dl><dd>i1
	//   <dl><dd>i2</dd></dl></dd></dl>
	//
	// The newline after i1 needs to be emitted -- the avoidance below is a
	// hack since this is not a separator newline and wont be captured by
	// emitSeparator.  An alternative fix is to create the mirror version of
	// 'migrateTrailingNLs' in DOM to move preceding nls *into* a node that
	// starts a line in wikitext. So, in this example, rewrite the DOM to:
	//
	//   <dl><dd>i1<dl>
	//   <dd>i2</dd></dl></dd></dl>
	//
	// Something to consider later maybe.
	//
	// content processing
	if (!state.env.page.src && state.singleLineMode && !handler.isTemplateSrc) {
		// XXX: Switch singleLineMode to stack if there are more
		// exceptions than just isTemplateSrc later on.
		res = res.replace(/\n/g, '');
	}

	state.chunkCB( suppressOutput ? '' : res, state.selser.serializeInfo );
	this.debug_pp("===> ", "res: ", suppressOutput ? '' : res);

	if (res.match(/[\r\n]$/)) {
		state.onNewline = true;
		state.onStartOfLine = true;
	} else if ( res !== '' ) {
		state.onNewline = false;
		if (!handler.solTransparent) {
			state.onStartOfLine = false;
		}
	}

	if (handler.emitsNL) {
		emitNLs('\n', "emitsNL: ", true);
	} else if (state.bufferedSeparator) {
		state.emitSepChunk(state.bufferedSeparator);
	}

	// end-of-line processing
	if (handler.endsLine && !state.onNewline) {
		// Buffer newlines if we have access to original source.
		// These will be emitted if separator cannot be extracted
		// from original source for whatever reason.
		emitNLs('\n', "eol: ", false);
	}

	if ( handler.singleLine > 0 ) {
		state.singleLineMode += handler.singleLine;
	}

	// Reset
	state.separatorEmittedFromSrc = false;
};

WSP._getDOMAttribs = function( attribs ) {
	// convert to list fo key-value pairs
	var out = [],
		ignoreAttribs = {
			'data-parsoid': 1,
			'data-ve-changed': 1,
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

WSP._getDOMRTInfo = function( attribs ) {
	if ( attribs['data-parsoid'] ) {
		return JSON.parse( attribs['data-parsoid'].value || '{}' );
	} else {
		return {};
	}
};

// 1. Update state with the set of templated attributes.
// 2. Strip non-semantic leading and trailing newlines.
WSP.preprocessDOM = function(node, state, inPre, haveOrigSrc) {

	function setupSeparator(nodeA, nodeB, sepNodes, sepText) {
		// Create meta with the separator src in data-sep attribute
		var sepMeta = (nodeA || nodeB).ownerDocument.createElement('meta');
		sepMeta.setAttribute("typeof", "mw:Separator");
		sepMeta.setAttribute("data-sep", sepText.join(''));

		if (nodeA) {
			nodeA.parentNode.insertBefore(sepMeta, nodeA.nextSibling);
		} else {
			nodeB.parentNode.insertBefore(sepMeta, nodeB.previousSibling);
		}

		// delete separator nodes
		for (var i = 0, n = sepNodes.length; i < n; i++) {
			sepNodes[i].parentNode.removeChild(sepNodes[i]);
		}
	}

	if (node.nodeName.toLowerCase() === "meta") {
		var prop = node.getAttribute("property");
		if (prop.match(/mw:objectAttr/)) {
			var templateId = node.getAttribute("about");
			var src  = this._getDOMRTInfo(node.attributes).src;
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
			node.parentNode.removeChild(node);
		}
	} else {
		var about = node.nodeType === Node.ELEMENT_NODE ? node.getAttribute("about") : "";
		var child = node.firstChild;
		var next, prev, childIsPre, str;

		while (child) {
			// Get the next sibling first thing because we may delete this child
			next = child.nextSibling, prev = child.previousSibling;
			childIsPre = DU.hasNodeName(child, "pre");

			// Descend and recurse
			this.preprocessDOM(child, state, inPre || childIsPre, haveOrigSrc);

			// Collapse a sequence of text nodes and delete empty text nodes
			// NOTE: We could have used body.normalize() and got this for free,
			// but JSDOM is buggy and strips empty comments.
			if (child.nodeType === Node.TEXT_NODE) {
				var buf = [child.data];
				while (next && next.nodeType === Node.TEXT_NODE) {
					var nextnext = next.nextSibling;
					buf.push(next.data);
					node.removeChild(next);
					next = nextnext;
				}

				if (buf.length > 1) {
					child.data = buf.join('');
				}

				// Delete empty text nodes
				if (child.data === '') {
					node.removeChild(child);
				}
			}

			child = next;
		}

		// Post-text-normalization, strip runs of whitespace and comments and
		// record them in a meta-tag.
		//
		// (http://dev.w3.org/html5/spec-LC/content-models.html#content-models)
		//
		// Dont normalize if we are in a PRE-node or if the node is a mw:Entity SPAN
		// Or if the node has no element-node child
		if (!inPre &&
			!(DU.hasNodeName(node, 'span') && node.getAttribute('typeof') === 'mw:Entity') &&
			(!haveOrigSrc || DU.hasElementChild(node)))
		{
			var prevSentinel = null,
				waitForSentinel = false,
				sepNodes = [],
				sepText = [];

			child = node.firstChild;
			while (child) {
				var nodeType = child.nodeType;

				next = child.nextSibling;

				// Delete empty text nodes
				if (nodeType === Node.TEXT_NODE && child.data === '') {
					node.removeChild(child);
					child = next;
					continue;
				}

				if (!haveOrigSrc) {
					if (nodeType === Node.TEXT_NODE) {
						str = child.data;
						// Strip leading/trailing newlines if preceded by or
						// followed by block nodes -- these newlines are syntactic
						// and can be normalized away since the serializer in sourceless
						// mode is tuned to normalize newlines.
						if (str.match(/\n$/) && (!next || DU.isBlockNode(next))) {
							child.data = str.replace(/\n+$/, '');
						}
					    if (str.match(/^\n/) && (!prev || DU.isBlockNode(prev))) {
							child.data = str.replace(/^\n+/, '');
						}
					}
				} else {
					switch (nodeType) {
						case Node.TEXT_NODE:
							str = child.data;
							if (!waitForSentinel && str.match(/^\s+$/)) {
								sepText.push(str);
								sepNodes.push(child);
							} else {
								prevSentinel = null;
								waitForSentinel = true;
							}
							break;

						case Node.COMMENT_NODE:
							if (!waitForSentinel) {
								sepText.push("<!--");
								sepText.push(child.data);
								sepText.push("-->");
								sepNodes.push(child);
							}
							break;

						case Node.ELEMENT_NODE:
							if (!waitForSentinel && sepNodes.length > 0) {
								setupSeparator(prevSentinel, child, sepNodes, sepText);
							}
							waitForSentinel = false;
							prevSentinel = child;
							sepNodes = [];
							sepText = [];
							break;
					}
				}

				child = next;
			}

			if (prevSentinel && sepNodes.length > 0) {
				setupSeparator(prevSentinel, null, sepNodes, sepText);
			}
		}
	}
};

/**
 * Serialize an HTML DOM document.
 */
WSP.serializeDOM = function( node, chunkCB, finalCB, selser ) {
	var state = Util.extendProps({},
		// Make sure these two are cloned, so we don't alter the initial
		// state for later serializer runs.
		Util.clone(this.initialState),
		Util.clone(this.options));
	state.serializer = this;

	try {
		if ( selser === undefined ) {
			// Clone the DOM if we are not in selser-mode
			// since we will modify the DOM in preprocessDOM.
			node = node.cloneNode(true);
		} else {
			// In selser mode, cloning is not required since
			// selser passes us a cloned DOM.
			state.selser = selser;
		}

		// Preprocess DOM (collect tpl attr tags + strip empty white space)
		this.preprocessDOM(node, state, false, state.env.page.src);
		this.debug(" DOM ==> ", node.innerHTML);

		var out = [];
	    if ( ! chunkCB ) {
			state.chunkCB = function ( chunk, serializeID ) {
				// Keep a sliding buffer of the last emitted source
				state.lastRes = (state.lastRes + chunk).substr(-100);
				out.push( chunk );
			};
		} else {
			state.chunkCB = function ( chunk, serializeID ) {
				// Keep a sliding buffer of the last emitted source
				state.lastRes = (state.lastRes + chunk).substr(-100);
				chunkCB(chunk, serializeID);
			};
		}

		this._serializeDOM( node, state );
		this._serializeToken( state, new EOFTk() );

		if ( finalCB && typeof finalCB === 'function' ) {
			finalCB();
		}

		return chunkCB ? '' : out.join('');
	} catch (e) {
		console.warn("e: " + JSON.stringify(e) + "; stack: " + e.stack);
		state.env.errCB(e);
		throw e;
	}
};

function firstBlockNodeAncestor(node) {
	while (!isHtmlBlockTag(node.nodeName.toLowerCase())) {
		node = node.parentNode;
	}
	return node;
}

function gatherInlineText(buf, node) {
	switch (node.nodeType) {
		case Node.ELEMENT_NODE:
			var name = node.nodeName.toLowerCase();
			if (isHtmlBlockTag(name)) {
				return;
			}

		/* -----------------------------------------------------------------
		 * SSS: check not needed if we are not doing a full tokenization
		 * on the gathered text
		 *
			// Ignore text for extlink/numbered
			if (name === 'a' && node.attributes["rel"].value === 'mw:ExtLink/Numbered') {
				return;
			}
		 * -----------------------------------------------------------------*/

			var children = node.childNodes;
			for (var i = 0, n = children.length; i < n; i++) {
				gatherInlineText(buf, children[i]);
			}

			return;
		case Node.COMMENT_NODE:
			buf.push("<--" + node.data + "-->");
			return;
		case Node.TEXT_NODE:
			buf.push(node.data);
			return;
		default:
			return;
	}
}

/**
 * Internal worker. Recursively serialize a DOM subtree by creating tokens and
 * calling _serializeToken on each of these.
 */
WSP._serializeDOM = function( node, state ) {
	var newNLs;
	// serialize this node
	if (node.nodeType === Node.ELEMENT_NODE) {
		if (state.activeTemplateId &&
			state.activeTemplateId === node.getAttribute("about"))
		{
			// skip -- template content
			return;
		} else {
			state.activeTemplateId = null;
		}

		if (!state.activeTemplateId) {
			// Check if this node marks the start of template output
			// NOTE: Since we are deleting all mw:Object/**/End markers,
			// we need not verify if it is an End marker
			var typeofVal = node.getAttribute("typeof");
			if (typeofVal && typeofVal.match(/\bmw:Object(\/[^\s]+|\b)/)) {
				state.activeTemplateId = node.getAttribute("about");
				var attrs = [ new KV("typeof", "mw:TemplateSource") ];
				var dps = node.getAttribute("data-parsoid-serialize");
				if (dps) {
					attrs.push(new KV("data-parsoid-serialize", dps));
				}
				var dummyToken = new SelfclosingTagTk("meta",
					attrs,
					{ src: this._getDOMRTInfo(node.attributes).src }
				);

				if ( dps ) {
					state.selser.serializeInfo = dps;
				}
				this._serializeToken(state, dummyToken);
				return;
			}
		}
	} else if (node.nodeType !== Node.COMMENT_NODE) {
		state.activeTemplateId = null;
	}

	var i, n, child, children;

	switch( node.nodeType ) {
		case Node.ELEMENT_NODE:
			var name = node.nodeName.toLowerCase(),
				tkAttribs = this._getDOMAttribs(node.attributes),
				tkRTInfo = this._getDOMRTInfo(node.attributes),
				parentSTX = state.parentSTX;

			children = node.childNodes;

			if (isHtmlBlockTag(name)) {
				state.currLine = {
					text: null,
					numPieces: 0,
					processed: false,
					hasBracketPair: false,
					hasHeadingPair: false
				};
			}

			var tailSrc = '';
			// Hack for link tail escaping- access to the next node is
			// difficult otherwise.
			// TODO: Implement this more cleanly!
			if ( node.nodeName.toLowerCase() === 'a' &&
					node.getAttribute('rel') === 'mw:WikiLink' )
			{
				var dp = JSON.parse(node.getAttribute('data-parsoid') || '{}');
				if ( dp.stx !== 'html' &&
					! dp.tail &&
					node.nextSibling && node.nextSibling.nodeType === Node.TEXT_NODE &&
					// TODO: use tokenizer
					node.nextSibling.nodeValue &&
					node.nextSibling.nodeValue.match(/^[a-z]/) )
				{
					tailSrc = '<nowiki/>';
				}
			}

			// Handle html-pres specially
			// 1. If the node has a leading newline, add one like it (logic copied from VE)
			// 2. If not, and it has a data-parsoid strippedNL flag, add it back.
			// This patched DOM will serialize html-pres correctly.
			//
			// FIXME: This code should be extracted into a DOMUtils.js file to be used
			// by the testing setup.
			if (name === 'pre' && tkRTInfo.stx === 'html') {
				var modified = false;
				var fc = node.firstChild;
				if (fc && fc.nodeType === Node.TEXT_NODE) {
					var matches = fc.data.match(/^(\r\n|\r|\n)/);
					if (matches) {
						fc.insertData(0, matches[1]);
						modified = true;
					}
				}

				var strippedNL = tkRTInfo.strippedNL;
				if (!modified && strippedNL) {
					if (fc && fc.nodeType === Node.TEXT_NODE) {
						fc.insertData(0, strippedNL);
					} else {
						node.insertBefore(node.ownerDocument.createTextNode(strippedNL), fc);
					}
				}
			}

			var serializeInfo = null;
			if ( state.selser.serializeInfo === null ) {
				serializeInfo = node.getAttribute( 'data-parsoid-serialize' ) || null;
				state.selser.serializeInfo = serializeInfo;
			}

			// Serialize the start token
			var startToken = new TagTk(name, tkAttribs, tkRTInfo);
			this._serializeToken(state, startToken);

			// Newly created elements/tags in this list inherit their default
			// syntax from their parent scope
			var inheritSTXTags = { tbody:1, tr: 1, td: 1, li: 1, dd: 1, dt: 1 },
				// These reset the inherited syntax no matter what
				setSTXTags = { table: 1, ul: 1, ol: 1, dl: 1 },
				// These (and inline elements) reset the default syntax to
				// undefined
				noHTMLSTXTags = {p: 1};

			// Set self to parent token if data-parsoid is set
			if ( Object.keys(tkRTInfo).length > 0 ||
					setSTXTags[name] ||
					! inheritSTXTags[name] )
			{
				if ( noHTMLSTXTags[name] || ! Util.isBlockTag(name) ) {
					// Don't inherit stx in these
					state.parentSTX = undefined;
				} else {
					state.parentSTX = tkRTInfo.stx;
				}
			}

			// Clear out prevTagToken at each dom level
			var oldPrevToken = state.prevToken, oldPrevTagToken = state.prevTagToken;
			state.prevToken = null;
			state.prevTagToken = null;

			var prevEltChild = null;
			for (i = 0, n = children.length; i < n; i++) {
				child = children[i];

				// Ignore -- handled separately
				if (DU.hasNodeName(child, "meta") &&
					child.getAttribute("typeof") === "mw:Separator")
				{
					continue;
				}

				// Skip over comment, white-space text nodes, and tpl-content nodes
				var nodeType = child.nodeType;
				if (  nodeType !== Node.COMMENT_NODE &&
					!(nodeType === Node.TEXT_NODE && child.data.match(/^\s*$/)) &&
					!(nodeType === Node.ELEMENT_NODE &&
						state.activeTemplateId &&
						state.activeTemplateId === child.getAttribute("about"))
					)
				{
					if (child.nodeType === Node.ELEMENT_NODE) {
						if (prevEltChild === null) {
							if (!DU.hasNodeName(node, "pre")) {
								// extract separator text between node and child;
								state.emitSeparator(node, child, START_SEP);
							}
						} else if (prevEltChild.nodeType === Node.ELEMENT_NODE) {
							if (!DU.hasNodeName(node, "pre")) {
								// extract separator text between prevEltChild and child;
								state.emitSeparator(prevEltChild, child, IE_SEP);
							}
						}
					}

					prevEltChild = child;
				}

				this._serializeDOM( children[i], state );
			}

			if (prevEltChild && prevEltChild.nodeType === Node.ELEMENT_NODE) {
				// extract separator text between prevEltChild and node
				if (!DU.hasNodeName(node, "pre")) {
					state.emitSeparator(prevEltChild, node, END_SEP);
				}
			}

			// Reset parent state
			state.prevTagToken = oldPrevTagToken;
			state.prevToken = oldPrevToken;
			state.parentSTX = parentSTX;

			// then the end token
			this._serializeToken(state, new EndTagTk(name, tkAttribs, tkRTInfo));

			if ( tailSrc ) {
				// emit the tail
				state.chunkCB( tailSrc, state.selser.serializeID );
			}

			if ( serializeInfo !== null ) {
				state.selser.serializeInfo = null;
			}

			break;
		case Node.TEXT_NODE:
			if (state.currLine.text === null) {
				var buf = [],
					bn = firstBlockNodeAncestor(node);

				children = bn.childNodes;
				for (i = 0, n = children.length; i < n; i++) {
					gatherInlineText(buf, children[i]);
				}
				state.currLine.numPieces = n;
				state.currLine.text = buf.join('');
			}
			this._serializeToken( state, node.data );
			break;
		case Node.COMMENT_NODE:
			// delay the newline creation until after the comment
			this._serializeToken( state, new CommentTk( node.data ) );
			break;
		default:
			console.warn( "Unhandled node type: " +
					node.outerHTML );
			break;
	}
};

if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
