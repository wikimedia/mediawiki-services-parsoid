/**
 * Simple noinclude / onlyinclude implementation. Strips all tokens in
 * noinclude sections.
 */
'use strict';

var coreutil = require('util');
var TokenHandler = require('./TokenHandler.js');
var TokenCollector = require('./TokenCollector.js').TokenCollector;
var defines = require('../parser.defines.js');

// define some constructor shortcuts
var KV = defines.KV;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;
var EOFTk = defines.EOFTk;


/**
 * This helper function will build a meta token in the right way for these
 * tags.
 */
var buildMetaToken = function(manager, tokenName, isEnd, tsr, src) {
	if (isEnd) {
		tokenName += '/End';
	}

	return new SelfclosingTagTk('meta',
		[ new KV('typeof', tokenName) ],
		tsr ? { tsr: tsr, src: manager.env.page.src.substring(tsr[0], tsr[1]) } : { src: src }
	);
};

var buildStrippedMetaToken = function(manager, tokenName, startDelim, endDelim) {
	var da = startDelim.dataAttribs;
	var tsr0 = da ? da.tsr : null;
	var t0 = tsr0 ? tsr0[0] : null;
	var t1;

	if (endDelim) {
		da = endDelim ? endDelim.dataAttribs : null;
		var tsr1 = da ? da.tsr : null;
		t1 = tsr1 ? tsr1[1] : null;
	} else {
		t1 = manager.env.page.src.length;
	}

	return buildMetaToken(manager, tokenName, false, [t0, t1]);
};


/**
 * @class
 *
 * OnlyInclude sadly forces synchronous template processing, as it needs to
 * hold onto all tokens in case an onlyinclude block is encountered later.
 * This can fortunately be worked around by caching the tokens after
 * onlyinclude processing (which is a good idea anyway).
 *
 * @extends TokenHandler
 * @constructor
 */
function OnlyInclude() {
	TokenHandler.apply(this, arguments);
}
coreutil.inherits(OnlyInclude, TokenHandler);

OnlyInclude.prototype.rank = 0.01; // Before any further processing

OnlyInclude.prototype.init = function() {
	if (this.options.isInclude) {
		this.accum = [];
		this.inOnlyInclude = false;
		this.foundOnlyInclude = false;
		// Register for 'any' token, collect those.
		this.manager.addTransform(this.onAnyInclude.bind(this),
			'OnlyInclude:onAnyInclude', this.rank, 'any');
	} else {
		// Just convert onlyinclude tokens into meta tags with rt info.
		this.manager.addTransform(this.onOnlyInclude.bind(this),
			'OnlyInclude:onOnlyInclude', this.rank, 'tag', 'onlyinclude');
	}
};

OnlyInclude.prototype.onOnlyInclude = function(token, manager) {
	var tsr = token.dataAttribs.tsr;
	var src = !this.options.inTemplate ? token.getWTSource(manager.env) : undefined;
	var attribs = [
		new KV('typeof', 'mw:Includes/OnlyInclude' + (token instanceof EndTagTk ? '/End' : '')),
	];
	var meta = new SelfclosingTagTk('meta', attribs, { tsr: tsr, src: src });
	return { token: meta };
};

OnlyInclude.prototype.onAnyInclude = function(token, manager) {
	var isTag, tagName, curriedBuildMetaToken, meta;

	if (token.constructor === EOFTk) {
		this.inOnlyInclude = false;
		if (this.accum.length && !this.foundOnlyInclude) {
			var res = this.accum;
			res.push(token);
			this.accum = [];
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

	if (isTag) {
		switch (token.name) {
			case 'onlyinclude':
				tagName = 'mw:Includes/OnlyInclude';
				break;
			case 'includeonly':
				tagName = 'mw:Includes/IncludeOnly';
				break;
			case 'noinclude':
				tagName = 'mw:Includes/NoInclude';
		}
	}

	curriedBuildMetaToken = buildMetaToken.bind(null, manager, tagName);

	if (isTag && token.name === 'onlyinclude') {
		if (!this.inOnlyInclude) {
			this.foundOnlyInclude = true;
			this.inOnlyInclude = true;
			// wrap collected tokens into meta tag for round-tripping
			meta = curriedBuildMetaToken(token.constructor === EndTagTk, (token.dataAttribs || {}).tsr);
			return meta;
		} else {
			this.inOnlyInclude = false;
			meta = curriedBuildMetaToken(token.constructor === EndTagTk, (token.dataAttribs || {}).tsr);
		}
		// meta.rank = this.rank;
		return { token: meta };
	} else {
		if (this.inOnlyInclude) {
			// token.rank = this.rank;
			return { token: token };
		} else {
			this.accum.push(token);
			return { };
		}
	}
};


/**
 * @class
 * @extends TokenCollector
 * @constructor
 */
function NoInclude() {
	TokenCollector.apply(this, arguments);
}
coreutil.inherits(NoInclude, TokenCollector);

// Very early in stage 1, to avoid any further processing.
NoInclude.prototype.rank = 0.02;
NoInclude.prototype.type = 'tag';
NoInclude.prototype.name = 'noinclude';
// Match the end-of-input if </noinclude> is missing.
NoInclude.prototype.toEnd = true;
NoInclude.prototype.ackEnd = true;

NoInclude.prototype.transformation = function(collection) {
	var start = collection.shift();

	// A stray end tag.
	if (start.constructor === EndTagTk) {
		var meta = buildMetaToken(this.manager, 'mw:Includes/NoInclude', true,
			(start.dataAttribs || {}).tsr);
		return { tokens: [ meta ] };
	}

	// Handle self-closing tag case specially!
	if (start.constructor === SelfclosingTagTk) {
		return (this.options.isInclude) ?
			{ tokens: [] } :
			{ tokens: [ buildMetaToken(this.manager, 'mw:Includes/NoInclude', false, (start.dataAttribs || {}).tsr) ] };
	}

	var tokens = [];
	var end = collection.pop();
	var eof = end.constructor === EOFTk;

	if (!this.options.isInclude) {
		// Content is preserved
		// Add meta tags for open and close
		var curriedBuildMetaToken = buildMetaToken.bind(null, this.manager,
			'mw:Includes/NoInclude');
		var startTSR = start && start.dataAttribs && start.dataAttribs.tsr;
		var endTSR = end && end.dataAttribs && end.dataAttribs.tsr;
		tokens.push(curriedBuildMetaToken(false, startTSR));
		tokens = tokens.concat(collection);
		if (end && !eof) {
			tokens.push(curriedBuildMetaToken(true, endTSR));
		}
	} else if (this.options.wrapTemplates) {
		// Content is stripped
		tokens.push(buildStrippedMetaToken(this.manager,
			'mw:Includes/NoInclude', start, end));
	}

	// Preserve EOF
	if (eof) {
		tokens.push(end);
	}

	return { tokens: tokens };
};


/**
 * @class
 * @extends TokenCollector
 * @constructor
 */
function IncludeOnly() {
	TokenCollector.apply(this, arguments);
}
coreutil.inherits(IncludeOnly, TokenCollector);

// Very early in stage 1, to avoid any further processing.
IncludeOnly.prototype.rank = 0.03;
IncludeOnly.prototype.type = 'tag';
IncludeOnly.prototype.name = 'includeonly';
// Match the end-of-input if </includeonly> is missing.
IncludeOnly.prototype.toEnd = true;
IncludeOnly.prototype.ackEnd = false;  // FIXME: That right?!

IncludeOnly.prototype.transformation = function(collection) {
	var start = collection.shift();

	// Handle self-closing tag case specially!
	if (start.constructor === SelfclosingTagTk) {
		return (this.options.isInclude) ?
			{ tokens: [] } :
			{ tokens: [ buildMetaToken(this.manager, 'mw:Includes/IncludeOnly', false, (start.dataAttribs || {}).tsr) ] };
	}

	var tokens = [];
	var end = collection.pop();
	var eof = end.constructor === EOFTk;

	if (this.options.isInclude) {
		// Just pass through the full collection including delimiters
		tokens = tokens.concat(collection);
	} else if (this.options.wrapTemplates) {
		// Content is stripped
		// Add meta tags for open and close for roundtripping.
		//
		// We can make do entirely with a single meta-tag since
		// there is no real content.  However, we add a dummy end meta-tag
		// so that all <*include*> meta tags show up in open/close pairs
		// and can be handled similarly by downstream handlers.
		var name = 'mw:Includes/IncludeOnly';
		tokens.push(buildStrippedMetaToken(this.manager, name, start, eof ? null : end));
		if (end && !eof) {
			// This token is just a placeholder for RT purposes. Since the
			// stripped token (above) got the entire tsr value, we are artificially
			// setting the tsr on this node to zero-width to ensure that
			// DSR computation comes out correct.
			var tsr = (end.dataAttribs || {tsr: [null, null]}).tsr;
			tokens.push(buildMetaToken(this.manager, name, true, [tsr[1], tsr[1]], ''));
		}
	}

	// Preserve EOF
	if (eof) {
		tokens.push(end);
	}

	return { tokens: tokens };
};


if (typeof module === "object") {
	module.exports.NoInclude = NoInclude;
	module.exports.IncludeOnly = IncludeOnly;
	module.exports.OnlyInclude = OnlyInclude;
}
