'use strict';
require('./core-upgrade.js');

var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer;
var wtConsts = require('./mediawiki.wikitext.constants.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var pd = require('./mediawiki.parser.defines.js');
var SanitizerConstants = require('./ext.core.Sanitizer.js').SanitizerConstants;

var Consts = wtConsts.WikitextConstants;


// Empty constructor
var WikitextEscapeHandlers = function(env, serializer) {
	this.tokenizer = new PegTokenizer(env);
	this.serializer = serializer;
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
	if (opts.node.parentNode === headingNode && opts.isLastChild &&
		DU.isText(DU.firstNonDeletedChildNode(headingNode))
	) {
		var line = state.currLine.text;
		if (line.length === 0) {
			line = text;
		}
		return line[0] === '=' &&
			text && text.length > 0 && text[text.length - 1] === '=';
	} else {
		return false;
	}
};

WEHP.liHandler = function(liNode, state, text, opts) {
	if (opts.node.parentNode !== liNode) {
		return false;
	}

	// For <dt> nodes, ":" trigger nowiki outside of elements
	// For first nodes of <li>'s, bullets in sol posn trigger escaping
	if (liNode.nodeName === 'DT' && /:/.test(text)) {
		return true;
	} else if (state.currLine.text === '' && this.isFirstContentNode(opts.node)) {
		return text.match(/^[#\*:;]/);
	} else {
		return false;
	}
};

function hasLeadingEscapableQuoteChar(text, opts) {
	var node = opts.node;
	// Use 'node.textContent' to do the tests since it hasn't had newlines
	// stripped out from it.
	//   Ex: For this DOM: <i>x</i>\n'\n<i>y</i>
	//       node.textContent = \n'\n and text = '
	// Those newline separators can prevent unnecessary <nowiki/> protection
	// if the string begins with one or more newlines before a leading quote.
	var origText = node.textContent;
	if (origText.match(/^'/)) {
		var prev = DU.previousNonDeletedSibling(node);
		if (!prev) {
			prev = node.parentNode;
		}
		if (DU.isQuoteElt(prev)) {
			return true;
		}
	}

	return false;
}

function hasTrailingEscapableQuoteChar(text, opts) {
	var node = opts.node;
	// Use 'node.textContent' to do the tests since it hasn't had newlines
	// stripped out from it.
	//   Ex: For this DOM: <i>x</i>\n'\n<i>y</i>
	//       node.textContent = \n'\n and text = '
	// Those newline separators can prevent unnecessary <nowiki/> protection
	// if the string ends with a trailing quote and then one or more newlines.
	var origText = node.textContent;
	if (origText.match(/'$/)) {
		var next = DU.nextNonDeletedSibling(node);
		if (!next) {
			next = node.parentNode;
		}
		if (DU.isQuoteElt(next)) {
			return true;
		}
	}

	return false;
}

// SSS FIXME: By doing a DOM walkahead to identify what else is on the current line,
// these heuristics can be improved. Ex: '<i>foo</i> blah blah does not require a
// <nowiki/> after the single quote since we know that there are no other quotes on
// the rest of the line that will be emitted. Similarly, '' does not need a <nowiki>
// wrapper since there are on other quote chars on the line.
//
// This is checking text-node siblings of i/b tags.
function escapedIBSiblingNodeText(state, text, opts) {
	// For a sequence of 2+ quote chars, we have to
	// fully wrap the sequence in <nowiki>...</nowiki>
	// <nowiki/> at the start and end doesn't work.
	//
	// Ex: ''<i>foo</i> should serialize to <nowiki>''</nowiki>''foo''.
	//
	// Serializing it to ''<nowiki/>''foo'' breaks html2html semantics
	// since it will parse back to <i><meta../></i>foo<i></i>
	if (text.match(/''+/)) {
		// Minimize the length of the string that is wrapped in <nowiki>.
		var pieces = text.split("'");
		var first = pieces.shift();
		var last = pieces.pop();
		return first + "<nowiki>'" + pieces.join("'") + "'</nowiki>" + last;
	}

	// Check whether the head and/or tail of the text needs <nowiki/> protection.
	var out = '';
	if (hasTrailingEscapableQuoteChar(text, opts)) {
		state.hasQuoteNowikis = true;
		out = text + "<nowiki/>";
	}

	if (hasLeadingEscapableQuoteChar(text, opts)) {
		state.hasQuoteNowikis = true;
		out =  "<nowiki/>" + (out || text);
	}

	return out;
}

WEHP.thHandler = function(thNode, state, text, opts) {
	// {|
	// !a<div>!!b</div>
	// !c<div>||d</div>
	// |}
	//
	// The <div> will get split across two <th> tags because
	// the !! and | has higher precedence in the tokenizer.
	//
	// So, no matter where in the DOM subtree of the <th> node
	// that text shows up in, we have to unconditionally escape
	// the !! and | characters.
	//
	// That is, so long as it serializes to the same line as the
	// heading was started.
	var line = state.currLine.chunks.reduce(function(prev, curr) {
		return prev + curr.text;
	}, state.currLine.text);
	return line.match(/^\s*!/) && text.match(/^[^\n]*!!|\|/);
};

WEHP.wikilinkHandler = function(state, text) {
	return text.match(/(^\|)|(\[\[)|(\]\])|(^[^\[]*\]$)/);
};

WEHP.aHandler = function(state, text) {
	return text.match(/\]$/);
};

WEHP.tdHandler = function(tdNode, state, text, opts) {
	/*
	 * "|" anywhere in a text node of the <td> subtree can be trouble!
	 * It is not sufficient to just look at immediate child of <td>
	 * Try parsing the following table:
	 *
	 * {|
	 * |a''b|c''
	 * |}
	 *
	 * Similarly, "-" or "+" when emitted after a "|" in sol position
	 * is trouble, but in addition to showing up as the immediate first
	 * child of tdNode, they can appear on the leftmost path from
	 * tdNode as long as the path only has nodes don't emit any wikitext.
	 * Ex: <td><p>-</p></td>, but not: <td><small>-</small></td>
	 */

	// If 'text' is on the same wikitext line as the "|" corresponding
	// to the <td>
	// * | in a td should be escaped
	// * +- in SOL position (if they show up on the leftmost path with
	//   only zero-wt-emitting nodes on that path)
	return (!opts.node || state.currLine.firstNode === tdNode) &&
		(text.match(/\|/) || (
			!state.inWideTD &&
			state.currLine.text === '' &&
			text.match(/^[\-+]/) &&
			opts.node && DU.pathToAncestor(opts.node, tdNode).every(function(n) {
				return this.isFirstContentNode(n) &&
					(n === opts.node || DU.isZeroWidthWikitextElt(n));
			}, this)
		));
};

WEHP.tokenizeStr = function(str, sol) {
	return this.tokenizer.tokenize(str, null, null, true, sol);
};

WEHP.hasWikitextTokens = function(state, onNewline, options, text, linksOnly) {
	state.env.log("trace/wt-escape", "nl:", onNewline, ":text=", function() { return JSON.stringify(text); });

	// tokenize the text

	var sol = onNewline && !(state.inIndentPre || state.inPPHPBlock);

	// If we're inside a <pre>, we need to add an extra space after every
	// newline so that the tokenizer correctly parses all tokens in a pre
	// instead of just the first one. See T95794.
	if (state.inIndentPre) {
		text = text.replace("\n", "\n ");
	}
	var tokens = this.tokenizeStr(text, sol);

	// If the token stream has a pd.TagTk, pd.SelfclosingTagTk, pd.EndTagTk or pd.CommentTk
	// then this text needs escaping!
	var numEntities = 0;
	for (var i = 0, n = tokens.length; i < n; i++) {
		var t = tokens[i];

		state.env.log("trace/wt-escape", "T:", function() { return JSON.stringify(t); });

		var tc = t.constructor;

		// Ignore non-whitelisted html tags
		if (t.isHTMLTag()) {
			if (/(?:^|\s)mw:Extension(?=$|\s)/.test(t.getAttribute("typeof")) &&
				options.extName !== t.getAttribute("name")) {
				return true;
			}

			// Always escape isolated extension tags (T59469). Consider this:
			//    echo "&lt;ref&gt;foo<p>&lt;/ref&gt;</p>" | node parse --html2wt
			// The <ref> and </ref> tag-like text is spread across the DOM, and in
			// the worst case can be anywhere. So, we conservatively escape these
			// elements always (which can lead to excessive nowiki-escapes in some
			// cases, but is always safe).
			if ((tc === pd.TagTk || tc === pd.EndTagTk) &&
				state.env.conf.wiki.isExtensionTag(t.name)) {
				return true;
			}

			// If the tag is one that's allowed in wikitext, we need to escape
			// it inside <nowiki>s, because a text node nodeValue always returns
			// non-escaped entities (that is, converts "&lt;h2&gt;" to "<h2>").
			// TODO: We should also do this for <a> tags because even if they
			// aren't allowed in wikitext and thus don't need to be escaped, the
			// result can be confusing for editors. However, doing it here in a
			// simple way interacts badly with normal link escaping, so it's
			// left for later.
			if (Consts.Sanitizer.TagWhiteList.has(t.name.toUpperCase())) {
				return true;
			} else {
				continue;
			}
		}

		if (tc === pd.SelfclosingTagTk) {

			// * Ignore RFC/ISBN/PMID tokens when those are encountered in the
			//   context of another link's content -- those are not parsed to
			//   ext-links in that context. (T109371)
			if ((t.name === 'extlink' || t.name === 'wikilink') && t.dataAttribs && t.dataAttribs.stx === 'magiclink' && (state.inAttribute || state.inLink)) {
				continue;
			}

			// Ignore url links in attributes (href, mostly)
			// since they are not in danger of being autolink-ified there.
			if (t.name === 'urllink' && (state.inAttribute || state.inLink)) {
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

			if (t.name === 'wikilink') {
				if (state.env.isValidLinkTarget(t.getAttribute("href"))) {
					return true;
				} else {
					continue;
				}
			}

			return !linksOnly;
		}

		if (state.inCaption && tc === pd.TagTk && t.name === 'listItem') {
			continue;
		}

		if (!linksOnly && tc === pd.TagTk) {
			var ttype = t.getAttribute('typeof');
			// Ignore mw:Entity tokens
			if (t.name === 'span' && ttype === 'mw:Entity') {
				numEntities++;
				continue;
			}
			// Ignore heading tokens
			if (t.name.match(/^h\d$/)) {
				continue;
			}
			// Ignore table tokens outside of tables
			if (t.name in {td: 1, tr: 1, th: 1} && !t.isHTMLTag() && state.wikiTableNesting === 0) {
				continue;
			}

			// Ignore display-hack placeholders and display spaces -- they dont need nowiki escaping
			// They are added as a display-hack by the tokenizer (and we should probably
			// find a better solution than that if one exists).
			if (ttype && ttype.match(/(?:\b|mw:DisplaySpace\s+)mw:Placeholder\b/) && t.dataAttribs.isDisplayHack) {
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
			if (t.name in {table: 1} && state.wikiTableNesting === 0) {
				continue;
			}

			// </br>!
			if (SanitizerConstants.noEndTagSet.has(t.name.toLowerCase())) {
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
 * single string).  The idea here is that since this should all be
 * text, anything that tokenizes to another construct needs to be
 * wrapped.
 *
 * Full-wrapping is enabled in the following cases:
 * - origText has url triggers (RFC, ISBN, etc.)
 * - is being escaped within context-specific handlers
 * ---------------------------------------------------------------- */
WEHP.escapedText = function(state, sol, origText, fullWrap) {
	try {
		var match = origText.match(/^((?:[^\r\n]|[\r\n]+[^\r\n]|[~]{3,5})*?)((?:\r?\n)*)$/);
		var text = match[1];
		var nls = match[2];

		if (fullWrap) {
			return "<nowiki>" + text + "</nowiki>" + nls;
		} else {
			var buf = '';
			var inNowiki = false;
			var nowikisAdded = false;
			var tokensWithoutClosingTag = new Set([
				// These token types don't come with a closing tag
				'listItem', 'td', 'tr',
			]);

			// reverse escaping nowiki tags
			// we do this so that they tokenize as nowikis
			// instead of entity enclosed text
			text = text.replace(/&lt;(\/?nowiki\s*\/?\s*)&gt;/gi, '<$1>');

			// Tokenize string and pop EOFTk
			var tokens = this.tokenizeStr(text, sol);
			tokens.pop();

			var nowikiWrap = function(str, close) {
				if (!inNowiki) {
					buf += '<nowiki>';
					inNowiki = true;
					nowikisAdded = true;
				}
				buf += str;
				if (close) {
					buf += '</nowiki>';
					inNowiki = false;
				}
			};

			for (var i = 0, n = tokens.length; i < n; i++) {
				var t = tokens[i];
				var tsr = (t.dataAttribs || {}).tsr;

				// Ignore display hacks, so text like "A : B" doesn't produce
				// an unnecessary nowiki.
				if (t.dataAttribs && t.dataAttribs.isDisplayHack) {
					continue;
				}

				switch (t.constructor) {
				case String:
					if (t.length > 0) {
						t = DU.escapeNowikiTags(t);
						if (!inNowiki && ((sol && t.match(/^ /)) || t.match(/\n /))) {
							var x = t.split(/(^|\n) /g);
							buf += x[0];
							for (var k = 1; k < x.length - 1; k += 2) {
								buf += x[k];
								if (k !== 1 || x[k] === '\n' || sol) {
									nowikiWrap(' ', true);
								} else {
									buf += ' ';
								}
								buf += x[k + 1];
							}
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
					var close = tokensWithoutClosingTag.has(t.name);
					nowikiWrap(text.substring(tsr[0], tsr[1]), close);
					sol = false;
					break;

				case pd.EndTagTk:
					nowikiWrap(text.substring(tsr[0], tsr[1]), true);
					sol = false;
					break;

				case pd.SelfclosingTagTk:
					if (t.name !== 'meta' || !/^mw:(TSRMarker|EmptyLine)$/.test(t.getAttribute('typeof'))) {
						// Don't bother with marker or empty-line metas
						nowikiWrap(text.substring(tsr[0], tsr[1]), true);
					}
					sol = false;
					break;
				}
			}

			// close any unclosed nowikis
			if (inNowiki) {
				buf += '</nowiki>';
			}

			// Make sure nowiki is always added
			// Ex: "foo]]" won't tokenize into tags at all
			if (!nowikisAdded) {
				buf = '';
				nowikiWrap(text, true);
			}

			buf += nls;
			return buf;
		}
	} catch (e) {
		state.env.log("error", "Error escaping text", origText);
	}
};

// ignore the cases where the serializer adds newlines not present in the dom
function startsOnANewLine(node) {
	var name = node.nodeName.toUpperCase();
	return Consts.BlockScopeOpenTags.has(name) &&
		!DU.isLiteralHTMLNode(node) &&
		name !== "BLOCKQUOTE";
}

// look ahead on current line for block content
function hasBlocksOnLine(node, first) {

	// special case for firstNode:
	// we're at sol so ignore possible \n at first char
	if (first) {
		if (node.textContent.substring(1).match(/\n/)) {
			return false;
		}
		node = node.nextSibling;
	}

	while (node) {
		if (DU.isElt(node)) {
			if (DU.isBlockNode(node)) {
				return !startsOnANewLine(node);
			}
			if (node.childNodes.length > 0) {
				if (hasBlocksOnLine(node.firstChild, false)) {
					return true;
				}
			}
		} else {
			if (node.textContent.match(/\n/)) {
				return false;
			}
		}
		node = node.nextSibling;
	}
	return false;

}

WEHP.escapeWikiText = function(state, text, opts) {
	state.env.log("trace/wt-escape", "EWT:", function() { return JSON.stringify(text); });

	/* -----------------------------------------------------------------
	 * General strategy: If a substring requires escaping, we can escape
	 * the entire string without further analysis of the rest of the string.
	 * ----------------------------------------------------------------- */

	var hasMagicWord = /(^|\W)(RFC|ISBN|PMID)\s/.test(text);
	var hasAutolink = state.env.conf.wiki.findValidProtocol(text);
	var fullCheckNeeded = !state.inLink && (hasMagicWord || hasAutolink);
	var hasQuoteChar = false;
	var indentPreUnsafe = false;
	var hasNonQuoteEscapableChars = false;
	var indentPreSafeMode = state.inIndentPre || state.inPHPBlock;
	var sol = state.onSOL && !indentPreSafeMode;
	if (!fullCheckNeeded) {
		hasQuoteChar = /'/.test(text);
		indentPreUnsafe = (!indentPreSafeMode && (/\n +[^\r\n]*?[^\s]+/).test(text) || sol && (/^ +[^\r\n]*?[^\s]+/).test(text));
		hasNonQuoteEscapableChars = /[<>\[\]\-\+\|!=#\*:;~{}]|__[^_]*__/.test(text);
	}

	// Quick check for the common case (useful to kill a majority of requests)
	//
	// Pure white-space or text without wt-special chars need not be analyzed
	if (!fullCheckNeeded && !hasQuoteChar && !indentPreUnsafe && !hasNonQuoteEscapableChars) {
		state.env.log("trace/wt-escape", "---No-checks needed---");
		return text;
	}

	// Context-specific escape handler
	var wteHandler = state.wteHandlerStack.last();
	if (wteHandler && wteHandler(state, text, opts)) {
		state.env.log("trace/wt-escape", "---Context-specific escape handler---");
		return this.escapedText(state, false, text, true);
	}

	// Quote-escape test
	if (/''+/.test(text)
		|| hasLeadingEscapableQuoteChar(text, opts)
		|| hasTrailingEscapableQuoteChar(text, opts)) {
		// Check if we need full-wrapping <nowiki>..</nowiki>
		// or selective <nowiki/> escaping for quotes.
		if (fullCheckNeeded
			|| indentPreUnsafe
			|| (hasNonQuoteEscapableChars &&
				this.hasWikitextTokens(state, sol, this.serializer.options, text))) {
			state.env.log("trace/wt-escape", "---quotes: escaping text---");
			// If the reason for full wrap is that the text contains non-quote
			// escapable chars, it's still possible to minimize the contents
			// of the <nowiki> (T71950).
			return this.escapedText(state, sol, text, !hasNonQuoteEscapableChars);
		} else {
			var quoteEscapedText = escapedIBSiblingNodeText(state, text, opts);
			if (quoteEscapedText) {
				state.env.log("trace/wt-escape", "---sibling of i/b tag---");
				return quoteEscapedText;
			}
		}
	}

	// Template and template-arg markers are escaped unconditionally!
	// Conditional escaping requires matching brace pairs and knowledge
	// of whether we are in template arg context or not.
	if (text.match(/\{\{\{|\{\{|\}\}\}|\}\}/)) {
		state.env.log("trace/wt-escape", "---Unconditional: transclusion chars---");
		return this.escapedText(state, false, text, fullCheckNeeded);
	}

	var hasNewlines = text.match(/\n./);
	var hasTildes = text.match(/~{3,5}/);

	state.env.log("trace/wt-escape", "SOL:", sol, function() { return JSON.stringify(text); });

	if (!fullCheckNeeded && !hasNewlines && !hasTildes) {
		// {{, {{{, }}}, }} are handled above.
		// Test 1: '', [], <>, __FOO__ need escaping wherever they occur
		//         = needs escaping in end-of-line context
		// Test 2: {|, |}, ||, |-, |+,  , *#:;, ----, =*= need escaping only in SOL context.
		if (!sol && !text.match(/''|[<>]|\[.*\]|\]|(=[ ]*(\n|$))|__[^_]*__/)) {
			// It is not necessary to test for an unmatched opening bracket ([)
			// as long as we always escape an unmatched closing bracket (]).
			state.env.log("trace/wt-escape", "---Not-SOL and safe---");
			return text;
		}

		// Quick checks when on a newline
		// + can only occur as "|+" and - can only occur as "|-" or ----
		if (sol && !text.match(/(^|\n)[ #*:;=]|[<\[\]>\|'!]|\-\-\-\-|__[^_]*__/)) {
			state.env.log("trace/wt-escape", "---SOL and safe---");
			return text;
		}
	}

	// The front-end parser eliminated pre-tokens in the tokenizer
	// and moved them to a stream handler. So, we always conservatively
	// escape text with ' ' in sol posn with two caveats
	// * indent-pres are disabled in ref-bodies (See ext.core.PreHandler.js)
	// * and when the current line has block tokens
	if (indentPreUnsafe &&
		this.serializer.options.extName !== 'ref' &&
		!hasBlocksOnLine(state.currLine.firstNode, true)
	) {

		state.env.log("trace/wt-escape", "---SOL and pre---");
		state.hasIndentPreNowikis = true;
		return this.escapedText(state, sol, text, fullCheckNeeded);

	}

	// escape nowiki tags
	text = DU.escapeNowikiTags(text);

	// Use the tokenizer to see if we have any wikitext tokens
	//
	// Ignores headings & entities -- headings have additional
	// EOL matching requirements which are not captured by the
	// hasWikitextTokens check
	if (this.hasWikitextTokens(state, sol, this.serializer.options, text) || hasTildes) {
		state.env.log("trace/wt-escape", "---Found WT tokens---");
		return this.escapedText(state, sol, text, fullCheckNeeded);
	} else if (sol) {
		if (text.match(/(^|\n)=+[^\n=]+=+[ \t]*\n/)) {
			state.env.log("trace/wt-escape", "---SOL: heading (easy test)---");
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
				DU.isText(nonSepSibling) && nonSepSibling.nodeValue.match(/^\s*\n/)) {
				state.env.log("trace/wt-escape", "---SOL: heading (complex single-line test) ---");
				return this.escapedText(state, sol, text, fullCheckNeeded);
			} else {
				state.env.log("trace/wt-escape", "---SOL: no-heading (complex single-line test)---");
				return text;
			}
		} else {
			state.env.log("trace/wt-escape", "---SOL: no-heading---");
			return text;
		}
	} else {
		// Detect if we have open brackets or heading chars -- we use 'processed' flag
		// as a performance opt. to run this detection only if/when required.
		//
		// FIXME: Even so, it is reset after every emitted text chunk.
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
				cl.firstNode.nodeName.match(/^H/) && cl.firstNode.firstChild && DU.isText(cl.firstNode.firstChild))) {
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
				this.hasWikitextTokens(state, sol, this.serializer.options, cl.text + text, true)) {
			state.env.log("trace/wt-escape", "---Wikilink chars: complex single-line test---");
			return this.escapedText(state, sol, text, fullCheckNeeded);
		} else {
			state.env.log("trace/wt-escape", "---All good!---");
			return text;
		}
	}
};

/**
 * General strategy:
 *
 * Tokenize the arg wikitext.  Anything that parses as tags
 * are good and we need not bother with those. Check for harmful
 * characters "[[]]{{}}" or additionally '=' in positional parameters and escape
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
WEHP.escapeTplArgWT = function(state, arg, opts) {
	var serializeAsNamed = opts.serializeAsNamed;
	var buf = '';
	var openNowiki;

	function appendStr(str, last, checkNowiki) {
		if (!checkNowiki) {
			if (openNowiki) {
				buf += "</nowiki>";
				openNowiki = false;
			}
			buf += str;
			return;
		}

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
				opts.numPositionalArgs === opts.argPositionalIndex) {
				serializeAsNamed = true;
			}
		}

		// Count how many reasons for nowiki
		var needNowikiCount = 0;
		var neededSubstitution;
		// Protect against unmatched pairs of braces and brackets, as they
		// should never appear in template arguments.
		var bracketPairStrippedStr =
				str.replace(/\[\[([^\[\]]*)\]\]|\{\{([^\{\}]*)\}\}/g, '_$1_');
		if (/\{\{|\}\}|\[\[|\]\]/.test(bracketPairStrippedStr)) {
			needNowikiCount++;
		}
		if (!serializeAsNamed && /[=]/.test(str)) {
			needNowikiCount++;
		}
		if (opts.argIndex === opts.numArgs && last && /\}$/.test(str)) {
			// If this is the last part of the last argument, we need to protect
			// against an ending }, as it would get confused with the template ending }}.
			needNowikiCount++;
			neededSubstitution = [/(\})$/, "<nowiki>}</nowiki>"];
		}
		if (/\|/.test(str)) {
			// If there's an unprotected |, guard it so it doesn't get confused
			// with the beginning of a different paramenter.
			needNowikiCount++;
			neededSubstitution = [/\|/g, "{{!}}"];
		}

		// Now, if arent' already in a <nowiki> and there's only one reason to
		// protect, avoid guarding too much text by just substituting.
		if (!openNowiki && needNowikiCount === 1 && neededSubstitution) {
			str = str.replace(neededSubstitution[0], neededSubstitution[1]);
			needNowikiCount = false;
		}
		if (!openNowiki && needNowikiCount) {
			buf += "<nowiki>";
			openNowiki = true;
		}
		if (!needNowikiCount && openNowiki) {
			buf += "</nowiki>";
			openNowiki = false;
		}
		buf += str;
	}

	// Tokenize and get rid of the ending EOFTk.
	var tokens = this.tokenizeStr(arg, false);
	tokens.pop();

	for (var i = 0, n = tokens.length; i < n; i++) {
		var t = tokens[i];
		var da = t.dataAttribs;
		var last = i === n - 1;

		// For mw:Entity spans, the opening and closing tags have 0 width
		// and the enclosed content is the decoded entity. Hence the
		// special case to serialize back the entity's source.
		if (t.constructor === pd.TagTk) {
			var type = t.getAttribute("typeof");
			if (type && type.match(/\bmw:(?:(?:DisplaySpace\s+mw:)?Placeholder|Entity)\b/)) {
				i += 2;
				appendStr(arg.substring(da.tsr[0], tokens[i].dataAttribs.tsr[1]), last, false);
				continue;
			} else if (type === "mw:Nowiki") {
				i++;
				while (i < n && (tokens[i].constructor !== pd.EndTagTk || tokens[i].getAttribute("typeof") !== "mw:Nowiki")) {
					i++;
				}
				if (i < n) {
					// After tokenization, we can get here:
					// * Text explicitly protected by <nowiki> in the parameter.
					// * Other things that should be protected but weren't
					//   according to the tokenizer.
					// In template argument, we only need to check for unmatched
					// braces and brackets pairs (which is done in appendStr),
					// but only if they weren't explicitly protected in the
					// passed wikitext.
					var substr = arg.substring(da.tsr[0], tokens[i].dataAttribs.tsr[1]);
					appendStr(substr, last, !/<nowiki>[^<]*<\/nowiki>/.test(substr));
				}
				continue;
			}
		}

		var errors;
		switch (t.constructor) {
			case pd.TagTk:
			case pd.EndTagTk:
			case pd.NlTk:
			case pd.CommentTk:
				if (!da.tsr) {
					errors = ["Missing tsr for: " + JSON.stringify(t)];
					errors.push("Arg : " + JSON.stringify(arg));
					errors.push("Toks: " + JSON.stringify(tokens));
					state.env.log("error", errors.join("\n"));
				}
				appendStr(arg.substring(da.tsr[0], da.tsr[1]), last, false);
				break;

			case pd.SelfclosingTagTk:
				if (!da.tsr) {
					errors = ["Missing tsr for: " + JSON.stringify(t)];
					errors.push("Arg : " + JSON.stringify(arg));
					errors.push("Toks: " + JSON.stringify(tokens));
					state.env.log("error", errors.join("\n"));
				}
				var tkSrc = arg.substring(da.tsr[0], da.tsr[1]);
				// Replace pipe by an entity. This is not completely safe.
				if (t.name === 'extlink' || t.name === 'urllink') {
					var tkBits = this.tokenizer.tokenize(tkSrc,
						"tplarg_or_template_or_bust", null, true);
					/* jshint loopfunc: true */
					tkBits.forEach(function(bit) {
						if (typeof bit === "object") {
							appendStr(bit.dataAttribs.src, last, false);
						} else {
							// Convert to a named param w/ the same reasoning
							// as above for escapeStr, however, here we replace
							// with an entity to avoid breaking up querystrings
							// with nowikis.
							if (opts.isTemplate && !serializeAsNamed && /[=]/.test(bit)) {
								if (opts.numPositionalArgs === 0 ||
										opts.numPositionalArgs === opts.argIndex) {
									serializeAsNamed = true;
								} else {
									bit = bit.replace(/=/g, '&#61;');
								}
							}
							buf += bit.replace(/\|/g, '&#124;');
						}
					});
				} else {
					appendStr(tkSrc, last, false);
				}
				break;

			case String:
				appendStr(t, last, true);
				break;

			case pd.EOFTk:
				break;
		}
	}

	// If nowiki still open, close it now.
	if (openNowiki) {
		buf += "</nowiki>";
	}

	return { serializeAsNamed: serializeAsNamed, v: buf };
};

if (typeof module === "object") {
	module.exports.WikitextEscapeHandlers = WikitextEscapeHandlers;
}
