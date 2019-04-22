/** @module */

'use strict';

const TokenHandler = require('./TokenHandler.js');
const { PipelineUtils } = require('../../utils/PipelineUtils.js');
const { TagTk, EOFTk, SelfclosingTagTk, EndTagTk } = require('../../tokens/TokenTypes.js');

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class DOMFragmentBuilder extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		this.manager.addTransform(
			(scopeToken, cb) => this.buildDOMFragment(scopeToken, cb),
			'buildDOMFragment',
			DOMFragmentBuilder.scopeRank(),
			'tag',
			'mw:dom-fragment-token'
		);
	}

	static scopeRank() { return 1.99; }

	/**
     * Can/should content represented in 'toks' be processed in its own DOM scope?
	 * 1. No reason to spin up a new pipeline for plain text
	 * 2. In some cases, if templates need not be nested entirely within the
	 *    boundary of the token, we cannot process the contents in a new scope.
	 */
	subpipelineUnnecessary(toks, contextTok) {
		for (let i = 0, n = toks.length; i < n; i++) {
			const t = toks[i];
			const tc = t.constructor;

			// For wikilinks and extlinks, templates should be properly nested
			// in the content section. So, we can process them in sub-pipelines.
			// But, for other context-toks, we back out. FIXME: Can be smarter and
			// detect proper template nesting, but, that can be a later enhancement
			// when dom-scope-tokens are used in other contexts.
			if (contextTok && contextTok.name !== 'wikilink' && contextTok.name !== 'extlink' &&
				tc === SelfclosingTagTk &&
				t.name === 'meta' && t.getAttribute("typeof") === "mw:Transclusion") {
				return true;
			} else if (tc === TagTk || tc === EndTagTk || tc === SelfclosingTagTk) {
				// Since we encountered a complex token, we'll process this
				// in a subpipeline.
				return false;
			}
		}

		// No complex tokens at all -- no need to spin up a new pipeline
		return true;
	}

	buildDOMFragment(scopeToken, cb) {
		const contentKV = scopeToken.getAttributeKV("content");
		const content = contentKV.v;
		if (this.subpipelineUnnecessary(content, scopeToken.getAttribute('contextTok'))) {
			// New pipeline not needed. Pass them through
			cb({ tokens: typeof content === "string" ? [content] : content, async: false });
		} else {
			// First thing, signal that the results will be available asynchronously
			cb({ async: true });

			// Source offsets of content
			const srcOffsets = contentKV.srcOffsets;

			// Without source offsets for the content, it isn't possible to
			// compute DSR and template wrapping in content. So, users of
			// mw:dom-fragment-token should always set offsets on content
			// that comes from the top-level document.
			console.assert(
				this.options.inTemplate || !!srcOffsets,
				"Processing top-level content without source offsets"
			);

			const pipelineOpts = {
				inlineContext: scopeToken.getAttribute('inlineContext'),
				inPHPBlock: scopeToken.getAttribute('inPHPBlock'),
				expandTemplates: this.options.expandTemplates,
				inTemplate: this.options.inTemplate,
			};

			// Process tokens
			PipelineUtils.processContentInPipeline(
				this.manager.env,
				this.manager.frame,
				// Append EOF
				content.concat([new EOFTk()]),
				{
					pipelineType: "tokens/x-mediawiki/expanded",
					pipelineOpts: pipelineOpts,
					srcOffsets: srcOffsets.slice(2, 4),
					documentCB: dom => this.wrapDOMFragment(cb, scopeToken, pipelineOpts, dom),
					sol: true,
				}
			);
		}
	}

	wrapDOMFragment(cb, scopeToken, pipelineOpts, dom) {
		// Pass through pipeline options
		const toks = PipelineUtils.tunnelDOMThroughTokens(this.manager.env, scopeToken, dom.body, {
			pipelineOpts,
		});

		// Nothing more to send cb after this
		cb({ tokens: toks, async: false });
	}
}

if (typeof module === "object") {
	module.exports.DOMFragmentBuilder = DOMFragmentBuilder;
}
