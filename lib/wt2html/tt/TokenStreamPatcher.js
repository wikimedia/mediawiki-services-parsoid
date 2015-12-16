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
'use strict';

var coreutil = require('util');
var PegTokenizer = require('../tokenizer.js').PegTokenizer;
var defines = require('../parser.defines.js');
var TemplateHandler = require('./TemplateHandler.js').TemplateHandler;
var Util = require('../../utils/Util.js').Util;

// define some constructor shortcuts
var CommentTk = defines.CommentTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;
var KV = defines.KV;


/**
 * @class
 * @extends TemplateHandler
 * @constructor
 */
function TokenStreamPatcher() {
	TemplateHandler.apply(this, arguments);
}
coreutil.inherits(TokenStreamPatcher, TemplateHandler);

TokenStreamPatcher.prototype.nlRank  = 2.001;
TokenStreamPatcher.prototype.anyRank = 2.002;
TokenStreamPatcher.prototype.endRank = 2.003;

TokenStreamPatcher.prototype.init = function() {
	this.tokenizer = new PegTokenizer(this.env);
	this.manager.addTransform(this.onNewline.bind(this),
		'TokenStreamPatcher:onNewline', this.nlRank, 'newline');
	this.manager.addTransform(this.onEnd.bind(this),
		'TokenStreamPatcher:onEnd', this.endRank, 'end');
	this.manager.addTransform(this.onAny.bind(this),
		'TokenStreamPatcher:onAny', this.anyRank, 'any');
	this.reset();
};

TokenStreamPatcher.prototype.reset = function() {
	this.inNowiki = false;
	this.wikiTableNesting = 0;
	this.srcOffset = 0;
	this.sol = true;
	this.tokenBuf = [];
};

TokenStreamPatcher.prototype.onNewline = function(token) {
	this.manager.env.log("trace/tsp", this.manager.pipelineId, function() { return JSON.stringify(token); });
	this.srcOffset = (token.dataAttribs.tsr || [null, null])[1];
	this.sol = true;
	this.tokenBuf.push(token);
	return {tokens: []};
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

TokenStreamPatcher.prototype._convertTokenToString = function(token) {
	var da = token.dataAttribs;
	var tsr = da ? da.tsr : null;

	if (tsr && tsr[1] > tsr[0]) {
		// > will only hold if these are valid numbers
		var str = this.manager.env.page.src.substring(tsr[0], tsr[1]);
		// sol === false ensures that the pipe will not be parsed as a <td> again
		var toks = this.tokenizer.tokenize(str, null, null, true, false);
		toks.pop(); // pop EOFTk
		// Update tsr
		Util.shiftTokenTSR(toks, tsr[0]);

		var ret = [];
		for (var i = 0; i < toks.length; i++) {
			var t = toks[i];
			if (!t) {
				continue;
			}

			// Reprocess magic words to completion.
			// FIXME: This doesn't handle any templates that got retokenized.
			// That requires processing this whole thing in a tokens/x-mediawiki
			// pipeline which is not possible right now because TSP runs in the
			// synchronous 3rd phase. So, not tackling that in this patch.
			// This has been broken for the longest time and feels similar to
			// https://gerrit.wikimedia.org/r/#/c/105018/
			// All of these need uniform handling. To be addressed separately
			// if this proves to be a real problem on production pages.
			if (t.constructor === SelfclosingTagTk && t.name === 'template') {
				t = TemplateHandler.prototype.checkForMagicWordVariable.call(this, t) || t;
			}
			ret = ret.concat(t);
		}
		return ret;
	} else if (da.autoInsertedStart && da.autoInsertedEnd) {
		return [""];
	} else {
		// SSS FIXME: What about "!!" and "||"??
		switch (token.name) {
			case 'td' : return ["|"];
			case 'th' : return ["!"];
			case 'tr' : return ["|-"];
			case 'table':
				if (token.constructor === EndTagTk) {
					return ["|}"];
				}
		}

		// No conversion if we get here
		return [token];
	}
};

TokenStreamPatcher.prototype.onAny = function(token) {
	this.manager.env.log("trace/tsp", this.manager.pipelineId, function() { return JSON.stringify(token); });

	var tokens = [token];
	switch (token.constructor) {
		case String:
			// While we are buffering newlines to suppress them
			// in case we see a category, buffer all intervening
			// white-space as well.
			if (this.tokenBuf.length > 0 && /^\s*$/.test(token)) {
				this.tokenBuf.push(token);
				return {tokens: []};
			}

			// TRICK #1:
			// Attempt to match "{|" after a newline and convert
			// it to a table token.
			if (this.sol && !this.inNowiki) {
				if (this.atTopLevel && token.match(/^\{\|/)) {
					// Reparse string with the 'table_start_tag' rule
					// and shift tsr of result tokens by source offset
					tokens = this.tokenizer.tokenize(token, 'table_start_tag');
					Util.shiftTokenTSR(tokens, this.srcOffset, true);
					this.wikiTableNesting++;
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
			this.srcOffset = (token.dataAttribs.tsr || [null, null])[1];
			break;

		case SelfclosingTagTk:
			if (token.name === 'meta' && token.dataAttribs.stx !== 'html') {
				this.srcOffset = (token.dataAttribs.tsr || [null, null])[1];
				// If we have buffered newlines, we might very well encounter
				// a category link, so continue buffering.
				if (this.tokenBuf.length > 0 && token.name === 'meta' &&
					token.getAttribute('typeof') === 'mw:Transclusion') {
					this.tokenBuf.push(token);
					return {tokens: []};
				}
			} else if (token.name === 'link' &&
				token.getAttribute('rel') === 'mw:PageProp/Category') {
				// Replace buffered newline & whitespace tokens with mw:EmptyLine
				// meta-tokens. This tunnels them through the rest of the transformations
				// without affecting them. During HTML building, they are expanded
				// back to newlines / whitespace.
				var n = this.tokenBuf.length;
				if (n > 0) {
					var i = 0;
					while (i < n && this.tokenBuf[i].constructor !== SelfclosingTagTk) {
						i++;
					}

					var toks = [
						new SelfclosingTagTk("meta",
							[new KV('typeof', 'mw:EmptyLine')], {
								tokens: this.tokenBuf.slice(0, i),
							}),
					];
					if (i < n) {
						toks.push(this.tokenBuf[i]);
						if (i + 1 < n) {
							toks.push(new SelfclosingTagTk("meta",
								[new KV('typeof', 'mw:EmptyLine')], {
									tokens: this.tokenBuf.slice(i + 1),
								})
							);
						}
					}
					tokens = toks.concat(tokens);
					this.tokenBuf = [];
				}
				this.clearSOL();
			} else {
				this.clearSOL();
			}
			break;

		case TagTk:
			if (token.getAttribute("typeof") === "mw:Nowiki") {
				this.inNowiki = true;
			} else if (this.atTopLevel && !Util.isHTMLTag(token)) {
				if (token.name === 'table') {
					this.wikiTableNesting++;
				} else if (this.wikiTableNesting === 0 &&
					(token.name === 'td' || token.name === 'th' || token.name === 'tr')) {
					tokens = this._convertTokenToString(token);
				}
			}
			this.clearSOL();
			break;

		case EndTagTk:
			if (token.getAttribute("typeof") === "mw:Nowiki") {
				this.inNowiki = false;
			} else if (this.atTopLevel && !Util.isHTMLTag(token) && token.name === 'table') {
				if (this.wikiTableNesting > 0) {
					this.wikiTableNesting--;
				} else {
					// Convert this to "|}"
					tokens = this._convertTokenToString(token);
				}
			}
			this.clearSOL();
			break;

		default:
			break;
	}

	// Emit buffered newlines (and a transclusion meta-token, if any)
	if (this.tokenBuf.length > 0) {
		tokens = this.tokenBuf.concat(tokens);
		this.tokenBuf = [];
	}
	return {tokens: tokens};
};

if (typeof module === "object") {
	module.exports.TokenStreamPatcher = TokenStreamPatcher;
}
