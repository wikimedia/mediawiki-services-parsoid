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

var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer;
var Util = require('./mediawiki.Util.js').Util;
var defines = require('./mediawiki.parser.defines.js');
var TemplateHandler = require('./ext.core.TemplateHandler.js').TemplateHandler;
var coreutil = require('util');

// define some constructor shortcuts
var CommentTk = defines.CommentTk;
var NlTk = defines.NlTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;
var KV = defines.KV;

/**
 * @class
 * @extends TemplateHandler
 * @constructor
 */
function TokenStreamPatcher(manager, options) {
	TemplateHandler.apply(this, arguments);
	this.tokenizer = new PegTokenizer(this.env);
	this.reset();
}

// Similar to the ExtensionHandler, we get some code reuse from inheritance.
// FIXME: At this point, it probably deserves a refactor.
coreutil.inherits(TokenStreamPatcher, TemplateHandler);

TokenStreamPatcher.prototype.nlRank   = 2.001;
TokenStreamPatcher.prototype.anyRank  = 2.002;
TokenStreamPatcher.prototype.endRank  = 2.003;

TokenStreamPatcher.prototype.register = function() {
	this.manager.addTransform(this.onNewline.bind(this),
		"TokenStreamPatcher:onNewline", this.nlRank, 'newline');
	this.manager.addTransform(this.onEnd.bind(this),
		"TokenStreamPatcher:onEnd", this.endRank, 'end');
	this.manager.addTransform(this.onAny.bind(this),
		"TokenStreamPatcher:onAny", this.anyRank, 'any');
};

TokenStreamPatcher.prototype.resetState = function(opts) {
	this.atTopLevel = opts && opts.toplevel;
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
		var sub = this.manager.env.page.src.substring(tsr[0], tsr[1]);

		// fast path
		if (!/{{!}}/.test(sub)) {
			return [sub];
		}

		// special case for {{!}} magic word
		var split = sub.split("{{!}}");
		var rets = [split[0]];
		var ind = split[0].length;

		for (var i = 1; i < split.length; i++) {
			var params = [ new KV("!", "", [ind + 2, ind + 3]) ];
			var tok = new SelfclosingTagTk("template", params, {
				tsr: [ind, ind + 5],
				src: '{{!}}',
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
