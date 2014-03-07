/* --------------------------------------------------------------------
 * This class is an attempt to fixup the token stream to reparse strings
 * as tokens that failed to parse in the tokenizer because of sol or
 * other constraints OR because tags were being constructed in pieces
 * or whatever.
 *
 * This is a pure hack to improve compatibility with the PHP parser
 * given that we dont have a preprocessor.  This will be a grab-bag of
 * heuristics and tricks to handle different scenarios.
 * -------------------------------------------------------------------- */
"use strict";

var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	Util = require('./mediawiki.Util.js').Util,
	defines = require('./mediawiki.parser.defines.js');

// define some constructor shortcuts
var CommentTk = defines.CommentTk,
    TagTk = defines.TagTk,
    SelfclosingTagTk = defines.SelfclosingTagTk,
    EndTagTk = defines.EndTagTk;

var gid = 0;

function TokenStreamPatcher( manager, options ) {
	this.manager = manager;
	this.tokenizer = new PegTokenizer(this.manager.env);
	this.uid = gid++;
	this.env = this.manager.env;

	manager.addTransform(this.onNewline.bind(this),
		"TokenStreamPatcher:onNewline", this.nlRank, 'newline');
	manager.addTransform(this.onEnd.bind(this),
		"TokenStreamPatcher:onEnd", this.endRank, 'end');
	manager.addTransform( this.onAny.bind(this),
		"TokenStreamPatcher:onAny", this.anyRank, 'any' );

	this.reset();
}

TokenStreamPatcher.prototype.anyRank  = 2.001;
TokenStreamPatcher.prototype.nlRank   = 2.002;
TokenStreamPatcher.prototype.endRank  = 2.003;

TokenStreamPatcher.prototype.reset = function() {
	this.inNowiki = false;
	this.srcOffset = 0;
	this.sol = true;
};

TokenStreamPatcher.prototype.onNewline = function(token) {
	this.srcOffset = (token.dataAttribs.tsr || [null,null])[1];
	this.sol = true;
	return {tokens: [token]};
};

TokenStreamPatcher.prototype.onEnd = function(token) {
	this.reset();
	return {tokens: [token]};
};

TokenStreamPatcher.prototype.clearSOL = function() {
	// clear tsr and sol flag
	this.srcOffset = null;
	this.sol = false;
};

TokenStreamPatcher.prototype.onAny = function(token) {
	this.env.log("trace/tsp", "T[", this.uid, "]: ", JSON.stringify(token));

	var tokens = [token];
	switch (token.constructor) {
		case String:
			// TRICK #1:
			// Attempt to match "{|" after a newline and convert
			// it to a table token.
			if (this.sol && !this.inNowiki) {
				if (token.match(/^\{\|/)) {
					// Reparse string with the 'table_start_tag' production
					// and shift tsr of result tokens by source offset
					tokens = this.tokenizer.tokenize(token, 'table_start_tag');
					Util.shiftTokenTSR(tokens, this.srcOffset, true);
				} else if (token.match(/^\s*$/)) {
					// White-space doesn't change SOL state
					// Update srcOffset
					this.srcOffset += token.length;
				} else {
					this.clearSOL();
				}
			} else {
				this.clearSOL();
			}
			break;

		case CommentTk:
			// Comments don't change SOL state
			// Update srcOffset
			this.srcOffset = (token.dataAttribs.tsr || [null,null])[1];
			break;

		case SelfclosingTagTk:
			if (token.name === "meta" && token.dataAttribs.stx !== "html") {
				this.srcOffset = (token.dataAttribs.tsr || [null,null])[1];
			} else {
				this.clearSOL();
			}
			break;

		case TagTk:
			if (token.getAttribute("typeof") === "mw:Nowiki") {
				this.inNowiki = true;
			}
			this.clearSOL();
			break;

		case EndTagTk:
			if (token.getAttribute("typeof") === "mw:Nowiki") {
				this.inNowiki = false;
			}
			this.clearSOL();
			break;

		default:
			break;
	}

	return {tokens: tokens};
};

if (typeof module === "object") {
	module.exports.TokenStreamPatcher = TokenStreamPatcher;
}