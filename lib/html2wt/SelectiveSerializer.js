/**
 * This is a Serializer class that will compare two versions of a DOM
 * and re-use the original wikitext for unmodified regions of the DOM.
 * Originally this relied on special change markers inserted by the
 * editor, but we now generate these ourselves using DOMDiff.
 * @module
 */

'use strict';

const { DOMDiff } = require('./DOMDiff.js');
const { ContentUtils } = require('../utils/ContentUtils.js');
const { DOMUtils } = require('../utils/DOMUtils.js');
const Promise = require('../utils/promise.js');
const { WikitextSerializer } = require('./WikitextSerializer.js');

/**
 * If we have the page source (this.env.page.src), we use the selective
 * serialization method, only reporting the serialized wikitext for parts of
 * the page that changed. Else, we fall back to serializing the whole DOM.
 *
 * @class
 * @param {Object} options Options for the serializer.
 * @param {MWParserEnvironment} options.env
 * @param {WikitextSerializer} [options.wts]
 */
class SelectiveSerializer {
	constructor(options) {
		this.env = options.env;
		this.wts = options.wts || new WikitextSerializer(options);

		// Debug options
		this.trace = this.env.conf.parsoid.traceFlags &&
				this.env.conf.parsoid.traceFlags.has("selser");

		// Performance Timing option
		this.metrics = this.env.conf.parsoid.metrics;
	}

	/**
	 * Selectively serialize an HTML DOM document.
	 *
	 * WARNING: You probably want to use FromHTML.serializeDOM instead.
	 * @func
	 * @param {Node} body
	 * @return {Promise}
	 */
	*serializeDOMG(body) {
		console.assert(DOMUtils.isBody(body), 'Expected a body node.');
		console.assert(this.env.page.editedDoc, 'Should be set.');  // See WSP.serializeDOM

		var serializeStart, domDiffStart;
		var metrics = this.metrics;
		var r;

		if (metrics) {
			serializeStart = Date.now();
		}
		if ((!this.env.page.dom && !this.env.page.domdiff) || this.env.page.src === null) {
			// If there's no old source, fall back to non-selective serialization.
			r = yield this.wts.serializeDOM(body, false);
			if (metrics) {
				metrics.endTiming('html2wt.full.serialize', serializeStart);
			}
		} else {
			var diff;
			// Use provided diff-marked DOM (used during testing)
			// or generate one (used in production)
			if (this.env.page.domdiff) {
				diff = this.env.page.domdiff;
				body = diff.dom;
			} else {
				if (metrics) {
					domDiffStart = Date.now();
				}

				// Strip <section> and mw:FallbackId <span> tags, if present.
				// This ensures that we can accept HTML from CX / VE
				// and other clients that might have stripped them.
				ContentUtils.stripSectionTagsAndFallbackIds(body);
				ContentUtils.stripSectionTagsAndFallbackIds(this.env.page.dom);

				diff = (new DOMDiff(this.env)).diff(this.env.page.dom, body);

				if (metrics) {
					metrics.endTiming('html2wt.selser.domDiff', domDiffStart);
				}
			}

			if (diff.isEmpty) {
				// Nothing was modified, just re-use the original source
				r = this.env.page.src;
			} else {
				if (this.trace || (this.env.conf.parsoid.dumpFlags &&
					this.env.conf.parsoid.dumpFlags.has('dom:post-dom-diff'))) {
					ContentUtils.dumpDOM(body, 'DOM after running DOMDiff', {
						storeDiffMark: true,
						env: this.env,
					});
				}

				// Call the WikitextSerializer to do our bidding
				r = yield this.wts.serializeDOM(body, true);
			}
			if (metrics) {
				metrics.endTiming('html2wt.selser.serialize', serializeStart);
			}
		}
		return r;
	}
}

SelectiveSerializer.prototype.serializeDOM = Promise.async(SelectiveSerializer.prototype.serializeDOMG);

if (typeof module === 'object') {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}
