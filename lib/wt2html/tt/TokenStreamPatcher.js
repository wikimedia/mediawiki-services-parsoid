/**
 * This class is an attempt to fixup the token stream to reparse strings
 * as tokens that failed to parse in the tokenizer because of sol or
 * other constraints OR because tags were being constructed in pieces
 * or whatever.
 *
 * This is a pure hack to improve compatibility with the PHP parser
 * given that we dont have a preprocessor.  This will be a grab-bag of
 * heuristics and tricks to handle different scenarios.
 * @module
 */

'use strict';

const { PegTokenizer } = require('../tokenizer.js');
const { TemplateHandler } = require('./TemplateHandler.js');
const { TokenUtils } = require('../../utils/TokenUtils.js');

// define some constructor shortcuts
const { KV, TagTk, EndTagTk, SelfclosingTagTk, CommentTk } = require('../../tokens/TokenTypes.js');

/**
 * @class
 * @extends module:wt2html/tt/TemplateHandler~TemplateHandler
 */
class TokenStreamPatcher extends TemplateHandler {

	constructor(manager, options) {
		super(manager, Object.assign({ tsp:true }, options));
		this.tokenizer = new PegTokenizer(this.env);
		this.reset();
	}

	reset() {
		this.srcOffset = 0;
		this.sol = true;
		this.tokenBuf = [];
		this.wikiTableNesting = 0;
		// This marker tries to track the most recent table-cell token (td/th)
		// that was converted to string. For those, we want to get rid
		// of their corresponding mw:TSRMarker meta tag.
		//
		// This marker is set when we convert a td/th token to string
		//
		// This marker is cleared in one of the following scenarios:
		// 1. When we clear a mw:TSRMarker corresponding to the token set earlier
		// 2. When we change table nesting
		// 3. When we hit a tr/td/th/caption token that wasn't converted to string
		this.lastConvertedTableCellToken = null;
	}

	onNewline(token) {
		this.manager.env.log("trace/tsp", this.manager.pipelineId, function() { return JSON.stringify(token); });
		this.srcOffset = (token.dataAttribs.tsr || [null, null])[1];
		this.sol = true;
		this.tokenBuf.push(token);
		return { tokens: [] };
	}

	onEnd(token) {
		const res = this.onAny(token);
		this.reset();
		return res;
	}

	clearSOL() {
		// clear tsr and sol flag
		this.srcOffset = null;
		this.sol = false;
	}

	_convertTokenToString(token) {
		var da = token.dataAttribs;
		var tsr = da ? da.tsr : null;

		if (tsr && tsr[1] > tsr[0]) {
			// > will only hold if these are valid numbers
			var str = this.manager.frame.srcText.substring(tsr[0], tsr[1]);
			// sol === false ensures that the pipe will not be parsed as a <td> again
			var toks = this.tokenizer.tokenizeSync(str, { sol: false });
			toks.pop(); // pop EOFTk
			// Update tsr
			TokenUtils.shiftTokenTSR(toks, tsr[0]);

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
					t = TemplateHandler.prototype.processSpecialMagicWord.call(this, t) || t;
				}
				ret = ret.concat(t);
			}
			return ret;
		} else if (da.autoInsertedStart && da.autoInsertedEnd) {
			return [""];
		} else {
			// SSS FIXME: What about "!!" and "||"??
			switch (token.name) {
				case 'td': return ["|"];
				case 'th': return ["!"];
				case 'tr': return ["|-"];
				case 'caption':
					return [token.constructor === TagTk ? '|+' : ''];
				case 'table':
					if (token.constructor === EndTagTk) {
						return ["|}"];
					}
			}

			// No conversion if we get here
			return [token];
		}
	}

	onAny(token) {
		this.manager.env.log("trace/tsp", this.manager.pipelineId, function() { return JSON.stringify(token); });

		var tokens = [token];
		switch (token.constructor) {
			case String:
				// While we are buffering newlines to suppress them
				// in case we see a category, buffer all intervening
				// white-space as well.
				if (this.tokenBuf.length > 0 && /^\s*$/.test(token)) {
					this.tokenBuf.push(token);
					return { tokens: [] };
				}

				// TRICK #1:
				// Attempt to match "{|" after a newline and convert
				// it to a table token.
				if (this.sol) {
					if (this.atTopLevel && token.match(/^\{\|/)) {
						// Reparse string with the 'table_start_tag' rule
						// and shift tsr of result tokens by source offset
						const retoks = this.tokenizer.tokenizeAs(token, 'table_start_tag', /* sol */true);
						if (retoks instanceof Error) {
							// XXX: The string begins with table start syntax,
							// we really shouldn't be here.  Anything else on the
							// line would get swallowed up as attributes.
							this.manager.env.log('error', 'Failed to tokenize table start tag.');
							this.clearSOL();
						} else {
							TokenUtils.shiftTokenTSR(retoks, this.srcOffset, true);
							tokens = retoks;
							this.wikiTableNesting++;
							this.lastConvertedTableCellToken = null;
						}
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
					var typeOf = token.getAttribute('typeof');
					if (typeOf === 'mw:TSRMarker' && this.lastConvertedTableCellToken !== null &&
						this.lastConvertedTableCellToken.name === token.getAttribute('data-etag')) {
						// Swallow the token and clear the marker
						this.lastConvertedTableCellToken = null;
						return { tokens: [] };
					} else if (this.tokenBuf.length > 0 && typeOf === 'mw:Transclusion') {
						// If we have buffered newlines, we might very well encounter
						// a category link, so continue buffering.
						this.tokenBuf.push(token);
						return { tokens: [] };
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
				if (this.atTopLevel && !TokenUtils.isHTMLTag(token)) {
					if (token.name === 'table') {
						this.lastConvertedTableCellToken = null;
						this.wikiTableNesting++;
					} else if (['td', 'th', 'tr', 'caption'].indexOf(token.name) !== -1) {
						if (this.wikiTableNesting === 0) {
							if (token.name === 'td' || token.name === 'th') {
								this.lastConvertedTableCellToken = token;
							}
							tokens = this._convertTokenToString(token);
						} else {
							this.lastConvertedTableCellToken = null;
						}
					}
				}
				this.clearSOL();
				break;

			case EndTagTk:
				if (this.atTopLevel && !TokenUtils.isHTMLTag(token)) {
					if (this.wikiTableNesting > 0) {
						if (token.name === 'table') {
							this.lastConvertedTableCellToken = null;
							this.wikiTableNesting--;
						}
					} else if (token.name === 'table' || token.name === 'caption') {
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
		return { tokens: tokens };
	}
}

if (typeof module === "object") {
	module.exports.TokenStreamPatcher = TokenStreamPatcher;
}
