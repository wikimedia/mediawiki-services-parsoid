/**
 * This file contains parsing pipeline related utilities.
 *
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var JSUtils = require('./jsutils.js').JSUtils;
var Promise = require('./promise.js');
var pd = require('../wt2html/parser.defines.js');
var DU;

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
	 * @param {Token[]} content
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

		return new pd.SelfclosingTagTk('mw:dom-fragment-token', [
			new pd.KV('contextTok', opts.token),
			new pd.KV('content', content),
			new pd.KV('inlineContext',  opts.inlineContext || false),
			new pd.KV('inPHPBLock',  opts.inPHPBLock || false),
			new pd.KV('srcOffsets', srcOffsets),
		]);
	},

	/**
	 * Processes content (wikitext, array of tokens, whatever) in its own pipeline
	 * based on options.
	 *
	 * @param {Object} env
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
	 */
	processContentInPipeline: function(env, frame, content, opts) {
		// Build a pipeline
		var pipeline = env.pipelineFactory.getPipeline(
			opts.pipelineType,
			opts.pipelineOpts
		);

		// Set frame if necessary
		if (opts.tplArgs) {
			pipeline.setFrame(frame, opts.tplArgs.name, opts.tplArgs.attribs);
		} else {
			pipeline.setFrame(frame, null, []);
		}

		// Set source offsets for this pipeline's content
		if (opts.srcOffsets) {
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
		pipeline.process(content);
	},

	/**
	 * A promise returning wrapper around processContentInPipeline that
	 * resolves with the docuemnt.
	 * @return {Promise<Document>}
	 */
	promiseToProcessContent: function(env, frame, content, opts, cb) {
		cb = JSUtils.mkPromised(cb);
		PipelineUtils.processContentInPipeline(env, frame, content, {
			pipelineType: opts.pipelineType,
			pipelineOpts: opts.pipelineOpts,
			srcOffsets: opts ? opts.srcOffsets : undefined,
			// processContentInPipeline has no error callback :(
			documentCB: function(dom) { cb(null, dom); },
		});
		return cb.promise;
	},

	/**
	 * Expands values all the way to DOM and passes them back to a callback.
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
	 * @param {Object[]} vals
	 *    The array of values to process.
	 *    Each value of this array is expected to be an object with a "html" property.
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
	 * @param {Function} [finalCB]
	 *    The (optional) callback to pass the expanded values into.
	 *
	 * @return {Promise}
	 *    A promise that will be resolved with the expanded values.
	 */
	expandValuesToDOM: function(env, frame, vals, expandTemplates, inTemplate, finalCB) {
		if (!DU) { DU = require('./DOMUtils.js').DOMUtils; }
		return Promise.all(vals.map(Promise.async(function *(v) {
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
				};
				var content = v.html.concat([new pd.EOFTk()]);
				try {
					var dom = yield PipelineUtils.promiseToProcessContent(
						env, frame, content, opts
					);
					// Since we aren't at the top level, data attrs
					// were not applied in cleanup.  However, tmp
					// was stripped.
					v.html = DU.ppToXML(dom.body, { innerXML: true });
				} catch (err) {
					env.log('error', 'Expanding values to DOM', err);
				}
			}
			return v;
		}))).nodify(finalCB);
	},
};

if (typeof module === "object") {
	module.exports.PipelineUtils = PipelineUtils;
}
