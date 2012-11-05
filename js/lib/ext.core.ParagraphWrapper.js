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


function ParagraphWrapper ( dispatcher ) {
	this.nlWsTokens = [];
	this.nonNlTokens = [];
	this.currLine = {
		tokens: [],
		hasBlockToken: false,
		hasWrappableTokens: false
	};
	this.newLineCount = 0;
	this.hasOpenPTag = false;
	this.inPre = false;
	this.register( dispatcher );
	this.trace = dispatcher.env.debug ||
		(dispatcher.env.traceFlags &&
		(dispatcher.env.traceFlags.indexOf("p-wrap") !== -1));
}

// constants
ParagraphWrapper.prototype.newlineRank = 2.995;
ParagraphWrapper.prototype.anyRank     = 2.996;
ParagraphWrapper.prototype.endRank     = 2.997;

// Register this transformer with the TokenTransformer
ParagraphWrapper.prototype.register = function ( dispatcher ) {
	this.dispatcher = dispatcher;
	dispatcher.addTransform( this.onNewLineOrEOF.bind(this),
		"ParagraphWrapper:onNewLine", this.newlineRank, 'newline' );
	dispatcher.addTransform( this.onAny.bind(this),
		"ParagraphWrapper:onAny", this.anyRank, 'any' );
	dispatcher.addTransform( this.onNewLineOrEOF.bind(this),
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

ParagraphWrapper.prototype.discardOneNlTk = function(out) {
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
		return { tokens: this._getTokensAndReset(res) };
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
			// 1. close any open p-tag
			this.closeOpenPTag(resToks);

			// 2. Discard 3 newlines (the p-br-p section
			// serializes back to 3 newlines)
			nlTk = this.discardOneNlTk(resToks);
			this.discardOneNlTk(resToks);
			this.discardOneNlTk(resToks);

			resToks.push(nlTk); // For readable html output

			// 3. Insert <p><br></p> sections
			resToks.push(new TagTk( 'p' ));
			resToks.push(new SelfclosingTagTk('br'));
			if (newLineCount > 3) {
				resToks.push(new EndTagTk('p'));
			} else {
				this.hasOpenPTag = true;
			}

			newLineCount -= 3;
		}

		if (newLineCount === 2) {
			nlTk = this.discardOneNlTk(resToks);
			nlTk2 = this.discardOneNlTk(resToks);
			this.closeOpenPTag(resToks);
			resToks.push(nlTk);
			resToks.push(nlTk2);
		}
	} else if (isBlockToken) {
		if (newLineCount === 1){
			nlTk = this.discardOneNlTk(resToks);
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

ParagraphWrapper.prototype.onAny = function ( token, frame, cb ) {
	if (this.trace) {
		console.warn("T:p-wrap:any: " + JSON.stringify(token));
	}

	var res,
		tc = token.constructor,
		isNamedTagToken = function ( token, names ) {
			return ( token.constructor === TagTk ||
					token.constructor === SelfclosingTagTk ||
					token.constructor === EndTagTk ) &&
					names[token.name.toLowerCase()];
		};
	if (tc === TagTk && token.name === 'pre') {
		res = this.processPendingNLs(true);
		res = res.concat(this.currLine.tokens);
		res.push(token);

		this.dispatcher.removeTransform(this.newlineRank, 'newline');
		this.inPre = true;
		this.resetCurrLine();

		return { tokens: this._getTokensAndReset(res) };
	} else if (tc === EndTagTk && token.name === 'pre') {
		this.dispatcher.addTransform(this.onNewLineOrEOF.bind(this),
			"ParagraphWrapper:onNewLine", this.newlineRank, 'newline');
		this.inPre = false;
		this.currLine.hasBlockToken = true;
		return { tokens: [token] };
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
			// Swallow newline, whitespace, and comments
			this.nonNlTokens = this.nonNlTokens.concat(this.nlWsTokens);
			this.newLineCount = 0;
			this.nlWsTokens = [];

			// Swallow the current line as well
			this.nonNlTokens = this.nonNlTokens.concat(this.currLine.tokens);
			this.resetCurrLine();

			// But, dont process the new token yet
			this.currLine.tokens.push(token);
			return {};
		} else {
			res = this.processPendingNLs(false);
			this.currLine.tokens.push(token);
			return { tokens: this._getTokensAndReset(res) };
		}
	} else {
		var isBlockToken = Util.isBlockToken(token);
		if (isBlockToken) {
			this.currLine.hasBlockToken = true;
		}
		res = this.processPendingNLs(isBlockToken);
		this.currLine.tokens.push(token);
		this.currLine.hasWrappableTokens = true;

		return { tokens: this._getTokensAndReset(res) };
	}
};

if (typeof module === "object") {
	module.exports.ParagraphWrapper = ParagraphWrapper;
}
