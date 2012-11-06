"use strict";
/* --------------------------------------------------------------------------

 PRE-handling relies on the following 5-state FSM.

 ------
 States
 ------
 SOL           -- start-of-line
                  (white-space, comments, meta-tags are all SOL transparent)
 PRE           -- we might need a pre-block
                  (if we enter the PRE_COLLECT state)
 PRE_COLLECT   -- we will need to generate a pre-block and are collecting
                  content for it.
 MULTILINE_PRE -- we might need to extend the pre-block to multiple lines.
                  (depending on whether we see a white-space tok or not)
 IGNORE        -- nothing to do for the rest of the line.

 -----------
 Transitions
 -----------

 In the transition table below, purge is just a shortcut for:
 "pass on collected tokens to the callback and reset (getResultAndReset)"

 + --------------+-----------------+---------------+--------------------------+
 | Start state   |     Token       | End state     |  Action                  |
 + --------------+-----------------+---------------+--------------------------+
 | SOL           | --- nl      --> | SOL           | purge                    |
 | SOL           | --- eof     --> | SOL           | purge                    |
 | SOL           | --- ws      --> | PRE           | save whitespace token    |
 | SOL           | --- sol-tr  --> | SOL           | TOKS << tok              |
 | SOL           | --- other   --> | IGNORE        | purge                    |
 + --------------+-----------------+---------------+--------------------------+
 | PRE           | --- nl OR   --> | SOL           | purge   if |TOKS| == 0   |
 |               |  wt-table tag   |               | gen-pre if |TOKS| > 0 (#)|
 |               |  html-blk tag   |               |                          |
 |               |  html-end tag   |               |                          |
 | PRE           | --- eof     --> | SOL           | purge                    |
 | PRE           | --- sol-tr  --> | PRE           | SOL-TR-TOKS << tok       |
 | PRE           | --- other   --> | PRE_COLLECT   | TOKS = SOL-TR-TOKS + tok |
 + --------------+-----------------+---------------+--------------------------+
 | PRE_COLLECT   | --- nl      --> | MULTILINE_PRE | save nl token            |
 | PRE_COLLECT   | --- eof     --> | SOL           | gen-pre                  |
 | PRE_COLLECT   | --- blk tag --> | IGNORE        | gen-pre                  |
 |               |  html-end tag   |               |                          |
 | PRE_COLLECT   | --- any     --> | PRE_COLLECT   | TOKS << tok              |
 + --------------+-----------------+---------------+--------------------------+
 | MULTILINE_PRE | --- nl      --> | SOL           | gen-pre                  |
 | MULTILINE_PRE | --- eof     --> | SOL           | gen-pre                  |
 | MULTILINE_PRE | --- ws      --> | PRE           | pop saved nl token       |
 | MULTILINE_PRE | --- sol-tr  --> | MULTILINE_PRE | SOL-TR-TOKS << tok       |
 | MULTILINE_PRE | --- any     --> | IGNORE        | gen-pre                  |
 + --------------+-----------------+---------------+--------------------------+
 | IGNORE        | --- nl      --> | SOL           | purge                    |
 | IGNORE        | --- eof     --> | SOL           | purge                    |
 + --------------+-----------------+---------------+--------------------------+

 # In PRE-state, |TOKS| > 0 only if we got here from MULTILINE_PRE.  In addition,
   we are guaranteed that they will not all be whitespace/sol-transparent tokens
   since the transition path would have been:
      SOL -> PRE -> PRE_COLLECT -> MULTILINE_PRE -> PRE
   and the transition from PRE -> PRE_COLLECT adds a non-ws/non-sol-tr token
   to TOKS.

 * --------------------------------------------------------------------------*/

var Util = require('./mediawiki.Util.js').Util;

// Constructor
function PreHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform(this.onNewline.bind(this),
		"PreHandler:onNewline", this.nlRank, 'newline');
	this.manager.addTransform(this.onEnd.bind(this),
		"PreHandler:onEnd", this.endRank, 'end');
	var env = manager.env;
	this.debug = env.debug || (env.traceFlags && (env.traceFlags.indexOf("pre_debug") !== -1));
	this.trace = this.debug || (env.traceFlags && (env.traceFlags.indexOf("pre") !== -1));
	init(this, true);
}

// Handler ranks
PreHandler.prototype.nlRank   = 2.01;
PreHandler.prototype.anyRank  = 2.02;
PreHandler.prototype.endRank  = 2.03;
PreHandler.prototype.skipRank = 2.04; // should be higher than all other ranks above

// FSM states
PreHandler.STATE_SOL = 1;
PreHandler.STATE_PRE = 2;
PreHandler.STATE_PRE_COLLECT = 3;
PreHandler.STATE_MULTILINE_PRE = 4;
PreHandler.STATE_IGNORE = 5;

function init(handler, addAnyHandler) {
	handler.state  = PreHandler.STATE_SOL;
	handler.lastNLTk = null;
	handler.tokens = [];
	handler.preWSToken = null;
	handler.solTransparentTokens = [];
	if (addAnyHandler) {
		handler.manager.addTransform(handler.onAny.bind(handler),
			"PreHandler:onAny", handler.anyRank, 'any');
	}
}

PreHandler.prototype.moveToIgnoreState = function() {
	this.state = PreHandler.STATE_IGNORE;
	this.manager.removeTransform(this.anyRank, 'any');
};

PreHandler.prototype.popLastNL = function(ret) {
	if (this.lastNlTk) {
		ret.push(this.lastNlTk);
		this.lastNlTk = null;
	}
};

PreHandler.prototype.getResultAndReset = function(token) {
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

	ret.rank = this.skipRank; // prevent this from being processed again
	return ret;
};

PreHandler.prototype.processPre = function(token) {

	// discard the white-space token that triggered pre
	var ret = [];
	if (!this.preWSToken.match(/^\s*$/)) {
		ret.push(this.preWSToken.replace(/^\s/, ''));
	}
	this.preWSToken = null;

	if (this.tokens.length === 0 && ret.length === 0) {
		this.popLastNL(ret);
		var stToks = this.solTransparentTokens;
		ret = stToks.length > 0 ? [' '].concat(stToks) : stToks;
	} else {
		// Special case handling when the last token before </pre>
		// is a TagTk -- close the pre before that opening tag.
		var lastToken = this.tokens.pop();
		ret = [ new TagTk('pre') ].concat(ret).concat(this.tokens);
		if (lastToken.constructor === TagTk) {
			ret.push(new EndTagTk('pre'));
			ret.push(lastToken);
		} else {
			ret.push(lastToken);
			ret.push(new EndTagTk('pre'));
		}
		this.popLastNL(ret);
		ret = ret.concat(this.solTransparentTokens);
	}

	// push the the current token
	ret.push(token);

	// reset!
	this.solTransparentTokens = [];
	this.tokens = [];

	ret.rank = this.skipRank; // prevent this from being processed again
	return ret;
};

PreHandler.prototype.onNewline = function (token, manager, cb) {
	if (this.trace) {
		if (this.debug) console.warn("----------");
		console.warn("T:pre:nl : " + this.state);
	}

	var ret = null;
	switch (this.state) {
		case PreHandler.STATE_SOL:
			ret = this.getResultAndReset(token);
			break;

		case PreHandler.STATE_PRE:
			if (this.tokens.length > 0) {
				// we got here from a multiline-pre
				ret = this.processPre(token);
			} else {
				ret = this.getResultAndReset(token);
			}
			this.state = PreHandler.STATE_SOL;
			break;

		case PreHandler.STATE_PRE_COLLECT:
			this.lastNlTk = token;
			this.state = PreHandler.STATE_MULTILINE_PRE;
			break;

		case PreHandler.STATE_MULTILINE_PRE:
			ret = this.processPre(token);
			this.state = PreHandler.STATE_SOL;
			break;

		case PreHandler.STATE_IGNORE:
			ret = [token];
			ret.rank = this.skipRank; // prevent this from being processed again
			init(this, true); // Reset!
			break;
	}

	if (this.debug) {
		console.warn("saved: " + JSON.stringify(this.tokens));
		console.warn("ret  : " + JSON.stringify(ret));
	}

	return { tokens: ret };
};

PreHandler.prototype.onEnd = function (token, manager, cb) {
	if (this.state !== PreHandler.STATE_IGNORE) {
		console.error("!ERROR! Not IGNORE! Cannot get here: " + this.state + "; " + JSON.stringify(token));
		init(this, false);
		return {tokens: [token]};
	}

	init(this, true);
	return {tokens: [token]};
};

function isTableTag(token) {
	var tc = token.constructor;
	return (tc === TagTk || tc === EndTagTk) &&
		['table','tr','td','th','tbody'].indexOf(token.name.toLowerCase()) !== -1;
}

PreHandler.prototype.onAny = function ( token, manager, cb ) {
	if (this.trace) {
		if (this.debug) console.warn("----------");
		console.warn("T:pre:any: " + this.state + " : " + JSON.stringify(token));
	}

	if (this.state === PreHandler.STATE_IGNORE) {
		console.error("!ERROR! IGNORE! Cannot get here: " + JSON.stringify(token));
		return {tokens: null};
	}

	var ret = null;
	var tc = token.constructor;
	if (tc === EOFTk) {
		switch (this.state) {
			case PreHandler.STATE_SOL:
			case PreHandler.STATE_PRE:
				ret = this.getResultAndReset(token);
				break;

			case PreHandler.STATE_PRE_COLLECT:
			case PreHandler.STATE_MULTILINE_PRE:
				ret = this.processPre(token);
				break;
		}

		// reset for next use of this pipeline!
		init(this, false);
	} else {
		switch (this.state) {
			case PreHandler.STATE_SOL:
				if ((tc === String) && token.match(/^\s/)) {
					ret = this.tokens;
					this.tokens = [];
					this.preWSToken = token;
					this.state = PreHandler.STATE_PRE;
				} else if (Util.isSolTransparent(token)) { // continue watching
					this.tokens.push(token);
				} else {
					ret = this.getResultAndReset(token);
					this.moveToIgnoreState();
				}
				break;

			case PreHandler.STATE_PRE:
				if (Util.isSolTransparent(token)) { // continue watching
					this.solTransparentTokens.push(token);
				} else if (isTableTag(token) ||
					(token.isHTMLTag() && (Util.isBlockTag(token.name) || tc === EndTagTk)))
				{
					if (this.tokens.length > 0) {
						// we got here from a multiline-pre
						ret = this.processPre(token);
					} else {
						ret = this.getResultAndReset(token);
					}
					this.state = PreHandler.STATE_SOL;
				} else {
					this.tokens = this.tokens.concat(this.solTransparentTokens);
					this.tokens.push(token);
					this.solTransparentTokens = [];
					this.state = PreHandler.STATE_PRE_COLLECT;
				}
				break;

			case PreHandler.STATE_PRE_COLLECT:
				if (token.isHTMLTag() && (Util.isBlockTag(token.name) || tc === EndTagTk)) {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				} else {
					// nothing to do .. keep collecting!
					this.tokens.push(token);
				}
				break;

			case PreHandler.STATE_MULTILINE_PRE:
				if ((tc === String) && token.match(/^\s/)) {
					this.popLastNL(this.tokens);
					this.state = PreHandler.STATE_PRE;
					// Ignore white-space token.
				} else if (Util.isSolTransparent(token)) { // continue watching
					this.solTransparentTokens.push(token);
				} else {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				}
				break;
		}
	}

	if (this.debug) {
		console.warn("saved: " + JSON.stringify(this.tokens));
		console.warn("ret  : " + JSON.stringify(ret));
	}

	return { tokens: ret };
};

if (typeof module === "object") {
	module.exports.PreHandler = PreHandler;
}
