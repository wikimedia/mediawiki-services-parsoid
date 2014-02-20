"use strict";

var Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	defines = require('./mediawiki.parser.defines.js');

// define some constructor shortcuts
var CommentTk = defines.CommentTk,
    TagTk = defines.TagTk,
    EOFTk = defines.EOFTk,
    SelfclosingTagTk = defines.SelfclosingTagTk,
    EndTagTk = defines.EndTagTk;

function DOMFragmentBuilder( manager, options ) {
	this.manager = manager;
	this.manager.addTransform(
		this.buildDOMFragment.bind( this ),
		"buildDOMFragment",
		this.scopeRank,
		'tag',
		'mw:dom-fragment-token'
	);
}

DOMFragmentBuilder.prototype.scopeRank = 1.99;

/**
 * Can/should content represented in 'toks' be processed in its own DOM scope?
 * 1. No reason to spin up a new pipeline for plain text
 * 2. In some cases, if templates need not be nested entirely within the
 *    boundary of the token, we cannot process the contents in a new scope.
 */
DOMFragmentBuilder.prototype.subpipelineUnnecessary = function(toks, contextTok) {
	for (var i = 0, n = toks.length; i < n; i++) {
		var t = toks[i],
			tc = t.constructor;

		// For wikilinks and extlinks, templates should be properly nested
		// in the content section. So, we can process them in sub-pipelines.
		// But, for other context-toks, we back out. FIXME: Can be smarter and
		// detect proper template nesting, but, that can be a later enhancement
		// when dom-scope-tokens are used in other contexts.
		if (contextTok && contextTok.name !== 'wikilink' && contextTok.name !== 'extlink' &&
			tc === SelfclosingTagTk &&
			t.name === 'meta' && t.getAttribute("typeof") === "mw:Transclusion")
		{
			return true;
		} else if (tc === TagTk || tc === EndTagTk || tc === SelfclosingTagTk) {
			// Since we encountered a complex token, we'll process this
			// in a subpipeline.
			return false;
		}
	}

	// No complex tokens at all -- no need to spin up a new pipeline
	return true;
};

DOMFragmentBuilder.prototype.buildDOMFragment = function(scopeToken, frame, cb) {
	var content = scopeToken.getAttribute("content");
	if (this.subpipelineUnnecessary(content, scopeToken.getAttribute('contextTok'))) {
		// New pipeline not needed. Pass them through
		cb({tokens: content, async: false});
	} else {
		// First thing, signal that the results will be available asynchronously
		cb({async:true});

		// Source offsets of content
		var srcOffsets = scopeToken.getAttribute("srcOffsets");

		// Process tokens
		Util.processContentInPipeline(
			this.manager.env,
			this.manager.frame,
			// Append EOF
			content.concat([new EOFTk()]),
			{
				pipelineType: "tokens/x-mediawiki/expanded",
				pipelineOpts: {
					inBlockToken: true,
					noPre: scopeToken.getAttribute('noPre'),
					// Without source offsets for the content, it isn't possible to
					// compute DSR and template wrapping in content. So, users of
					// mw:dom-fragment-token should always set offsets on content
					// that comes from the top-level document.
					wrapTemplates: !!srcOffsets
				},
				srcOffsets: srcOffsets,
				documentCB: this.wrapDOMFragment.bind(this, cb, scopeToken)
			}
		);
	}
};

DOMFragmentBuilder.prototype.wrapDOMFragment = function(cb, scopeToken, dom) {
	var toks = DU.buildDOMFragmentTokens(this.manager.env, scopeToken, dom);

	// Nothing more to send cb after this
	cb({tokens: toks, async:false});
};

if (typeof module === "object") {
	module.exports.DOMFragmentBuilder = DOMFragmentBuilder;
}
