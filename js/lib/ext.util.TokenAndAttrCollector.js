/* ------------------------------------------------------------------------
 * Summary
 * -------
 * This whole handler collects delimiter-separated tokens on behalf of other
 * transformers.  It is also one giant hack of sorts to get around:
 *
 * (1) precedence issues in a single-pass tokenizer (without
 *     preprocessing passes like in the multi-pass PHP parser)
 *     to process noinclude/includeonly and extension content tags.
 * (2) unbalanced/misnested tags in source wikitext.
 * ------------------------------------------------------------------------
 *
 * Token attributes can have one or both of their key/value information
 * come from a token stream.  Ex: <div {{echo|id}}="{{echo|test}}">
 *
 * However if noinclude/includeonly or an extension tag shows up in
 * an attribute key/value position (as far as the tokenizer is concerned),
 * these delimiter tags get buried inside token attributes rather than
 * being present at the top-level of the token stream.
 *
 * Examples:
 * - <div <noinclude>id</noinclude><includeonly>about</includeonly>='foo'>
 * - <noinclude>{|</noinclude> ...
 * - {|<noinclude>style='color:red'</noinclude>
 * - [[Image:foo.jpg| .. <math>a|b</math> ..]]
 *
 * This class attempts to match up opening and closing tags across token
 * nesting boundaries when the parser cannot always accurately match them
 * up within the restricted parsing context.  The broad strategy is to
 * find matching pairs of delimiters within attributes of the same token
 * and merge those attributes into a single attribute to let the
 * Attribute Expander handle them.  After this is done, there should only
 * be atmost one unmatched open/closing delimiter within each token.
 *
 * The current strategy has been adopted to not crash while handling uses
 * of such tags that may not be properly nested vis-a-vis other tags:
 *
 * Ex: <p id="<noinclude>"> foo </noinclude></p>
 *
 * This use of <noinclude> tags spans a DOM-attribute and a DOM child
 * across levels and is not really well-structured wrt DOM semantics and
 * ideally should not be supported/seen in wikitext.  This support may
 * evolve in the future to issue appropriate warnings/error messages to
 * encourage fixing up the relevant pages.
 *
 * Authors: Subramanya Sastry <ssastry@wikimedia.org>
 *          Gabriel Wicke <gwicke@wikimedia.org>
 * ------------------------------------------------------------------------ */

"use strict";

function TokenAndAttrCollector(manager, transformation, toEnd, rank, name) {
	this.transformation = transformation;
	this.manager = manager;
	this.rank = rank;
	this.tagName = name;
	this.toEnd = toEnd;
	this.hasOpenTag = false;
	// this.uid = this.manager.env.generateUID();
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
	 * - delimiter : the nested delimiter (ex: </noinclude>, <includeonly> ..)
	 * - token     : the token that nested the delimiter
	 * - attrIndex : index of the attribute where the delimiter was found
	 * - k         : if >= 0, the index of the delimiter with the k-array of the attribute
	 * - v         : if >= 0, the index of the delimiter with the v-array of the attribute
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
	/* --------------------------------------------------
	 * NOTE: This function assumes:
	 * - balanced open/closed delimiters.
	 * - no nesting of delimiters.
	 * -------------------------------------------------- */

	function findMatchingDelimIndex(delims, opts) {
		// Finds first/last open/closed delimiter tag
		var i, n = delims.length;
		if (opts.first) {
			i = 0;
			// xor to detect unmet condition
			while (i < n && (opts.open ^ delims[i].open)) {
				i++;
			}

			// failure case
			if (i === n) {
				i = -1;
			}
		} else {
			i = n - 1;
			// xor to detect unmet condition
			while (i >= 0 && (opts.open ^ delims[i].open)) {
				i--;
			}
		}

		return i;
	}

	function nothingSpecialToDo(collector, token) {
		if (collector.hasOpenTag) {
			collector.collection.tokens.push(token);
			return {};
		} else {
			return {tokens: [token]};
		}
	}

	function collectNestedDelimiters(collector, containerToken, attrIndex, isK, tagArray) {
		// Don't collect balanced pairs of open-closed tags.
		// They will be taken care of by the attribute-handler.
		//
		// This let us distinguish between (a) and (b).
		// (a) <div style="<noinclude>">...</div>
		// (b) <div style="<noinclude>foo</noinclude>">...</div>
		var delims = [], openTag = null, closedTag = null;
		for (var j = 0, m = tagArray.length; j < m; j++) {
			var t  = tagArray[j];
			var tc = t.constructor;
			if ((tc === TagTk) && (t.name === collector.tagName)) {
				openTag = {
					delimiter: t,
					open: true,
					token: containerToken,
					attrIndex: attrIndex,
					k: isK  ? j : -1,
					v: !isK ? j : -1
				};
			} else if ((tc === EndTagTk) && (t.name === collector.tagName)) {
				closedTag = {
					delimiter: t,
					open: false,
					token: containerToken,
					attrIndex: attrIndex,
					k: isK  ? j : -1,
					v: !isK ? j : -1
				};

				// Collect any unbalanced closed tag
				if (!openTag) {
					closedTag.unbalanced = true;
					delims.push(closedTag);
				}

				openTag = closedTag = null;
			}
			// FIXME: Not recursing down into t's attributes above
		}

		// Collect any unbalanced open tag
		if (openTag) {
			delims.push(openTag);
		}

		return delims;
	}

	function reuniteSeparatedPairs(token, delims) {
		/* -----------------------------------------------------------
		 * FIXME: Merging attributes is not necessarily the right
		 * solution in all cases.  In certain parsing contexts,
		 * we shouldn't be merging the attributes at all.
		 *
		 * Ex: [[Image:foo.jpg|thumb|<noinclude>foo|bar|baz</noinclude>]]
		 *
		 * PHP parser treats these as 3 different attributes and
		 * discards everything but 'baz'.  But, by merging the 3 attrs,
		 * this handler will include everything.  This is an edge case,
		 * so, not worrying about it now.
		 *
		 * FIXME: Later on, we may implement smarter merging strategies.
		 * ------------------------------------------------------------ */

		// helper function
		function mergeToks(toks, t) {
			if (t.constructor === Array) {
				return toks.concat(t);
			} else {
				toks.push(t);
				return toks;
			}
		}

		// helper function
		function mergeAttr(toks, a) {
			// Compute toks + a.k + "=" + a.v
			if (a.k === "mw:maybeContent") {
				/* -----------------------------------------------------
				 * FIXME: This is not the right solution in all cases.
				 * This is appropriate only when we are processing
				 * extension content where "|" has no special meaning.
				 * For now, we are turning a blind eye since this is
				 * likely an edge case:
				 *
				 * [[Image:foo.jpg|thumb|<noinclude>foo|bar|baz</noinclude>]]
				 * ---------------------------------------------------------- */
				toks.push("|");
				toks = mergeToks(toks, a.v);
			} else {
				toks = mergeToks(toks, a.k);
				if (a.v !== "") {
					toks.push('=');
					toks = mergeToks(toks, a.v);
				}
			}
			return toks;
		}

		// console.warn("T: " + JSON.stringify(token));

		// find the first open delim -- will be delims[0/1] for well-formed WT
		var i = findMatchingDelimIndex(delims, {first: true, open: true});
		var openD = delims[i];

		// find the last closed delim -- will be delims[n-2/n-1] for well-formed WT
		var j = findMatchingDelimIndex(delims, {first: false, open: false});
		var closeD = delims[j];

		// Merge all attributes between openD.attrIndex and closeD.attrIndex
		// Tricky bits:
		// - every attribute is a (k,v) pair, and we need to merge
		//   both the k and v into one set of tokens and insert a "=" token
		//   in between.
		// - we need to handle the first/last attribute specially since the
		//   openD/closeD may show up in either k/v of those attrs.  That
		//   will determine what the merged k/v value will be.
		if (i < j) {
			var attrs = token.attribs, toks;

			// console.warn("openD: " + JSON.stringify(openD));
			// console.warn("closeD: " + JSON.stringify(closeD));

			if (openD.k === -1) {
				// openD didn't show up in k. Start with v
				toks = mergeToks([], attrs[openD.attrIndex].v);
			} else {
				// openD showed up in k.  Merge k & v
				toks = mergeAttr([], attrs[openD.attrIndex]);
			}

			var x = openD.attrIndex + 1;
			while (x < closeD.attrIndex) {
				// Compute toks + a.k + "=" + a.v
				toks = mergeAttr(toks, attrs[x]);
				x++;
			}

			// Compute merged (k,v)
			var mergedK, mergedV;
			if (openD.k === -1) {
				// openD didn't show up in k.
				// Use orig-k for the merged KV
				// Merge closeD's attr into toks and use it for v
				mergedK = attrs[openD.attrIndex].k;
				mergedV = mergeAttr(toks, attrs[closeD.attrIndex]);
			} else {
				// openD showed up in k.
				// check where closedD showed up.
				if (closeD.k !== -1) {
					mergedK = mergeToks(toks, attrs[closeD.attrIndex].k);
					mergedV = attrs[closeD.attrIndex].v;
				} else {
					mergedK = mergeAttr(toks, attrs[closeD.attrIndex]);
					mergedV = [];
				}
			}

			// console.warn("t-delims: " + JSON.stringify(delims));
			// console.warn("-------------");
			// console.warn("t-orig: " + JSON.stringify(token));
			// console.warn("merged k: " + JSON.stringify(mergedK));
			// console.warn("merged v: " + JSON.stringify(mergedV));

			// clone token and splice in merged attribute
			var numDeleted = closeD.attrIndex - openD.attrIndex;
			token = token.clone();
			token.attribs.splice(openD.attrIndex, numDeleted + 1, new KV(mergedK, mergedV));

			// console.warn("-------------");
			// console.warn("t-merged: " + JSON.stringify(token));

			// remove merged delims and update attr-index for remaining delimiters
			delims.splice(i,j-i+1);
			while (i < delims.length) {
				delims.attrIndex -= numDeleted;
				i++;
			}
		}

		return [token, delims];
	}

	// Check tags to see if we have a nested delimiter
	var attrs = token.attribs;
	var delims = [];
	var i, n;

	for (i = 0, n = attrs.length; i < n; i++) {
		var a = attrs[i];
		var k = a.k;
		if (k.constructor === Array && k.length > 0) {
			delims = delims.concat(collectNestedDelimiters(this, token, i, true, k));
		}
		var v = a.v;
		if (v.constructor === Array && v.length > 0) {
			delims = delims.concat(collectNestedDelimiters(this, token, i, false, v));
		}
	}

	// console.warn("delims: " + JSON.stringify(delims));

	if (delims.length === 0) {
		return nothingSpecialToDo(this, token);
	} else {
		if (delims.length > 1) {
			// we will have delims.length %2 matched pairs across
			// attributes and their .k and .v properties.  Merge
			// them into a unified attribute since this separation
			// is a Parsoid parsing artefact.
			var ret = reuniteSeparatedPairs(token, delims);
			token  = ret[0];
			delims = ret[1];
		}

		if (delims.length === 0) {
			// we merged matching pairs and eliminated all nested
			// delims to process in this pass.
			return nothingSpecialToDo(this, token);
		} else {
			var openDelim, closedDelim;

			// Find first closed delim -- should always be the delims[0]
			// if everything is working properly.
			i = findMatchingDelimIndex(delims, {first: true, open: false });
			closedDelim = i === -1 ? null : delims[i];

			// Find last open delim -- should always be the delims[numDelims-1]
			// if everything is working properly.
			i = findMatchingDelimIndex(delims, {first: false, open: true });
			openDelim = i === -1 ? null : delims[i];

			if (this.hasOpenTag) {
				if (closedDelim) {
					this.collection.end = closedDelim;
					this.hasOpenTag = false;
					return this.transformation(this.collection);
				} else {
					// nested/extra tag?  we'll ignore it.
					return nothingSpecialToDo(this, token);
				}
			} else {
				if (openDelim) {
					this.init(openDelim);
					return {tokens: null};
				} else {
					// nested/extra tag?  we'll ignore it.
					return nothingSpecialToDo(this, token);
				}
			}
		}
	}
};

TokenAndAttrCollector.prototype.onAnyToken = function( token, frame, cb ) {
	//console.warn("T<" + this.tagName + ":" + this.rank + ":" + this.hasOpenTag + ">:" + JSON.stringify(token));
	var tc = token.constructor, res;
	if ((tc === TagTk) && (token.name === this.tagName)) {
		this.init(token);
		return {tokens: null};
	} else if (this.hasOpenTag) {
		if ((tc === EndTagTk) && (token.name === this.tagName)) {
			this.hasOpenTag = false;
			this.collection.end = token;
			return this.transformation(this.collection);
		} else if (tc === EOFTk) {
			if (this.toEnd) {
				this.collection.tokens.push(token);
				this.hasOpenTag = false;
				res = this.transformation(this.collection);
				// make sure we preserve the EOFTk
				if ( res.tokens && res.tokens.length &&
						res.tokens.last().constructor !== EOFTk ) {
					res.tokens.push(token);
				} else {
					res = { tokens: [token] };
				}
				return res;
			} else {
				this.collection.tokens.push(token);
				return { tokens: this.collection.tokens };
			}
		} else if (tc === TagTk || tc === EndTagTk || tc === SelfclosingTagTk){
			return this.inspectAttrs(token);
		} else {
			this.collection.tokens.push(token);
			return { };
		}
	} else {
		if ((tc === EndTagTk) && (token.name === this.tagName)) {
			// ERROR! unbalanced closing token! -- convert to string!
			// Spit out error somewhere.
			// FIXME: Copy over tsr
			return {tokens: [new String("</" + this.tagName + ">")]};
		} else if (tc === SelfclosingTagTk && token.name === this.tagName) {
			return this.transformation({
				start  : token,
				end    : null,
				tokens : []
			});
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
