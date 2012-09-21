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


function PostExpandParagraphHandler ( dispatcher ) {
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
}

// constants
PostExpandParagraphHandler.prototype.newlineRank = 2.5;
PostExpandParagraphHandler.prototype.anyRank = 2.501;
PostExpandParagraphHandler.prototype.endRank = 2.502;

// Register this transformer with the TokenTransformer
PostExpandParagraphHandler.prototype.register = function ( dispatcher ) {
	this.dispatcher = dispatcher;
	dispatcher.addTransform( this.onNewLineOrEOF.bind(this),
		"PostExpandParagraphHandler:onNewLine", this.newlineRank, 'newline' );
	dispatcher.addTransform( this.onAny.bind(this),
		"PostExpandParagraphHandler:onAny", this.anyRank, 'any' );
	dispatcher.addTransform( this.onNewLineOrEOF.bind(this),
		"PostExpandParagraphHandler:onEnd", this.endRank, 'end' );
};

PostExpandParagraphHandler.prototype._getTokensAndReset = function (res) {
	var resToks = res ? res : this.nonNlTokens;
	// console.warn("RET toks: " + JSON.stringify(resToks));
	this.nonNlTokens = [];
	this.nlWsTokens = [];
	this.newLineCount = 0;
	return resToks;
};

PostExpandParagraphHandler.prototype.discardOneNlTk = function(out) {
	for (var i = 0, n = this.nlWsTokens.length; i < n; i++) {
		var t = this.nlWsTokens[i];
		if (t.constructor === NlTk) {
			this.nlWsTokens = this.nlWsTokens.splice(i+1);
			return t;
		}
	}

	return null;
};

PostExpandParagraphHandler.prototype.closeOpenPTag = function(out) {
	if (this.hasOpenPTag) {
		out.push(new EndTagTk('p'));
		this.hasOpenPTag = false;
	}
};

PostExpandParagraphHandler.prototype.resetCurrLine = function () {
	this.currLine = {
		tokens: [],
		hasBlockToken: false,
		hasWrappableTokens: false
	};
};

// Handle NEWLINE tokens
PostExpandParagraphHandler.prototype.onNewLineOrEOF = function (  token, frame, cb ) {
/**
	console.warn("-----");
	console.warn("TNL: " + JSON.stringify(token));
*/

	// If we dont have an open p-tag, and this line didn't have a block token,
	// start a p-tag
	var l = this.currLine;
	if (!this.hasOpenPTag && !l.hasBlockToken && l.hasWrappableTokens) {
		l.tokens.unshift(new TagTk('p'));
		this.hasOpenPTag = true;
	}

	// this.nonNlTokens += this.currLine.tokens
	Array.prototype.push.apply(this.nonNlTokens, l.tokens);
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

PostExpandParagraphHandler.prototype.processPendingNLs = function (isBlockToken) {
	var resToks = this.nonNlTokens,
		newLineCount = this.newLineCount,
		nlTk, nlTk2;

	// console.log("NLC: " + newLineCount);

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
			// FIXME: Mark this as a placeholder for now until the
			// editor handles this properly
			resToks.push(new TagTk( 'p', [new KV('typeof', 'mw:Placeholder')] ));
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
	Array.prototype.push.apply(resToks, this.nlWsTokens);
	return resToks;
};

PostExpandParagraphHandler.prototype.onAny = function ( token, frame, cb ) {
/**
	console.warn("-----");
	console.warn("TA: " + JSON.stringify(token));
**/
	//console.warn( 'PostExpandParagraphHandler.onAny' );

	var res,
		tc = token.constructor;
	if (tc === TagTk && token.name === 'pre') {
		res = this.processPendingNLs(true);
		Array.prototype.push.apply(res, this.currLine.tokens);
		res.push(token);

		this.dispatcher.removeTransform(this.newlineRank, 'newline');
		this.inPre = true;
		this.resetCurrLine();

		return { tokens: this._getTokensAndReset(res) };
	} else if (tc === EndTagTk && token.name === 'pre') {
		this.dispatcher.addTransform(this.onNewLineOrEOF.bind(this),
			"PostExpandParagraphHandler:onNewLine", this.newlineRank, 'newline');
		this.inPre = false;
		this.currLine.hasBlockToken = true;
		return { tokens: [token] };
	} else if (tc === EOFTk || this.inPre) {
		return { tokens: [token] };
	} else if ((tc === String && token.match( /^[\t ]*$/)) ||
			(tc === CommentTk) ||
			// TODO: narrow this down a bit more to take typeof into account
			(tc === SelfclosingTagTk && token.name === 'meta'))
	{
		if (this.newLineCount === 0) {
			this.currLine.tokens.push(token);
			// Safe to push these out since we have no pending newlines to trip us up.
			return { tokens: this._getTokensAndReset() };
		} else if (this.newLineCount === 1) {
			// Swallow newline, whitespace, and comments
			Array.prototype.push.apply(this.nonNlTokens, this.nlWsTokens);
			this.newLineCount = 0;
			this.nlWsTokens = [];

			// Swallow the current line
			Array.prototype.push.apply(this.nonNlTokens, this.currLine.tokens);
			this.resetCurrLine();

			// But, dont process the stashed tokens yet ... we may still
			// end up wrapping them in a paragraph later on.
			this.currLine.tokens.push(token);
			return {};
		} else {
			res = this.processPendingNLs(isBlockToken);
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
	module.exports.PostExpandParagraphHandler = PostExpandParagraphHandler;
}
