/*
 * This is a Serializer class that will run through a DOM looking for special
 * change markers, usually supplied by an HTML5 WYSIWYG editor (like the
 * VisualEditor for MediaWiki), and determining what needs to be
 * serialized and what can simply be copied over.
 */
'use strict';

var WikitextSerializer = require('./mediawiki.WikitextSerializer.js').WikitextSerializer;
var DOMDiff = require('./mediawiki.DOMDiff.js').DOMDiff;
var normalizeDOM = require('./wts.normalizeDOM.js').normalizeDOM;
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;


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
	this.timer = this.env.conf.parsoid.performanceTimer;
};

var SSP = SelectiveSerializer.prototype;

/**
 * Selectively serialize an HTML DOM document synchronously.
 * WARNING: You probably want to use DU.serializeDOM instead.
 */
SSP.serializeDOMSync = function(body) {
	console.assert(DU.isBody(body), 'Expected a body node.');

	var out;
	var startTimers = new Map();

	if ((!this.env.page.dom && !this.env.page.domdiff) || this.env.page.src === null) {
		if (this.timer) {
			startTimers.set('html2wt.full.serialize', Date.now());
		}

		// If there's no old source, fall back to non-selective serialization.
		out = this.wts.serializeDOMSync(body, false);

		if (this.timer) {
			this.timer.timing('html2wt.full.serialize', '',
				(Date.now() - startTimers.get('html2wt.full.serialize')));
		}
	} else {
		if (this.timer) {
			startTimers.set('html2wt.selser.serialize', Date.now());
		}

		var diff;
		if (this.env.page.domdiff) {
			diff = this.env.page.domdiff;
		} else {
			// Use provided diff-marked DOM (used during testing)
			// or generate one (used in production)
			if (this.timer) {
				startTimers.set('html2wt.selser.domDiff', Date.now());
			}

			diff = new DOMDiff(this.env).diff(body);

			if (this.timer) {
				this.timer.timing('html2wt.selser.domDiff', '',
					(Date.now() - startTimers.get('html2wt.selser.domDiff')));
			}
		}

		if (diff.isEmpty) {
			// Nothing was modified, just re-use the original source
			out = this.env.page.src;
		} else {
			body = diff.dom;
			this.env.page.editedDoc = body.ownerDocument;

			if (this.trace || (this.env.conf.parsoid.dumpFlags &&
				this.env.conf.parsoid.dumpFlags.indexOf('dom:post-dom-diff') !== -1)) {
				console.log('----- DOM after running DOMDiff -----');
				console.log(body.outerHTML);
			}

			// Call the WikitextSerializer to do our bidding
			out = this.wts.serializeDOMSync(body, true);
		}

		if (this.timer) {
			this.timer.timing('html2wt.selser.serialize', '',
				(Date.now() - startTimers.get('html2wt.selser.serialize')));
		}
	}
	return out;
};


if (typeof module === 'object') {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}
