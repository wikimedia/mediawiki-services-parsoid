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
 * Selectively serialize an HTML DOM document synchronously.
 * WARNING: You probably want to use DU.serializeDOM instead.
 */
SSP.serializeDOM = Promise.method(function(body) {
	console.assert(DU.isBody(body), 'Expected a body node.');
	console.assert(this.env.page.editedDoc, 'Should be set.');  // See WSP.serializeDOM

	var startTimers = new Map();
	var metrics = this.metrics;

	if ((!this.env.page.dom && !this.env.page.domdiff) || this.env.page.src === null) {
		if (metrics) {
			startTimers.set('html2wt.full.serialize', Date.now());
		}

		// If there's no old source, fall back to non-selective serialization.
		return this.wts.serializeDOM(body, false).tap(function() {
			if (metrics) {
				metrics.endTiming('html2wt.full.serialize',
					startTimers.get('html2wt.full.serialize'));
			}
		});
	} else {
		if (metrics) {
			startTimers.set('html2wt.selser.serialize', Date.now());
		}

		var diff;
		if (this.env.page.domdiff) {
			diff = this.env.page.domdiff;
			body = diff.dom;
		} else {
			// Use provided diff-marked DOM (used during testing)
			// or generate one (used in production)
			if (metrics) {
				startTimers.set('html2wt.selser.domDiff', Date.now());
			}

			// Strip <section> tags, if present.
			// This ensures that we can accept HTML from CX / VE
			// and other clients that might have stripped them.
			DU.stripSectionTags(body);
			DU.stripSectionTags(this.env.page.dom);

			diff = (new DOMDiff(this.env)).diff(this.env.page.dom, body);

			if (metrics) {
				metrics.endTiming('html2wt.selser.domDiff',
					startTimers.get('html2wt.selser.domDiff'));
			}
		}

		var p;
		if (diff.isEmpty) {
			// Nothing was modified, just re-use the original source
			p = Promise.resolve(this.env.page.src);
		} else {
			if (this.trace || (this.env.conf.parsoid.dumpFlags &&
				this.env.conf.parsoid.dumpFlags.has('dom:post-dom-diff'))) {
				DU.dumpDOM(body, 'DOM after running DOMDiff', {
					storeDiffMark: true,
					env: this.env,
				});
			}

			// Call the WikitextSerializer to do our bidding
			p = this.wts.serializeDOM(body, true);
		}
		return p.tap(function() {
			if (metrics) {
				metrics.endTiming('html2wt.selser.serialize',
					startTimers.get('html2wt.selser.serialize'));
			}
		});
	}
});


if (typeof module === 'object') {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}
