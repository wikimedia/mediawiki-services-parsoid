/*
 * This is a Serializer class that will compare two versions of a DOM
 * and re-use the original wikitext for unmodified regions of the DOM.
 * Originally this relied on special change markers inserted by the
 * editor, but we now generate these ourselves using DOMDiff.
 */

'use strict';

var DOMDiff = require('./DOMDiff.js').DOMDiff;
var DU = require('../utils/DOMUtils.js').DOMUtils;
var Promise = require('../utils/promise.js');
var WikitextSerializer = require('./WikitextSerializer.js').WikitextSerializer;


/**
 * @class
 *
 * If we have the page source (this.env.page.src), we use the selective
 * serialization method, only reporting the serialized wikitext for parts of
 * the page that changed. Else, we fall back to serializing the whole DOM.
 *
 * @constructor
 * @param {Object} options Options for the serializer.
 * @param {MWParserEnvironment} options.env
 */
var SelectiveSerializer = function(options) {
	this.env = options.env || { conf: { parsoid: {} } };
	this.wts = options.wts || new WikitextSerializer(options);

	// Debug options
	this.trace = this.env.conf.parsoid.traceFlags &&
			this.env.conf.parsoid.traceFlags.has("selser");

	// Performance Timing option
	this.metrics = this.env.conf.parsoid.metrics;
};

var SSP = SelectiveSerializer.prototype;

/**
 * Selectively serialize an HTML DOM document.
 * WARNING: You probably want to use DU.serializeDOM instead.
 */
SSP.serializeDOM = Promise.async(function *(body) {
	console.assert(DU.isBody(body), 'Expected a body node.');
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
		if (this.env.page.domdiff) {
			diff = this.env.page.domdiff;
			body = diff.dom;
		} else {
			// Use provided diff-marked DOM (used during testing)
			// or generate one (used in production)
			if (metrics) {
				domDiffStart = Date.now();
			}

			// Strip <section> tags, if present.
			// This ensures that we can accept HTML from CX / VE
			// and other clients that might have stripped them.
			DU.stripSectionTags(body);
			DU.stripSectionTags(this.env.page.dom);

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
				DU.dumpDOM(body, 'DOM after running DOMDiff', {
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
});


if (typeof module === 'object') {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}
