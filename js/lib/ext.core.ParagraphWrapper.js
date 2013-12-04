"use strict";
/*
 * Insert paragraph tags where needed -- smartly and carefully
 * -- there is much fun to be had mimicking "wikitext visual newlines"
 * behavior as implemented by the PHP parser.
 */

// Include general utilities
var Util = require('./mediawiki.Util.js').Util,
    defines = require('./mediawiki.parser.defines.js');
// define some constructor shortcuts
var KV = defines.KV,
    CommentTk = defines.CommentTk,
    EOFTk = defines.EOFTk,
    NlTk = defines.NlTk,
    TagTk = defines.TagTk,
    SelfclosingTagTk = defines.SelfclosingTagTk,
    EndTagTk = defines.EndTagTk;

function ParagraphWrapper ( manager, options ) {
	this.options = options;
	// Disable p-wrapper in <ref> tags
	if (options.extTag !== "ref") {
		this.register( manager );
	}
	this.trace = manager.env.conf.parsoid.debug ||
		(manager.env.conf.parsoid.traceFlags &&
		(manager.env.conf.parsoid.traceFlags.indexOf("p-wrap") !== -1));
	this.reset();
}

ParagraphWrapper.prototype.reset = function() {
	if (this.inPre) {
		// Clean up in case we run into EOF before seeing a </pre>
		this.manager.addTransform(this.onNewLineOrEOF.bind(this),
			"ParagraphWrapper:onNewLine", this.newlineRank, 'newline');
	}
	this.tableTags = [];
	this.nlWsTokens = [];
	this.nonNlTokens = [];
	this.newLineCount = 0;
	this.hasOpenPTag = false;
	this.hasOpenHTMLPTag = false;
	this.inPre = false;
	this.resetCurrLine(true);
	// XXX gwicke: This would be simpler if we did the paragraph wrapping on
	// the DOM
	this.currLine.hasBlockToken = this.options.inBlockToken === undefined ?
		false : this.options.inBlockToken;
};

// constants
ParagraphWrapper.prototype.newlineRank = 2.95;
ParagraphWrapper.prototype.anyRank     = 2.96;
ParagraphWrapper.prototype.endRank     = 2.97;

// Register this transformer with the TokenTransformer
ParagraphWrapper.prototype.register = function ( manager ) {
	this.manager = manager;
	manager.addTransform( this.onNewLineOrEOF.bind(this),
		"ParagraphWrapper:onNewLine", this.newlineRank, 'newline' );
	manager.addTransform( this.onAny.bind(this),
		"ParagraphWrapper:onAny", this.anyRank, 'any' );
	manager.addTransform( this.onNewLineOrEOF.bind(this),
		"ParagraphWrapper:onEnd", this.endRank, 'end' );
};

ParagraphWrapper.prototype._getTokensAndReset = function (res) {
	var resToks = res ? res : this.nonNlTokens.concat(this.nlWsTokens);
	if (this.trace) {
		console.warn("  p-wrap:RET: " + JSON.stringify(resToks));
	}
	this.nonNlTokens = [];
	this.nlWsTokens = [];
	this.newLineCount = 0;
	return resToks;
};

ParagraphWrapper.prototype.discardOneNlTk = function(out) {
	var i = 0, n = this.nlWsTokens.length;
	while (i < n) {
		var t = this.nlWsTokens.shift();
		if (t.constructor === NlTk) {
			return t;
		} else {
			out.push(t);
		}
	}

	return null;
};

ParagraphWrapper.prototype.closeOpenPTag = function(out) {
	if (this.hasOpenPTag) {
		out.push(new EndTagTk('p'));
		this.hasOpenPTag = false;
	}
};

ParagraphWrapper.prototype.resetCurrLine = function(atEOL) {
	this.currLine = {
		tokens: [],
		isNewline: atEOL,
		hasBlockToken: false,
		hasWrappableTokens: false
	};
};

// Handle NEWLINE tokens
ParagraphWrapper.prototype.onNewLineOrEOF = function (  token, frame, cb ) {
	if (this.trace) {
		console.warn("T:p-wrap:NL: " + JSON.stringify(token));
	}

	// If we dont have an open p-tag, and this line didn't have a block token,
	// start a p-tag
	var l = this.currLine;
	if (!this.hasOpenPTag && !this.hasOpenHTMLPTag && !l.hasBlockToken && l.hasWrappableTokens) {
		l.tokens.unshift(new TagTk('p'));
		this.hasOpenPTag = true;
	}

	// this.nonNlTokens += this.currLine.tokens
	this.nonNlTokens = this.nonNlTokens.concat(l.tokens);

	this.resetCurrLine(true);

	if (token.constructor === EOFTk) {
		this.nlWsTokens.push(token);
		this.closeOpenPTag(this.nonNlTokens);
		var res = this.processPendingNLs(false);
		this.inPre = false;
		this.hasOpenPTag = false;
		this.hasOpenHTMLPTag = false;
		this.reset();
		if (this.trace) {
			console.warn("  p-wrap:RET: " + JSON.stringify(res));
		}
		return { tokens: res };
	} else {
		this.newLineCount++;
		this.nlWsTokens.push(token);
		return {};
	}
};

ParagraphWrapper.prototype.processPendingNLs = function (isBlockToken) {
	var resToks = this.nonNlTokens,
		newLineCount = this.newLineCount,
		nlTk;

	if (this.trace) {
		console.warn("  p-wrap:NL-count: " + newLineCount);
	}

	if (newLineCount >= 2) {
		while ( newLineCount >= 3 ) {
			// 1. Close any open p-tag
			this.closeOpenPTag(resToks);

			var topTag = this.tableTags.length > 0 ? this.tableTags.last(): null;
			if (!topTag || topTag === 'td' || topTag === 'th') {
				// 2. Discard 3 newlines (the p-br-p section
				// serializes back to 3 newlines)
				resToks.push(this.discardOneNlTk(resToks));
				resToks.push(this.discardOneNlTk(resToks));
				nlTk = this.discardOneNlTk(resToks);

				// Preserve nls for pretty-printing and dsr reliability

				// 3. Insert <p><br></p> sections
				resToks.push(new TagTk( 'p' ));
				resToks.push(new SelfclosingTagTk('br'));
				resToks.push(nlTk);
				if (newLineCount > 3) {
					resToks.push(new EndTagTk('p'));
				} else {
					this.hasOpenPTag = true;
				}
			} else {
				resToks.push(this.discardOneNlTk(resToks));
				resToks.push(this.discardOneNlTk(resToks));
				resToks.push(this.discardOneNlTk(resToks));
			}

			newLineCount -= 3;
		}

		if (newLineCount === 2) {
			this.closeOpenPTag(resToks);
			resToks.push(this.discardOneNlTk(resToks));
			resToks.push(this.discardOneNlTk(resToks));
		}
	}

	if (isBlockToken) {
		if (newLineCount === 1){
			this.closeOpenPTag(resToks);
			resToks.push(this.discardOneNlTk(resToks));
		} else {
			this.closeOpenPTag(resToks);
		}
	}

	// Gather remaining ws and nl tokens
	resToks = resToks.concat(this.nlWsTokens);
	return resToks;
};

// popUntil: pop anything until one of the tag in this array is found.
//           Pass null to disable.
// popThen: after a stop is reached (or popUntil was null), continue
//			popping as long as the elements in this array match. Pass
//			null to disable.
function popTags(tblTags, popUntil, popThen) {
	while (popUntil && tblTags.length > 0 && popUntil.indexOf(tblTags.last()) === -1) {
		tblTags.pop();
	}
	while (popThen && tblTags.length > 0 && popThen.indexOf(tblTags.last()) !== -1) {
		tblTags.pop();
	}
}

function updateTableContext(tblTags, token) {
	if (Util.isTableTag(token)) {
		var tokenName = token.name;
		if (token.constructor === TagTk) {
			tblTags.push(tokenName);
		} else {
			switch (tokenName) {
			case "table":
				// Pop a table scope
				popTags(tblTags, ["table"], ["table"]);
				break;
			case "tbody":
				// Pop to the nearest table
				popTags(tblTags, ["table"], null);
				break;
			case "tr":
			case "thead":
			case "tfoot":
			case "caption":
				// Pop to tbody or table, whichever is nearer
				popTags(tblTags, ["tbody", "table"], null);
				break;
			case "td":
			case "th":
				// Pop to tr or (if that fails) to tbody or table.
				popTags(tblTags, ["tr", "tbody", "table"], null);
				break;
			}
		}
	}
}

ParagraphWrapper.prototype.onAny = function ( token, frame ) {
	if (this.trace) {
		console.warn("T:p-wrap:any: " + JSON.stringify(token));
	}

	var res, tc = token.constructor;
	if (tc === TagTk && token.name === 'pre') {
		if (this.hasOpenHTMLPTag) {
			// No pre-tokens inside html-p-tags -- replace it with a ' '
			this.currLine.tokens.push(' ');
			return {};
		} else {
			res = this.processPendingNLs(true);
			res = res.concat(this.currLine.tokens);
			res.push(token);

			this.manager.removeTransform(this.newlineRank, 'newline');
			this.inPre = true;
			this.resetCurrLine();

			return { tokens: this._getTokensAndReset(res) };
		}
	} else if (tc === EndTagTk && token.name === 'pre') {
		if (this.hasOpenHTMLPTag) {
			// No pre-tokens inside html-p-tags -- swallow it.
			return {};
		} else {
			if ( this.inPre ) {
				this.manager.addTransform(this.onNewLineOrEOF.bind(this),
					"ParagraphWrapper:onNewLine", this.newlineRank, 'newline');
				this.inPre = false;
			}
			this.currLine.hasBlockToken = true;
			return { tokens: [token] };
		}
	} else if (tc === EOFTk || this.inPre) {
		return { tokens: [token] };
	} else if (tc === CommentTk ||
		tc === String && token.match(/^[\t ]*$/) ||
		Util.isEmptyLineMetaToken(token))
	{
		if (this.newLineCount === 0) {
			this.currLine.tokens.push(token);
			// Since we have no pending newlines to trip us up,
			// no need to buffer -- just emit everything
			return { tokens: this._getTokensAndReset() };
		} else {
			// We are in buffering mode waiting till we are ready to
			// process pending newlines.
			this.nlWsTokens.push(token);
			return {};
		}
	} else if (tc !== String && Util.isSolTransparent(token)) {
		if (this.newLineCount === 0) {
			this.currLine.tokens.push(token);
			// Safe to push these out since we have no pending newlines to trip us up.
			return { tokens: this._getTokensAndReset() };
		} else if (this.newLineCount === 1) {
			// Swallow newline, whitespace, comments, and the current line
			this.nonNlTokens = this.nonNlTokens.concat(this.nlWsTokens, this.currLine.tokens);
			this.newLineCount = 0;
			this.nlWsTokens = [];
			this.resetCurrLine();

			// But, dont process the new token yet
			this.currLine.tokens.push(token);
			return {};
		} else {
			res = this.processPendingNLs(false);
			this.currLine.tokens.push(token);
			return { tokens: this._getTokensAndReset(res) };
		}
	} else if (tc === EndTagTk && token.name === 'p' && token.isHTMLTag()) {
		// process everything
		res = this.nonNlTokens.concat(this.nlWsTokens, this.currLine.tokens);
		res.push(token);

		// reset everthing
		this.resetCurrLine();
		this.hasOpenHTMLPTag = false;

		return { tokens: this._getTokensAndReset(res) };
	} else {
		var isBlockToken = Util.isBlockToken(token);
		if (isBlockToken) {
			this.currLine.hasBlockToken = true;
		}
		res = this.processPendingNLs(isBlockToken);

		// Close any open HTML P-tag at a block-token boundary
		if (isBlockToken && this.hasOpenHTMLPTag) {
			// This is an auto-inserted end-tag
			this.currLine.tokens.push(new EndTagTk('p', [], {autoInsertedEnd:true}));
			this.hasOpenHTMLPTag = false;
		}

		// Partial DOM-building!  What a headache
		// This is necessary to avoid introducing fosterable tags inside the table.
		updateTableContext(this.tableTags, token);

		// Deal with html p-tokens
		if (tc === TagTk && token.name === 'p' && token.isHTMLTag()) {
			if (this.hasOpenPTag) {
				this.closeOpenPTag(this.currLine.tokens);
			}
			this.hasOpenHTMLPTag = true;
		}

		this.currLine.tokens.push(token);
		this.currLine.hasWrappableTokens = true;

		return { tokens: this._getTokensAndReset(res) };
	}
};

if (typeof module === "object") {
	module.exports.ParagraphWrapper = ParagraphWrapper;
}
