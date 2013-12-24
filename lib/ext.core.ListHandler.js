/*
 * Create list tag around list items and map wiki bullet levels to html
 */

"use strict";
var Util = require('./mediawiki.Util.js').Util,
	defines = require('./mediawiki.parser.defines.js');
// define some constructor shortcuts
var NlTk = defines.NlTk,
    TagTk = defines.TagTk,
    EndTagTk = defines.EndTagTk;

function ListHandler ( manager ) {
	this.manager = manager;
	this.listFrames = [];
	this.init();
	this.manager.addTransform(this.onListItem.bind(this),
							"ListHandler:onListItem",
							this.listRank, 'tag', 'listItem' );
	this.manager.addTransform( this.onEnd.bind(this),
							"ListHandler:onEnd",
							this.listRank, 'end' );
	var env = manager.env;
	this.trace = env.conf.parsoid.debug || (env.conf.parsoid.traceFlags && (env.conf.parsoid.traceFlags.indexOf("list") !== -1));
}

ListHandler.prototype.listRank = 2.49; // before PostExpandParagraphHandler
ListHandler.prototype.anyRank = 2.49 + 0.001; // before PostExpandParagraphHandler

ListHandler.prototype.bulletCharsMap = {
	'*': { list: 'ul', item: 'li' },
	'#': { list: 'ol', item: 'li' },
	';': { list: 'dl', item: 'dt' },
	':': { list: 'dl', item: 'dd' }
};

function newListFrame() {
	return {
		atEOL    : true, // flag indicating a list-less line that terminates a list block
		nlTk     : null, // NlTk that triggered atEOL
		solTokens: [],
		bstack   : [], // Bullet stack, previous element's listStyle
		endtags  : [], // Stack of end tags
		// Partial DOM building heuristic
		// # of open block tags encountered within list context
		numOpenBlockTags: 0
	};
}

ListHandler.prototype.init = function() {
	this.reset();
	this.nestedTableCount = 0;
};

ListHandler.prototype.reset = function() {
	this.currListFrame = null;
};

ListHandler.prototype.onAny = function ( token, frame, prevToken ) {
	if (this.trace) {
		console.warn("T:list:any " + JSON.stringify(token));
	}

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

	if ( this.currListFrame.atEOL ) {
		if (token.constructor !== NlTk && Util.isSolTransparent(token)) {
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

	if ( token.constructor === NlTk ) {
		this.currListFrame.atEOL = true;
		this.currListFrame.nlTk = token;
		return { };
	}

	if (token.constructor === TagTk) {
		if (token.name === 'table') {
			this.listFrames.push(this.currListFrame);
			this.currListFrame = null;
		} else if (Util.isBlockTag(token.name)) {
			this.currListFrame.numOpenBlockTags++;
		}
		return { token: token };
	}

	// Nothing else left to do
	return { token: token };
};

ListHandler.prototype.onEnd = function( token, frame, prevToken ) {
	if (this.trace) {
		console.warn("T:list:end " + JSON.stringify(token));
	}

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
		this.manager.removeTransform( this.anyRank, 'any' );
	}

	this.reset();

	if (this.trace) {
		console.warn("----closing all lists----");
		console.warn("list:RET: " + JSON.stringify(tokens));
	}

	return tokens;
};

ListHandler.prototype.onListItem = function ( token, frame, prevToken ) {
	if (token.constructor === TagTk){
		if (!this.currListFrame) {
			this.currListFrame = newListFrame();
		}
		// convert listItem to list and list item tokens
		return { tokens: this.doListItem(this.currListFrame.bstack, token.bullets, token) };
	}
	return { token: token };
};

ListHandler.prototype.commonPrefixLength = function (x, y) {
	var minLength = Math.min(x.length, y.length);
	for (var i = 0; i < minLength; i++) {
		if (x[i] !== y[i]) {
			break;
		}
	}
	return i;
};

ListHandler.prototype.pushList = function ( container, liTok, dp1, dp2 ) {
	this.currListFrame.endtags.push( new EndTagTk( container.list ));
	this.currListFrame.endtags.push( new EndTagTk( container.item ));

	return [
		new TagTk( container.list, [], dp1),
		new TagTk( container.item, [], dp2)
	];
};

ListHandler.prototype.popTags = function ( n ) {
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

ListHandler.prototype.isDtDd = function (a, b) {
	var ab = [a,b].sort();
	return (ab[0] === ':' && ab[1] === ';');
};

ListHandler.prototype.doListItem = function ( bs, bn, token ) {
	if (this.trace) {
		console.warn("T:list:begin " + JSON.stringify(token));
	}

	var prefixLen = this.commonPrefixLength (bs, bn),
		prefix = bn.slice(0, prefixLen),
		dp = token.dataAttribs,
		tsr = dp.tsr,
		makeDP = function(i, j) {
			var newTSR, newDP;
			if ( tsr ) {
				newTSR = [ tsr[0] + i, tsr[0] + j ];
			} else {
				newTSR = undefined;
			}

			newDP = Util.clone(dp);
			newDP.tsr = newTSR;
			return newDP;
		};
	this.currListFrame.bstack = bn;
	if (!bs.length && this.listFrames.length === 0) {
		this.manager.addTransform( this.onAny.bind(this), "ListHandler:onAny",
				this.anyRank, 'any' );
	}

	var res, itemToken;

	// emit close tag tokens for closed lists
	if (this.trace) {
		console.warn("    bs: " + JSON.stringify(bs) + "; bn: " + JSON.stringify(bn));
	}
	if (prefix.length === bs.length && bn.length === bs.length) {
		if (this.trace) {
			console.warn("    -> no nesting change");
		}
		// same list item types and same nesting level
		itemToken = this.currListFrame.endtags.pop();
		this.currListFrame.endtags.push(new EndTagTk( itemToken.name ));
		res = [ itemToken ].concat(
			this.currListFrame.solTokens,
			[
				// this list item gets all the bullets since this is
				// a list item at the same level
				//
				// **a
				// **b
				this.currListFrame.nlTk || '',
				new TagTk( itemToken.name, [], makeDP( 0, bn.length ) )
			]
		);
	} else {
		var prefixCorrection = 0;
		var tokens = [];
		if ( bs.length > prefixLen &&
			 bn.length > prefixLen &&
			this.isDtDd( bs[prefixLen], bn[prefixLen] ) )
		{
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
			this.currListFrame.endtags.push(new EndTagTk( newName ));

			/* ------------------------------------------------
			 * 1. ;a:b  (;a  -> :b ) is a dt -> dd transition
			 * 2. ;;a:b (;;a -> ;:b) is a dt -> dd transition
			 *    ;;c:d (;:b -> ;;c) is a dd -> dt transition
			 * 3. *;a:b (*:a -> *;b) is a dt -> dd transition
			 * -------------------------------------- ----------*/
			var newTag;
			if (prefixLen === 0 || dp.stx === 'row' || (bs[prefixLen-1] !== ':' && bs[prefixLen] === ';')) {
				if (this.trace) {
					console.warn("    -> dt->dd");
				}
				// dt --> dd transition (dd token has a 1-length prefix: see tokenizer)
				newTag = new TagTk(newName, [], makeDP( 0, 1 ));
			} else {
				if (this.trace) {
					console.warn("    -> dd->dt");
				}
				// dd --> dt transition (dt token has a prefixLen prefix: see tokenizer)
				newTag = new TagTk(newName, [], makeDP( 0, prefixLen + 1 ));
			}
			tokens = tokens.concat([ endTag, this.currListFrame.nlTk || '', newTag ]);

			prefixCorrection = 1;
		} else {
			if (this.trace) {
				console.warn("    -> reduced nesting");
			}
			tokens = tokens.concat( this.popTags(bs.length - prefixLen) );
			tokens = this.currListFrame.solTokens.concat(tokens);
			if (this.currListFrame.nlTk) {
				tokens.push(this.currListFrame.nlTk);
			}
			if (prefixLen > 0 && bn.length === prefixLen ) {
				itemToken = this.currListFrame.endtags.pop();
				tokens.push(itemToken);
				// this list item gets all bullets upto the shared prefix
				tokens.push(new TagTk(itemToken.name, [], makeDP(0, bn.length)));
				this.currListFrame.endtags.push(new EndTagTk( itemToken.name ));
			}
		}

		for (var i = prefixLen + prefixCorrection; i < bn.length; i++) {
			if (!this.bulletCharsMap[bn[i]]) {
				throw("Unknown node prefix " + prefix[i]);
			}

			// First list item gets all bullets upto the shared prefix.
			// Later ones in the chain get one bullet each.
			// Example:
			//
			// **a
			// ****b
			//
			// When handling ***b, the "**" bullets are assigned to the
			// li that opens the "**" list item.
			// <ul><li>
			//   <ul><li>a</li>
			//       <li-FIRST-ONE-gets-**>
			//         <ul><li-*><ul><li-*>b</li></ul></li></ul>
			//
			// prefixCorrection is for handling dl-dts like this
			//
			// ;a:b
			// ;;c:d
			//
			// ";c:d" is embedded within a dt that is 1 char wide(;)
			// and needs to be accounted for.

			var listDP, listItemDP;
			if (i === prefixLen) {
				if (this.trace) {
					console.warn("    -> increased nesting: first");
				}
				listDP     = makeDP(prefixCorrection,prefixCorrection);
				listItemDP = makeDP(prefixCorrection,prefixLen+1);
			} else {
				if (this.trace) {
					console.warn("    -> increased nesting: 2nd and higher");
				}
				listDP     = makeDP(i,i);
				listItemDP = makeDP(i,i+1);
			}

			tokens = tokens.concat(
				this.pushList(
					this.bulletCharsMap[bn[i]], token, listDP, listItemDP
				)
			);
		}
		res = tokens;
	}

	// clear out sol-tokens
	res.rank = this.anyRank + 0.01;
	this.currListFrame.solTokens = [];
	this.currListFrame.nlTk = null;
	this.currListFrame.atEOL = false;

	if (this.trace) {
		console.warn("list:RET: " + JSON.stringify(res));
	}
	return res;
};

if (typeof module === "object") {
	module.exports.ListHandler = ListHandler;
}
