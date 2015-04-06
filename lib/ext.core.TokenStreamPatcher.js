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
	defines = require('./mediawiki.parser.defines.js'),
	TemplateHandler = require('./ext.core.TemplateHandler.js').TemplateHandler,
	coreutil = require('util');

// define some constructor shortcuts
var CommentTk = defines.CommentTk,
	TagTk = defines.TagTk,
	SelfclosingTagTk = defines.SelfclosingTagTk,
	EndTagTk = defines.EndTagTk,
	KV = defines.KV;

function TokenStreamPatcher( manager, options ) {
	TemplateHandler.apply( this, arguments );
	this.tokenizer = new PegTokenizer( this.env );
	this.reset();
}

// Similar to the ExtensionHandler, we get some code reuse from inheritance.
// FIXME: At this point, it probably deserves a refactor.
coreutil.inherits(TokenStreamPatcher, TemplateHandler);

TokenStreamPatcher.prototype.anyRank  = 2.001;
TokenStreamPatcher.prototype.nlRank   = 2.002;
TokenStreamPatcher.prototype.endRank  = 2.003;

TokenStreamPatcher.prototype.register = function() {
	this.manager.addTransform( this.onNewline.bind(this),
		"TokenStreamPatcher:onNewline", this.nlRank, 'newline' );
	this.manager.addTransform( this.onEnd.bind(this),
		"TokenStreamPatcher:onEnd", this.endRank, 'end' );
	this.manager.addTransform( this.onAny.bind(this),
		"TokenStreamPatcher:onAny", this.anyRank, 'any' );
};

TokenStreamPatcher.prototype.resetState = function(opts) {
	this.atTopLevel = opts && opts.toplevel;
};

TokenStreamPatcher.prototype.reset = function() {
	this.inNowiki = false;
	this.wikiTableNesting = 0;
	this.srcOffset = 0;
	this.sol = true;
};

TokenStreamPatcher.prototype.onNewline = function(token) {
	this.srcOffset = (token.dataAttribs.tsr || [null, null])[1];
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

TokenStreamPatcher.prototype._convertTokenToString = function(token) {
	var da = token.dataAttribs,
		tsr = da ? da.tsr : null;

	if (tsr && tsr[1] > tsr[0]) {
		// > will only hold if these are valid numbers
		var sub = this.manager.env.page.src.substring(tsr[0], tsr[1]);

		// fast path
		if ( !/{{!}}/.test(sub) ) {
			return [sub];
		}

		// special case for {{!}} magic word
		var split = sub.split("{{!}}"),
			rets = [split[0]],
			ind = split[0].length,
			i = 1, params, tok;

		for (; i < split.length; i++) {
			params = [ new KV("!", "", [ind + 2, ind + 3]) ];
			tok = new SelfclosingTagTk("template", params, {
				tsr: [ind, ind + 5],
				src: "{{!}}"
			});
			rets = rets.concat(
				TemplateHandler.prototype.checkForMagicWordVariable.call(this, tok),
				split[i]
			);
			ind += 5 + split[i].length;
		}

		// remove empty strings
		return rets.filter(function(tok) {
			return !!tok;
		});
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
	this.manager.env.log("trace/tsp", this.manager.pipelineId, function() { return JSON.stringify(token); } );

	var tokens = [token];
	switch (token.constructor) {
		case String:
			// TRICK #1:
			// Attempt to match "{|" after a newline and convert
			// it to a table token.
			if (this.sol && !this.inNowiki) {
				if (this.atTopLevel && token.match(/^\{\|/)) {
					// Reparse string with the 'table_start_tag' production
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
			if (token.name === "meta" && token.dataAttribs.stx !== "html") {
				this.srcOffset = (token.dataAttribs.tsr || [null, null])[1];
			} else {
				this.clearSOL();
			}
			break;

		case TagTk:
			if (token.getAttribute("typeof") === "mw:Nowiki") {
				this.inNowiki = true;
			} else if (this.atTopLevel && !token.isHTMLTag()) {
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
			} else if (this.atTopLevel && !token.isHTMLTag() && token.name === 'table') {
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

	return {tokens: tokens};
};

if (typeof module === "object") {
	module.exports.TokenStreamPatcher = TokenStreamPatcher;
}
