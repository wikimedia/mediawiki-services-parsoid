"use strict";

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
 *
 * @author Subramanya Sastry <ssastry@wikimedia.org>
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 * ---------------------------------------------------------------------- */

require('./core-upgrade.js');
var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	WikitextConstants = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	Util = require('./mediawiki.Util.js').Util,
	SanitizerConstants = require('./ext.core.Sanitizer.js').SanitizerConstants,
	$ = require( 'jquery' ),
	tagWhiteListHash;

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

WEHP.tdHandler = function(state, text) {
	return text.match(/\|/) || (isTd(state.currTagToken) && text.match(/^[-+]/));
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
	if ( options.env.debug || options.env.trace ) {
		WikitextSerializer.prototype.debug = function ( ) {
			var out = ['WTS:'];
			for ( var i = 0; i < arguments.length; i++) {
				out.push( JSON.stringify(arguments[i]) );
			}
			console.error(out.join(' '));
		}
	} else {
		WikitextSerializer.prototype.debug = function ( ) {}
	}
};

var WSP = WikitextSerializer.prototype;

WSP.wteHandlers = new WikitextEscapeHandlers();

/* *********************************************************************
 * Here is what the state attributes mean:
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
 * emitNewlineOnNextToken
 *    true if there is a pending newline waiting to be emitted on
 *    next token -- this let us handle cases where t
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
 * availableNewlineCount
 *    # of newlines that have been encountered so far but not emitted yet.
 *    Newlines are buffered till they need to be output.  This lets us
 *    swallow newlines in contexts where they shouldn't be emitted for
 *    ensuring equivalent wikitext output. (ex dom: ..</li>\n\n</li>..)
 *
 * nlsSinceLastEndTag
 *    # of newlines that have been emitted since last end-tag
 *    Used to ensure that the right # of newlines are emitted between
 *    tag-pairs that need X number of newlines.  This state variable
 *    tracks newlines emitted while dealing with comments, ws and
 *    other such tokens that show up in the interim.
 *
 * wteHandlerStack
 *    stack of wikitext escaping handlers -- these handlers are responsible
 *    for smart escaping when the surrounding wikitext context is known.
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
	listStack: [],
	onNewline: true,
	emitNewlineOnNextToken: false,
	onStartOfLine : true,
	availableNewlineCount: 0,
	nlsSinceLastEndTag: 0,
	singleLineMode: 0,
	wteHandlerStack: [],
	tplAttrs: {},
	currLine: {
		text: null,
		processed: false,
		hasBracketPair: false,
		hasHeadingPair: false
	},
	serializeTokens: function(newLineStart, tokens, chunkCB) {
		var initState = {
			onNewline: newLineStart,
			onStartOfLine: newLineStart,
			tplAttrs: this.tplAttrs,
			currLine: this.currLine,
			wteHandlerStack: []
		}
		return this.serializer.serializeTokens(initState, tokens, chunkCB);
	}
};

var id = function(v) {
	return function( state ) {
		return v;
	};
};

var installCollector = function ( collectorConstructor, cb, handler, state, token ) {
	state.tokenCollector = new collectorConstructor( token, cb, handler );
	return '';
};

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
	var match = text.match(/^((?:.*?|[\r\n]+[^\r\n])*?)((?:\r?\n)*)$/);
	return ["<nowiki>", match[1], "</nowiki>", match[2]].join('');
}

WSP.escapeWikiText = function ( state, text ) {
	// console.warn("---EWT:ALL1---");
    // console.warn("t: " + text);
	/* -----------------------------------------------------------------
	 * General strategy: If a substring requires escaping, we can escape
	 * the entire string without further analysis of the rest of the string.
	 * ----------------------------------------------------------------- */

	// Quick check for the common case (useful to kill a majority of requests)
	//
	// Pure white-space or text without wt-special chars need not be analyzed
	if (!text.match(/^[ \t][^\s]+|[<>\[\]\-\+\|'!=#\*:;{}]/)) {
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

	var sol = state.onNewline || state.emitNewlineOnNextToken;
	var hasNewlines = text.match(/\n./);
	if (!hasNewlines) {
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

	if (sol && text.match(/(^ |\n )[^\s]+/)) {
		// console.warn("---EWT:F6---");
		return escapedText(text);
	}

	// escape nowiki tags
	text = text.replace(/<(\/?nowiki)>/g, '&lt;$1&gt;');

	// SSS FIXME: pre-escaping is currently broken since the front-end parser
	// eliminated pre-tokens in the tokenizer and moved to a stream handler.
	//
	// Use the tokenizer to see if we have any wikitext tokens
	if (this.wteHandlers.hasWikitextTokens(state, sol, text)) {
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
		handler.startsNewline = true;
	} else {
		var curList = stack.last();
		//console.warn(JSON.stringify( stack ));
		bullets = curList.bullets + curList.itemBullet + bullet;
		curList.itemCount++;
		// A nested list, not directly after a list item
		if (curList.itemCount > 1 && !isListItem(state.prevToken)) {
			res = bullets;
			handler.startsNewline = true;
		} else {
			res = bullet;
			handler.startsNewline = false;
		}
	}
	stack.push({ itemCount: 0, bullets: bullets, itemBullet: ''});
	WSP.debug('lh res', bullets, res, handler );
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
		handler.startsNewline = true;
		res = curList.bullets + bullet;
	} else {
		handler.startsNewline = false;
		res = bullet;
	}
	WSP.debug( 'lih', token, res, handler );
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
	var caption = state.serializeTokens(false, figTokens.slice(fcStartIndex+1, fcEndIndex)).join('');

	// Get the image resource name
	// FIXME: file name has been capitalized -- need some fix in the parser
	var argDict = Util.KVtoHash( img.attribs );
	var imgR = argDict.resource.replace(/(^\[:)|(\]$)/g, '');

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
			size[k] = v;
		} else {
			// Output size first and clear it
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
	if ( token.name === 'pre' ) {
		// html-syntax pre is very similar to nowiki
		state.inHTMLPre = true;
	}

	if (token.dataAttribs.autoInsertedStart) {
		return '';
	}

	var close = '';
	if ( (Util.isVoidElement( token.name ) && !token.dataAttribs.noClose) || token.dataAttribs.selfClose ) {
		close = '/';
	}

	var sAttribs = WSP._serializeAttributes(state, token);
	if (sAttribs.length > 0) {
		return '<' + (token.dataAttribs.srcTagName || token.name) + ' ' + sAttribs + close + '>';
	} else {
		return '<' + (token.dataAttribs.srcTagName || token.name) + close + '>';
	}
};

WSP._serializeHTMLEndTag = function ( state, token ) {
	if ( token.name === 'pre' ) {
		state.inHTMLPre = false;
	}
	if ( !token.dataAttribs.autoInsertedEnd && ! Util.isVoidElement( token.name ) && !token.dataAttribs.selfClose  ) {
		return '</' + (token.dataAttribs.srcTagName || token.name) + '>';
	} else {
		return '';
	}
};


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
		tplAttrState = { kvs: {}, ks: {}, vs: {} },
		tail = '',
		isCat = false,
		isWikiLink = false,
		hrefFromTpl = true,
		tokenData = token.dataAttribs,
		target, linkText, unencodedTarget,
		hrefInfo = { fromsrc: false },
		href;

		// Helper function for getting RT data from the tokens
		function populateRoundTripData() {
			isCat = attribDict.rel.match( /\bmw:WikiLink\/Category/ );
			isWikiLink = attribDict.rel.match( /\bmw:WikiLink/ );
			target = tplAttrState.vs.href;

			// If the link target came from a template, target will be non-null
			if (target && !isCat) {
				href = target;
			} else {
				href = attribDict.href;
				hrefFromTpl = false;
				hrefInfo = token.getAttributeShadowInfo( 'href' );
				target = hrefInfo.value; //.replace(/^(\.\.\/)+/, ''),

				if ( hrefInfo.modified ) {
					// there was no rt info or the href was modified: normalize it
					if ( isWikiLink ) {
						// We (lightly) percent-encode wikilinks (but not
						// external links) on the way out, and expect
						// percent-encoded links on the way in. Wikitext links
						// are always serialized in decoded form, so decode
						// them here.
						target = Util.decodeURI(target)
												.replace( /_/g, ' ' )
												.replace(/^(\.\.\/)+/, '');
						tail = '';
					}
				} else {
					tail = tokenData.tail || '';
				}
			}

			unencodedTarget = target;

			//if ( ! hrefInfo.fromsrc && target.constructor === String ) {
			//	// Escape anything that looks like percent encoding, since we
			//	// decode the wikitext for regular attributes.
			//	//target = target.replace( /%(?=[a-f\d]{2})/gi, '%25' );
			//}


			// If the normalized link text is the same as the normalized
			// target and the link was either modified or not originally a
			// piped link, serialize to a simple link.
			// TODO: implement
			linkText = Util.tokensToString( tokens, true );
		}

	// Check if this token has attributes that have been
	// expanded from templates or extensions
	if (hasExpandedAttrs(attribDict['typeof'])) {
		tplAttrState = state.tplAttrs[attribDict.about];
	}

	if ( attribDict.rel && attribDict.rel.match( /\bmw:/ ) &&
			attribDict.href !== undefined )
	{
		// we have a rel starting with mw: prefix and href
		if ( attribDict.rel.match( /\bmw:WikiLink/ ) ) {
			// We'll need to check for round-trip data
			populateRoundTripData();

			if ((hrefFromTpl && tokenData.stx === 'simple') ||
				(linkText.constructor === String &&
				 env.normalizeTitle( Util.stripSuffix( linkText, tail ) ) ===
				 env.normalizeTitle( Util.decodeURI( unencodedTarget ) ) &&
				 (  Object.keys( tokenData ).length === 0 ||
					hrefInfo.modified ||
					tokenData.stx === 'simple' )
				))
			{
				return '[[' + target + ']]' + tail;
			} else {
				if (tokenData.pipetrick) {
					linkText = '';
				} else if ( isCat ) {
					// FIXME: isCat is only set as a side-effect of
					// populateRoundTripData, which is not the best code
					// style!
					var targetParts = target.match( /^([^#]*)#(.*)/ );

					if ( tplAttrState.vs.href ) {
						target = tplAttrState.vs.href;
					} else if ( targetParts && targetParts.length > 1 ) {
						target = targetParts[1].replace( /^(\.\.?\/)*/, '' );
					}

					if ( tplAttrState.vs['mw:sortKey'] ) {
						linkText = tplAttrState.vs['mw:sortKey'];
					} else if ( targetParts && targetParts.length > 2 ) {
						linkText = Util.decodeURI( targetParts[2] ).replace( /%23/g, '#' ).replace( /%20/g, ' ' );
					}
				} else {
					linkText = state.serializeTokens(false, tokens).join('');
					linkText = Util.stripSuffix( linkText, tail );
				}

				var needToChangeCategory = token.name === 'link' &&
						linkText !== '' &&
						linkText !== target && isCat,
					hasOtherLinkText = !isCat && linkText !== '';

				if ( needToChangeCategory || hasOtherLinkText || tokenData.pipetrick ) {
					return '[[' + target + '|' + linkText + ']]' + tail;
				} else {
					return '[[' + target + ']]' + tail;
				}
			}
		} else if ( attribDict.rel === 'mw:ExtLink' ) {
			populateRoundTripData();

			return '[' + href + ' ' +
				state.serializeTokens(false, tokens ).join('') +
				']';
		} else if ( attribDict.rel.match( /mw:ExtLink\/(?:ISBN|RFC|PMID)/ ) ) {
			return tokens.join('');
		} else if ( attribDict.rel === 'mw:ExtLink/URL' ) {
			populateRoundTripData();
			return Util.tokensToString( target );
		} else if ( attribDict.rel === 'mw:ExtLink/Numbered' ) {
			populateRoundTripData();
			return '[' + Util.tokensToString( target ) + ']';
		} else if ( attribDict.rel === 'mw:Image' ) {
			// simple source-based round-tripping for now..
			// TODO: properly implement!
			if ( tokenData.src ) {
				return tokenData.src;
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
				state.serializeTokens(state.onNewline, tokens ) +
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

WSP.genContentSpanTypes = { 'mw:Nowiki':1, 'mw:Entity': 1 };

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
		return state.serializeTokens(state.onNewline, tokens ).join('');
	} else if ( content === token.dataAttribs.srcContent ) {
		return token.dataAttribs.src;
	} else {
		return content;
	}
};

function buildHeadingHandler(headingWT) {
	return {
		start: { startsNewline: true, handle: openHeading(headingWT), defaultStartNewlineCount: 2 },
		end: { endsLine: true, handle: closeHeading(headingWT) },
		wtEscapeHandler: WSP.wteHandlers.headingHandler
	};
}

/* *********************************************************************
 * startsNewline
 *     if true, the wikitext for the dom subtree rooted
 *     at this html tag requires a new line context.
 *
 * endsLine
 *     if true, the wikitext for the dom subtree rooted
 *     at this html tag ends the line.
 *
 * pairsSepNlCount
 *     # of new lines required between wikitext for dom siblings
 *     of the same tag type (..</p><p>.., etc.)
 *
 * newlineTransparent
 *     if true, this token does not change the newline status
 *     after it is emitted.
 *
 * singleLine
 *     if 1, the wikitext for the dom subtree rooted at this html tag
 *     requires all content to be emitted on the same line without
 *     any line breaks. +1 sets the single-line mode (on descending
 *     the dom subtree), -1 clears the single-line mod (on exiting
 *     the dom subtree).
 *
 * ignore
 *     if true, the serializer pretends as if it never saw this token.
 * ********************************************************************* */
function dashyString(prefix, num_dashes) {
	if (num_dashes && num_dashes > 0) {
		var buf = [prefix];
		for (var i = 0; i < num_dashes; i++) {
			buf.push("-");
		}
		return buf.join('');
	} else {
		return prefix;
	}
}

WSP.tagHandlers = {
	body: {
		end: {
			handle: function(state, token) {
				// swallow trailing new line
				state.emitNewlineOnNextToken = false;
				return '';
			}
		}
	},
	ul: {
		start: {
			startsNewline : true,
			handle: function ( state, token ) {
					return WSP._listHandler( this, '*', state, token );
			},
			pairSepNLCount: 2,
			newlineTransparent: true
		},
		end: {
			endsLine: true,
			handle: WSP._listEndHandler
		}
	},
	ol: {
		start: {
			startsNewline : true,
			handle: function ( state, token ) {
					return WSP._listHandler( this, '#', state, token );
			},
			pairSepNLCount: 2,
			newlineTransparent: true
		},
		end: {
			endsLine      : true,
			handle: WSP._listEndHandler
		}
	},
	dl: {
		start: {
			startsNewline : true,
			handle: function ( state, token ) {
					return WSP._listHandler( this, '', state, token );
			},
			pairSepNLCount: 2
		},
		end: {
			endsLine: true,
			handle: WSP._listEndHandler
		}
	},
	li: {
		start: {
			handle: function ( state, token ) {
				return WSP._listItemHandler( this, '', state, token );
			},
			singleLine: 1,
			pairSepNLCount: 1
		},
		end: {
			singleLine: -1
		},
		wtEscapeHandler: WSP.wteHandlers.liHandler
	},
	// XXX: handle single-line vs. multi-line dls etc
	dt: {
		start: {
			singleLine: 1,
			handle: function ( state, token ) {
				return WSP._listItemHandler( this, ';', state, token );
			},
			pairSepNLCount: 1,
			newlineTransparent: true
		},
		end: {
			singleLine: -1
		},
		wtEscapeHandler: WSP.wteHandlers.liHandler
	},
	dd: {
		start: {
			singleLine: 1,
			handle: function ( state, token ) {
				return WSP._listItemHandler( this, ':', state, token );
			},
			pairSepNLCount: 1,
			newlineTransparent: true
		},
		end: {
			endsLine: true,
			singleLine: -1
		},
		wtEscapeHandler: WSP.wteHandlers.liHandler
	},
	// XXX: handle options
	table: {
		start: {
			handle: function(state, token) {
				var wt = token.dataAttribs.startTagSrc || "{|";
				return WSP._serializeTableTag(wt, '', state, token);
			}
		},
		end: {
			handle: function(state, token) {
				if ( state.prevTagToken && state.prevTagToken.name === 'tr' ) {
					this.startsNewline = true;
				} else {
					this.startsNewline = false;
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
					this.startsNewline = false;
					return WSP._serializeTableTag("!!", sep, state, token);
				} else {
					this.startsNewline = true;
					return WSP._serializeTableTag( "!", sep, state, token);
				}
			}
		},
		wtEscapeHandler: WSP.wteHandlers.thHandler
	},
	tr: {
		start: {
			handle: function ( state, token ) {
				// If the token has 'startTagSrc' set, it means that the tr was present
				// in the source wikitext and we emit it -- if not, we ignore it.
				var da = token.dataAttribs;
				if (state.prevToken.constructor === TagTk
					&& state.prevToken.name === 'tbody'
					&& !da.startTagSrc )
				{
					return '';
				} else {
					return WSP._serializeTableTag(da.startTagSrc || "|-", '', state, token );
				}
			},
			startsNewline: true
		}
	},
	td: {
		start: {
			handle: function ( state, token ) {
				var da = token.dataAttribs;
				var sep = " " + (da.attrSepSrc || "|");
				if ( da.stx_v === 'row' ) {
					this.startsNewline = false;
					return WSP._serializeTableTag(da.startTagSrc || "||", sep, state, token);
				} else {
					this.startsNewline = true;
					return WSP._serializeTableTag(da.startTagSrc || "|", sep, state, token);
				}
			}
		},
		wtEscapeHandler: WSP.wteHandlers.tdHandler
	},
	caption: {
		start: {
			startsNewline: true,
			handle: WSP._serializeTableTag.bind(null, "|+", ' |')
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
			startsNewline : true,
			pairSepNLCount: 2
		},
		end: {
			endsLine: true
		}
	},
	// XXX: support indent variant instead by registering a newline handler?
	pre: {
		start: {
			startsNewline: true,
			pairSepNLCount: 2,
			handle: function( state, token ) {
				state.inIndentPre = true;
				state.textHandler = function( currState, t ) {
					// replace \n in the middle of the text with
					// a leading space, and start of text if
					// the serializer in at start of line state.
					var res = t.replace(/\n(?!$)/g, '\n ' );
					return currState.onStartOfLine ? ' ' + res : res;
				};
				return ' ';
			}
		},
		end: {
			endsLine: true,
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
							this.newlineTransparent = true;
							if ( argDict.content === 'nowiki' ) {
								state.inNoWiki = true;
							} else if ( argDict.content === '/nowiki' ) {
								state.inNoWiki = false;
							} else {
								console.warn( JSON.stringify( argDict ) );
							}
							return '<' + argDict.content + '>';
						case 'mw:IncludeOnly':
							this.newlineTransparent = true;
							return token.dataAttribs.src;
						case 'mw:NoInclude':
							this.newlineTransparent = true;
							return '<noinclude>';
						case 'mw:NoInclude/End':
							return '</noinclude>';
						case 'mw:OnlyInclude':
							this.newlineTransparent = true;
							return '<onlyinclude>';
						case 'mw:OnlyInclude/End':
							return '</onlyinclude>';
						default:
							this.newlineTransparent = false;
							return WSP._serializeHTMLTag( state, token );
					}
				} else if ( argDict.property ) {
					switchType = argDict.property.match( /^mw\:PageProp\/(.*)$/ );
					if ( switchType ) {
						return '__' + switchType[1].toUpperCase() + '__';
					}
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
						return installCollector(
									endTagMatchTokenCollector,
									WSP.compareSourceHandler,
									this,
									state, token
								);
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
			startsNewline: true,
			handle: function(state, token) {
				return dashyString("----", token.dataAttribs.extra_dashes);
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
			startsNewline: true,
			endsLine: true,
			handle: id("\n")
		}
	},
	b:  {
		start: { handle: id("'''") },
		end: {
			handle: function ( state, token ) {
				return token.dataAttribs.autoInsertedEnd ? "" : "'''";
			}
		},
		wtEscapeHandler: WSP.wteHandlers.quoteHandler
	},
	i:  {
		start: { handle: id("''") },
		end: {
			handle: function ( state, token ) {
				return token.dataAttribs.autoInsertedEnd ? "" : "''";
			}
		},
		wtEscapeHandler: WSP.wteHandlers.quoteHandler
	},
	a:  {
		start: {
			handle: installCollector.bind(null,
						endTagMatchTokenCollector,
						WSP._linkHandler,
						this
					)
		},
		wtEscapeHandler: WSP.wteHandlers.linkHandler
	},
	link:  {
		start: {
			handle: installCollector.bind(null,
						endTagMatchTokenCollector,
						WSP._linkHandler,
						this
					)
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

	var out = [];
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		var kv = attribs[i];
		var k = kv.k;

		// Ignore about and typeof if they are template-related
		if (tokType && (k === "about" || k === "typeof")) {
			continue;
		}

		if (k.length) {
			var tplKV = tplAttrState.kvs[k];
			if (tplKV) {
				out.push(tplKV);
			} else {
				var tplK  = tplAttrState.ks[k],
					tplV  = tplAttrState.vs[k],
					v     = token.getAttributeShadowInfo(k).value;

				// Deal with k/v's that were template-generated
				if (tplK) {
					k = tplK;
				}
				if (tplV){
					v = tplV;
				}

				if (v.length ) {
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
			var k = aKeys[i];
			// Attrib not present -- sanitized away!
			if (!Util.lookupKV(attribs, k)) {
				// Deal with k/v's that were template-generated
				// and then sanitized away!
				var tplK = tplAttrState.ks[k];
				if (tplK) {
					k = tplK;
				}

				v = dataAttribs.sa[k];
				if (v) {
					var tplV = tplAttrState.vs[k];

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
	var i, l, state = Util.extendProps(startState || {}, this.initialState, this.options);
	state.serializer = this;
	if ( chunkCB === undefined ) {
		var out = [];
		state.chunkCB = function ( chunk ) {
			out.push( chunk );
		};
		for ( i = 0, l = tokens.length; i < l; i++ ) {
			this._serializeToken( state, tokens[i] );
		}
		return out;
	} else {
		state.chunkCB = chunkCB;
		for ( i = 0, l = tokens.length; i < l; i++ ) {
			this._serializeToken( state, tokens[i] );
		}
	}
};

WSP.defaultHTMLTagHandler = {
	start: { isNewlineEquivalent: true, handle: WSP._serializeHTMLTag },
	end  : { isNewlineEquivalent: true, handle: WSP._serializeHTMLEndTag }
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
	var res = '',
		collectorResult = false,
		solTransparent = false,
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

	if ( collectorResult === false ) {
		state.prevToken = state.curToken;
		state.curToken  = token;

		// The serializer is logically in a new line context if a new line is pending
		if (state.emitNewlineOnNextToken || (state.availableNewlineCount > 0)) {
			state.onNewline = true;
			state.onStartOfLine = true;
		}

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
				}
				break;
			case String:
				res = ( state.inNoWiki || state.inHTMLPre ) ? token
					: this.escapeWikiText( state, token );
				if (textHandler) {
					res = textHandler( state, res );
				}
				solTransparent = res.match(/^\s*$/);
				if (!solTransparent) {
					// Clear prev tag token
					state.prevTagToken = null;
					state.currTagToken = null;
				}
				break;
			case CommentTk:
				solTransparent = true;
				res = '<!--' + token.value + '-->';
				// don't consider comments for changes of the onStartOfLine status
				// XXX: convert all non-tag handlers to a similar handler
				// structure as tags?
				handler = { newlineTransparent: true };
				break;
			case NlTk:
				res = textHandler ? textHandler( state, '\n' ) : '\n';
				break;
			case EOFTk:
				res = '';
				for ( var i = 0, l = state.availableNewlineCount; i < l; i++ ) {
					res += '\n';
				}
				state.chunkCB( res, state.serializeID );
				break;
			default:
				res = '';
				console.warn( 'Unhandled token type ' + JSON.stringify( token ) );
				break;
		}
	}

	var newTrailingNLCount = 0;

	// FIXME: figure out where the non-string res comes from
	if ( res === undefined || res === null || res.constructor !== String ) {
		console.error("-------- Warning: Serializer error --------");
		console.error("TOKEN: " + JSON.stringify(token));
		console.error(state.env.pageName + ": res was undefined or not a string!");
		console.error(JSON.stringify(res));
		console.trace();
		res = '';
	}

	if (res !== '') {
		// NOTE: This used to be a single regexp:
		//   res.match( /^((?:\r?\n)*)((?:.*?|[\r\n]+[^\r\n])*?)((?:\r?\n)*)$/ );
		// But, we have split this into two 3 different REs since this RE got stuck
		// on certain pages (Ex: en:Good_Operating_Practice).  Recording this here
		// so we dont attempt this again in the future.

		// Strip leading or trailing newlines from the returned string
		var leadingNLs = '',
			trailingNLs = '',
			match = res.match(/^[\r\n]+/);
		if (match) {
			leadingNLs = match[0];
			state.availableNewlineCount += ( leadingNLs.match(/\n/g) || [] ).length;
		}
		if (leadingNLs === res) {
			// clear output
			res = "";
		} else {
			// check for trailing newlines
			match = res.match(/[\r\n]+$/);
			if (match) {
				trailingNLs = match[0];
			}
			newTrailingNLCount = ( trailingNLs.match(/\n/g) || [] ).length;
			// strip newlines
			res = res.replace(/^[\r\n]+|[\r\n]+$/g, '');
		}
	}

	// Check if we have a pair of identical tag tokens </p><p>; </ul><ul>; etc.
	// that have to be separated by extra newlines and add those in.
	if (handler.pairSepNLCount && state.prevTagToken &&
			state.prevTagToken.constructor === EndTagTk &&
			state.prevTagToken.name === token.name )
	{
		if ( state.nlsSinceLastEndTag + state.availableNewlineCount < handler.pairSepNLCount) {
			state.availableNewlineCount = handler.pairSepNLCount - state.nlsSinceLastEndTag;
		}
	}

	WSP.debug( token,
				"res: ", res,
				", nl: ", state.onNewline,
				", sol: ", state.onStartOfLine,
				", singleMode: ", state.singleLineMode,
				', eon:', state.emitNewlineOnNextToken,
				", #nl: ", state.availableNewlineCount,
				', #new:', newTrailingNLCount );

	if (res !== '') {
		var out = '';
		// If this is not a html tag and the serializer is not in single-line mode,
		// allocate a newline if
		// - prev token needs a single line,
		// - handler starts a new line and we aren't on a new line,
		//
		// Newline-equivalent tokens (HTML tags for example) don't get
		// implicit newlines.
		if (!handler.isNewlineEquivalent &&
			!state.singleLineMode &&
			!state.availableNewlineCount &&
			((!solTransparent && state.emitNewlineOnNextToken) ||
			 (!state.onStartOfLine && handler.startsNewline)))
		{
			state.availableNewlineCount = handler.defaultStartNewlineCount || 1;
		}

		// Add required # of new lines in the beginning
		state.nlsSinceLastEndTag += state.availableNewlineCount;
		for (; state.availableNewlineCount; state.availableNewlineCount--) {
			out += '\n';
		}

		// XXX: Switch singleLineMode to stack if there are more
		// exceptions than just isTemplateSrc later on.
		if ( state.singleLineMode && !handler.isTemplateSrc) {
			res = res.replace(/\n/g, ' ');
		}

		out += res;
		WSP.debug(' =>', out);
		state.chunkCB( out, state.serializeID );

		// Update new line state
		// 1. If this token generated new trailing new lines, we are in a newline state again.
		//    If not, we are not!  But, handle onStartOfLine specially.
		if (newTrailingNLCount > 0) {
			state.availableNewlineCount = newTrailingNLCount;
			state.onNewline = true;
			state.onStartOfLine = true;
		} else {
			state.availableNewlineCount = 0;
			state.onNewline = false;
			if (!handler.newlineTransparent) {
				state.onStartOfLine = false;
			}
		}

		// 2. Previous token nl state is no longer relevant
		state.emitNewlineOnNextToken = false;
	} else if ( handler.startsNewline && !state.onStartOfLine ) {
		state.emitNewlineOnNextToken = true;
	}

	if (handler.endsLine) {
		// Record end of line
		state.emitNewlineOnNextToken = true;
	}
	if ( handler.singleLine > 0 ) {
		state.singleLineMode += handler.singleLine;
	}
};

// SSS FIXME: Unnecessary tree-walking for the occasional
// templating of attributes.  Wonder if there is another solution
// to this problem.
//
// Update state with the set of templated attribute
WSP._collectAttrMetaTags = function(node, state) {
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
		while (child) {
			// get the next sibling first thing becase we may delete this child
			var nextSibling = child.nextSibling;
			this._collectAttrMetaTags(child, state);
			child = nextSibling;
		}
	}
};

/**
 * Serialize an HTML DOM document.
 */
WSP.serializeDOM = function( node, chunkCB, finalCB ) {
	// console.warn("DOM: " + node.outerHTML);
	if ( !finalCB || typeof finalCB !== 'function' ) {
		finalCB = function () {};
	}
	try {
		var state = Util.extendProps({}, this.initialState, this.options);
		state.serializer = this;
		state.serializeID = null;
		this._collectAttrMetaTags(node, state);
		//console.warn( node.innerHTML );
		if ( ! chunkCB ) {
			var out = [];
			state.chunkCB = out.push.bind( out );
			this._serializeDOM( node, state );
			this._serializeToken( state, new EOFTk() );
			return out.join('');
		} else {
			state.chunkCB = chunkCB;
			this._serializeDOM( node, state );
			this._serializeToken( state, new EOFTk() );
		}
		finalCB();
	} catch (e) {
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
	// serialize this node
	if (node.nodeType === Node.ELEMENT_NODE) {
		if (state.activeTemplateId === node.getAttribute("about")) {
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
				var dummyToken = new SelfclosingTagTk("meta",
					[ new KV("typeof", "mw:TemplateSource") ],
					{ src: this._getDOMRTInfo(node.attributes).src }
				);
				this._serializeToken(state, dummyToken);
				return;
			}
		}
	} else if (node.nodeType !== Node.COMMENT_NODE) {
		state.activeTemplateId = null;
	}

	switch( node.nodeType ) {
		case Node.ELEMENT_NODE:
			var children = node.childNodes,
				name = node.nodeName.toLowerCase(),
				tkAttribs = this._getDOMAttribs(node.attributes),
				tkRTInfo = this._getDOMRTInfo(node.attributes),
				parentSTX = state.parentSTX;

			if (isHtmlBlockTag(name)) {
				state.currLine = {
					text: null,
					numPieces: 0,
					processed: false,
					hasBracketPair: false,
					hasHeadingPair: false
				}
			}

			var serializeID = null;
			if ( state.serializeID === null ) {
				serializeID = node.getAttribute( 'data-serialize-id' );
				if ( serializeID ) {
					state.serializeID = serializeID;
				}
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

			// then children
			for (var i = 0, n = children.length; i < n; i++) {
				this._serializeDOM( children[i], state );
			}

			// Reset parent token
			state.parentSTX = parentSTX;

			// then the end token
			this._serializeToken(state, new EndTagTk(name, tkAttribs, tkRTInfo));

			if ( serializeID !== null ) {
				state.serializeID = null;
			}

			break;
		case Node.TEXT_NODE:
			if (state.currLine.text === null) {
				var buf = [];
				var bn = firstBlockNodeAncestor(node);
				var children = bn.childNodes;
				for (var i = 0, n = children.length; i < n; i++) {
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

WSP._getDOMAttribs = function( attribs ) {
	// convert to list fo key-value pairs
	var out = [];
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		var attrib = attribs.item(i);
		if ( attrib.name !== 'data-parsoid' && attrib.name !== 'data-ve-changed' && attrib.name !== 'data-serialize-id' ) {
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


// Quick HACK: define Node constants locally
// https://developer.mozilla.org/en/nodeType
var Node = {
	ELEMENT_NODE: 1,
    ATTRIBUTE_NODE: 2,
    TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4,
    ENTITY_REFERENCE_NODE: 5,
    ENTITY_NODE: 6,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8,
    DOCUMENT_NODE: 9,
    DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
    NOTATION_NODE: 12
};


if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
