var Util = require('./mediawiki.Util.js').Util;

// Constructor
function PreHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform(this.onNewline.bind(this),
		"PreHandler:onNewline", this.nlRank, 'newline');
	this.manager.addTransform(this.onEnd.bind(this),
		"PreHandler:onEnd", this.endRank, 'end');
	init(this, true);
}

// Handler ranks
PreHandler.prototype.nlRank  = 2.01;
PreHandler.prototype.anyRank = 2.02;
PreHandler.prototype.endRank = 2.03;

// FSM states
PreHandler.STATE_SOL     = 1;
PreHandler.STATE_PRE     = 2;
PreHandler.STATE_COLLECT = 3;
PreHandler.STATE_IGNORE  = 4;

function init(handler, addAnyHandler) {
	handler.lastNLTk = null;
	handler.onlyWS = true;
	handler.tokens = [];
	handler.state  = PreHandler.STATE_SOL;
	if (addAnyHandler) {
		handler.manager.addTransform(handler.onAny.bind(handler),
			"PreHandler:onAny", handler.anyRank, 'any');
	}
}

function isSolTransparent(token) {
	var tc = token.constructor;
	if (tc === String) {
		if (token.match(/[^\s]/)) {
			return false;
		}
	} else if (tc !== CommentTk && (tc !== SelfclosingTagTk || token.name !== 'meta')) {
		return false;
	}

	return true;
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
}

PreHandler.prototype.getResultAndReset = function(token) {
	this.popLastNL(this.tokens);

	var ret = this.tokens;
	ret.push(token);
	this.tokens = [];

	ret.rank = this.anyRank + 0.03; // prevent them from being processed again
	return ret;
};

PreHandler.prototype.processPre = function(token) {
	var ret;
	if (this.onlyWS) {
		ret = this.tokens.length > 0 ? [' '].concat(this.tokens) : this.tokens;
	} else {
		ret = [ new TagTk('pre') ].concat(this.tokens);
		ret.push(new EndTagTk('pre'));
	}

	// push the last new line and the current token
	this.popLastNL(ret);
	ret.push(token);

	// reset!
	this.onlyWS = true;
	this.tokens = [];

	ret.rank = this.anyRank + 0.03; // prevent them from being processed again
	return ret;
};

PreHandler.prototype.onNewline = function (token, manager, cb) {
/*
	console.warn("----------");
	console.warn("ST: " + this.state + "; NL: " + JSON.stringify(token));
*/

	var ret = null;
	switch (this.state) {
		case PreHandler.STATE_PRE:
			this.state = PreHandler.STATE_COLLECT;
			this.lastNlTk = token;
			break;

		case PreHandler.STATE_IGNORE:
			ret = this.getResultAndReset(token);
			init(this, true); // Reset!
			break;

		case PreHandler.STATE_SOL:
			ret = this.getResultAndReset(token);
			break;

		case PreHandler.STATE_COLLECT:
			ret = this.processPre(token);
			break;
	}

/*
	console.warn("TOKS: " + JSON.stringify(this.tokens));
	console.warn("RET:  " + JSON.stringify(ret));
*/
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

PreHandler.prototype.onAny = function ( token, manager, cb ) {
/*
	console.warn("----------");
	console.warn("ST: " + this.state + "; T: " + JSON.stringify(token));
*/

	if (this.state === PreHandler.STATE_IGNORE) {
		console.error("!ERROR! IGNORE! Cannot get here: " + JSON.stringify(token));
		return {tokens: null};
	}

	var ret = null;
	var tc = token.constructor;
	if (tc === EOFTk) {
		if (this.state === PreHandler.STATE_SOL) {
			ret = this.getResultAndReset(token);
		} else {
			ret = this.processPre(token);
		}

		// reset for next use of this pipeline!
		init(this, false);
	} else {
		switch (this.state) {
			case PreHandler.STATE_SOL:
				if ((tc === String) && token.match(/^\s/)) {
					ret = this.tokens;
					this.tokens = [];
					this.state = PreHandler.STATE_PRE;
				} else if (isSolTransparent(token)) { // continue watching
					this.tokens.push(token);
				} else {
					ret = this.getResultAndReset(token);
					this.moveToIgnoreState();
				}
				break;

			case PreHandler.STATE_COLLECT:
				if ((tc === String) && token.match(/^\s/)) {
					this.popLastNL(this.tokens);
					this.state = PreHandler.STATE_PRE;
					// SSS FIXME: white-space token is lost and won't be RT-ed.
					// Ex: " a\n<!--a-->\nc" VS " a\n <!--a-->\nc"
				} else if (isSolTransparent(token)) { // continue watching
					this.popLastNL(this.tokens);
					this.tokens.push(token);
				} else {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				}
				break;

			case PreHandler.STATE_PRE:
				if (token.isHTMLTag() && Util.isBlockTag(token.name)) {
					ret = this.processPre(token);
					this.moveToIgnoreState();
				} else {
					// nothing to do .. keep collecting!
					if (!isSolTransparent(token)) {
						this.onlyWS = false;
					}
					this.tokens.push(token);
				}
				break;
		}
	}

/*
	console.warn("TOKS: " + JSON.stringify(this.tokens));
	console.warn("RET:  " + JSON.stringify(ret));
*/

	return { tokens: ret };
};

if (typeof module === "object") {
	module.exports.PreHandler = PreHandler;
}
