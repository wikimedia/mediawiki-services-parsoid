/**
 * Simple noinclude / onlyinclude implementation. Strips all tokens in
 * noinclude sections.
 * @module
 */

'use strict';

const TokenHandler = require('./TokenHandler.js');
const { TokenCollector } = require('./TokenCollector.js');
const { KV, TagTk, EndTagTk, SelfclosingTagTk, EOFTk } = require('../../tokens/TokenTypes.js');

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
		tsr ? { tsr: tsr, src: manager.frame.srcText.substring(tsr[0], tsr[1]) } : { src: src }
	);
};

var buildStrippedMetaToken = function(manager, tokenName, startDelim, endDelim) {
	var da = startDelim.dataAttribs;
	var tsr0 = da ? da.tsr : null;
	var t0 = tsr0 ? tsr0[0] : null;
	var t1;

	if (endDelim) {
		da = endDelim.dataAttribs || null;
		var tsr1 = da ? da.tsr : null;
		t1 = tsr1 ? tsr1[1] : null;
	} else {
		t1 = manager.frame.srcText.length;
	}

	return buildMetaToken(manager, tokenName, false, [t0, t1]);
};


/**
 * OnlyInclude sadly forces synchronous template processing, as it needs to
 * hold onto all tokens in case an onlyinclude block is encountered later.
 * This can fortunately be worked around by caching the tokens after
 * onlyinclude processing (which is a good idea anyway).
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class OnlyInclude extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		if (this.options.isInclude) {
			this.accum = [];
			this.inOnlyInclude = false;
			this.foundOnlyInclude = false;
		}
	}

	onAny(token) {
		return this.options.isInclude ? this.onAnyInclude(token) : token;
	}

	onTag(token) {
		return !this.options.isInclude && token.name === 'onlyinclude' ? this.onOnlyInclude(token) : token;
	}

	onOnlyInclude(token) {
		var tsr = token.dataAttribs.tsr;
		var src = !this.options.inTemplate ? token.getWTSource(this.manager.frame) : undefined;
		var attribs = [
			new KV('typeof', 'mw:Includes/OnlyInclude' + (token instanceof EndTagTk ? '/End' : '')),
		];
		var meta = new SelfclosingTagTk('meta', attribs, { tsr: tsr, src: src });
		return { tokens: [ meta ] };
	}

	onAnyInclude(token) {
		var tagName, isTag, meta;

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
				return { tokens: [ token ] };
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
					break;
			}
		}

		var mgr = this.manager;
		var curriedBuildMetaToken = function(isEnd, tsr, src) {
			return buildMetaToken(mgr, tagName, isEnd, tsr, src);
		};

		if (isTag && token.name === 'onlyinclude') {
			if (!this.inOnlyInclude) {
				this.foundOnlyInclude = true;
				this.inOnlyInclude = true;
				// wrap collected tokens into meta tag for round-tripping
				meta = curriedBuildMetaToken(token.constructor === EndTagTk, (token.dataAttribs || {}).tsr);
			} else {
				this.inOnlyInclude = false;
				meta = curriedBuildMetaToken(token.constructor === EndTagTk, (token.dataAttribs || {}).tsr);
			}
			return { tokens: [ meta ] };
		} else {
			if (this.inOnlyInclude) {
				return { tokens: [ token ] };
			} else {
				this.accum.push(token);
				return { };
			}
		}
	}
}

/**
 * @class
 * @extends module:wt2html/tt/TokenCollector~TokenCollector
 */
class NoInclude extends TokenCollector {
	TYPE() { return 'tag'; }
	NAME() { return 'noinclude'; }
	TOEND() { return true; }  // Match the end-of-input if </noinclude> is missing.
	ACKEND() { return true; }

	transformation(collection) {
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
			var manager = this.manager;
			var curriedBuildMetaToken = function(isEnd, tsr, src) {
				return buildMetaToken(manager, 'mw:Includes/NoInclude', isEnd, tsr, src);
			};
			var startTSR = start && start.dataAttribs && start.dataAttribs.tsr;
			var endTSR = end && end.dataAttribs && end.dataAttribs.tsr;
			tokens.push(curriedBuildMetaToken(false, startTSR));
			tokens = tokens.concat(collection);
			if (end && !eof) {
				tokens.push(curriedBuildMetaToken(true, endTSR));
			}
		} else if (!this.options.inTemplate) {
			// Content is stripped
			tokens.push(buildStrippedMetaToken(this.manager,
				'mw:Includes/NoInclude', start, eof ? null : end));
		}

		// Preserve EOF
		if (eof) {
			tokens.push(end);
		}

		return { tokens: tokens };
	}
}

/**
 * @class
 * @extends module:wt2html/tt/TokenCollector~TokenCollector
 */
class IncludeOnly extends TokenCollector {
	TYPE() { return 'tag'; }
	NAME() { return 'includeonly'; }
	TOEND() { return true; }  // Match the end-of-input if </includeonly> is missing.
	ACKEND() { return false; }

	transformation(collection) {
		var start = collection.shift();

		// Handle self-closing tag case specially!
		if (start.constructor === SelfclosingTagTk) {
			var token = buildMetaToken(this.manager, 'mw:Includes/IncludeOnly', false, (start.dataAttribs || {}).tsr);
			if (start.dataAttribs.src) {
				var datamw = JSON.stringify({ src: start.dataAttribs.src });
				token.addAttribute('data-mw', datamw);
			}
			return (this.options.isInclude) ?
				{ tokens: [] } :
				{ tokens: [token] };
		}

		var tokens = [];
		var end = collection.pop();
		var eof = end.constructor === EOFTk;

		if (this.options.isInclude) {
			// Just pass through the full collection including delimiters
			tokens = tokens.concat(collection);
		} else if (!this.options.inTemplate) {
			// Content is stripped
			// Add meta tags for open and close for roundtripping.
			//
			// We can make do entirely with a single meta-tag since
			// there is no real content.  However, we add a dummy end meta-tag
			// so that all <*include*> meta tags show up in open/close pairs
			// and can be handled similarly by downstream handlers.
			var name = 'mw:Includes/IncludeOnly';
			tokens.push(buildStrippedMetaToken(this.manager, name, start, eof ? null : end));

			if (start.dataAttribs.src) {
				var dataMw = JSON.stringify({ src: start.dataAttribs.src });
				tokens[0].addAttribute('data-mw', dataMw);
			}

			if (end && !eof) {
				// This token is just a placeholder for RT purposes. Since the
				// stripped token (above) got the entire tsr value, we are artificially
				// setting the tsr on this node to zero-width to ensure that
				// DSR computation comes out correct.
				var tsr = (end.dataAttribs || { tsr: [null, null] }).tsr;
				tokens.push(buildMetaToken(this.manager, name, true, [tsr[1], tsr[1]], ''));
			}
		}

		// Preserve EOF
		if (eof) {
			tokens.push(end);
		}

		return { tokens: tokens };
	}
}

if (typeof module === "object") {
	module.exports.NoInclude = NoInclude;
	module.exports.IncludeOnly = IncludeOnly;
	module.exports.OnlyInclude = OnlyInclude;
}
