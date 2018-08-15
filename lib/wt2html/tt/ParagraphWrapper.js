/**
 * Insert paragraph tags where needed -- smartly and carefully
 * -- there is much fun to be had mimicking "wikitext visual newlines"
 * behavior as implemented by the PHP parser.
 * @module
 */

'use strict';

const { Util } = require('../../utils/Util.js');
const TokenHandler = require('./TokenHandler.js');
const { CommentTk, EOFTk, NlTk, TagTk, SelfclosingTagTk, EndTagTk } =
	require('../parser.defines.js');

// These are defined in the php parser's `BlockLevelPass`
const blockElems = new Set([
	'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'P', 'UL', 'OL', 'DL',
]);
const antiBlockElems = new Set([
	'TD', 'TH',
]);
const alwaysSuppress = new Set([
	'TR', 'DT', 'DD', 'LI',
]);
const neverSuppress = new Set([
	'CENTER', 'BLOCKQUOTE', 'DIV', 'HR',
	// XXX: This is new in https://gerrit.wikimedia.org/r/#/c/196532/
	'FIGURE',
]);

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class ParagraphWrapper extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		this.inPre = false;
		this.hasOpenPTag = false;
		this.inBlockElem = false;
		this.tokenBuffer = [];
		this.nlWsTokens = [];
		this.newLineCount = 0;
		this.currLine = null;

		// Disable p-wrapper
		if (!this.options.inlineContext && !this.options.inPHPBlock) {
			this.manager.addTransform(
				token => this.onNewLineOrEOF(token),
				'ParagraphWrapper:onNewLine',
				ParagraphWrapper.NEWLINE_RANK(),
				'newline'
			);
			this.manager.addTransform(
				token => this.onAny(token),
				'ParagraphWrapper:onAny',
				ParagraphWrapper.ANY_RANK(),
				'any'
			);
			this.manager.addTransform(
				token => this.onNewLineOrEOF(token),
				'ParagraphWrapper:onEnd',
				ParagraphWrapper.END_RANK(),
				'end'
			);
		}
		this.reset();
	}

	// Ranks for token handlers
	// EOF/NL tokens will also match 'ANY' handlers.
	// However, we want them in the custom eof/newline handlers.
	// So, set them to a lower rank (= higher priority) than
	// the any handler.
	static END_RANK() { return 2.95; }
	static NEWLINE_RANK() { return 2.96; }
	static ANY_RANK() { return 2.97; }
	// If a handler sends back the incoming 'token' back without change,
	// the SyncTTM (or AsyncTTM) will dispatch it to other matching handlers.
	// But, we don't want processed tokens coming back into the P-handler again.
	// To prevent this, we can set a rank on the token block to a higher value
	// than all handlers here. Hence, SKIP_RANK has to be larger than the
	// others above.
	static SKIP_RANK() { return 2.971; }

	reset() {
		if (this.inPre) {
			// Clean up in case we run into EOF before seeing a </pre>
			this.manager.addTransform(
				token => this.onNewLineOrEOF(token),
				"ParagraphWrapper:onNewLine",
				ParagraphWrapper.NEWLINE_RANK(),
				'newline'
			);
		}
		// This is the ordering of buffered tokens and how they should get emitted:
		//
		//   token-buffer         (from previous lines if newLineCount > 0)
		//   newline-ws-tokens    (buffered nl+sol-transparent tokens since last non-nl-token)
		//   current-line-tokens  (all tokens after newline-ws-tokens)
		//
		// newline-token-count is > 0 only when we encounter multiple "empty lines".
		//
		// Periodically, when it is clear where an open/close p-tag is required, the buffers
		// are collapsed and emitted. Wherever tokens are buffered/emitted, verify that this
		// order is preserved.
		this.resetBuffers();
		this.resetCurrLine();
		this.hasOpenPTag = false;
		this.inPre = false;
		// NOTE: This flag is the local equivalent of what we're mimicking with
		// the inPHPBlock pipeline option.
		this.inBlockElem = false;
	}

	resetBuffers() {
		this.tokenBuffer = [];
		this.nlWsTokens = [];
		this.newLineCount = 0;
	}

	resetCurrLine() {
		if (this.currLine && (this.currLine.openMatch || this.currLine.closeMatch)) {
			this.inBlockElem = !this.currLine.closeMatch;
		}
		this.currLine = {
			tokens: [],
			hasWrappableTokens: false,
			// These flags, along with `inBlockElem` are concepts from the
			// php parser's `BlockLevelPass`.
			openMatch: false,
			closeMatch: false,
		};
	}

	_processBuffers(token, flushCurrentLine) {
		let res = this.processPendingNLs();
		this.currLine.tokens.push(token);
		if (flushCurrentLine) {
			res = res.concat(this.currLine.tokens);
			this.resetCurrLine();
		}
		this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", () => JSON.stringify(res));
		res.rank = ParagraphWrapper.SKIP_RANK(); // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
		return res;
	}

	_flushBuffers() {
		// Assertion to catch bugs in p-wrapping; both cannot be true.
		if (this.newLineCount > 0) {
			this.env.log(
				"error/p-wrap",
				"Failed assertion in _flushBuffers: newline-count:",
				this.newLineCount,
				"; buffered tokens: ",
				JSON.stringify(this.nlWsTokens));
		}

		const resToks = this.tokenBuffer.concat(this.nlWsTokens);
		this.resetBuffers();
		this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", () => JSON.stringify(resToks));
		resToks.rank = ParagraphWrapper.SKIP_RANK(); // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
		return resToks;
	}

	discardOneNlTk(out) {
		let i = 0;
		const n = this.nlWsTokens.length;
		while (i < n) {
			const t = this.nlWsTokens.shift();
			if (t.constructor === NlTk) {
				return t;
			} else {
				out.push(t);
			}
			i++;
		}
		return "";
	}

	openPTag(out) {
		if (!this.hasOpenPTag) {
			let i = 0;
			let tplStartIndex = -1;
			// Be careful not to expand template ranges unnecessarily.
			// Look for open markers before starting a p-tag.
			for (; i < out.length; i++) {
				const t = out[i];
				if (t.name === "meta") {
					const typeOf = t.getAttribute("typeof");
					if (/^mw:Transclusion$/.test(typeOf)) {
						// We hit a start tag and everything before it is sol-transparent.
						tplStartIndex = i;
						continue;
					} else if (/^mw:Transclusion/.test(typeOf)) {
						// End tag. All tokens before this are sol-transparent.
						// Let us leave them all out of the p-wrapping.
						tplStartIndex = -1;
						continue;
					}
				}
				// Not a transclusion meta; Check for nl/sol-transparent tokens
				// and leave them out of the p-wrapping.
				if (!Util.isSolTransparent(this.env, t) && t.constructor !== NlTk) {
					break;
				}
			}
			if (tplStartIndex > -1) { i = tplStartIndex; }
			out.splice(i, 0, new TagTk('p'));
			this.hasOpenPTag = true;
		}
	}

	closeOpenPTag(out) {
		if (this.hasOpenPTag) {
			let i = out.length - 1;
			let tplEndIndex = -1;
			// Be careful not to expand template ranges unnecessarily.
			// Look for open markers before closing.
			for (; i > -1; i--) {
				const t = out[i];
				if (t.name === "meta") {
					const typeOf = t.getAttribute("typeof");
					if (/^mw:Transclusion$/.test(typeOf)) {
						// We hit a start tag and everything after it is sol-transparent.
						// Don't include the sol-transparent tags OR the start tag.
						tplEndIndex = -1;
						continue;
					} else if (/^mw:Transclusion/.test(typeOf)) {
						// End tag. The rest of the tags past this are sol-transparent.
						// Let us leave them all out of the p-wrapping.
						tplEndIndex = i;
						continue;
					}
				}
				// Not a transclusion meta; Check for nl/sol-transparent tokens
				// and leave them out of the p-wrapping.
				if (!Util.isSolTransparent(this.env, t) && t.constructor !== NlTk) {
					break;
				}
			}
			if (tplEndIndex > -1) { i = tplEndIndex; }
			out.splice(i + 1, 0, new EndTagTk('p'));
			this.hasOpenPTag = false;
		}
	}

	// Handle NEWLINE tokens
	onNewLineOrEOF(token) {
		this.env.log("trace/p-wrap", this.manager.pipelineId, "NL    |", () => JSON.stringify(token));

		const l = this.currLine;
		if (this.currLine.openMatch || this.currLine.closeMatch) {
			this.closeOpenPTag(l.tokens);
		} else if (!this.inBlockElem && !this.hasOpenPTag && l.hasWrappableTokens) {
			this.openPTag(l.tokens);
		}

		// Assertion to catch bugs in p-wrapping; both cannot be true.
		if (this.newLineCount > 0 && l.tokens.length > 0) {
			this.env.log(
				"error/p-wrap",
				"Failed assertion in onNewLineOrEOF: newline-count:",
				this.newLineCount,
				"; current line tokens: ",
				JSON.stringify(l.tokens)
			);
		}

		this.tokenBuffer = this.tokenBuffer.concat(l.tokens);

		if (token.constructor === EOFTk) {
			this.nlWsTokens.push(token);
			this.closeOpenPTag(this.tokenBuffer);
			const res = this.processPendingNLs();
			this.reset();
			this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", () => JSON.stringify(res));
			res.rank = ParagraphWrapper.SKIP_RANK(); // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
			return { tokens: res };
		} else {
			this.resetCurrLine();
			this.newLineCount++;
			this.nlWsTokens.push(token);
			return { tokens: [] };
		}
	}

	processPendingNLs() {
		let resToks = this.tokenBuffer;
		let newLineCount = this.newLineCount;
		let nlTk;

		this.env.log("trace/p-wrap", this.manager.pipelineId, "        NL-count:", newLineCount);

		if (newLineCount >= 2 && !this.inBlockElem) {
			this.closeOpenPTag(resToks);

			// First is emitted as a literal newline
			resToks.push(this.discardOneNlTk(resToks));
			newLineCount -= 1;

			const remainder = newLineCount % 2;

			while (newLineCount > 0) {
				nlTk = this.discardOneNlTk(resToks);
				if (newLineCount % 2 === remainder) {  // Always start here
					if (this.hasOpenPTag) {  // Only if we opened it
						resToks.push(new EndTagTk('p'));
						this.hasOpenPTag = false;
					}
					if (newLineCount > 1) {  // Don't open if we aren't pushing content
						resToks.push(new TagTk('p'));
						this.hasOpenPTag = true;
					}
				} else {
					resToks.push(new SelfclosingTagTk('br'));
				}
				resToks.push(nlTk);
				newLineCount -= 1;
			}
		}

		if (this.currLine.openMatch || this.currLine.closeMatch) {
			this.closeOpenPTag(resToks);
			if (newLineCount === 1) {
				resToks.push(this.discardOneNlTk(resToks));
			}
		}

		// Gather remaining ws and nl tokens
		resToks = resToks.concat(this.nlWsTokens);

		// reset buffers
		this.resetBuffers();

		return resToks;
	}

	onAny(token) {
		this.env.log("trace/p-wrap", this.manager.pipelineId, "ANY   |", () => JSON.stringify(token));

		let res;
		const tc = token.constructor;
		if (tc === TagTk && token.name === 'pre' && !Util.isHTMLTag(token)) {
			if (this.inBlockElem) {
				// No pre-tokens inside block tags -- replace it with a ' '
				this.currLine.tokens.push(' ');
				return { tokens: [] };
			} else {
				this.manager.removeTransform(ParagraphWrapper.NEWLINE_RANK(), 'newline');
				this.inPre = true;
				// This will put us `inBlockElem`, so we need the extra `!inPre`
				// condition below.  Presumably, we couldn't have entered
				// `inBlockElem` while being `inPre`.  Alternatively, we could say
				// that index-pre is "never suppressing" and set the `closeMatch`
				// flag.  The point of all this is that we want to close any open
				// p-tags.
				this.currLine.openMatch = true;
				return { tokens: this._processBuffers(token, true) };
			}
		} else if (tc === EndTagTk && token.name === 'pre' && !Util.isHTMLTag(token)) {
			if (this.inBlockElem && !this.inPre) {
				// No pre-tokens inside block tags -- swallow it.
				return { tokens: [] };
			} else {
				if (this.inPre) {
					this.manager.addTransform(
						token => this.onNewLineOrEOF(token),
						"ParagraphWrapper:onNewLine",
						ParagraphWrapper.NEWLINE_RANK(),
						'newline'
					);
					this.inPre = false;
				}
				this.currLine.closeMatch = true;
				this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", () => JSON.stringify(token));
				res = [token];
				res.rank = ParagraphWrapper.SKIP_RANK(); // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
				return { tokens: res };
			}
		} else if (tc === EOFTk || this.inPre) {
			this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", () => JSON.stringify(token));
			res = [token];
			res.rank = ParagraphWrapper.SKIP_RANK(); // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
			return { tokens: res };
		} else if (tc === CommentTk || tc === String && token.match(/^[\t ]*$/) || Util.isEmptyLineMetaToken(token)) {
			if (this.newLineCount === 0) {
				this.currLine.tokens.push(token);
				// Since we have no pending newlines to trip us up,
				// no need to buffer -- just flush everything
				return { tokens: this._flushBuffers() };
			} else {
				// We are in buffering mode waiting till we are ready to
				// process pending newlines.
				this.nlWsTokens.push(token);
				return { tokens: [] };
			}
		} else if (tc !== String &&
			// T186965: <style> behaves similarly to sol transparent tokens in
			// that it doesn't open/close paragraphs, but also doesn't induce
			// a new paragraph by itself.
			(Util.isSolTransparent(this.env, token) || token.name === 'style')
		) {
			if (this.newLineCount === 0) {
				this.currLine.tokens.push(token);
				// Since we have no pending newlines to trip us up,
				// no need to buffer -- just flush everything
				return { tokens: this._flushBuffers() };
			} else if (this.newLineCount === 1) {
				// Swallow newline, whitespace, comments, and the current line
				this.tokenBuffer = this.tokenBuffer.concat(this.nlWsTokens, this.currLine.tokens);
				this.newLineCount = 0;
				this.nlWsTokens = [];
				this.resetCurrLine();

				// But, don't process the new token yet.
				this.currLine.tokens.push(token);
				return { tokens: [] };
			} else {
				return { tokens: this._processBuffers(token, false) };
			}
		} else {
			const name = (token.name || '').toUpperCase();

			if ((blockElems.has(name) && tc !== EndTagTk) ||
				(antiBlockElems.has(name) && tc === EndTagTk) ||
				alwaysSuppress.has(name)) {
				this.currLine.openMatch = true;
			}
			if ((blockElems.has(name) && tc === EndTagTk) ||
				(antiBlockElems.has(name) && tc !== EndTagTk) ||
				neverSuppress.has(name)) {
				this.currLine.closeMatch = true;
			}
			this.currLine.hasWrappableTokens = true;
			return { tokens: this._processBuffers(token, false) };
		}
	}
}

if (typeof module === "object") {
	module.exports.ParagraphWrapper = ParagraphWrapper;
}
