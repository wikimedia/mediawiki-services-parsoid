'use strict';

/**
 * PRE handling.
 *
 * PRE-handling relies on the following 5-state FSM.
 *
 * States
 * ------
 * ```
 * SOL           -- start-of-line
 *                  (white-space, comments, meta-tags are all SOL transparent)
 * PRE           -- we might need a pre-block
 *                  (if we enter the PRE_COLLECT state)
 * PRE_COLLECT   -- we will need to generate a pre-block and are collecting
 *                  content for it.
 * MULTILINE_PRE -- we might need to extend the pre-block to multiple lines.
 *                  (depending on whether we see a white-space tok or not)
 * IGNORE        -- nothing to do for the rest of the line.
 * ```
 *
 * Transitions
 * -----------
 *
 * In the transition table below, purge is just a shortcut for:
 * "pass on collected tokens to the callback and reset (getResultAndReset)"
 * ```
 * + --------------+-----------------+---------------+--------------------------+
 * | Start state   |     Token       | End state     |  Action                  |
 * + --------------+-----------------+---------------+--------------------------+
 * | SOL           | --- nl      --> | SOL           | purge                    |
 * | SOL           | --- eof     --> | SOL           | purge                    |
 * | SOL           | --- ws      --> | PRE           | save whitespace token(##)|
 * | SOL           | --- sol-tr  --> | SOL           | TOKS << tok              |
 * | SOL           | --- other   --> | IGNORE        | purge                    |
 * + --------------+-----------------+---------------+--------------------------+
 * | PRE           | --- nl      --> | SOL           | purge                    |
 * | PRE           |  html-blk tag   | IGNORE        | purge                    |
 * |               |  wt-table tag   |               |                          |
 * | PRE           | --- eof     --> | SOL           | purge                    |
 * | PRE           | --- sol-tr  --> | PRE           | SOL-TR-TOKS << tok       |
 * | PRE           | --- other   --> | PRE_COLLECT   | TOKS = SOL-TR-TOKS + tok |
 * + --------------+-----------------+---------------+--------------------------+
 * | PRE_COLLECT   | --- nl      --> | MULTILINE_PRE | save nl token            |
 * | PRE_COLLECT   | --- eof     --> | SOL           | gen-pre                  |
 * | PRE_COLLECT   | --- blk tag --> | IGNORE        | gen-prepurge (#)         |
 * | PRE_COLLECT   | --- any     --> | PRE_COLLECT   | TOKS << tok              |
 * + --------------+-----------------+---------------+--------------------------+
 * | MULTILINE_PRE | --- nl      --> | SOL           | gen-pre                  |
 * | MULTILINE_PRE | --- eof     --> | SOL           | gen-pre                  |
 * | MULTILINE_PRE | --- ws      --> | PRE_COLLECT   | pop saved nl token (##)  |
 * |               |                 |               | TOKS = SOL-TR-TOKS + tok |
 * | MULTILINE_PRE | --- sol-tr  --> | MULTILINE_PRE | SOL-TR-TOKS << tok       |
 * | MULTILINE_PRE | --- any     --> | IGNORE        | gen-pre                  |
 * + --------------+-----------------+---------------+--------------------------+
 * | IGNORE        | --- nl      --> | SOL           | purge                    |
 * | IGNORE        | --- eof     --> | SOL           | purge                    |
 * + --------------+-----------------+---------------+--------------------------+
 *
 * # If we've collected any tokens from previous lines, generate a pre. This
 * line gets purged.
 *
 * ## In these states, check if the whitespace token is a single space or has
 * additional chars (white-space or non-whitespace) -- if yes, slice it off
 * and pass it through the FSM.
 */

const { TokenUtils } = require('../../utils/TokenUtils.js');
const TokenHandler = require('./TokenHandler.js');
const { WTUtils } = require('../../utils/WTUtils.js');
const { TagTk, EndTagTk, SelfclosingTagTk, NlTk, CommentTk } = require('../../tokens/TokenTypes.js');

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class PreHandler extends TokenHandler {
	// FSM states
	static STATE_SOL() { return 1; }
	static STATE_PRE() { return  2; }
	static STATE_PRE_COLLECT() { return  3; }
	static STATE_MULTILINE_PRE() { return  4; }
	static STATE_IGNORE() { return  5; }

	// debug string output of FSM states
	static STATE_STR() {
		return {
			1: 'sol        ',
			2: 'pre        ',
			3: 'pre_collect',
			4: 'multiline  ',
			5: 'ignore     ',
		};
	}

	constructor(manager, options) {
		super(manager, options);
		if (this.options.inlineContext || this.options.inPHPBlock) {
			this.disabled = true;
		} else {
			this.disabled = false;
			this.resetState();
		}
	}

	resetState() {
		this.reset();
	}

	reset() {
		this.state  = PreHandler.STATE_SOL();
		this.lastNlTk = null;
		// Initialize to zero to deal with indent-pre
		// on the very first line where there is no
		// preceding newline to initialize this.
		this.preTSR = 0;
		this.tokens = [];
		this.preCollectCurrentLine = [];
		this.preWSToken = null;
		this.multiLinePreWSToken = null;
		this.solTransparentTokens = [];
		this.onAnyEnabled = true;
	}

	moveToIgnoreState() {
		this.onAnyEnabled = false;
		this.state = PreHandler.STATE_IGNORE();
	}

	popLastNL(ret) {
		if (this.lastNlTk) {
			ret.push(this.lastNlTk);
			this.lastNlTk = null;
		}
	}

	resetPreCollectCurrentLine() {
		if (this.preCollectCurrentLine.length > 0) {
			this.tokens = this.tokens.concat(this.preCollectCurrentLine);
			this.preCollectCurrentLine = [];
			// Since the multi-line pre materialized, the multilinee-pre-ws token
			// should be discarded so that it is not emitted after <pre>..</pre>
			// is generated (see processPre).
			this.multiLinePreWSToken = null;
		}
	}

	encounteredBlockWhileCollecting(token) {
		var env = this.manager.env;
		var ret = [];
		var mlp = null;

		// we remove any possible multiline ws token here and save it because
		// otherwise the propressPre below would add it in the wrong place
		if (this.multiLinePreWSToken) {
			mlp = this.multiLinePreWSToken;
			this.multiLinePreWSToken = null;
		}

		if (this.tokens.length > 0) {
			var i = this.tokens.length - 1;
			while (i > 0 && TokenUtils.isSolTransparent(env, this.tokens[i])) { i--; }
			var solToks = this.tokens.splice(i);
			this.lastNlTk = solToks.shift();
			console.assert(this.lastNlTk && this.lastNlTk.constructor === NlTk);
			ret = this.processPre(null).concat(solToks);
		}

		if (this.preWSToken || mlp) {
			ret.push(this.preWSToken || mlp);
			this.preWSToken = null;
		}

		this.resetPreCollectCurrentLine();
		ret = ret.concat(this.getResultAndReset(token));
		return ret;
	}

	getResultAndReset(token) {
		this.popLastNL(this.tokens);

		var ret = this.tokens;
		if (this.preWSToken) {
			ret.push(this.preWSToken);
			this.preWSToken = null;
		}
		if (this.solTransparentTokens.length > 0) {
			ret = ret.concat(this.solTransparentTokens);
			this.solTransparentTokens = [];
		}
		ret.push(token);
		this.tokens = [];
		this.multiLinePreWSToken = null;

		return ret;
	}

	processPre(token) {
		var ret = [];

		// pre only if we have tokens to enclose
		if (this.tokens.length > 0) {
			var da = null;
			if (this.preTSR !== -1) {
				da = { tsr: [this.preTSR, this.preTSR + 1] };
			}
			ret = [new TagTk('pre', [], da)].concat(this.tokens, new EndTagTk('pre'));
		}

		// emit multiline-pre WS token
		if (this.multiLinePreWSToken) {
			ret.push(this.multiLinePreWSToken);
			this.multiLinePreWSToken = null;
		}
		this.popLastNL(ret);

		// sol-transparent toks
		ret = ret.concat(this.solTransparentTokens);

		// push the the current token
		if (token !== null) {
			ret.push(token);
		}

		// reset!
		this.solTransparentTokens = [];
		this.tokens = [];

		return ret;
	}

	onNewline(token) {
		var env = this.manager.env;

		function initPreTSR(nltk) {
			var da = nltk.dataAttribs;
			// tsr[1] can never be zero, so safe to use da.tsr[1] to check for null/undefined
			return (da && da.tsr && da.tsr[1]) ? da.tsr[1] : -1;
		}

		env.log("trace/pre", this.manager.pipelineId, "NL    |",
			PreHandler.STATE_STR()[this.state], "|", function() { return JSON.stringify(token); });

		// Whenever we move into SOL-state, init preTSR to
		// the newline's tsr[1].  This will later be  used
		// to assign 'tsr' values to the <pre> token.

		var ret = [];
		// See TokenHandler's documentation for the onAny handler
		// for what this flag is about.
		var skipOnAny = false;
		switch (this.state) {
			case PreHandler.STATE_SOL():
				ret = this.getResultAndReset(token);
				skipOnAny = true;
				this.preTSR = initPreTSR(token);
				break;

			case PreHandler.STATE_PRE():
				ret = this.getResultAndReset(token);
				skipOnAny = true;
				this.preTSR = initPreTSR(token);
				this.state = PreHandler.STATE_SOL();
				break;

			case PreHandler.STATE_PRE_COLLECT():
				this.resetPreCollectCurrentLine();
				this.lastNlTk = token;
				this.state = PreHandler.STATE_MULTILINE_PRE();
				break;

			case PreHandler.STATE_MULTILINE_PRE():
				this.preWSToken = null;
				this.multiLinePreWSToken = null;
				ret = this.processPre(token);
				skipOnAny = true;
				this.preTSR = initPreTSR(token);
				this.state = PreHandler.STATE_SOL();
				break;

			case PreHandler.STATE_IGNORE():
				ret = [token];
				skipOnAny = true;
				this.reset();
				this.preTSR = initPreTSR(token);
				break;
		}

		env.log("debug/pre", this.manager.pipelineId, "saved :", this.tokens);
		env.log("debug/pre", this.manager.pipelineId, "---->  ",
			function() { return JSON.stringify(ret); });

		return { tokens: ret, skipOnAny: skipOnAny };
	}

	onEnd(token) {
		this.manager.env.log("trace/pre", this.manager.pipelineId, "eof   |",
			PreHandler.STATE_STR()[this.state], "|", function() { return JSON.stringify(token); });

		var ret = [];
		switch (this.state) {
			case PreHandler.STATE_SOL():
			case PreHandler.STATE_PRE():
				ret = this.getResultAndReset(token);
				break;

			case PreHandler.STATE_PRE_COLLECT():
			case PreHandler.STATE_MULTILINE_PRE():
				this.preWSToken = null;
				this.multiLinePreWSToken = null;
				this.resetPreCollectCurrentLine();
				ret = this.processPre(token);
				break;

			case PreHandler.STATE_IGNORE():
				ret.push(token);
				break;
		}

		this.manager.env.log("debug/pre", this.manager.pipelineId, "saved :", this.tokens);
		this.manager.env.log("debug/pre", this.manager.pipelineId, "---->  ",
			function() { return JSON.stringify(ret); });

		return { tokens: ret, skipOnAny: true };
	}

	getUpdatedPreTSR(tsr, token) {
		var tc = token.constructor;
		if (tc === CommentTk) {
			// comment length has 7 added for "<!--" and "-->" deliminters
			// (see WTUtils.decodedCommentLength() -- but that takes a node not a token)
			tsr = token.dataAttribs.tsr ? token.dataAttribs.tsr[1] : (tsr === -1 ? -1 : WTUtils.decodeComment(token.value).length + 7 + tsr);
		} else if (tc === SelfclosingTagTk) {
			// meta-tag (cannot compute)
			tsr = -1;
		} else if (tsr !== -1) {
			// string
			tsr += token.length;
		}
		return tsr;
	}

	onAny(token) {
		var env = this.manager.env;

		env.log("trace/pre", this.manager.pipelineId, "any   |", this.state, ":",
			PreHandler.STATE_STR()[this.state], "|", function() { return JSON.stringify(token); });

		if (this.state === PreHandler.STATE_IGNORE()) {
			env.log("error", function() {
				return "!ERROR! IGNORE! Cannot get here: " + JSON.stringify(token);
			});
			return token;
		}

		var ret = [];
		var tc = token.constructor;
		switch (this.state) {
			case PreHandler.STATE_SOL():
				if ((tc === String) && token.match(/^ /)) {
					ret = this.tokens;
					this.tokens = [];
					this.preWSToken = token[0];
					this.state = PreHandler.STATE_PRE();
					if (!token.match(/^ $/)) {
						// Treat everything after the first space
						// as a new token
						this.onAny(token.slice(1));
					}
				} else if (TokenUtils.isSolTransparent(env, token)) {
					// continue watching ...
					// update pre-tsr since we haven't transitioned to PRE yet
					this.preTSR = this.getUpdatedPreTSR(this.preTSR, token);
					this.tokens.push(token);
				} else {
					ret = this.getResultAndReset(token);
					this.moveToIgnoreState();
				}
				break;

			case PreHandler.STATE_PRE():
				if (TokenUtils.isSolTransparent(env, token)) { // continue watching
					this.solTransparentTokens.push(token);
				} else if (TokenUtils.isTableTag(token) ||
					(TokenUtils.isHTMLTag(token) && TokenUtils.isBlockTag(token.name))) {
					ret = this.getResultAndReset(token);
					this.moveToIgnoreState();
				} else {
					this.preCollectCurrentLine = this.solTransparentTokens.concat(token);
					this.solTransparentTokens = [];
					this.state = PreHandler.STATE_PRE_COLLECT();
				}
				break;

			case PreHandler.STATE_PRE_COLLECT():
				if (token.name && TokenUtils.isBlockTag(token.name)) {
					ret = this.encounteredBlockWhileCollecting(token);
					this.moveToIgnoreState();
				} else {
					// nothing to do .. keep collecting!
					this.preCollectCurrentLine.push(token);
				}
				break;

			case PreHandler.STATE_MULTILINE_PRE():
				if ((tc === String) && token.match(/^ /)) {
					this.popLastNL(this.tokens);
					this.state = PreHandler.STATE_PRE_COLLECT();
					this.preWSToken = null;

					// Pop buffered sol-transparent tokens
					this.tokens = this.tokens.concat(this.solTransparentTokens);
					this.solTransparentTokens = [];

					// check if token is single-space or more
					this.multiLinePreWSToken = token[0];
					if (!token.match(/^ $/)) {
						// Treat everything after the first space as a new token
						this.onAny(token.slice(1));
					}
				} else if (TokenUtils.isSolTransparent(env, token)) { // continue watching
					this.solTransparentTokens.push(token);
				} else {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				}
				break;
		}

		env.log("debug/pre", this.manager.pipelineId, "saved :", this.tokens);
		env.log("debug/pre", this.manager.pipelineId, "---->  ",
			function() { return JSON.stringify(ret); });

		return { tokens: ret };
	}
}

if (typeof module === "object") {
	module.exports.PreHandler = PreHandler;
}
