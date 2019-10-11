'use strict';

require('../core-upgrade.js');

const Promise = require('./utils/promise.js');
const { ContentUtils } = require('./utils/ContentUtils.js');
const { DOMDataUtils } = require('./utils/DOMDataUtils.js');
const { DOMUtils } = require('./utils/DOMUtils.js');
const { SelectiveSerializer } = require('./html2wt/SelectiveSerializer.js');
const { TemplateRequest } = require('./mw/ApiRequest.js');
const { WikitextSerializer } = require('./html2wt/WikitextSerializer.js');

class FromHTML {
	/**
	 * Fetch prior DOM for selser.  This is factored out of
	 * {@link serializeDOM} so that it can be reused by alternative
	 * content handlers which support selser.
	 *
	 * @param {Object} env The environment.
	 * @param {boolean} useSelser Use the selective serializer, or not.
	 * @return {Promise} A promise that is resolved after selser information
	 *   has been loaded.
	 */
	static fetchSelser(env, useSelser) {
		var hasOldId = !!env.page.meta.revision.revid;
		var needsContent = useSelser && hasOldId && (env.page.src === null);
		var needsOldDOM = useSelser && !(env.page.dom || env.page.domdiff);

		var p = Promise.resolve();
		if (needsContent) {
			p = p.then(function() {
				var target = env.normalizeAndResolvePageTitle();
				return TemplateRequest.setPageSrcInfo(env, target, env.page.meta.revision.revid)
				.catch(function(err) {
					env.log('error', 'Error while fetching page source.', err);
				});
			});
		}
		// Why is it safe to use a reparsed dom for dom diff'ing?
		// (Since that's the only use of `env.page.dom`)
		//
		// There are two types of non-determinism to discuss:
		//
		//   * The first is from parsoid generated ids.  At this point,
		//     data-attributes have already been applied so there's no chance
		//     that variability in the ids used to associate data-attributes
		//     will lead to data being applied to the wrong nodes.
		//
		//     Further, although about ids will differ, they belong to the set
		//     of ignorable attributes in the dom differ.
		//
		//   * Templates, and encapsulated content in general, are the second.
		//     Since that content can change in between parses, the resulting
		//     dom might not be the same.  However, because dom diffing on
		//     on those regions only uses data-mw for comparision (which will
		//     remain constant between parses), this also shouldn't be an
		//     issue.
		//
		//     There is one caveat.  Because encapsulated content isn't
		//     guaranteed to be "balanced", the template affected regions
		//     may change between parses.  This should be rare.
		//
		// We therefore consider this safe since it won't corrupt the page
		// and, at worst, mixed up diff'ing annotations can end up with an
		// unfaithful serialization of the edit.
		//
		// However, in cases where original content is not returned by the
		// client / RESTBase, selective serialization cannot proceed and
		// we're forced to fallback to normalizing the entire page.  This has
		// proved unacceptable to editors as is and, as we lean heavier on
		// selser, will only get worse over time.
		//
		// So, we're forced to trade off the correctness for usability.
		if (needsOldDOM) {
			p = p.then(function() {
				const metrics = env.conf.parsoid.metrics;
				if (env.page.src === null) {
					// The src fetch failed or we never had an oldid.
					// We'll just fallback to non-selser.
					if (metrics) { metrics.increment('html2wt.nosrc'); }
					return;
				}
				return env.getContentHandler().toHTML(env)
				.then(function(doc) {
					env.page.dom = env.createDocument(ContentUtils.toXML(doc)).body;
					if (!env.conf.wiki.isRestricted) {
						// Only log this where RESTBase is deployed and it would
						// be unexpected to trigger a reparse.
						env.log('error/html2wt/reparse', 'Original HTML missing. Reparsing.');
						if (metrics) {
							metrics.increment(`html2wt.reparse.${env.conf.wiki.iwp}`);
						}
					}
				})
				.catch(function(err) {
					env.log('error', 'Error while parsing original DOM.', err);
				});
			});
		}

		return p;
	}

	/**
	 * The main serializer from DOM to *wikitext*.
	 *
	 * If you could be handling non-wikitext content, use
	 * `env.getContentHandler().fromHTML(env, body, useSelser)` instead.
	 * See {@link MWParserEnvironment#getContentHandler}.
	 *
	 * @param {Object} env The environment.
	 * @param {Node} body The document body to serialize.
	 * @param {boolean} useSelser Use the selective serializer, or not.
	 * @param {Function} cb Optional callback.
	 */
	static serializeDOM(env, body, useSelser, cb) {
		console.assert(DOMUtils.isBody(body), 'Expected a body node.');

		// Preprocess the DOM, if required.
		//
		// Usually, only extensions that have page-level state might
		// provide these processors to provide subtree-editing support
		// and server-side management of this page-level state.
		//
		// NOTE: This means that our extension API exports information
		// to extensions that there is such a thing as subtree editing
		// and other related info. This needs to be in our extension API docs.
		const preprocessDOM = function() {
			env.conf.wiki.extConfig.domProcessors.forEach(function(extProcs) {
				if (extProcs.procs.html2wtPreProcessor) {
					// This updates the DOM in-place
					extProcs.procs.html2wtPreProcessor(env, body);
				}
			});
		};

		return this.fetchSelser(env, useSelser).then(function() {
			var Serializer = useSelser ? SelectiveSerializer : WikitextSerializer;
			var serializer = new Serializer({ env: env });
			// TODO(arlolra): There's probably an opportunity to refactor callers
			// of `serializeDOM` to use `ContentUtils.ppToDOM` but this is a safe bet
			// for now, since it's the main entrypoint to serialization.
			DOMDataUtils.visitAndLoadDataAttribs(body, { markNew: true });
			if (useSelser && env.page.dom) {
				DOMDataUtils.visitAndLoadDataAttribs(env.page.dom, { markNew: true });
			}

			// NOTE:
			// 1. The edited DOM (represented by body) might not be in canonical
			//    form because Parsoid might be providing server-side management
			//    of global state for extensions (ex: Cite). To address this and
			//    bring the DOM back to canonical form, we run extension-provided
			//    handlers. The original dom (env.page.dom) isn't subject to this
			//    problem.
			// 2. We need to do this after all data attributes have been loaded above.
			// 3. We need to do this before we run dom-diffs to eliminate spurious
			//    diffs.
			preprocessDOM();

			env.page.editedDoc = body.ownerDocument;
			return serializer.serializeDOM(body);
		}).nodify(cb);
	}
}

if (typeof module === "object") {
	module.exports.FromHTML = FromHTML;
}
