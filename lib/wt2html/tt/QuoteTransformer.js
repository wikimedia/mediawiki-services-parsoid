/**
 * MediaWiki-compatible italic/bold handling as a token stream transformation.
 * @module
 */

'use strict';

var TokenHandler = require('./TokenHandler.js');
const { KV, TagTk, EndTagTk, SelfclosingTagTk } = require('../../tokens/TokenTypes.js');

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class QuoteTransformer extends TokenHandler {
	/**
	 * Class constructor.
	 *
	 * @param {TokenTransformManager} manager
	 * @param {Object} options
	 */
	constructor(manager, options) {
		super(manager, options);
		this.reset();
	}

	/**
	 * Reset the buffering of chunks.
	 */
	reset() {
		// Chunks alternate between quote tokens and sequences of non-quote
		// tokens.  The quote tokens are later replaced with the actual tag
		// token for italic or bold.  The first chunk is a non-quote chunk.
		this.chunks = [];
		// The current chunk we're accumulating into.
		this.currentChunk = [];
		// last italic / last bold open tag seen.  Used to add autoInserted flags
		// where necessary.
		this.last = Object.create(null);

		this.onAnyEnabled = false;
	}

	/**
	 * Make a copy of the token context.
	 */
	startNewChunk() {
		this.chunks.push(this.currentChunk);
		this.currentChunk = [];
	}

	/**
	 * Handles mw-quote tokens and td/th tokens.
	 * @param {Token} token
	 */
	onTag(token) {
		if (token.name === 'mw-quote') {
			return this.onQuote(token);
		} else if (token.name === 'td' || token.name === 'th') {
			return this.processQuotes(token);
		} else {
			return token;
		}
	}

	/**
	 * On encountering an NlTk, processes quotes on the current line.
	 * @param {Token} token
	 */
	onNewline(token) {
		return this.processQuotes(token);
	}

	/**
	 * On encountering an EOFTk, process quotes on the current line.
	 * @param {Token} token
	 */
	onEnd(token) {
		return this.processQuotes(token);
	}

	/**
	 * Handle any other tags.
	 * @param {Token} token
	 */
	onAny(token) {
		this.manager.env.log(
			"trace/quote",
			this.manager.pipelineId,
			"ANY   |",
			() => (!this.onAnyEnabled ? " ---> " : "") + JSON.stringify(token)
		);

		if (this.onAnyEnabled) {
			this.currentChunk.push(token);
			return {};
		} else {
			return token;
		}
	}

	/**
	 * Handle QUOTE tags. These are collected in italic/bold lists depending on
	 * the length of quote string. Actual analysis and conversion to the
	 * appropriate tag tokens is deferred until the next quote-scope-ending
	 * token triggers processQuotes.
	 * @param {Token} token
	 */
	onQuote(token) {
		var qlen = token.getAttribute('value').length;
		this.manager.env.log("trace/quote", this.manager.pipelineId, "QUOTE |", () => JSON.stringify(token));

		this.onAnyEnabled = true;

		if (qlen === 2 || qlen === 3 || qlen === 5) {
			this.startNewChunk();
			this.currentChunk.push(token);
			this.startNewChunk();
		} else {
			console.assert(false, "should be transformed by tokenizer");
		}

		return {};
	}

	/**
	 * Handle quote-scope-ending tokens that trigger the actual quote analysis
	 * on the buffered quote tokens so far.
	 * @param {Token} token
	 */
	processQuotes(token) {
		if (!this.onAnyEnabled) {
			// Nothing to do, quick abort.
			return token;
		}

		this.manager.env.log(
			"trace/quote",
			this.manager.pipelineId,
			"NL    |",
			() => JSON.stringify(token)
		);

		// Only consider !html table cells as newlines
		if (['td', 'th'].includes(token.name) && token.dataAttribs.stx === 'html') {
			return { tokens: [ token ] };
		}

		// count number of bold and italics
		var res, qlen, i;
		var numbold = 0;
		var numitalics = 0;
		for (i = 1; i < this.chunks.length; i += 2) {
			console.assert(this.chunks[i].length === 1); // quote token
			qlen = this.chunks[i][0].getAttribute('value').length;
			if (qlen === 2 || qlen === 5) { numitalics++; }
			if (qlen === 3 || qlen === 5) { numbold++; }
		}

		// balance out tokens, convert placeholders into tags
		if ((numitalics % 2 === 1) && (numbold % 2 === 1)) {
			var firstsingleletterword = -1;
			var firstmultiletterword = -1;
			var firstspace = -1;
			for (i = 1; i < this.chunks.length; i += 2) {
				// only look at bold tags
				if (this.chunks[i][0].getAttribute('value').length !== 3) { continue; }
				var ctxPrevToken = this.chunks[i][0].getAttribute('preceding-2chars');
				var lastchar = ctxPrevToken[ctxPrevToken.length - 1];
				var secondtolastchar = ctxPrevToken[ctxPrevToken.length - 2];
				if (lastchar === ' ' && firstspace === -1) {
					firstspace = i;
				} else if (lastchar !== ' ') {
					if (secondtolastchar === ' ' &&
						firstsingleletterword === -1
					) {
						firstsingleletterword = i;
						// if firstsingleletterword is set, we don't need
						// to look at the other options, so we can bail early
						break;
					} else if (firstmultiletterword === -1) {
						firstmultiletterword = i;
					}
				}
			}

			// now see if we can convert a bold to an italic and an apostrophe
			if (firstsingleletterword > -1) {
				this.convertBold(firstsingleletterword);
			} else if (firstmultiletterword > -1) {
				this.convertBold(firstmultiletterword);
			} else if (firstspace > -1) {
				this.convertBold(firstspace);
			} else {
				// (notice that it is possible for all three to be -1 if, for
				// example, there is only one pentuple-apostrophe in the line)
				// In this case, do no balancing.
			}
		}

		// convert the quote tokens into tags
		this.convertQuotesToTags();

		// return all collected tokens including the newline
		this.currentChunk.push(token);
		this.startNewChunk();
		const tokens = this.chunks.reduce((acc,el) => acc.concat(el), []);
		res = { tokens: tokens };

		this.manager.env.log("trace/quote", this.manager.pipelineId, "----->", () => JSON.stringify(res.tokens));

		// prepare for next line
		this.reset();

		return res;
	}

	/**
	 * Convert a bold token to italic to balance an uneven number of both bold and
	 * italic tags. In the process, one quote needs to be converted back to text.
	 * @param {int} i index into chunks
	 */
	convertBold(i) {
		// this should be a bold tag.
		console.assert(
			i > 0 &&
			this.chunks[i].length === 1 &&
			this.chunks[i][0].getAttribute('value').length === 3
		);
		// we're going to convert it to a single plain text ' plus an italic tag
		this.chunks[i - 1].push("'");
		var oldbold = this.chunks[i][0];
		var tsr = oldbold.dataAttribs ? oldbold.dataAttribs.tsr : null;
		if (tsr) {
			tsr = [ tsr[0] + 1, tsr[1] ];
		}
		this.chunks[i] = [
			// bold -> italic
			new SelfclosingTagTk('mw-quote', [new KV('value', "''")], { tsr: tsr })
		];
	}

	/**
	 * Convert quote tokens to tags, using the same state machine as the
	 * legacy parser uses.
	 */
	convertQuotesToTags() {
		var lastboth = -1;
		var state = '';

		for (var i = 1; i < this.chunks.length; i += 2) {
			console.assert(this.chunks[i].length === 1);
			var qlen = this.chunks[i][0].getAttribute('value').length;
			if (qlen === 2) {
				if (state === 'i') {
					this.quoteToTag(i, [new EndTagTk('i')]);
					state = '';
				} else if (state === 'bi') {
					this.quoteToTag(i, [new EndTagTk('i')]);
					state = 'b';
				} else if (state === 'ib') {
				// annoying!
					this.quoteToTag(i, [
						new EndTagTk('b'),
						new EndTagTk('i'),
						new TagTk('b'),
					], "bogus two");
					state = 'b';
				} else if (state === 'both') {
					this.quoteToTag(lastboth, [new TagTk('b'), new TagTk('i')]);
					this.quoteToTag(i, [new EndTagTk('i')]);
					state = 'b';
				} else { // state can be 'b' or ''
					this.quoteToTag(i, [new TagTk('i')]);
					state += 'i';
				}
			} else if (qlen === 3) {
				if (state === 'b') {
					this.quoteToTag(i, [new EndTagTk('b')]);
					state = '';
				} else if (state === 'ib') {
					this.quoteToTag(i, [new EndTagTk('b')]);
					state = 'i';
				} else if (state === 'bi') {
				// annoying!
					this.quoteToTag(i, [
						new EndTagTk('i'),
						new EndTagTk('b'),
						new TagTk('i'),
					], "bogus two");
					state = 'i';
				} else if (state === 'both') {
					this.quoteToTag(lastboth, [new TagTk('i'), new TagTk('b')]);
					this.quoteToTag(i, [new EndTagTk('b')]);
					state = 'i';
				} else { // state can be 'i' or ''
					this.quoteToTag(i, [new TagTk('b')]);
					state += 'b';
				}
			} else if (qlen === 5) {
				if (state === 'b') {
					this.quoteToTag(i, [new EndTagTk('b'), new TagTk('i')]);
					state = 'i';
				} else if (state === 'i') {
					this.quoteToTag(i, [new EndTagTk('i'), new TagTk('b')]);
					state = 'b';
				} else if (state === 'bi') {
					this.quoteToTag(i, [new EndTagTk('i'), new EndTagTk('b')]);
					state = '';
				} else if (state === 'ib') {
					this.quoteToTag(i, [new EndTagTk('b'), new EndTagTk('i')]);
					state = '';
				} else if (state === 'both') {
					this.quoteToTag(lastboth, [new TagTk('i'), new TagTk('b')]);
					this.quoteToTag(i, [new EndTagTk('b'), new EndTagTk('i')]);
					state = '';
				} else { // state == ''
					lastboth = i;
					state = 'both';
				}
			}
		}

		// now close all remaining tags.  notice that order is important.
		if (state === 'both') {
			this.quoteToTag(lastboth, [new TagTk('b'), new TagTk('i')]);
			state = 'bi';
		}
		if (state === 'b' || state === 'ib') {
			this.currentChunk.push(new EndTagTk('b'));
			this.last.b.dataAttribs.autoInsertedEnd = true;
		}
		if (state === 'i' || state === 'bi' || state === 'ib') {
			this.currentChunk.push(new EndTagTk('i'));
			this.last.i.dataAttribs.autoInsertedEnd = true;
		}
		if (state === 'bi') {
			this.currentChunk.push(new EndTagTk('b'));
			this.last.b.dataAttribs.autoInsertedEnd = true;
		}
	}

	/**
	 * Convert italics/bolds into tags.
	 * @param {int} chunk
	 * @param {Array} tags
	 * @param {boolean} ignoreBogusTwo
	 */
	quoteToTag(chunk, tags, ignoreBogusTwo) {
		console.assert(this.chunks[chunk].length === 1);
		var result = [];
		var oldtag = this.chunks[chunk][0];
		// make tsr
		var tsr = oldtag.dataAttribs ? oldtag.dataAttribs.tsr : null;
		var startpos = tsr ? tsr[0] : null;
		var endpos = tsr ? tsr[1] : null;
		for (var i = 0; i < tags.length; i++) {
			if (tsr) {
				if (i === 0 && ignoreBogusTwo) {
					this.last[tags[i].name].dataAttribs.autoInsertedEnd = true;
				} else if (i === 2 && ignoreBogusTwo) {
					tags[i].dataAttribs.autoInsertedStart = true;
				} else if (tags[i].name === 'b') {
					tags[i].dataAttribs.tsr = [ startpos, startpos + 3 ];
					startpos = tags[i].dataAttribs.tsr[1];
				} else if (tags[i].name === 'i') {
					tags[i].dataAttribs.tsr = [ startpos, startpos + 2 ];
					startpos = tags[i].dataAttribs.tsr[1];
				} else { console.assert(false); }
			}
			this.last[tags[i].name] = (tags[i].constructor === EndTagTk) ? null : tags[i];
			result.push(tags[i]);
		}
		if (tsr) { console.assert(startpos === endpos, startpos, endpos); }
		this.chunks[chunk] = result;
	}
}

if (typeof module === "object") {
	module.exports.QuoteTransformer = QuoteTransformer;
}
