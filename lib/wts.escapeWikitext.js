"use strict";

require('./core-upgrade.js');
var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	wtConsts = require('./mediawiki.wikitext.constants.js'),
	JSUtils = require('./jsutils.js').JSUtils,
	Consts = wtConsts.WikitextConstants,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	pd = require('./mediawiki.parser.defines.js'),
	SanitizerConstants = require('./ext.core.Sanitizer.js').SanitizerConstants;

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

function tokenizeStr(state, str, sol) {
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
}

WEHP.hasWikitextTokens = function ( state, onNewline, options, text, linksOnly ) {
	if (this.traceWTE) {
		console.warn("WTE-tokenize: nl:" + onNewline + ":text=" + JSON.stringify(text));
	}

	// tokenize the text

	var sol = onNewline && !(state.inIndentPre || state.inPPHPBlock);
	var tokens = tokenizeStr(state, text, sol);

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
function escapedText(state, sol, origText, fullWrap) {

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
		var tokens = tokenizeStr(state, text, sol);
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

var escapeWikiText = function ( state, text, opts ) {
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
		return escapedText(state, false, text, true);
	}

	// Template and template-arg markers are escaped unconditionally!
	// Conditional escaping requires matching brace pairs and knowledge
	// of whether we are in template arg context or not.
	if (text.match(/\{\{\{|\{\{|\}\}\}|\}\}/)) {
		if (this.traceWTE) {
			console.warn("---Unconditional: transclusion chars---");
		}
		return escapedText(state, false, text, fullCheckNeeded);
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
		return escapedText(state, sol, text, fullCheckNeeded);

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
		return escapedText(state, sol, text, fullCheckNeeded);
	} else if (state.onSOL) {
		if (text.match(/(^|\n)=+[^\n=]+=+[ \t]*\n/)) {
			if (this.traceWTE) {
				console.warn("---SOL: heading (easy test)---");
			}
			return escapedText(state, sol, text, fullCheckNeeded);
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
				return escapedText(state, sol, text, fullCheckNeeded);
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
			return escapedText(state, sol, text, fullCheckNeeded);
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
var escapeTplArgWT = function(state, arg, opts) {
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

	var tokens = tokenizeStr(state, arg, false);
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

if (typeof module === "object") {
	module.exports.WikitextEscapeHandlers = WikitextEscapeHandlers;
	module.exports.escapeWikiText = escapeWikiText;
	module.exports.escapeTplArgWT = escapeTplArgWT;
}
