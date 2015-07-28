/*
 * Insert paragraph tags where needed -- smartly and carefully
 * -- there is much fun to be had mimicking "wikitext visual newlines"
 * behavior as implemented by the PHP parser.
 */
'use strict';

// Include general utilities
var Util = require('./mediawiki.Util.js').Util;
var defines = require('./mediawiki.parser.defines.js');
var Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;

// define some constructor shortcuts
var KV = defines.KV;
var CommentTk = defines.CommentTk;
var EOFTk = defines.EOFTk;
var NlTk = defines.NlTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;


function ParagraphWrapper(manager, options) {
	this.options = options;
	// Disable p-wrapper
	if (!options.noPWrapping) {
		this.register(manager);
	}
	this.manager = manager;
	this.env = manager.env;
	this.reset();
}

ParagraphWrapper.prototype.reset = function() {
	if (this.inPre) {
		// Clean up in case we run into EOF before seeing a </pre>
		this.manager.addTransform(this.onNewLineOrEOF.bind(this),
			"ParagraphWrapper:onNewLine", this.NEWLINE_RANK, 'newline');
	}
	this.tableTags = [];
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
	this.hasOpenHTMLPTag = false;
	this.inPre = false;
	this.currLine.hasBlockToken = false;
	this.currLine.firstBlockTokenType = null;
};

// Ranks for token handlers
// EOF/NL tokens will also match 'ANY' handlers.
// However, we want them in the custom eof/newline handlers.
// So, set them to a lower rank (= higher priority) than
// the any handler.
ParagraphWrapper.prototype.END_RANK     = 2.95;
ParagraphWrapper.prototype.NEWLINE_RANK = 2.96;
ParagraphWrapper.prototype.ANY_RANK     = 2.97;
// If a handler sends back the incoming 'token' back without change,
// the SyncTTM (or AsyncTTM) will dispatch it to other matching handlers.
// But, we don't want processed tokens coming back into the P-handler again.
// To prevent this, we can set a rank on the token block to a higher value
// than all handlers here. Hence, SKIP_RANK has to be larger than the others above.
ParagraphWrapper.prototype.SKIP_RANK    = 2.971;

// Register this transformer with the TokenTransformer
ParagraphWrapper.prototype.register = function(manager) {
	this.manager = manager;
	manager.addTransform(this.onNewLineOrEOF.bind(this),
		"ParagraphWrapper:onNewLine", this.NEWLINE_RANK, 'newline');
	manager.addTransform(this.onAny.bind(this),
		"ParagraphWrapper:onAny", this.ANY_RANK, 'any');
	manager.addTransform(this.onNewLineOrEOF.bind(this),
		"ParagraphWrapper:onEnd", this.END_RANK, 'end');
};

// This function removes paragraph wrappers like these: <p><b></p> OR <p></b></p>
// These individual formatting tags get wrapped when they show up next to
// block tags which terminate p-wrapping.
function removeUselessPWrappers(res) {
	// Don't create a new array till it becomes necessary.
	var newRes = null;
	for (var i = 0, n = res.length; i < n; i++) {
		var t = res[i];
		if (i + 2 < n && t.constructor === TagTk && t.name === 'p' && !t.isHTMLTag() &&
			Consts.HTML.FormattingTags.has((res[i + 1].name || '').toUpperCase()) &&
			res[i + 2].constructor === EndTagTk && res[i + 2].name === 'p' && !res[i + 2].isHTMLTag()) {
			// Init newRes
			if (newRes === null) {
				newRes = i === 0 ? [] : res.slice(0, i);
			}
			newRes.push(res[i + 1]);
			i += 2;
		} else if (newRes !== null) {
			newRes.push(t);
		}
	}

	return newRes || res;
}

ParagraphWrapper.prototype.resetBuffers = function() {
	this.tokenBuffer = [];
	this.nlWsTokens = [];
	this.newLineCount = 0;
};

ParagraphWrapper.prototype.resetCurrLine = function() {
	this.currLine = {
		tokens: [],
		hasBlockToken: false,
		firstBlockTokenType: null,
		hasWrappableTokens: false,
	};
};

ParagraphWrapper.prototype._processBuffers = function(token, isBlockToken, flushCurrentLine) {
	var res = this.processPendingNLs(isBlockToken);

	this.currLine.tokens.push(token);
	if (flushCurrentLine) {
		res = res.concat(this.currLine.tokens);
		this.resetCurrLine();
	}

	res = removeUselessPWrappers(res);
	this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", function() { return JSON.stringify(res); });
	res.rank = this.SKIP_RANK; // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
	return res;
};

ParagraphWrapper.prototype._flushBuffers = function() {
	// Assertion to catch bugs in p-wrapping; both cannot be true.
	if (this.newLineCount > 0) {
		this.env.log("error/p-wrap",
			"Failed assertion in _flushBuffers: newline-count:", this.newLineCount,
			"; buffered tokens: ", JSON.stringify(this.nlWsTokens));
	}

	var resToks = this.tokenBuffer.concat(this.nlWsTokens);
	this.resetBuffers();
	var newRes = removeUselessPWrappers(resToks);
	this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", function() { return JSON.stringify(newRes); });
	newRes.rank = this.SKIP_RANK; // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
	return newRes;
};

ParagraphWrapper.prototype.discardOneNlTk = function(out) {
	var i = 0;
	var n = this.nlWsTokens.length;
	while (i < n) {
		var t = this.nlWsTokens.shift();
		if (t.constructor === NlTk) {
			return t;
		} else {
			out.push(t);
		}
		i++;
	}
	return "";
};

ParagraphWrapper.prototype.openPTag = function(out) {
	if (!this.hasOpenPTag) {
		// Be careful not to expand template ranges unnecessarily.
		// Look for open markers before starting a p-tag.
		for (var i = 0; i < out.length; i++) {
			var t = out[i];
			if (t.name === "meta") {
				var typeOf = t.getAttribute("typeof");
				if (/^mw:Transclusion$/.test(typeOf)) {
					// We hit a start tag and everything before it is sol-transparent.
					break;
				} else if (/^mw:Transclusion/.test(typeOf)) {
					// End tag. All tokens before this are sol-transparent.
					// Let leave them all out of the p-wrapping.
					i += 1;
					break;
				}
			}
			// Not a transclusion meta; Check for nl/sol-transparent tokens
			// and leave them out of the p-wrapping.
			if (!Util.isSolTransparent(this.env, t) && t.constructor !== NlTk) {
				break;
			}
		}
		out.splice(i, 0, new TagTk('p'));
		this.hasOpenPTag = true;
	}
};

ParagraphWrapper.prototype.closeOpenPTag = function(out) {
	if (this.hasOpenPTag) {
		// Be careful not to expand template ranges unnecessarily.
		// Look for open markers before closing.
		for (var i = out.length - 1; i > -1; i--) {
			var t = out[i];
			if (t.name === "meta") {
				var typeOf = t.getAttribute("typeof");
				if (/^mw:Transclusion$/.test(typeOf)) {
					// We hit a start tag and everything after it is sol-transparent.
					// Don't include the sol-transparent tags OR the start tag.
					i -= 1;
					break;
				} else if (/^mw:Transclusion/.test(typeOf)) {
					// End tag. We're done.
					// The rest of the tags past this are sol-transparent.
					// Let us leave them all out of the p-wrapping.
					break;
				}
			}
			// Not a transclusion meta; Check for nl/sol-transparent tokens
			// and leave them out of the p-wrapping.
			if (!Util.isSolTransparent(this.env, t) && t.constructor !== NlTk) {
				break;
			}
		}
		out.splice(i + 1, 0, new EndTagTk('p'));
		this.hasOpenPTag = false;
	}
};

ParagraphWrapper.prototype.addPTagsOnCurrLine = function() {
	var newToks = [];

	// Close any open p-tag.
	this.closeOpenPTag(newToks);

	if (this.currLine.hasWrappableTokens) {
		var blockTagCount = this.currLine.firstBlockTokenType === EndTagTk ? 1 : 0;
		var toks = this.currLine.tokens;
		for (var i = 0, n = toks.length; i < n; i++) {
			var t = toks[i];
			if (Util.isBlockToken(t)) {
				if (t.constructor === TagTk) {
					blockTagCount++;
				} else if (t.constructor === EndTagTk && blockTagCount > 0) {
					blockTagCount--;
				}
				this.closeOpenPTag(newToks);
			} else if (blockTagCount === 0 && !Util.isSolTransparent(this.env, t) && !this.hasOpenPTag) {
				// SSS FIXME: This check below is strictly not necessary since
				// removeUselessPWrappers will take care of it. But, doing this
				// here will eliminate useless array copying. Not sure if this
				// optimization is worth this check.
				if (!t.name || !Consts.HTML.FormattingTags.has(t.name.toUpperCase())
					|| !(i + 1 < n && Util.isBlockToken(toks[i + 1]))) {
					newToks.push(new TagTk('p'));
					this.hasOpenPTag = true;
				}
			}
			newToks.push(t);
		}
	} else {
		newToks = this.currLine.tokens;
	}

	// close any open p-tag
	this.closeOpenPTag(newToks);

	this.currLine.tokens = newToks;
};

// Handle NEWLINE tokens
ParagraphWrapper.prototype.onNewLineOrEOF = function(token, frame, cb) {
	this.env.log("trace/p-wrap", this.manager.pipelineId, "NL    |", function() { return JSON.stringify(token); });

	var l = this.currLine;
	if (!this.hasOpenHTMLPTag) {
		if (l.hasBlockToken) {
			// Wrap non-block content in p-tags -- but any open
			// p-tag from previous lines have to be closed since
			// that is how the php parser seems to behave.
			this.addPTagsOnCurrLine();
		} else if (!this.hasOpenPTag && l.hasWrappableTokens) {
			// If we dont have an open p-tag,
			// and this line didn't have a block token, start a p-tag.
			this.openPTag(l.tokens);
		}
	}

	// Assertion to catch bugs in p-wrapping; both cannot be true.
	if (this.newLineCount > 0 && l.tokens.length > 0) {
		this.env.log("error/p-wrap",
			"Failed assertion in onNewLineOrEOF: newline-count:", this.newLineCount,
			"; current line tokens: ", JSON.stringify(l.tokens));
	}

	this.tokenBuffer = this.tokenBuffer.concat(l.tokens);

	this.resetCurrLine();

	if (token.constructor === EOFTk) {
		this.nlWsTokens.push(token);
		this.closeOpenPTag(this.tokenBuffer);
		var res = this.processPendingNLs(false);
		this.inPre = false;
		this.hasOpenPTag = false;
		this.hasOpenHTMLPTag = false;
		this.reset();
		var newRes = removeUselessPWrappers(res);
		this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", function() { return JSON.stringify(newRes); });
		newRes.rank = this.SKIP_RANK; // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
		return { tokens: newRes };
	} else {
		this.newLineCount++;
		this.nlWsTokens.push(token);
		return {};
	}
};

ParagraphWrapper.prototype.processPendingNLs = function(isBlockToken) {
	var resToks = this.tokenBuffer;
	var newLineCount = this.newLineCount;
	var nlTk;

	this.env.log("trace/p-wrap", this.manager.pipelineId, "        NL-count:", newLineCount);

	if (newLineCount >= 2) {
		while (newLineCount >= 3) {
			// 1. Close any open p-tag
			this.closeOpenPTag(resToks);

			var topTag = this.tableTags.length > 0 ? this.tableTags.last(): null;
			if (!topTag || topTag === 'td' || topTag === 'th') {
				// 2. Discard 3 newlines (the p-br-p section
				// serializes back to 3 newlines)
				resToks.push(this.discardOneNlTk(resToks));
				resToks.push(this.discardOneNlTk(resToks));
				nlTk = this.discardOneNlTk(resToks);

				// Preserve nls for pretty-printing and dsr reliability

				// 3. Insert <p><br></p> sections
				resToks.push(new TagTk('p'));
				resToks.push(new SelfclosingTagTk('br'));
				resToks.push(nlTk);
				if (newLineCount > 3) {
					resToks.push(new EndTagTk('p'));
				} else {
					this.hasOpenPTag = true;
				}
			} else {
				resToks.push(this.discardOneNlTk(resToks));
				resToks.push(this.discardOneNlTk(resToks));
				resToks.push(this.discardOneNlTk(resToks));
			}

			newLineCount -= 3;
		}

		if (newLineCount === 2) {
			this.closeOpenPTag(resToks);
			resToks.push(this.discardOneNlTk(resToks));
			resToks.push(this.discardOneNlTk(resToks));
		}
	}

	if (isBlockToken) {
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
};

// popUntil: pop anything until one of the tag in this array is found.
//           Pass null to disable.
// popThen: after a stop is reached (or popUntil was null), continue
//          popping as long as the elements in this array match. Pass
//          null to disable.
function popTags(tblTags, popUntil, popThen) {
	while (popUntil && tblTags.length > 0 && popUntil.indexOf(tblTags.last()) === -1) {
		tblTags.pop();
	}
	while (popThen && tblTags.length > 0 && popThen.indexOf(tblTags.last()) !== -1) {
		tblTags.pop();
	}
}

function updateTableContext(tblTags, token) {
	if (Util.isTableTag(token)) {
		var tokenName = token.name;
		if (token.constructor === TagTk) {
			tblTags.push(tokenName);
		} else {
			switch (tokenName) {
			case "table":
				// Pop a table scope
				popTags(tblTags, ["table"], ["table"]);
				break;
			case "tbody":
				// Pop to the nearest table
				popTags(tblTags, ["table"], null);
				break;
			case "tr":
			case "thead":
			case "tfoot":
			case "caption":
				// Pop to tbody or table, whichever is nearer
				popTags(tblTags, ["tbody", "table"], null);
				break;
			case "td":
			case "th":
				// Pop to tr or (if that fails) to tbody or table.
				popTags(tblTags, ["tr", "tbody", "table"], null);
				break;
			}
		}
	}
}

ParagraphWrapper.prototype.onAny = function(token, frame) {
	this.env.log("trace/p-wrap", this.manager.pipelineId, "ANY   |", function() { return JSON.stringify(token); });

	var res;
	var tc = token.constructor;
	if (tc === TagTk && token.name === 'pre') {
		if (this.hasOpenHTMLPTag) {
			// No pre-tokens inside html-p-tags -- replace it with a ' '
			this.currLine.tokens.push(' ');
			return {};
		} else {
			this.manager.removeTransform(this.NEWLINE_RANK, 'newline');
			this.inPre = true;
			return { tokens: this._processBuffers(token, true, true) };
		}
	} else if (tc === EndTagTk && token.name === 'pre') {
		if (this.hasOpenHTMLPTag) {
			// No pre-tokens inside html-p-tags -- swallow it.
			return {};
		} else {
			if (this.inPre) {
				this.manager.addTransform(this.onNewLineOrEOF.bind(this),
					"ParagraphWrapper:onNewLine", this.NEWLINE_RANK, 'newline');
				this.inPre = false;
			}

			if (!this.currLine.hasBlockToken) {
				this.currLine.firstBlockTokenType = tc;
				this.currLine.hasBlockToken = true;
			}

			this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", function() { return JSON.stringify(token); });
			res = [token];
			res.rank = this.SKIP_RANK; // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
			return { tokens: res };
		}
	} else if (tc === EOFTk || this.inPre) {
		this.env.log("trace/p-wrap", this.manager.pipelineId, "---->  ", function() { return JSON.stringify(token); });
		res = [token];
		res.rank = this.SKIP_RANK; // ensure this propagates further in the pipeline, and doesn't hit the AnyHandler
		return { tokens: res };
	} else if (tc === CommentTk ||
		tc === String && token.match(/^[\t ]*$/) ||
		Util.isEmptyLineMetaToken(token)) {
		if (this.newLineCount === 0) {
			this.currLine.tokens.push(token);
			// Since we have no pending newlines to trip us up,
			// no need to buffer -- just flush everything
			return { tokens: this._flushBuffers() };
		} else {
			// We are in buffering mode waiting till we are ready to
			// process pending newlines.
			this.nlWsTokens.push(token);
			return {};
		}
	} else if (tc !== String && Util.isSolTransparent(this.env, token)) {
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
			return {};
		} else {
			return { tokens: this._processBuffers(token, false, false) };
		}
	} else {
		var isBlockToken = Util.isBlockToken(token);
		if (isBlockToken && !this.currLine.hasBlockToken) {
			this.currLine.firstBlockTokenType = tc;
			this.currLine.hasBlockToken = true;
		}

		// Deal with HTML P-tokens.
		if (token.name === 'p' && token.isHTMLTag()) {
			if (tc === TagTk) {
				// Close unclosed HTML P-tag.
				if (this.hasOpenHTMLPTag) {
					this.currLine.tokens.push(new EndTagTk('p', [], {autoInsertedEnd: true}));
				}
				this.hasOpenHTMLPTag = true;
			} else {
				this.hasOpenHTMLPTag = false;
				this.hasOpenPTag = false;
			}
		} else if (isBlockToken && this.hasOpenHTMLPTag) {
			// Close any open HTML P-tag at a block-token boundary.
			// This is an auto-inserted end-tag.
			this.currLine.tokens.push(new EndTagTk('p', [], {autoInsertedEnd: true}));
			this.hasOpenHTMLPTag = false;
		}

		this.currLine.hasWrappableTokens = true;
		res = this._processBuffers(token, isBlockToken, false);

		// Partial DOM-building! What a headache!
		// This is necessary to avoid introducing fosterable tags inside the table.
		updateTableContext(this.tableTags, token);

		return { tokens: res };
	}
};

if (typeof module === "object") {
	module.exports.ParagraphWrapper = ParagraphWrapper;
}
