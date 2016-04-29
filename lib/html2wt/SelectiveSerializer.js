/*
 * This is a Serializer class that will run through a DOM looking for special
 * change markers, usually supplied by an HTML5 WYSIWYG editor (like the
 * VisualEditor for MediaWiki), and determining what needs to be
 * serialized and what can simply be copied over.
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
			(this.env.conf.parsoid.traceFlags.indexOf("selser") !== -1);

	// Performance Timing option
	this.stats = this.env.conf.parsoid.stats;
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
	var stats = this.stats;

	if ((!this.env.page.dom && !this.env.page.domdiff) || this.env.page.src === null) {
		if (stats) {
			startTimers.set('html2wt.full.serialize', Date.now());
		}

		// If there's no old source, fall back to non-selective serialization.
		return this.wts.serializeDOM(body, false).tap(function() {
			if (stats) {
				stats.timing('html2wt.full.serialize', '',
					(Date.now() - startTimers.get('html2wt.full.serialize')));
			}
		});
	} else {
		if (stats) {
			startTimers.set('html2wt.selser.serialize', Date.now());
		}

		var diff;
		if (this.env.page.domdiff) {
			diff = this.env.page.domdiff;
			body = diff.dom;
		} else {
			// Use provided diff-marked DOM (used during testing)
			// or generate one (used in production)
			if (stats) {
				startTimers.set('html2wt.selser.domDiff', Date.now());
			}

			diff = (new DOMDiff(this.env)).diff(this.env.page.dom, body);

			if (stats) {
				stats.timing('html2wt.selser.domDiff', '',
					(Date.now() - startTimers.get('html2wt.selser.domDiff')));
			}
		}

		var p;
		if (diff.isEmpty) {
			// Nothing was modified, just re-use the original source
			p = Promise.resolve(this.env.page.src);
		} else {
			if (this.trace || (this.env.conf.parsoid.dumpFlags &&
				this.env.conf.parsoid.dumpFlags.indexOf('dom:post-dom-diff') !== -1)) {
				DU.dumpDOM(body, 'DOM after running DOMDiff', {
					storeDiffMark: true,
					env: this.env,
				});
			}

			// Call the WikitextSerializer to do our bidding
			p = this.wts.serializeDOM(body, true);
		}
		return p.tap(function() {
			if (stats) {
				stats.timing('html2wt.selser.serialize', '',
					(Date.now() - startTimers.get('html2wt.selser.serialize')));
			}
		});
	}
});


if (typeof module === 'object') {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}
