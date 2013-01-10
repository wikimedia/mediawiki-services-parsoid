"use strict";
/**
 * Simple noinclude / onlyinclude implementation. Strips all tokens in
 * noinclude sections.
 */

var Collector = require( './ext.util.TokenAndAttrCollector.js' ).TokenAndAttrCollector;

/**
 * This helper function will build a meta token in the right way for these
 * tags.
 */
var buildMetaToken = function ( manager, tokenName, isEnd, tsr ) {
	var metaToken, tokenAttribs;

	if ( isEnd ) {
		tokenName += '/End';
	}

	tokenAttribs = [ new KV( 'typeof', tokenName ) ];
	metaToken = new SelfclosingTagTk( 'meta', tokenAttribs );

	if ( tsr ) {
		metaToken.dataAttribs.tsr = tsr;
		metaToken.dataAttribs.src = metaToken.getWTSource( manager.env );
	}

	return metaToken;
};

var buildStrippedMetaToken = function ( manager, tokenName, startDelim, endDelim ) {
	var tokens = [],
		da = startDelim.dataAttribs,
		tsr0 = da ? da.tsr : null,
		t0 = tsr0 ? tsr0[0] : null,
		t1, tsr1;

	if (endDelim) {
		da = endDelim ? endDelim.dataAttribs : null;
		tsr1 = da ? da.tsr : null;
		t1 = tsr1 ? tsr1[1] : null;
	} else {
		t1 = manager.env.page.src.length;
	}

	return buildMetaToken(manager, tokenName, false, [t0, t1]);
};

/**
 * OnlyInclude sadly forces synchronous template processing, as it needs to
 * hold onto all tokens in case an onlyinclude block is encountered later.
 * This can fortunately be worked around by caching the tokens after
 * onlyinclude processing (which is a good idea anyway).
 */
function OnlyInclude( manager, options ) {
	this.manager = manager;
	if ( options.isInclude ) {
		this.accum = [];
		this.inOnlyInclude = false;
		this.foundOnlyInclude = false;
		// register for 'any' token, collect those
		this.manager.addTransform( this.onAnyInclude.bind( this ), "OnlyInclude:onAnyInclude", this.rank, 'any' );
	} else {
		// just convert onlyinclude tokens into meta tags with rt info
		this.manager.addTransform( this.onOnlyInclude.bind( this ), "OnlyInclude:onOnlyInclude", this.rank,
				'tag', 'onlyinclude' );
	}
}

OnlyInclude.prototype.rank = 0.01; // Before any further processing

OnlyInclude.prototype.onOnlyInclude = function ( token, manager ) {
	var tsr = (token.dataAttribs || {}).tsr;
	var src = tsr[1] ? token.getWTSource( manager.env ) : undefined;
	var attribs = [
			new KV( 'typeof', 'mw:OnlyInclude' + ( token instanceof EndTagTk ? '/End' : '' ) )
		],
		meta = new SelfclosingTagTk( 'meta', attribs, { tsr: tsr, src: src } );
	return { token: meta };
};

OnlyInclude.prototype.onAnyInclude = function ( token, manager ) {
	//this.manager.env.dp( 'onAnyInclude', token, this );
	var isTag, tagName, curriedBuildMetaToken, meta;

	if ( token.constructor === EOFTk ) {
		this.inOnlyInclude = false;
		if ( this.accum.length && ! this.foundOnlyInclude ) {
			var res = this.accum;
			res.push( token );
			this.accum = [];
			//this.manager.setTokensRank( res, this.rank + 0.001 );
			return { tokens: res };
		} else {
			this.foundOnlyInclude = false;
			this.accum = [];
			return { token: token };
		}
	}

	isTag = token.constructor === TagTk ||
			token.constructor === EndTagTk ||
			token.constructor === SelfclosingTagTk;

	if ( isTag ) {
		switch ( token.name ) {
			case 'onlyinclude':
				tagName = 'mw:OnlyInclude';
				break;
			case 'includeonly':
				tagName = 'mw:IncludeOnly';
				break;
			case 'noinclude':
				tagName = 'mw:NoInclude';
		}
	}

	curriedBuildMetaToken = buildMetaToken.bind( null, manager, tagName );

	if ( isTag && token.name === 'onlyinclude' ) {
		if ( ! this.inOnlyInclude ) {
			this.foundOnlyInclude = true;
			this.inOnlyInclude = true;
			// wrap collected tokens into meta tag for round-tripping
			meta = curriedBuildMetaToken( token.constructor === EndTagTk, (token.dataAttribs || {}).tsr );
			return meta;
		} else {
			this.inOnlyInclude = false;
			meta = curriedBuildMetaToken( token.constructor === EndTagTk, (token.dataAttribs || {}).tsr);
		}
		//meta.rank = this.rank;
		return { token: meta };
	} else {
		if ( this.inOnlyInclude ) {
			//token.rank = this.rank;
			return { token: token };
		} else {
			this.accum.push( token );
			return { };
		}
	}
};

function defaultNestedDelimiterHandler(nestedDelimiterInfo) {
	// Always clone the container token before modifying it
	var token = nestedDelimiterInfo.token.clone();

	// Strip the delimiter token wherever it is nested
	// and strip upto/from the delimiter depending on the
	// token type and where in the stream we are.
	var i = nestedDelimiterInfo.attrIndex;
	var delimiter = nestedDelimiterInfo.delimiter;
	var isOpenTag = delimiter.constructor === TagTk;
	var stripFrom = ((delimiter.name === "noinclude") && isOpenTag) ||
					((delimiter.name === "includeOnly") && !isOpenTag);
	var stripUpto = ((delimiter.name === "noinclude") && !isOpenTag) ||
					((delimiter.name === "includeOnly") && isOpenTag);

	if (nestedDelimiterInfo.k >= 0) {
		if (stripFrom) {
			token.attribs.splice(i+1);
			token.attribs[i].k.splice(nestedDelimiterInfo.k);
		}
		if (stripUpto) {
			// Since we are stripping upto the delimiter,
			// change the token to a simple span.
			// SSS FIXME: For sure in the case of table tags (tr,td,th,etc.) but, always??
			token.name = 'span';
			token.attribs.splice(0, i);
			i = 0;
			token.attribs[i].k.splice(0, nestedDelimiterInfo.k);
		}

		// default -- not sure when this might be triggered
		if (!stripFrom && !stripUpto) {
			token.attribs[i].k.splice(nestedDelimiterInfo.k, 1);
		}
		token.attribs[i].ksrc = undefined;
	} else {
		if (stripFrom) {
			token.attribs.splice(i+1);
			token.attribs[i].v.splice(nestedDelimiterInfo.v);
		}
		if (stripUpto) {
			// Since we are stripping upto the delimiter,
			// change the token to a simple span.
			// SSS FIXME: For sure in the case of table tags (tr,td,th,etc.) but, always??
			token.name = 'span';
			token.attribs.splice(0, i);
			i = 0;
			token.attribs[i].v.splice(0, nestedDelimiterInfo.v);
		}

		// default -- not sure when this might be triggered
		if (!stripFrom && !stripUpto) {
			token.attribs[i].v.splice(nestedDelimiterInfo.v, 1);
		}
		token.attribs[i].vsrc = undefined;
	}

	return {containerToken: token, delimiter: delimiter};
}

function noIncludeHandler(manager, options, collection) {
	var start = collection.start, end = collection.end;

	// Handle self-closing tag case specially!
	if (start.constructor === SelfclosingTagTk) {
		return (options.isInclude) ?
			{ tokens: [] } :
			{ tokens: [ buildMetaToken(manager, 'mw:NoInclude', false, (start.dataAttribs || {}).tsr) ] };
	}

	var tokens = [];

	// Deal with nested opening delimiter found in another token
	if (start.constructor !== TagTk) {
		// FIXME: May use other handlers later.
		// May abort collection, convert to text, whatever ....
		// For now, this is just an intermediate solution while we
		// figure out other smarter strategies and how to plug them in here.
		tokens.push(defaultNestedDelimiterHandler(start).containerToken);
	}

	if (!options.isInclude) {
		// Content is preserved
		var curriedBuildMetaToken = buildMetaToken.bind( null, manager, 'mw:NoInclude' ),
			// TODO: abstract this!
			startTSR = start &&
				start.dataAttribs &&
				start.dataAttribs.tsr,
			endTSR = end &&
				end.dataAttribs &&
				end.dataAttribs.tsr;
		tokens.push(curriedBuildMetaToken(false, startTSR));
		tokens = tokens.concat(collection.tokens);
		if ( end ) {
			tokens.push(curriedBuildMetaToken(true, endTSR));
		} else if ( tokens.last().constructor === EOFTk ) {
			tokens.pop();
		}
	} else if (options.wrapTemplates) {
		// content is stripped
		tokens.push(buildStrippedMetaToken(manager, 'mw:NoInclude',
					start, end));
	}

	// Deal with nested closing delimiter found in another token
	if (end && end.constructor !== EndTagTk) {
		tokens.push(defaultNestedDelimiterHandler(end).containerToken);
	}

	return { tokens: tokens };
}

function NoInclude( manager, options ) {
	new Collector(
			manager,
			noIncludeHandler.bind(null, manager, options),
			true, // match the end-of-input if </noinclude> is missing
			0.02, // very early in stage 1, to avoid any further processing.
			'noinclude'
			);
}

function includeOnlyHandler(manager, options, collection) {
	var start = collection.start, end = collection.end;

	// Handle self-closing tag case specially!
	if (start.constructor === SelfclosingTagTk) {
		return (options.isInclude) ?
			{ tokens: [] } :
			{ tokens: [ buildMetaToken(manager, 'mw:IncludeOnly', false, (start.dataAttribs || {}).tsr) ] };
	}

	// Deal with nested opening delimiter found in another token
	var startDelim, startHead;
	if (start.constructor !== TagTk) {
		// FIXME: May use other handlers later.
		// May abort collection, convert to text, whatever ....
		// For now, this is just an intermediate solution while we
		// figure out other smarter strategies and how to plug them in here.
		var s = defaultNestedDelimiterHandler(start);
		startHead  = s.containerToken;
		startDelim = s.delimiter;
	} else {
		startDelim = start;
	}

	// Deal with nested closing delimiter found in another token
	var endDelim, endTail;
	if (end) {
		if (end.constructor !== EndTagTk) {
			var e = defaultNestedDelimiterHandler(end);
			endTail  = e.containerToken;
			endDelim = e.delimiter;
		} else {
			endDelim = end;
		}
	}

	var tokens = [];
	if (startHead) {
		tokens.push(startHead);
	}

	if (options.isInclude) {
		// Just pass through the full collection including delimiters
		tokens = tokens.concat(collection.tokens);
	} else if (options.wrapTemplates) {
		// Content is stripped, add a meta for round-tripping
		tokens.push(buildStrippedMetaToken(manager, 'mw:IncludeOnly',
					startDelim, endDelim));
	}

	if (endTail) {
		tokens.push(endTail);
	}

	return { tokens: tokens };
}

// XXX: Preserve includeonly content in meta tag (data attribute) for
// round-tripping!
function IncludeOnly( manager, options ) {
	new Collector(
			manager,
			includeOnlyHandler.bind(null, manager, options),
			true, // match the end-of-input if </noinclude> is missing
			0.03, // very early in stage 1, to avoid any further processing.
			'includeonly'
			);
}


if (typeof module === "object") {
	module.exports.NoInclude = NoInclude;
	module.exports.IncludeOnly = IncludeOnly;
	module.exports.OnlyInclude = OnlyInclude;
}
