/** @module */

'use strict';

require('../../core-upgrade.js');

const { DOMUtils } = require('../utils/DOMUtils.js');
const { JSUtils } = require('../utils/jsutils.js');
const { PegTokenizer } = require('../wt2html/tokenizer.js');
const { SanitizerConstants } = require('../wt2html/tt/Sanitizer.js');
const { TagTk, EndTagTk, SelfclosingTagTk, NlTk, EOFTk, CommentTk } = require('../tokens/TokenTypes.js');
const { TokenUtils } = require('../utils/TokenUtils.js');
const { Util } = require('../utils/Util.js');
const { WTUtils } = require('../utils/WTUtils.js');
const { WikitextConstants: Consts } = require('../config/WikitextConstants.js');

// ignore the cases where the serializer adds newlines not present in the dom
function startsOnANewLine(node) {
	var name = node.nodeName.toUpperCase();
	return Consts.BlockScopeOpenTags.has(name) &&
		!WTUtils.isLiteralHTMLNode(node) &&
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
		if (DOMUtils.isElt(node)) {
			if (DOMUtils.isBlockNode(node)) {
				return !startsOnANewLine(node);
			}
			if (node.hasChildNodes()) {
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
		var prev = DOMUtils.previousNonDeletedSibling(node);
		if (!prev) {
			prev = node.parentNode;
		}
		if (DOMUtils.isQuoteElt(prev)) {
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
		var next = DOMUtils.nextNonDeletedSibling(node);
		if (!next) {
			next = node.parentNode;
		}
		if (DOMUtils.isQuoteElt(next)) {
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

const linkEscapeRE = /(\[\[)|(\]\])|(-\{)|(^[^\[]*\]$)/;

/**
 * @class
 * @alias module:html2wt/WikitextEscapeHandlers
 * @param {MWParserEnvironment} env
 * @param {WikitextSerializer} serializer
 */
class WikitextEscapeHandlers {
	constructor(options) {
		this.tokenizer = new PegTokenizer(options.env);
		this.options = options;
	}

	isFirstContentNode(node) {
		// Conservative but safe
		if (!node) {
			return true;
		}

		// Skip deleted-node markers
		return DOMUtils.previousNonDeletedSibling(node) === null;
	}

	liHandler(liNode, state, text, opts) {
		if (opts.node.parentNode !== liNode) {
			return false;
		}

		// For <dt> nodes, ":" trigger nowiki outside of elements
		// For first nodes of <li>'s, bullets in sol posn trigger escaping
		if (liNode.nodeName === 'DT' && /:/.test(text)) {
			return true;
		} else if (/^[#*:;]*$/.test(state.currLine.text) && this.isFirstContentNode(opts.node)) {
			// Wikitext styling might require whitespace insertion after list bullets.
			// In those scenarios, presence of bullet-wiktext in the text node is okay.
			// Hence the check for /^[#*:;]*$/ above.
			return text.match(/^[#*:;]/);
		} else {
			return false;
		}
	}

	thHandler(thNode, state, text, opts) {
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
		return state.currLine.text.match(/^\s*!/) && text.match(/^[^\n]*!!|\|/);
	}

	mediaOptionHandler(state, text) {
		return /\|/.test(text) || linkEscapeRE.test(text);
	}

	wikilinkHandler(state, text) {
		return linkEscapeRE.test(text);
	}

	aHandler(state, text) {
		return text.match(/\]/);
	}

	tdHandler(tdNode, inWideTD, state, text, opts) {
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
		// * +-} in SOL position (if they show up on the leftmost path with
		//   only zero-wt-emitting nodes on that path)
		return (!opts.node || state.currLine.firstNode === tdNode) &&
			(/\|/.test(text) || (
				!inWideTD &&
				state.currLine.text === '|' &&
				text.match(/^[\-+}]/) &&
				opts.node && DOMUtils.pathToAncestor(opts.node, tdNode).every(function(n) {
					return this.isFirstContentNode(n) &&
						(n === opts.node || WTUtils.isZeroWidthWikitextElt(n));
				}, this)
			));
	}

	// Tokenize string and pop EOFTk
	tokenizeStr(str, sol) {
		var tokens = this.tokenizer.tokenizeSync(str, { sol });
		console.assert(tokens.pop().constructor === EOFTk, 'Expected EOF token!');
		return tokens;
	}

	textCanParseAsLink(node, state, text) {
		state.env.log("trace/wt-escape", "link-test-text=", function() { return JSON.stringify(text); });

		// Strip away extraneous characters after a ]] or a ]
		// They are inessential to the test of whether the ]]/]
		// will get parsed into a wikilink and only complicate
		// the logic (needing to ignore entities, etc.).
		text = text.replace(/\][^\]]*$/, ']');

		// text only contains ']' chars.
		// Since we stripped everything after ']' above, if a newline is
		// present, a link would have to straddle newlines which is not valid.
		if (/\n/.test(text)) {
			return false;
		}

		var str = state.currLine.text + text;
		var tokens = this.tokenizeStr(str, false); // sol state is irrelevant here
		var n = tokens.length;
		var lastToken = tokens[n - 1];

		state.env.log("trace/wt-escape", "str=", str, ";tokens=", tokens);

		// If 'text' remained outside of any non-string tokens,
		// it does not need nowiking.
		if (lastToken === text || (typeof lastToken === 'string' &&
			text === lastToken.substring(lastToken.length - text.length))) {
			return false;
		}

		// Verify that the tokenized links are valid links
		var buf = '';
		for (var i = n - 1; i >= 0; i--) {
			var t = tokens[i];
			if (typeof t === 'string') {
				buf = t + buf;
			} else if (t.name === 'wikilink') {
				var target = t.getAttribute('href');
				if (Array.isArray(target)) {
					// FIXME: in theory template expansion *could* make this a link.
					return false;
				}
				if (state.env.isValidLinkTarget(target) &&
						!state.env.conf.wiki.hasValidProtocol(target)) {
					return true;
				}

				// Assumes 'src' will always be present which it seems to be.
				// Tests will fail if anything changes in the tokenizer.
				buf = t.dataAttribs.src + buf;
			} else if (t.name === 'extlink') {
				// Check if the extlink came from a template which in the end
				// would not really parse as an extlink.

				var href = t.getAttribute('href');
				if (Array.isArray(href)) {
					href = href[0];
				}

				if (!TokenUtils.isTemplateToken(href)) {
					// Not a template and a real href => needs nowiking
					if (typeof href === 'string' && /https?:\/\//.test(href)) {
						return true;
					}
				} else {
					while (node) {
						node = DOMUtils.previousNonSepSibling(node);
						if (WTUtils.isFirstEncapsulationWrapperNode(node)) {
							// FIXME: This is not entirely correct.
							// Assumes that extlink content doesn't have templates.
							// Solution: Count # of non-nested templates encountered
							// and skip over intermediate templates.
							// var content = t.getAttribute('mw:content');
							// var n = intermediateNonNestedTemplates(content);
							break;
						}
					}

					if (node && node.nodeName === 'A' &&
						node.textContent === node.getAttribute('href')) {
						// The template expands to an url link => needs nowiking
						return true;
					}
				}

				// Since this will not parse to a real extlink,
				// update buf with the wikitext src for this token.
				var tsr = t.dataAttribs.tsr;
				buf = str.substring(tsr[0], tsr[1]) + buf;
			} else {
				// We have no other smarts => be conservative.
				return true;
			}

			if (text === buf.substring(buf.length - text.length)) {
				// 'text' emerged unscathed
				return false;
			}
		}

		// We couldn't prove safety of skipping nowiki-ing.
		return true;
	}

	hasWikitextTokens(state, onNewline, options, text) {
		state.env.log("trace/wt-escape", "nl:", onNewline, ":text=", function() { return JSON.stringify(text); });

		// tokenize the text

		var sol = onNewline && !(state.inIndentPre || state.inPPHPBlock);

		// If we're inside a <pre>, we need to add an extra space after every
		// newline so that the tokenizer correctly parses all tokens in a pre
		// instead of just the first one. See T95794.
		if (state.inIndentPre) {
			text = text.replace(/\n/g, "\n ");
		}

		var tokens = this.tokenizeStr(text, sol);

		// If the token stream has a TagTk, SelfclosingTagTk, EndTagTk or CommentTk
		// then this text needs escaping!
		var numEntities = 0;
		for (var i = 0, n = tokens.length; i < n; i++) {
			var t = tokens[i];

			state.env.log("trace/wt-escape", "T:", function() { return JSON.stringify(t); });

			var tc = t.constructor;

			// Ignore non-whitelisted html tags
			if (TokenUtils.isHTMLTag(t)) {
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
				if ((tc === TagTk || tc === EndTagTk) &&
					state.env.conf.wiki.extConfig.tags.has(t.name.toLowerCase())) {
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

			if (tc === SelfclosingTagTk) {

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

				return true;
			}

			if (state.inCaption && tc === TagTk && t.name === 'listItem') {
				continue;
			}

			if (tc === TagTk) {
				var ttype = t.getAttribute('typeof');
				// Ignore mw:Entity tokens
				if (t.name === 'span' && ttype === 'mw:Entity') {
					numEntities++;
					continue;
				}

				// Ignore table tokens outside of tables
				if (t.name in { caption: 1, td: 1, tr: 1, th: 1 } && !TokenUtils.isHTMLTag(t) && state.wikiTableNesting === 0) {
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

				// Headings have both SOL and EOL requirements. This tokenization
				// here only verifies SOL requirements, not EOL requirements.
				// So, record this information so that we can strip unnecessary
				// nowikis after the fact.
				if (t.name.match(/^h\d$/)) {
					state.hasHeadingEscapes = true;
				}

				return true;
			}

			if (tc === EndTagTk) {
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
				if (t.name in { caption: 1, table: 1 } && state.wikiTableNesting === 0) {
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
	}

	/**
	 * This function attempts to wrap smallest escapable units into
	 * nowikis (which can potentially add multiple nowiki pairs in a
	 * single string).  The idea here is that since this should all be
	 * text, anything that tokenizes to another construct needs to be
	 * wrapped.
	 *
	 * Full-wrapping is enabled if the string is being escaped within
	 * context-specific handlers where the tokenization context might
	 * be different from what we use in this code.
	 */
	escapedText(state, sol, origText, fullWrap, dontWrapIfUnnecessary) {
		var match = origText.match(/^([^]*?)((?:\r?\n)*)$/);
		var text = match[1];
		var nls = match[2];

		if (fullWrap) {
			return "<nowiki>" + text + "</nowiki>" + nls;
		}

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

		var tokens = this.tokenizeStr(text, sol);

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
			if (t.constructor === String) {
				if (t.length > 0) {
					t = WTUtils.escapeNowikiTags(t);
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
				continue;
			}

			// Ignore display hacks, so text like "A : B" doesn't produce
			// an unnecessary nowiki.
			if (t.dataAttribs && t.dataAttribs.isDisplayHack) {
				continue;
			}

			var tsr = (t.dataAttribs || {}).tsr;
			if (!Array.isArray(tsr)) {
				state.env.log('error/html2wt/escapeNowiki',
					'Missing tsr for token ',
					JSON.stringify(t),
					'while processing text ',
					text);

				// Bail and wrap the whole thing in a nowiki
				// if we have missing information.
				// Use match[1] since text has been clobbered above.
				return '<nowiki>' + match[1] + '</nowiki>' + nls;
			}

			// Now put back the escaping we removed above
			var tSrc = WTUtils.escapeNowikiTags(text.substring(tsr[0], tsr[1]));
			switch (t.constructor) {
				case NlTk:
					buf += tSrc;
					sol = true;
					break;

				case CommentTk:
					// Comments are sol-transparent
					buf += tSrc;
					break;

				case TagTk:
					// Treat tokens with missing tags as self-closing tokens
					// for the purpose of minimal nowiki escaping
					nowikiWrap(tSrc, tokensWithoutClosingTag.has(t.name));
					sol = false;
					break;

				case EndTagTk:
					nowikiWrap(tSrc, true);
					sol = false;
					break;

				case SelfclosingTagTk:
					if (t.name !== 'meta' || !/^mw:(TSRMarker|EmptyLine)$/.test(t.getAttribute('typeof'))) {
						// Don't bother with marker or empty-line metas
						nowikiWrap(tSrc, true);
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
		if (!nowikisAdded && !dontWrapIfUnnecessary) {
			buf = '';
			nowikiWrap(text, true);
		}

		buf += nls;
		return buf;
	}

	/**
	 * @param {Object} state
	 * @param {string} text
	 * @param {Object} opts
	 */
	escapeWikiText(state, text, opts) {
		state.env.log("trace/wt-escape", "EWT:", function() { return JSON.stringify(text); });

		/* -----------------------------------------------------------------
		 * General strategy: If a substring requires escaping, we can escape
		 * the entire string without further analysis of the rest of the string.
		 * ----------------------------------------------------------------- */

		var hasMagicWord = /(^|\W)(RFC|ISBN|PMID)\s/.test(text);
		var hasAutolink = state.env.conf.wiki.findValidProtocol(text);
		var fullCheckNeeded = !state.inLink && (hasMagicWord || hasAutolink);
		var hasLanguageConverter = false;
		var hasQuoteChar = false;
		var indentPreUnsafe = false;
		var hasNonQuoteEscapableChars = false;
		var indentPreSafeMode = state.inIndentPre || state.inPHPBlock;
		var sol = state.onSOL && !indentPreSafeMode;

		// Fast path for special protected characters.
		if (state.protect && state.protect.test(text)) {
			return this.escapedText(state, sol, text);
		}

		if (!fullCheckNeeded) {
			hasQuoteChar = /'/.test(text);
			indentPreUnsafe = (!indentPreSafeMode && (/\n +[^\r\n]*?[^\s]+/).test(text) || sol && (/^ +[^\r\n]*?[^\s]+/).test(text));
			hasNonQuoteEscapableChars = /[<>\[\]\-\+\|!=#\*:;~{}]|__[^_]*__/.test(text);
			hasLanguageConverter = /-\{|\}-/.test(text);
			if (hasLanguageConverter) { fullCheckNeeded = true; }
		}

		// Quick check for the common case (useful to kill a majority of requests)
		//
		// Pure white-space or text without wt-special chars need not be analyzed
		if (!fullCheckNeeded && !hasQuoteChar && !indentPreUnsafe && !hasNonQuoteEscapableChars) {
			state.env.log("trace/wt-escape", "---No-checks needed---");
			return text;
		}

		// Context-specific escape handler
		var wteHandler = JSUtils.lastItem(state.wteHandlerStack);
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
					this.hasWikitextTokens(state, sol, this.options, text))) {
				state.env.log("trace/wt-escape", "---quotes: escaping text---");
				// If the reason for full wrap is that the text contains non-quote
				// escapable chars, it's still possible to minimize the contents
				// of the <nowiki> (T71950).
				return this.escapedText(state, sol, text);
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
			return this.escapedText(state, false, text);
		}

		// Once we eliminate the possibility of multi-line tokens, split the text
		// around newlines and escape each line separately.
		if (/\n./.test(text)) {
			state.env.log("trace/wt-escape", "-- <multi-line-escaping-mode> --");
			// We've already processed the full string in a context-specific handler.
			// No more additional processing required. So, push/pop a null handler.
			state.wteHandlerStack.push(null);

			var ret = text.split(/\n/).map((line, i) => {
				if (i > 0) {
					// Update state
					state.onSOL = true;
					state.currLine.text = '';
					opts.inMultilineMode = true;
				}
				return this.escapeWikiText(state, line, opts);
			}).join('\n');

			state.wteHandlerStack.pop();

			// If nothing changed, check if the original multiline string has
			// any wikitext tokens (ex: multi-line html tags <div\n>foo</div\n>).
			if (ret === text &&
				this.hasWikitextTokens(state, sol, this.options, text)) {
				state.env.log("trace/wt-escape", "---Found multi-line wt tokens---");
				ret = this.escapedText(state, sol, text);
			}

			state.env.log("trace/wt-escape", "-- </multi-line-escaping-mode> --");
			return ret;
		}

		state.env.log("trace/wt-escape", "SOL:", sol, function() { return JSON.stringify(text); });

		var hasTildes = text.match(/~{3,5}/);
		if (!fullCheckNeeded && !hasTildes) {
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
		// escape text with ' ' in sol posn with one caveat:
		// * and when the current line has block tokens
		if (indentPreUnsafe &&
			(!hasBlocksOnLine(state.currLine.firstNode, true) || opts.inMultilineMode)
		) {
			state.env.log("trace/wt-escape", "---SOL and pre---");
			state.hasIndentPreNowikis = true;
			return this.escapedText(state, sol, text);
		}

		// escape nowiki tags
		text = WTUtils.escapeNowikiTags(text);

		// Use the tokenizer to see if we have any wikitext tokens
		//
		// Ignores entities
		if (hasTildes) {
			state.env.log("trace/wt-escape", "---Found tildes---");
			return this.escapedText(state, sol, text);
		} else if (this.hasWikitextTokens(state, sol, this.options, text)) {
			state.env.log("trace/wt-escape", "---Found WT tokens---");
			return this.escapedText(state, sol, text);
		} else if (text.match(/[^\[]*\]/) && this.textCanParseAsLink(opts.node, state, text)) {
			// we have an closing bracket, and
			//    - the text will get parsed as a link in
			state.env.log("trace/wt-escape", "---Links: complex single-line test---");
			return this.escapedText(state, sol, text);
		} else if (opts.isLastChild && text.match(/=$/)) {
			// 1. we have an open heading char, and
			//    - text ends in a '='
			//    - text comes from the last child
			var headingMatch = state.currLine.firstNode.nodeName.match(/^H(\d)/);
			if (headingMatch) {
				var n = headingMatch[1];
				if ((state.currLine.text + text)[n] === '=') {
					// The first character after the heading wikitext is/will be a '='.
					// So, the trailing '=' can change semantics if it is not nowikied.
					state.env.log("trace/wt-escape", "---Heading: complex single-line test---");
					return this.escapedText(state, sol, text);
				} else {
					return text;
				}
			} else if (state.currLine.text[0] === '=') {
				state.env.log("trace/wt-escape", "---Text-as-heading: complex single-line test---");
				return this.escapedText(state, sol, text);
			} else {
				return text;
			}
		} else {
			state.env.log("trace/wt-escape", "---All good!---");
			return text;
		}
	}

	/**
	 * General strategy:
	 *
	 * Tokenize the arg wikitext.  Anything that parses as tags
	 * are good and we need not bother with those. Check for harmful
	 * characters `[[]]{{}}` or additionally `=` in positional parameters and escape
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
	escapeTplArgWT(arg, opts) {
		var env = this.options.env;
		var serializeAsNamed = opts.serializeAsNamed;
		var buf = '';
		var openNowiki;
		var isTemplate = opts.type === 'template';

		function appendStr(str, isLast, checkNowiki) {
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
			if (isTemplate && !serializeAsNamed && /[=]/.test(str)) {
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
					str.replace(/\[\[([^\[\]]*)\]\]|\{\{([^\{\}]*)\}\}|-\{([^\{\}]*)\}-/g, '_$1_');
			if (/\{\{|\}\}|\[\[|\]\]|-\{/.test(bracketPairStrippedStr)) {
				needNowikiCount++;
			}
			if (opts.type !== 'templatearg' && !serializeAsNamed && /[=]/.test(str)) {
				needNowikiCount++;
			}
			if (opts.argIndex === opts.numArgs && isLast && /\}$/.test(str)) {
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

		var tokens = this.tokenizeStr(arg, false);

		for (var i = 0, n = tokens.length; i < n; i++) {
			var t = tokens[i];
			var da = t.dataAttribs;
			var last = i === n - 1;

			// For mw:Entity spans, the opening and closing tags have 0 width
			// and the enclosed content is the decoded entity. Hence the
			// special case to serialize back the entity's source.
			if (t.constructor === TagTk) {
				var type = t.getAttribute("typeof");
				if (type && type.match(/\bmw:(?:(?:DisplaySpace\s+mw:)?Placeholder|Entity)\b/)) {
					i += 2;
					appendStr(arg.substring(da.tsr[0], tokens[i].dataAttribs.tsr[1]), last, false);
					continue;
				} else if (type === "mw:Nowiki") {
					i++;
					while (i < n && (tokens[i].constructor !== EndTagTk || tokens[i].getAttribute("typeof") !== "mw:Nowiki")) {
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
				case TagTk:
				case EndTagTk:
				case NlTk:
				case CommentTk:
					if (!da.tsr) {
						errors = ["Missing tsr for: " + JSON.stringify(t)];
						errors.push("Arg : " + JSON.stringify(arg));
						errors.push("Toks: " + JSON.stringify(tokens));
						env.log("error/html2wt/wtescape", errors.join("\n"));
					}
					appendStr(arg.substring(da.tsr[0], da.tsr[1]), last, false);
					break;

				case SelfclosingTagTk:
					if (!da.tsr) {
						errors = ["Missing tsr for: " + JSON.stringify(t)];
						errors.push("Arg : " + JSON.stringify(arg));
						errors.push("Toks: " + JSON.stringify(tokens));
						env.log("error/html2wt/wtescape", errors.join("\n"));
					}
					var tkSrc = arg.substring(da.tsr[0], da.tsr[1]);
					// Replace pipe by an entity. This is not completely safe.
					if (t.name === 'extlink' || t.name === 'urllink') {
						var tkBits = this.tokenizer.tokenizeSync(tkSrc, {
							startRule: "tplarg_or_template_or_bust",
						});
						tkBits.forEach(function(bit) {
							if (typeof bit === "object") {
								appendStr(bit.dataAttribs.src, last, false);
							} else {
								// Convert to a named param w/ the same reasoning
								// as above for escapeStr, however, here we replace
								// with an entity to avoid breaking up querystrings
								// with nowikis.
								if (isTemplate && !serializeAsNamed && /[=]/.test(bit)) {
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

				case EOFTk:
					break;
			}
		}

		// If nowiki still open, close it now.
		if (openNowiki) {
			buf += "</nowiki>";
		}

		return { serializeAsNamed: serializeAsNamed, v: buf };
	}

	// See also `escapeLinkTarget` in LinkHandler.js
	escapeLinkContent(state, str, solState, node, isMedia) {
		// Entity-escape the content.
		str = Util.escapeWtEntities(str);

		// Wikitext-escape content.
		state.onSOL = solState || false;
		state.wteHandlerStack.push(isMedia
			? this.mediaOptionHandler
			: this.wikilinkHandler);
		state.inLink = true;
		var res = this.escapeWikiText(state, str, { node: node });
		state.inLink = false;
		state.wteHandlerStack.pop();

		return res;
	}
}

if (typeof module === "object") {
	module.exports.WikitextEscapeHandlers = WikitextEscapeHandlers;
}
