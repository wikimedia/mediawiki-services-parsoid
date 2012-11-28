"use strict";
/*
 * Create list tag around list items and map wiki bullet levels to html
 */

var Util = require('./mediawiki.Util.js').Util;

function ListHandler ( manager ) {
	this.manager = manager;
	this.reset();
	this.manager.addTransform(this.onListItem.bind(this),
							"ListHandler:onListItem",
							this.listRank, 'tag', 'listItem' );
	this.manager.addTransform( this.onEnd.bind(this),
							"ListHandler:onEnd",
							this.listRank, 'end' );
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
		solTokens: [],
		bstack   : [], // Bullet stack, previous element's listStyle
		endtags  : []  // Stack of end tags
	};
}

ListHandler.prototype.reset = function() {
	this.newline = false; // flag to identify a list-less line that terminates
						// a list block
	this.tableStack = [];
	this.currListFrame = newListFrame();
};

ListHandler.prototype.onAny = function ( token, frame, prevToken ) {
	// console.warn("AT: " + JSON.stringify(token));

	var tokens, solTokens;
	if (!this.currListFrame) {
		// We are in a table context.  Continue to pass through tokens
		// till we find matching end-table tags.
		if (token.constructor === EndTagTk && token.name === 'table') {
			this.currListFrame = this.tableStack.pop();
		}
		return { token: token };
	} else {
		// No tables -- all good!
		if ( token.constructor === NlTk ) {
			if (this.newline) {
				// second newline without a list item in between, close the list
				solTokens = this.currListFrame.solTokens;
				tokens = this.end().concat(solTokens, [token]);
				this.newline = false;
			} else {
				tokens = [token];
				this.newline = true;
			}
			return { tokens: tokens };
		} else if ( this.newline ) {
			if (Util.isSolTransparent(token)) {
				// Hold on to see where the token stream goes from here
				// - another list item, or
				// - end of list
				this.currListFrame.solTokens.push(token);
				return {};
			} else {
				solTokens = this.currListFrame.solTokens;
				tokens = this.end().concat(solTokens, [token]);
				this.newline = false;
				return { tokens: tokens };
			}
		} else {
			if (token.constructor === TagTk && token.name === 'table') {
				this.tableStack.push(this.currListFrame);
				this.currListFrame = null;
			}
			return { token: token };
		}
	}
};


ListHandler.prototype.onEnd = function( token, frame, prevToken ) {
	// console.warn("ET: " + JSON.stringify(token));

	var solTokens = this.currListFrame.solTokens;
	return { tokens: this.end().concat(solTokens, [token]) };
};

ListHandler.prototype.end = function( ) {
	// pop all open list item tokens
	var tokens = this.popTags(this.currListFrame.bstack.length);
	this.reset();
	this.manager.removeTransform( this.anyRank, 'any' );
	return tokens;
};

ListHandler.prototype.onListItem = function ( token, frame, prevToken ) {
	this.newline = false;
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

ListHandler.prototype.pushList = function ( container ) {
	this.currListFrame.endtags.push( new EndTagTk( container.list ));
	this.currListFrame.endtags.push( new EndTagTk( container.item ));
	return [
		new TagTk( container.list ),
		new TagTk( container.item )
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
	// console.warn("LT: " + JSON.stringify(token));

	var prefixLen = this.commonPrefixLength (bs, bn),
		prefix = bn.slice(0, prefixLen);
	this.newline = false;
	this.currListFrame.bstack = bn;
	if (!bs.length) {
		this.manager.addTransform( this.onAny.bind(this), "ListHandler:onAny",
				this.anyRank, 'any' );
	}

	var res, itemToken;

	// emit close tag tokens for closed lists
	if (prefix.length === bs.length && bn.length === bs.length) {
		// same list item types and same nesting level
		itemToken = this.currListFrame.endtags.pop();
		this.currListFrame.endtags.push(new EndTagTk( itemToken.name ));
		res = [
			itemToken,
			new TagTk( itemToken.name, [], Util.clone(token.dataAttribs) )
		];
	} else {
		var tokens = [];
		if ( bs.length > prefixLen &&
			 bn.length > prefixLen &&
			this.isDtDd( bs[prefixLen], bn[prefixLen] ) )
		{
			/*---------------------------------------
			 * Example:
			 *
			 * **;:: foo
			 * **::: bar
			 *
			 * the 3rd bullet is the dt-dd transition
			 * -------------------------------------- */

			tokens = this.popTags(bs.length - prefixLen - 1);
			// handle dd/dt transitions
			var newName = this.bulletCharsMap[bn[prefixLen]].item;
			var endTag = this.currListFrame.endtags.pop();
			this.currListFrame.endtags.push(new EndTagTk( newName ));
			var dp = Util.clone(token.dataAttribs);
			if (dp.tsr) {
				// The bullets get split here.
				// Set tsr length to prefix used here.
				//
				// So, "**:" in the example above with prefixLen = 2
				dp.tsr[1] = dp.tsr[0] + prefixLen + 1;
			}
			var newTag = new TagTk(newName, [], dp);
			tokens = tokens.concat([ endTag, newTag ]);
			prefixLen++;
		} else {
			tokens = tokens.concat( this.popTags(bs.length - prefixLen) );
			if (prefixLen > 0 && bn.length === prefixLen ) {
				itemToken = this.currListFrame.endtags.pop();
				tokens.push(itemToken);
				tokens.push(new TagTk(itemToken.name, [], Util.clone(token.dataAttribs)));
				this.currListFrame.endtags.push(new EndTagTk( itemToken.name ));
			}
		}

		for (var i = prefixLen; i < bn.length; i++) {
			if (!this.bulletCharsMap[bn[i]]) {
				throw("Unknown node prefix " + prefix[i]);
			}

			tokens = tokens.concat(this.pushList(this.bulletCharsMap[bn[i]]));
		}
		res = tokens;
	}

	if (this.manager.env.trace) {
		this.manager.env.tracer.output("Returning: " + Util.toStringTokens(res).join(","));
	}

	// clear out sol-tokens
	res = this.currListFrame.solTokens.concat(res);
	res.rank = this.anyRank + 0.01;
	this.currListFrame.solTokens = [];

	return res;
};

if (typeof module === "object") {
	module.exports.ListHandler = ListHandler;
}
