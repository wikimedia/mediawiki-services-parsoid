/* ------------------------------------------------------------------------
 * Token attributes can have one or both of their key/value information
 * come from a token stream.  Ex: <div {{echo|id}}="{{echo|test}}">
 *
 * In these examples, "<noinclude" or "</noinclude>" is encountered in
 * an attribute key/value position within the parser and is added to the
 * attribute of the div/table.
 *
 * - <div <noinclude>id</noinclude><includeonly>about</includeonly>='foo'>
 * - <noinclude>{|</noinclude> ...
 * - {|<noinclude>style='color:red'</noinclude>
 *
 * This class attempts to match up opening and closing tags across token
 * nesting boundaries when the parser cannot always accurately match them
 * up within the restricted parsing context.  While a different parsing
 * strategy might be able to handle these, the current strategy has been
 * adopted to not crash while handling weird uses of <noinclude>, etc. tags
 * that may not be properly nested vis-a-vis other tags:
 *
 * Ex: <p id="<noinclude>"> foo </noinclude></p>
 *
 * This use of <noinclude> tags spans a DOM-attribute and a DOM child
 * across levels and is not really well-structure wrt DOM semantics and
 * ideally should not be supported/seen in wikitext.  This support may
 * evolve in the future to issue appropriate warnings/error messages to
 * encourage fixing up the relevant pages.
 *
 * Authors: Subramanya Sastry <ssastry@wikimedia.org>
 *          Gabriel Wicke <gwicke@wikimedia.org>
 * ------------------------------------------------------------------------ */
function TokenAndAttrCollector(manager, transformation, toEnd, rank, name) {
	this.transformation = transformation;
	this.manager = manager;
	this.rank = rank;
	this.tagName = name;
	this.toEnd = toEnd;
	this.hasOpenTag = false;
	manager.addTransform(this.onAnyToken.bind( this ), "TokenAndAttrCollector:onAnyToken", rank, 'any');
}

TokenAndAttrCollector.prototype.init = function(start) {
	/*
	 * start and end are usually delimiter tokens (ex: <noinclude> and </noinclude>)
	 * but, if they are nested in attributes of another token, then start and end
	 * will be an object with info about the nesting.
	 *
	 * tokens are all tokens in between start and end.
	 *
	 * The nesting info object has the following fields:
	 * 	- delimiter : the nested delimiter (ex: </noinclude>, <includeonly> ..)
	 * 	- token     : the token that nested the delimiter
	 * 	- attrIndex : index of the attribute where the delimiter was found
	 * 	- k         : if >= 0, the index of the delimiter with the k-array of the attribute
 	 * 	- v         : if >= 0, the index of the delimiter with the v-array of the attribute
	 */
	this.collection = {
		start  : null,
		end    : null,
		tokens : []
	};
	this.hasOpenTag = true;
	this.collection.start = start;
};

TokenAndAttrCollector.prototype.inspectAttrs = function(token) {
	var balanced = true;
	var nestedTagInfo = null;

	function testForNestedDelimiter(collector, containerToken, attrIndex, isK, tagArray) {
		for (var j = 0, m = tagArray.length; j < m; j++) {
			var t  = tagArray[j];
			var tc = t.constructor;
			// Last open unmatched tag is the nested tag we are looking for
			if ((tc === TagTk) && (t.name === collector.tagName)) {
				if (!collector.hasOpenTag && balanced) {
					nestedTagInfo = {
						delimiter: t,
						token: containerToken,
						attrIndex: attrIndex,
						k: isK  ? j : -1,
						v: !isK ? j : -1
					};
				}
				balanced = !balanced;
			} else if ((tc === EndTagTk) && (t.name === collector.tagName)) {
				// First unmatched closing tag is the nested tag we are looking for
				if (!nestedTagInfo && collector.hasOpenTag && balanced) {
					nestedTagInfo = {
						delimiter: t,
						token: containerToken,
						attrIndex: attrIndex,
						k: isK  ? j : -1,
						v: !isK ? j : -1
					};
				}
				balanced = !balanced;
			}
			// FIXME: Not recursing down for now
			// else if is-tag { .. inspectAttrs ..  }
		}
	}

	// Check tags to see if we have a nested delimiter
	var attrs = token.attribs;
	for (var i = 0, n = attrs.length; i < n; i++) {
		var a = attrs[i];
		var k = a.k;
		if (k.constructor === Array && k.length > 0) {
			testForNestedDelimiter(this, token, i, true, k);
		}
		var v = a.v;
		if (v.constructor === Array && v.length > 0) {
			testForNestedDelimiter(this, token, i, false, v);
		}
	}

	// Check if we have the nested delimiters were balanced.
	//
	// This let us distinguish between (a) and (b).
	// (a) <div style="<noinclude>">...</div>
	// (b) <div style="<noinclude>foo</noinclude>">...</div>
	//
	// If balanced, the attribute-handler will deal with nested tags later on.
	// If unbalanced, we let the collection user deal with the mess.
	if (balanced) {
		if (this.hasOpenTag) {
			this.collection.tokens.push(token);
			return {tokens: null};
		} else {
			return {tokens: [token]};
		}
	} else {
		if (this.hasOpenTag) {
			this.collection.end = nestedTagInfo ? nestedTagInfo : token;
			this.hasOpenTag = false;
			return this.transformation(this.collection);
		} else {
			this.init(nestedTagInfo);
			return {tokens: null};
		}
	}
};

TokenAndAttrCollector.prototype.onAnyToken = function( token, frame, cb ) {
	var tc = token.constructor;
	if ((tc === TagTk) && (token.name === this.tagName)) {
		this.init(token);
		return {tokens: null};
	} else if (this.hasOpenTag) {
		if ((tc === EndTagTk) && (token.name === this.tagName)) {
			this.hasOpenTag = false;
			this.collection.end = token;
			return this.transformation(this.collection);
		} else if ((tc === EOFTk) && this.toEnd) {
			this.collection.tokens.push(token);
			this.hasOpenTag = false;
			return this.transformation(this.collection);
		} else if (tc === TagTk || tc === EndTagTk || tc === SelfclosingTagTk){
			return this.inspectAttrs(token);
		} else {
			this.collection.tokens.push(token);
			return {tokens: null};
		}
	} else {
		if ((tc === EndTagTk) && (token.name === this.tagName)) {
			// ERROR! unbalanced closing token! -- convert to string!
			// Spit out error somewhere.
			// FIXME: Copy over tsr
			return {tokens: [new String("</" + this.tagName + ">")]};
		} else if (tc === TagTk || tc === EndTagTk || tc === SelfclosingTagTk){
			return this.inspectAttrs(token);
		} else {
			return {tokens: [token]};
		}
	}
};

if (typeof module === "object") {
	module.exports.TokenAndAttrCollector = TokenAndAttrCollector;
}
