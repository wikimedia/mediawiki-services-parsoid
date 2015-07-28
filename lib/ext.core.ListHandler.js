/*
 * Create list tag around list items and map wiki bullet levels to html
 */
'use strict';

var Util = require('./mediawiki.Util.js').Util;
var defines = require('./mediawiki.parser.defines.js');

// define some constructor shortcuts
var NlTk = defines.NlTk;
var TagTk = defines.TagTk;
var EndTagTk = defines.EndTagTk;


function ListHandler(manager) {
	this.manager = manager;
	this.listFrames = [];
	this.init();
	this.manager.addTransform(this.onListItem.bind(this),
							"ListHandler:onListItem",
							this.listRank, 'tag', 'listItem');
	this.manager.addTransform(this.onEnd.bind(this),
							"ListHandler:onEnd",
							this.listRank, 'end');
	this.env = manager.env;
}

ListHandler.prototype.listRank = 2.49; // before Sanitizer
ListHandler.prototype.anyRank = 2.49 + 0.001; // before Sanitizer

ListHandler.prototype.bulletCharsMap = {
	'*': { list: 'ul', item: 'li' },
	'#': { list: 'ol', item: 'li' },
	';': { list: 'dl', item: 'dt' },
	':': { list: 'dl', item: 'dd' },
};

function newListFrame() {
	return {
		atEOL: true, // flag indicating a list-less line that terminates a list block
		nlTk: null, // NlTk that triggered atEOL
		solTokens: [],
		bstack: [], // Bullet stack, previous element's listStyle
		endtags: [], // Stack of end tags
		// Partial DOM building heuristic
		// # of open block tags encountered within list context
		numOpenBlockTags: 0,
		// # of open tags encountered within list context
		numOpenTags: 0,
	};
}

ListHandler.prototype.init = function() {
	this.reset();
	this.nestedTableCount = 0;
};

ListHandler.prototype.reset = function() {
	this.currListFrame = null;
};

ListHandler.prototype.onAny = function(token, frame, prevToken) {
	this.env.log("trace/list", this.manager.pipelineId,
		"ANY:", function() { return JSON.stringify(token); });

	var tokens;
	if (!this.currListFrame) {
		// this.currListFrame will be null only when we are in a table
		// that in turn was seen in a list context.
		//
		// Since we are not in a list within the table, nothing to do.
		// Just send the token back unchanged.
		if (token.constructor === EndTagTk && token.name === 'table') {
			if (this.nestedTableCount === 0) {
				this.currListFrame = this.listFrames.pop();
			} else {
				this.nestedTableCount--;
			}
		} else if (token.constructor === TagTk && token.name === 'table') {
			this.nestedTableCount++;
		}

		return { token: token };
	}

	// Keep track of open tags per list frame in order to prevent colons
	// starting lists illegally. Php's findColonNoLinks.
	if (token.constructor === TagTk &&
		// Table tokens will push the frame and remain balanced.
		// They're safe to ignore in the bookkeeping.
		token.name !== "table"
	) {
		this.currListFrame.numOpenTags += 1;
	} else if (token.constructor === EndTagTk && this.currListFrame.numOpenTags > 0) {
		this.currListFrame.numOpenTags -= 1;
	}

	if (token.constructor === EndTagTk) {
		if (token.name === 'table') {
			// close all open lists and pop a frame
			var ret = this.closeLists(token);
			this.currListFrame = this.listFrames.pop();
			return { tokens: ret };
		} else if (Util.isBlockTag(token.name)) {
			if (this.currListFrame.numOpenBlockTags === 0) {
				// Unbalanced closing block tag in a list context ==> close all previous lists
				return { tokens: this.closeLists(token) };
			} else {
				this.currListFrame.numOpenBlockTags--;
				return { token: token };
			}
		}

		/* Non-block tag -- fall-through to other tests below */
	}

	if (this.currListFrame.atEOL) {
		if (token.constructor !== NlTk && Util.isSolTransparent(this.env, token)) {
			// Hold on to see where the token stream goes from here
			// - another list item, or
			// - end of list
			if (this.currListFrame.nlTk) {
				this.currListFrame.solTokens.push(this.currListFrame.nlTk);
				this.currListFrame.nlTk = null;
			}
			this.currListFrame.solTokens.push(token);
			return { };
		} else {
			// Non-list item in newline context ==> close all previous lists
			tokens = this.closeLists(token);
			return { tokens: tokens };
		}
	}

	if (token.constructor === NlTk) {
		this.currListFrame.atEOL = true;
		this.currListFrame.nlTk = token;
		// php's findColonNoLinks is run in doBlockLevels, which examines
		// the text line-by-line. At nltk, any open tags will cease having
		// an effect.
		this.currListFrame.numOpenTags = 0;
		return { };
	}

	if (token.constructor === TagTk) {
		if (token.name === 'table') {
			this.listFrames.push(this.currListFrame);
			this.reset();
		} else if (Util.isBlockTag(token.name)) {
			this.currListFrame.numOpenBlockTags++;
		}
		return { token: token };
	}

	// Nothing else left to do
	return { token: token };
};

ListHandler.prototype.onEnd = function(token, frame, prevToken) {
	this.env.log("trace/list", this.manager.pipelineId,
		"END:", function() { return JSON.stringify(token); });

	this.listFrames = [];
	if (!this.currListFrame) {
		// init here so we dont have to have a check in closeLists
		// That way, if we get a null frame there, we know we have a bug.
		this.currListFrame = newListFrame();
	}
	var toks = this.closeLists(token);
	this.init();
	return { tokens: toks };
};

ListHandler.prototype.closeLists = function(token) {
	// pop all open list item tokens
	var tokens = this.popTags(this.currListFrame.bstack.length);

	// purge all stashed sol-tokens
	tokens = tokens.concat(this.currListFrame.solTokens);
	if (this.currListFrame.nlTk) {
		tokens.push(this.currListFrame.nlTk);
	}
	tokens.push(token);

	// remove any transform if we dont have any stashed list frames
	if (this.listFrames.length === 0) {
		this.manager.removeTransform(this.anyRank, 'any');
	}

	this.reset();

	this.env.log("trace/list", this.manager.pipelineId, "----closing all lists----");
	this.env.log("trace/list", this.manager.pipelineId, "RET", tokens);

	return tokens;
};

ListHandler.prototype.onListItem = function(token, frame, prevToken) {
	if (token.constructor === TagTk) {
		if (this.currListFrame) {
			// Ignoring colons inside tags to prevent illegal overlapping.
			// Attempts to mimic findColonNoLinks in the php parser.
			if (token.bullets.last() === ":" && this.currListFrame.numOpenTags > 0) {
				return { token: ":" };
			}
		} else {
			this.currListFrame = newListFrame();
		}
		// convert listItem to list and list item tokens
		return { tokens: this.doListItem(this.currListFrame.bstack, token.bullets, token) };
	}
	return { token: token };
};

ListHandler.prototype.commonPrefixLength = function(x, y) {
	var minLength = Math.min(x.length, y.length);
	for (var i = 0; i < minLength; i++) {
		if (x[i] !== y[i]) {
			break;
		}
	}
	return i;
};

ListHandler.prototype.pushList = function(container, liTok, dp1, dp2) {
	this.currListFrame.endtags.push(new EndTagTk(container.list));
	this.currListFrame.endtags.push(new EndTagTk(container.item));

	return [
		new TagTk(container.list, [], dp1),
		new TagTk(container.item, [], dp2),
	];
};

ListHandler.prototype.popTags = function(n) {
	var tokens = [];
	while (n > 0) {
		// push list item..
		tokens.push(this.currListFrame.endtags.pop());
		// and the list end tag
		tokens.push(this.currListFrame.endtags.pop());

		n--;
	}
	return tokens;
};

ListHandler.prototype.isDtDd = function(a, b) {
	var ab = [a, b].sort();
	return (ab[0] === ':' && ab[1] === ';');
};

ListHandler.prototype.doListItem = function(bs, bn, token) {
	this.env.log("trace/list", this.manager.pipelineId,
		"BEGIN:", function() { return JSON.stringify(token); });

	var prefixLen = this.commonPrefixLength(bs, bn);
	var prefix = bn.slice(0, prefixLen);
	var dp = token.dataAttribs;
	var tsr = dp.tsr;
	var makeDP = function(i, j) {
		var newTSR;
		if (tsr) {
			newTSR = [ tsr[0] + i, tsr[0] + j ];
		} else {
			newTSR = undefined;
		}
		var newDP = Util.clone(dp);
		newDP.tsr = newTSR;
		return newDP;
	};
	this.currListFrame.bstack = bn;
	if (!bs.length && this.listFrames.length === 0) {
		this.manager.addTransform(this.onAny.bind(this), "ListHandler:onAny",
				this.anyRank, 'any');
	}

	var res, itemToken;

	// emit close tag tokens for closed lists
	this.env.log("trace/list", this.manager.pipelineId, function() {
		return "    bs: " + JSON.stringify(bs) + "; bn: " + JSON.stringify(bn);
	});

	if (prefix.length === bs.length && bn.length === bs.length) {
		this.env.log("trace/list", this.manager.pipelineId, "    -> no nesting change");

		// same list item types and same nesting level
		itemToken = this.currListFrame.endtags.pop();
		this.currListFrame.endtags.push(new EndTagTk(itemToken.name));
		res = [ itemToken ].concat(
			this.currListFrame.solTokens,
			[
				// this list item gets all the bullets since this is
				// a list item at the same level
				//
				// **a
				// **b
				this.currListFrame.nlTk || '',
				new TagTk(itemToken.name, [], makeDP(0, bn.length)),
			]
		);
	} else {
		var prefixCorrection = 0;
		var tokens = [];
		if (bs.length > prefixLen &&
				bn.length > prefixLen &&
				this.isDtDd(bs[prefixLen], bn[prefixLen])) {
			/*-------------------------------------------------
			 * Handle dd/dt transitions
			 *
			 * Example:
			 *
			 * **;:: foo
			 * **::: bar
			 *
			 * the 3rd bullet is the dt-dd transition
			 * ------------------------------------------------ */

			tokens = this.popTags(bs.length - prefixLen - 1);
			tokens = this.currListFrame.solTokens.concat(tokens);
			var newName = this.bulletCharsMap[bn[prefixLen]].item;
			var endTag = this.currListFrame.endtags.pop();
			this.currListFrame.endtags.push(new EndTagTk(newName));

			var newTag;
			if (dp.stx === 'row') {
				// stx='row' is only set for single-line dt-dd lists (see tokenizer)
				// In this scenario, the dd token we are building a token for has no prefix
				// Ex: ;a:b, *;a:b, #**;a:b, etc. Compare with *;a\n*:b, #**;a\n#**:b
				this.env.log("trace/list", this.manager.pipelineId, "    -> single-line dt->dd transition");
				newTag = new TagTk(newName, [], makeDP(0, 1));
			} else {
				this.env.log("trace/list", this.manager.pipelineId, "    -> other dt/dd transition");
				newTag = new TagTk(newName, [], makeDP(0, prefixLen + 1));
			}

			tokens = tokens.concat([ endTag, this.currListFrame.nlTk || '', newTag ]);

			prefixCorrection = 1;
		} else {
			this.env.log("trace/list", this.manager.pipelineId, "    -> reduced nesting");
			tokens = tokens.concat(this.popTags(bs.length - prefixLen));
			tokens = this.currListFrame.solTokens.concat(tokens);
			if (this.currListFrame.nlTk) {
				tokens.push(this.currListFrame.nlTk);
			}
			if (prefixLen > 0 && bn.length === prefixLen) {
				itemToken = this.currListFrame.endtags.pop();
				tokens.push(itemToken);
				// this list item gets all bullets upto the shared prefix
				tokens.push(new TagTk(itemToken.name, [], makeDP(0, bn.length)));
				this.currListFrame.endtags.push(new EndTagTk(itemToken.name));
			}
		}

		for (var i = prefixLen + prefixCorrection; i < bn.length; i++) {
			if (!this.bulletCharsMap[bn[i]]) {
				throw("Unknown node prefix " + prefix[i]);
			}

			// Each list item in the chain gets one bullet.
			// However, the first item also includes the shared prefix.
			//
			// Example:
			//
			// **a
			// ****b
			//
			// Yields:
			//
			// <ul><li-*>
			//   <ul><li-*>a
			//     <ul><li-FIRST-ONE-gets-***>
			//       <ul><li-*>b</li></ul>
			//     </li></ul>
			//   </li></ul>
			// </li></ul>
			//
			// Unless prefixCorrection is > 0, in which case we've
			// already accounted for the initial bullets.
			//
			// prefixCorrection is for handling dl-dts like this
			//
			// ;a:b
			// ;;c:d
			//
			// ";c:d" is embedded within a dt that is 1 char wide(;)

			var listDP, listItemDP;
			if (i === prefixLen) {
				this.env.log("trace/list", this.manager.pipelineId,
					"    -> increased nesting: first");
				listDP     = makeDP(0, 0);
				listItemDP = makeDP(0, i + 1);
			} else {
				this.env.log("trace/list", this.manager.pipelineId,
					"    -> increased nesting: 2nd and higher");
				listDP     = makeDP(i, i);
				listItemDP = makeDP(i, i + 1);
			}

			tokens = tokens.concat(this.pushList(
				this.bulletCharsMap[bn[i]], token, listDP, listItemDP
			));
		}
		res = tokens;
	}

	// clear out sol-tokens
	res.rank = this.anyRank + 0.01;
	this.currListFrame.solTokens = [];
	this.currListFrame.nlTk = null;
	this.currListFrame.atEOL = false;

	this.env.log("trace/list", this.manager.pipelineId,
		"RET:", function() { return JSON.stringify(res); });
	return res;
};

if (typeof module === "object") {
	module.exports.ListHandler = ListHandler;
}
