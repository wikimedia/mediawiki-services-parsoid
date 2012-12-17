"use strict";
/*
 * Insert paragraph tags where needed -- smartly and carefully
 * -- there is much fun to be had mimicking "wikitext visual newlines"
 * behavior as implemented by the PHP parser.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 * @author Subramanya Sastry <ssastry@wikimedia.org>
 */

// Include general utilities
var Util = require('./mediawiki.Util.js').Util;

function ParagraphWrapper ( manager, options ) {
	this.options = options;
	this.register( manager );
	this.trace = manager.env.debug ||
		(manager.env.traceFlags &&
		(manager.env.traceFlags.indexOf("p-wrap") !== -1));
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
	this.currLine = {
		tokens: [],
		hasBlockToken: this.options.inBlockToken === undefined ? false : this.options.inBlockToken,
		hasWrappableTokens: false
	};
	this.newLineCount = 0;
	this.hasOpenPTag = false;
	this.hasOpenHTMLPTag = false;
	this.inPre = false;
}

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
	var resToks = res ? res : this.nonNlTokens;
	if (this.trace) {
		console.warn("  p-wrap:RET: " + JSON.stringify(resToks));
	}
	this.nonNlTokens = [];
	this.nlWsTokens = [];
	this.newLineCount = 0;
	return resToks;
};

ParagraphWrapper.prototype.discardOneNlTk = function() {
	for (var i = 0, n = this.nlWsTokens.length; i < n; i++) {
		var t = this.nlWsTokens[i];
		if (t.constructor === NlTk) {
			this.nlWsTokens = this.nlWsTokens.splice(i+1);
			return t;
		}
	}

	return null;
};

ParagraphWrapper.prototype.closeOpenPTag = function(out) {
	if (this.hasOpenPTag) {
		out.push(new EndTagTk('p'));
		this.hasOpenPTag = false;
		this.hasOpenHTMLPTag = false;
	}
};

ParagraphWrapper.prototype.resetCurrLine = function () {
	this.currLine = {
		tokens: [],
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
	if (!this.hasOpenPTag && !l.hasBlockToken && l.hasWrappableTokens) {
		l.tokens.unshift(new TagTk('p'));
		this.hasOpenPTag = true;
	}

	// this.nonNlTokens += this.currLine.tokens
	this.nonNlTokens = this.nonNlTokens.concat(l.tokens);
	this.resetCurrLine();

	this.nlWsTokens.push(token);
	if (token.constructor === EOFTk) {
		this.closeOpenPTag(this.nonNlTokens);
		var res = this.processPendingNLs(false);
		this.inPre = false;
		this.hasOpenPTag = false;
		this.hasOpenHTMLPTag = false;
		this.reset();
		return { tokens: res };
	} else {
		this.newLineCount++;
		return {};
	}
};

ParagraphWrapper.prototype.processPendingNLs = function (isBlockToken) {
	var resToks = this.nonNlTokens,
		newLineCount = this.newLineCount,
		nlTk, nlTk2;

	if (this.trace) {
		console.warn("  p-wrap:NL-count: " + newLineCount);
	}

	if (newLineCount >= 2) {
		while ( newLineCount >= 3 ) {
			// 1. Close any open p-tag
			var hadOpenTag = this.hasOpenPTag;
			this.closeOpenPTag(resToks);

			var topTag = this.tableTags.length > 0 ? this.tableTags.last(): null;
			if (!topTag || topTag === 'td' || topTag === 'th') {
				// 2. Discard 3 newlines (the p-br-p section
				// serializes back to 3 newlines)
				nlTk = this.discardOneNlTk();
				nlTk2 = this.discardOneNlTk();
				this.discardOneNlTk();

				if (hadOpenTag) {
					// We strictly dont need this for correctness,
					// but useful for readable html output
					resToks.push(nlTk);
				} else {
					resToks.push(nlTk);
					resToks.push(nlTk2);
				}

				// 3. Insert <p><br></p> sections
				// FIXME: Mark this as a placeholder for now until the
				// editor handles this properly
				resToks.push(new TagTk( 'p', [new KV('typeof', 'mw:Placeholder')] ));
				resToks.push(new SelfclosingTagTk('br'));
				if (newLineCount > 3) {
					resToks.push(new EndTagTk('p'));
				} else {
					this.hasOpenPTag = true;
				}
			} else {
				resToks.push(this.discardOneNlTk());
				resToks.push(this.discardOneNlTk());
				resToks.push(this.discardOneNlTk());
			}

			newLineCount -= 3;
		}

		if (newLineCount === 2) {
			nlTk = this.discardOneNlTk();
			nlTk2 = this.discardOneNlTk();
			this.closeOpenPTag(resToks);
			resToks.push(nlTk);
			resToks.push(nlTk2);
		}
	} else if (isBlockToken) {
		if (newLineCount === 1){
			nlTk = this.discardOneNlTk();
			this.closeOpenPTag(resToks);
			resToks.push(nlTk);
		} else {
			this.closeOpenPTag(resToks);
		}
	}

	// Gather remaining ws and nl tokens
	resToks = resToks.concat(this.nlWsTokens);
	return resToks;
};

ParagraphWrapper.prototype.onAny = function ( token, frame ) {
	function updateTableContext(tblTags, token) {
		function popTags(tblTags, tokenName, altTag1, altTag2) {
			while (tblTags.length > 0) {
				var topTag = tblTags.pop();
				if (topTag === tokenName || topTag === altTag1 || topTag === altTag2) {
					break;
				}
			}
		}

		if (Util.isTableTag(token)) {
			var tokenName = token.name;
			if (tc === TagTk) {
				tblTags.push(tokenName);
			} else {
				switch (tokenName) {
				case "table":
					// Pop till we match
					popTags(tblTags, tokenName);
					break;
				case "tbody":
					// Pop till we match
					popTags(tblTags, tokenName, "table");
					break;
				case "tr":
					// Pop till we match
					popTags(tblTags, tokenName, "table", "tbody");
					break;
				case "td":
				case "th":
					// Pop just the topmost tag if it matches the token
					if (tblTags.last() === token.name) {
						tblTags.pop();
					}
					break;
				}
			}
		}
	}

	if (this.trace) {
		console.warn("T:p-wrap:any: " + JSON.stringify(token));
	}

	var res,
		tc = token.constructor,
		isNamedTagToken = function ( token, names ) {
			return ( token.constructor === TagTk ||
					token.constructor === SelfclosingTagTk ||
					token.constructor === EndTagTk ) &&
					names[token.name];
		};

	if (tc === InternalTk) {
		// Unwrap the internal token so paragraph-wrapping considers
		// fully expanded content from extensions in the context of
		// current p-wrapping state.
		var buf = [],
			wrappedTks = token.getAttribute("tokens"),
			n = wrappedTks.length;
		for (var j = 0; j < n; j++) {
			var ret = this.onAny(wrappedTks[j], frame);
			if (ret.tokens) {
				buf = buf.concat(ret.tokens);
			}
		}
		return { tokens: buf };
	} else if (tc === TagTk && token.name === 'pre') {
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
			this.manager.addTransform(this.onNewLineOrEOF.bind(this),
				"ParagraphWrapper:onNewLine", this.newlineRank, 'newline');
			this.inPre = false;
			this.currLine.hasBlockToken = true;
			return { tokens: [token] };
		}
	} else if (tc === EOFTk || this.inPre) {
		return { tokens: [token] };
	} else if ((tc === String && token.match( /^[\t ]*$/)) ||
			(tc === CommentTk) ||
			// TODO: narrow this down a bit more to take typeof into account
			(tc === SelfclosingTagTk && token.name === 'meta') ||
			isNamedTagToken(token, {'link':1}) )
	{
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
		this.hasOpenPTag = false;

		return { tokens: this._getTokensAndReset(res) };
	} else {
		var isBlockToken = Util.isBlockToken(token);
		if (isBlockToken) {
			this.currLine.hasBlockToken = true;
		}
		res = this.processPendingNLs(isBlockToken);

		// Partial DOM-building!  What a headache
		// This is necessary to avoid introducing fosterable tags inside the table.
		updateTableContext(this.tableTags, token);

		// Deal with html p-tokens
		if (tc === TagTk && token.name === 'p' && token.isHTMLTag()) {
			if (this.hasOpenPTag) {
				this.closeOpenPTag(this.currLine.tokens);
			}
			this.hasOpenHTMLPTag = true;
			this.hasOpenPTag = true;
		}

		this.currLine.tokens.push(token);
		this.currLine.hasWrappableTokens = true;

		return { tokens: this._getTokensAndReset(res) };
	}
};

if (typeof module === "object") {
	module.exports.ParagraphWrapper = ParagraphWrapper;
}
