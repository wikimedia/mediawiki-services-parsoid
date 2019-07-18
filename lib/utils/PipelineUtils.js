/**
 * This file contains parsing pipeline related utilities.
 *
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var JSUtils = require('./jsutils.js').JSUtils;
var Promise = require('./promise.js');
var Util = require('./Util.js').Util;
var TokenUtils = require('./TokenUtils.js').TokenUtils;
const { ContentUtils } = require('./ContentUtils.js');
const { DOMDataUtils } = require('./DOMDataUtils.js');
const { DOMUtils } = require('./DOMUtils.js');
const { WTUtils } = require('./WTUtils.js');
const { KV, TagTk, EndTagTk, SelfclosingTagTk, EOFTk, CommentTk } = require('../tokens/TokenTypes.js');
const tu = require('../wt2html/tokenizer.utils.js');

/**
 * @namespace
 */
var PipelineUtils = {
	/**
	 * Creates a dom-fragment-token for processing 'content' (an array of tokens)
	 * in its own subpipeline all the way to DOM. These tokens will be processed
	 * by their own handler (DOMFragmentBuilder) in the last stage of the async
	 * pipeline.
	 *
	 * srcOffsets should always be provided to process top-level page content in a
	 * subpipeline. Without it, DSR computation and template wrapping cannot be done
	 * in the subpipeline. While unpackDOMFragment can do this on unwrapping, that can
	 * be a bit fragile and makes dom-fragments a leaky abstraction by leaking subpipeline
	 * processing into the top-level pipeline.
	 *
	 * @param {Token[]|string} content
	 *   The array of tokens to process.
	 * @param {number[]} srcOffsets
	 *   Wikitext source offsets (start/end) of these tokens.
	 * @param {Object} [opts]
	 *   Parsing options.
	 * @param {Token} opts.contextTok
	 *   The token that generated the content.
	 * @param {boolean} opts.inlineContext
	 *   Is this DOM fragment used in an inline context?
	 * @param {boolean} opts.inPHPBlock
	 *   Is this DOM fragment used inside a "PHP Block"
	 *   FIXME: This primarily exists for backward compatibility
	 *   reasons and is likely to eventually go away.
	 */
	getDOMFragmentToken: function(content, srcOffsets, opts) {
		if (!opts) {
			opts = {};
		}

		return new SelfclosingTagTk('mw:dom-fragment-token', [
			new KV('contextTok', opts.token, tu.expandTsrV(opts.token.dataAttribs.tsr)),
			new KV('content', content, tu.expandTsrV(srcOffsets)),
			new KV('inlineContext',  opts.inlineContext || false),
			new KV('inPHPBLock',  opts.inPHPBLock || false),
		]);
	},

	/**
	 * Processes content (wikitext, array of tokens, whatever) in its own pipeline
	 * based on options.
	 *
	 * @param {MWParserEnvironment} env
	 *    The environment/context for the expansion.
	 *
	 * @param {Object} frame
	 *    The parent frame within which the expansion is taking place.
	 *    This param is mostly defunct now that we are not doing native
	 *    expansion anymore.
	 *
	 * @param {Object} content
	 *    This could be wikitext or single token or an array of tokens.
	 *    How this content is processed depends on what kind of pipeline
	 *    is constructed specified by opts.
	 *
	 * @param {Object} opts
	 *    Processing options that specify pipeline-type, opts, and callbacks.
	 * @param {string} opts.pipelineType
	 * @param {Object} opts.pipelineOpts
	 * @param {Object} [opts.tplArgs]
	 * @param {string} opts.tplArgs.name
	 * @param {Title} opts.tplArgs.title
	 * @param {Array} opts.tplArgs.attribs
	 * @param {Array} [opts.srcOffsets]
	 * @param {Function} [opts.chunkCB]
	 * @param {Function} [opts.endCB]
	 * @param {Function} [opts.documentCB]
	 * @param {boolean} opts.sol
	 */
	processContentInPipeline: function(env, frame, content, opts) {
		// Build a pipeline
		var pipeline = env.pipelineFactory.getPipeline(
			opts.pipelineType,
			opts.pipelineOpts
		);

		// Set frame if necessary
		const srcText = opts.srcText || frame.srcText;
		console.assert(typeof (srcText) === 'string');
		if (opts.tplArgs) {
			pipeline.setFrame(frame, opts.tplArgs.title, opts.tplArgs.attribs, srcText);
		} else {
			pipeline.setFrame(frame, null, [], srcText);
		}

		// Set source offsets for this pipeline's content
		if (opts.srcOffsets) {
			console.assert(Array.isArray(opts.srcOffsets) && opts.srcOffsets.length === 2);
			pipeline.setSourceOffsets(opts.srcOffsets[0], opts.srcOffsets[1]);
		}

		// Set up provided callbacks
		if (opts.chunkCB) {
			pipeline.addListener('chunk', opts.chunkCB);
		}
		if (opts.endCB) {
			pipeline.addListener('end', opts.endCB);
		}
		if (opts.documentCB) {
			pipeline.addListener('document', opts.documentCB);
		}

		// Off the starting block ... ready, set, go!
		pipeline.process(content, opts.sol);
	},

	/**
	 * A promise returning wrapper around processContentInPipeline that
	 * resolves with the docuemnt.
	 *
	 * @param {MWParserEnvironment} env
	 *    The environment/context for the expansion.
	 *
	 * @param {Object} frame
	 *    The parent frame within which the expansion is taking place.
	 *    This param is mostly defunct now that we are not doing native
	 *    expansion anymore.
	 *
	 * @param {Object} content
	 *    This could be wikitext or single token or an array of tokens.
	 *    How this content is processed depends on what kind of pipeline
	 *    is constructed specified by opts.
	 *
	 * @param {Object} opts
	 *    Processing options that specify pipeline-type, opts, and callbacks.
	 * @param {string} opts.pipelineType
	 * @param {Object} opts.pipelineOpts
	 * @param {Object} [opts.tplArgs]
	 * @param {string} opts.tplArgs.name
	 * @param {Array} opts.tplArgs.attribs
	 * @param {Array} [opts.srcOffsets]
	 * @param {boolean} opts.sol
	 * @return {Promise<Document>}
	 */
	promiseToProcessContent: function(env, frame, content, opts, cb) {
		cb = JSUtils.mkPromised(cb);
		// FIXME: refactor these, so that Promise.async style is default
		// (with proper error handling) and the three-callback
		// style is built on top of that.
		PipelineUtils.processContentInPipeline(
			env, frame, content,
			Object.assign({}, opts, {
				// processContentInPipeline has no error callback :(
				documentCB: dom => cb(null, dom),
			})
		);
		return cb.promise;
	},

	/**
	 * Expands value all the way to DOM and pass it back to a callback.
	 *
	 * FIXME: More of the users of `PipelineUtils.promiseToProcessContent` and
	 * `PipelineUtils.processContentInPipeline` could be converted to use this method
	 * if we could find a good way to abstract the different use cases.
	 *
	 * @param {Object} env
	 *    The environment/context for the expansion.
	 *
	 * @param {Object} frame
	 *    The parent frame within which the expansion is taking place.
	 *    This param is mostly defunct now that we are not doing native
	 *    expansion anymore.
	 *
	 * @param {Object[]} v
	 *    The value to process.
	 *    The value is expected to be an object with a "html" property.
	 *    The html property is expanded to DOM only if it is an array (of tokens).
	 *    Non-arrays are passed back unexpanded.
	 *
	 * @param {boolean} expandTemplates
	 *    Should any templates encountered here be expanded
	 *    (usually false for nested templates since they are never directly editable).
	 *
	 * @param {boolean} inTemplate
	 *    Unexpanded templates can occur in the content of extension tags.
	 *
	 * @return {Promise}
	 *    A promise that will be resolved with the expanded values.
	 */
	expandValueToDOM: Promise.async(function *(env, frame, v, expandTemplates, inTemplate) {
		if (Array.isArray(v.html)) {
			// Set up pipeline options
			var opts = {
				pipelineType: 'tokens/x-mediawiki/expanded',
				pipelineOpts: {
					attrExpansion: true,
					inlineContext: true,
					expandTemplates: expandTemplates,
					inTemplate: inTemplate,
				},
				srcOffsets: v.srcOffsets,
				sol: true,
			};
			var content = v.html.concat([new EOFTk()]);
			try {
				var dom = yield PipelineUtils.promiseToProcessContent(
					env, frame, content, opts
				);
				// Since we aren't at the top level, data attrs
				// were not applied in cleanup.  However, tmp
				// was stripped.
				v.html = ContentUtils.ppToXML(dom.body, { innerXML: true });
			} catch (err) {
				env.log('error', 'Expanding values to DOM', err);
			}
		}
		// Remove srcOffsets after value is expanded, so they don't show
		// up in the output data-mw attribute
		v.srcOffsets = undefined;
		return v;
	}),

	/**
	 * See `expandValueToDOM` above.
	 */
	expandValuesToDOM: function(env, frame, vals, expandTemplates, inTemplate) {
		return Promise.all(vals.map((v) => {
			return PipelineUtils.expandValueToDOM(env, frame, v, expandTemplates, inTemplate);
		}));
	},

	/**
	 * @param {Token[]} tokBuf This is where the tokens get stored.
	 */
	convertDOMtoTokens: function(tokBuf, node) {
		function domAttrsToTagAttrs(attrs) {
			var out = [];
			for (var j = 0, m = attrs.length; j < m; j++) {
				var a = attrs.item(j);
				// Not super important since they'll be overwritten in prepareDOM.js
				if (!['data-parsoid', DOMDataUtils.DataObjectAttrName()].includes(a.name)) {
					out.push(new KV(a.name, a.value));
				}
			}
			return { attrs: out, dataAttrs: DOMDataUtils.getDataParsoid(node) };
		}

		switch (node.nodeType) {
			case node.ELEMENT_NODE:
				var nodeName = node.nodeName.toLowerCase();
				var attrInfo = domAttrsToTagAttrs(node.attributes);

				if (Util.isVoidElement(nodeName)) {
					tokBuf.push(new SelfclosingTagTk(nodeName, attrInfo.attrs, attrInfo.dataAttrs));
				} else {
					tokBuf.push(new TagTk(nodeName, attrInfo.attrs, attrInfo.dataAttrs));
					for (var child = node.firstChild; child; child = child.nextSibling) {
						tokBuf = PipelineUtils.convertDOMtoTokens(tokBuf, child);
					}
					var endTag = new EndTagTk(nodeName);
					// Keep stx parity
					if (WTUtils.isLiteralHTMLNode(node)) {
						endTag.dataAttribs = { 'stx': 'html' };
					}
					tokBuf.push(endTag);
				}
				break;

			case node.TEXT_NODE:
				tokBuf = tokBuf.concat(TokenUtils.newlinesToNlTks(node.nodeValue));
				break;

			case node.COMMENT_NODE:
				tokBuf.push(new CommentTk(node.nodeValue));
				break;

			default:
				console.warn("Unhandled node type: " + node.outerHTML);
				break;
		}
		return tokBuf;
	},

	/**
	 * Get tokens representing a DOM forest (from transclusions, extensions,
	 * whatever that were generated as part of a separate processing pipeline)
	 * in the token stream. These tokens will tunnel the subtree through the
	 * token processing while preserving token stream semantics as if
	 * the DOM had been converted to tokens.
	 *
	 * @param {Node[]} nodes List of DOM nodes that need to be tunneled through.
	 * @param {Object} opts
	 *    See encapsulateExpansionHTML's doc. for more info about these options.
	 * @return {Array} List of token representatives.
	 */
	getWrapperTokens: function(nodes, opts) {
		if (!nodes.length) {
			return [new TagTk('span'), new EndTagTk('span')];
		}

		var node = nodes[0];

		// Do we represent this with inline or block elements?
		// This is to ensure that we get p-wrapping correct.
		//
		// * If all content is inline, we use inline-elements to represent this
		//   so that this content gets swallowed into the P tag that wraps
		//   adjacent inline content.
		//
		// * If any part of this is a block content, we treat extension content
		//   independent of surrounding content and don't want inline content
		//   here to be swallowed into a P tag that wraps adjacent inline content.
		//
		// This behavior ensures that we and clients can "drop-in" extension content
		// into the DOM without messing with fixing up paragraph tags of surrounding
		// content. It could potentially introduce minor rendering differences when
		// compared to PHP parser output, but we'll swallow it for now.
		var wrapperType = 'INLINE';
		if (opts.pipelineOpts && (opts.pipelineOpts.inlineContext || opts.pipelineOpts.inPHPBlock)) {
			// If the DOM fragment is being processed in the context where P wrapping
			// has been suppressed, we represent the DOM fragment with inline-tokens.
			//
			// FIXME(SSS): Looks like we have some "impedance mismatch" here. But, this
			// is correct in scenarios where link-content or image-captions are being
			// processed in a sub-pipeline and we don't want a <div> in the link-caption
			// to cause the <a>..</a> to get split apart.
			//
			// Filed as T49963
		} else if (opts.sealFragment) {
			// Sealed fragments aren't amenable to inspection, since the
			// ultimate content is unknown.  For example, refs shuttle content
			// through treebuilding that ends up in the references list.
			//
			// FIXME(arlolra): Do we need a mechanism to specify content
			// categories?
		} else {
			for (var i = 0; i < nodes.length; i++) {
				if (DOMUtils.isBlockNode(nodes[i]) || DOMUtils.hasBlockElementDescendant(nodes[i])) {
					wrapperType = 'BLOCK';
					break;
				}
			}
		}

		var wrapperName;
		if (wrapperType === 'BLOCK' && !DOMUtils.isBlockNode(node)) {
			wrapperName = 'DIV';
		} else if (node.nodeName === 'A') {
			// Do not use 'A' as a wrapper node because it could
			// end up getting nested inside another 'A' and the DOM
			// structure can change where the wrapper tokens are no
			// longer siblings.
			// Ex: "[http://foo.com Bad nesting [[Here]]].
			wrapperName = 'SPAN';
		} else if (['STYLE', 'SCRIPT'].includes(node.nodeName) && nodes.length > 1) {
			// <style>/<script> tags are not fostered, so if we're wrapping
			// more than a single node, they aren't a good representation for
			// the content.  It can lead to fosterable content being inserted
			// in a fosterable position after treebuilding is done, which isn't
			// roundtrippable.
			wrapperName = 'SPAN';
		} else if (!DOMUtils.isElt(node)) {
			wrapperName = 'SPAN';
		} else {
			wrapperName = node.nodeName;
		}

		// Assumed to only be called on nodes that have had data
		// attributes stored.
		if (DOMUtils.isElt(node)) {
			console.assert(!node.hasAttribute(DOMDataUtils.DataObjectAttrName()));
		}

		var workNode;
		if (!DOMUtils.isElt(node)) {
			workNode = node.ownerDocument.createElement(wrapperName);
		} else if (wrapperName !== node.nodeName) {
			// Create a copy of the node without children
			workNode = node.ownerDocument.createElement(wrapperName);
			// Copy over attributes
			for (var j = 0; j < node.attributes.length; j++) {
				var attribute = node.attributes.item(j);
				// "typeof" is ignored since it'll be remove below.
				// "data-parsoid" will be overwritten with `dataAttribs` when
				// the token gets to the tree builder, so skip it.  It's
				// present on the `node` since it has already had its data
				// attributes stored.
				if (!['typeof', 'data-parsoid'].includes(attribute.name)) {
					workNode.setAttribute(attribute.name, attribute.value);
				}
			}
		} else {
			// Shallow clone since we don't want to convert the whole tree
			// to tokens.
			workNode = node.clone(false);

			// dataAttribs are not copied over so that we don't inject
			// broken tsr or dsr values. This also lets these tokens pass
			// through the sanitizer as stx.html is not set.
			//
			// FIXME(arlolra): Presumably, the tsr/dsr portion of the above
			// comment is with respect to the case where the child nodes are
			// being dropped.  The stx part though is suspect considering
			// below where `workNode` is set to the `node` that information
			// would be preserved.
			//
			// We've filed T204279 to look into all this, but for now we'll do
			// the safe thing and preserve dataAttribs where it makes sense.
			//
			// As indicated above, data attributes have already been stored
			// for `node` so we need to peel them off for the purpose of
			// cloning.
			const storedDp = DOMDataUtils.getJSONAttribute(node, 'data-parsoid', {});
			storedDp.tsr = undefined;
			DOMDataUtils.setDataParsoid(workNode, storedDp);
		}

		var tokens = [];
		PipelineUtils.convertDOMtoTokens(tokens, workNode);

		// Remove the typeof attribute from the first token.
		// It will be replaced with mw:DOMFragment.
		tokens[0].removeAttribute('typeof');
		// Remove the about attribute from the first token.
		// We want to be able to distinguish when this wrapper was template
		// annotated.
		tokens[0].removeAttribute('about');

		return tokens;
	},

	/**
	 * Generates wrapper tokens for a HTML expansion -- the wrapper
	 * tokens are placeholders that adequately represent semantics
	 * of the HTML DOM for the purposes of additional token transformations
	 * that will be applied to them.
	 *
	 * @param {MWParserEnvironment} env
	 *    The active environment/context.
	 *
	 * @param {Token} token
	 *    The token that generated the DOM.
	 *
	 * @param {Object} expansion
	 * @param {string} expansion.html
	 *    HTML of the expansion.
	 * @param {Node[]} expansion.nodes
	 *    Outermost nodes of the HTML.
	 *
	 * @param {Object} [opts]
	 * @param {Object} opts.tsr
	 *    The TSR to set on the generated tokens. This TSR is
	 *    used to compute DSR on the placeholder tokens.
	 *    The computed DSR is transferred over to the unpacked DOM
	 *    if setDSR is true (see below).
	 * @param {boolean} opts.setDSR
	 *    When the DOM fragment is unpacked, this option governs
	 *    whether the DSR from the placeholder node is transferred
	 *    over to the unpacked DOM or not.
	 *    For example: Cite, reused transclusions.
	 * @param {boolean} opts.fromCache
	 * @param {Object} opts.pipelineOpts
	 * @param {boolean} opts.sealFragment
	 * @param {string} opts.wrapperName
	 */
	encapsulateExpansionHTML: function(env, token, expansion, opts) {
		opts = opts || {};

		// Get placeholder tokens to get our subdom through the token processing
		// stages. These will be finally unwrapped on the DOM.
		var toks = PipelineUtils.getWrapperTokens(expansion.nodes, opts);
		var firstWrapperToken = toks[0];

		// Add the DOMFragment type so that we get unwrapped later.
		firstWrapperToken.setAttribute('typeof', 'mw:DOMFragment' + (opts.sealFragment ? '/sealed/' + opts.wrapperName : ''));

		// Assign the HTML fragment to the data-parsoid.html on the first wrapper token.
		firstWrapperToken.dataAttribs.html = expansion.html;

		// Pass through setDSR flag
		if (opts.setDSR) {
			if (!firstWrapperToken.dataAttribs.tmp) {
				firstWrapperToken.dataAttribs.tmp = {};
			}
			firstWrapperToken.dataAttribs.tmp.setDSR = opts.setDSR;
		}

		// Pass through fromCache flag
		if (opts.fromCache) {
			if (!firstWrapperToken.dataAttribs.tmp) {
				firstWrapperToken.dataAttribs.tmp = {};
			}
			firstWrapperToken.dataAttribs.tmp.fromCache = opts.fromCache;
		}

		// Transfer the tsr.
		// The first token gets the full width, the following tokens zero width.
		var tokenTsr = opts.tsr || (token.dataAttribs ? token.dataAttribs.tsr : null);
		if (tokenTsr) {
			firstWrapperToken.dataAttribs.tsr = tokenTsr;
			firstWrapperToken.dataAttribs.extTagOffsets = token.dataAttribs ? token.dataAttribs.extTagOffsets : null;
			var endTsr = [tokenTsr[1], tokenTsr[1]];
			for (var i = 1; i < toks.length; i++) {
				toks[i].dataAttribs.tsr = endTsr;
			}
		}

		return toks;
	},

	/**
	 * Wrap text and comment nodes in a node list into spans, so that all
	 * top-level nodes are elements.
	 *
	 * @param {Node[]} nodes List of DOM nodes to wrap, mix of node types.
	 */
	addSpanWrappers: function(nodes) {
		let textCommentAccum = [];
		const doc = nodes[0] && nodes[0].ownerDocument;

		function wrapAccum() {
			// Wrap accumulated nodes in a span
			const span = doc.createElement('span');
			const parentNode = textCommentAccum[0].parentNode;
			parentNode.insertBefore(span, textCommentAccum[0]);
			textCommentAccum.forEach(function(n) {
				span.appendChild(n);
			});
			DOMDataUtils.setDataParsoid(span, { tmp: { wrapper: true } });
			textCommentAccum = [];
		}

		// Build a real array out of nodes.
		//
		// Operating directly on DOM child-nodes array
		// and manipulating them by adding span wrappers
		// changes the traversal itself
		const nodeBuf = Array.from(nodes);

		nodeBuf.forEach(function(node) {
			if (DOMUtils.isText(node) || DOMUtils.isComment(node)) {
				textCommentAccum.push(node);
			} else {
				if (textCommentAccum.length) {
					wrapAccum();
				}
			}
		});

		if (textCommentAccum.length) {
			wrapAccum();
		}
	},

	/**
	 * Convert a HTML5 DOM into a mw:DOMFragment and generate appropriate
	 * tokens to insert into the token stream for further processing.
	 *
	 * The DOMPostProcessor will unpack the fragment and insert the HTML
	 * back into the DOM.
	 *
	 * @param {MWParserEnvironment} env
	 *    The active environment/context.
	 *
	 * @param {Token} token
	 *    The token that generated the DOM.
	 *
	 * @param {Node} body
	 *    The DOM that the token expanded to.
	 *
	 * @param {Object} opts
	 *    Options to be passed onto the encapsulation code
	 *    See encapsulateExpansionHTML's doc. for more info about these options.
	 */
	tunnelDOMThroughTokens: function(env, token, body, opts) {
		console.assert(DOMUtils.isBody(body), 'DOMFragment expected body node.');
		// Get placeholder tokens to get our subdom through the token processing
		// stages. These will be finally unwrapped on the DOM.
		var expansion = PipelineUtils.makeExpansion(env, body.childNodes);
		return PipelineUtils.encapsulateExpansionHTML(env, token, expansion, opts);
	},

	makeExpansion: function(env, nodes) {
		nodes.forEach(function(n) {
			DOMDataUtils.visitAndStoreDataAttribs(n);
		});
		return { nodes: nodes, html: env.setFragment(nodes) };
	},

	/**
	 * Extract transclusion and extension expansions from a DOM, and return
	 * them in a structure like this:
	 * ```
	 *     {
	 *         transclusions: {
	 *             'key1': {
	 *                  html: 'html1',
	 *                  nodes: [<node1>, <node2>]
	 *             }
	 *         },
	 *         extensions: {
	 *             'key2': {
	 *                  html: 'html2',
	 *                  nodes: [<node1>, <node2>]
	 *             }
	 *         },
	 *         files: {
	 *             'key3': {
	 *                  html: 'html3',
	 *                  nodes: [<node1>, <node2>]
	 *             }
	 *         }
	 *     }
	 * ```
	 */
	extractExpansions: function(env, body) {
		var expansions = {
			transclusions: {},
			extensions: {},
			media: {},
		};
		function doExtractExpansions(node) {
			var nodes, expAccum;
			while (node) {
				if (DOMUtils.isElt(node)) {
					var typeOf = node.getAttribute('typeof') || '';
					if ((/(?:^|\s)(?:mw:(?:Transclusion(?=$|\s)|Extension\/))/.test(typeOf) && node.hasAttribute('about')) ||
							/(?:^|\s)(?:mw:(?:Image|Video|Audio)(?:(?=$|\s)|\/))/.test(typeOf)) {
						var dp = DOMDataUtils.getDataParsoid(node);
						var about = node.hasAttribute('about') ?
							node.getAttribute('about') : null;
						nodes = WTUtils.getAboutSiblings(node, about);

						var key;
						if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
							expAccum = expansions.transclusions;
							key = dp.src;
						} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
							expAccum = expansions.extensions;
							key = dp.src;
						} else {
							expAccum = expansions.media;
							// XXX gwicke: use proper key that is not
							// source-based? This also needs to work for
							// transclusion output.
							key = null;
						}

						if (key) {
							expAccum[key] = PipelineUtils.makeExpansion(env, nodes);
						}

						node = JSUtils.lastItem(nodes);
					} else {
						doExtractExpansions(node.firstChild);
					}
				}
				node = node.nextSibling;
			}
		}
		// Kick off the extraction
		doExtractExpansions(body.firstChild);
		return expansions;
	},

};

if (typeof module === "object") {
	module.exports.PipelineUtils = PipelineUtils;
}
