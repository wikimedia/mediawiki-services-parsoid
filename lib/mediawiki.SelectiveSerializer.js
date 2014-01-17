/*
 * This is a Serializer class that will run through a DOM looking for special
 * change markers, usually supplied by an HTML5 WYSIWYG editor (like the
 * VisualEditor for MediaWiki), and determining what needs to be
 * serialized and what can simply be copied over.
 */

'use strict';

var WikitextSerializer = require( './mediawiki.WikitextSerializer.js' ).WikitextSerializer,
	Util = require( './mediawiki.Util.js' ).Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	ParserPipelineFactory = require('./mediawiki.parser.js').ParserPipelineFactory,
	DOMDiff = require('./mediawiki.DOMDiff.js').DOMDiff,
	ParsoidCacheRequest = require('./mediawiki.ApiRequest.js').ParsoidCacheRequest,
	async = require('async');

/**
 * @class
 * @constructor
 *
 * If one of options.env.page.name or options.oldtext is set, we use the selective serialization
 * method, only reporting the serialized wikitext for parts of the page that changed. Else, we
 * fall back to serializing the whole DOM.
 *
 * @param options {Object} Options for the serializer.
 * @param options.env {MWParserEnvironment}
 * @param options.oldtext {string} The old text of the document, if any
 * @param options.oldid {string} The revision ID you want to compare to (defaults to latest revision)
 */
var SelectiveSerializer = function ( options ) {
	// Set edit mode
	this.env = options.env || { conf : { parsoid : {} }, performance : {} };
	this.env.conf.parsoid.editMode = true;
	this.env.performance.selser = true;

	this.wts = options.wts || new WikitextSerializer( options );

	// Debug options
	this.trace = this.env.conf.parsoid.debug || (
		this.env.conf.parsoid.traceFlags &&
		(this.env.conf.parsoid.traceFlags.indexOf("selser") !== -1)
	);

	if ( this.trace ) {
		SelectiveSerializer.prototype.debug_pp = function () {
			Util.debug_pp.apply(Util, ["SS:", ' '].concat([].slice.apply(arguments)));
		};

		SelectiveSerializer.prototype.debug = function ( ) {
			console.error.apply(console, ["SS:", ' '].concat([].slice.apply(arguments)));
		};
	} else {
		SelectiveSerializer.prototype.debug_pp = function ( ) {};
		SelectiveSerializer.prototype.debug = function ( ) {};
	}
};

var SSP = SelectiveSerializer.prototype;

/**
 * @method
 * @private
 *
 * Run the DOM serialization on a node.
 *
 * @param {Error} err
 * @param {Node} doc
 * @param {Function} cb Callback that is called for each chunk.
 * @param {string} cb.res The wikitext of the chunk we've just serialized.
 * @param {Function} finalcb The callback for when we've finished serializing the DOM.
 */
SSP.doSerializeDOM = function ( err, doc, cb, finalcb ) {
	var self = this;

	if ( err || (!this.env.page.dom && !this.env.page.domdiff) || !this.env.page.src) {
		// If there's no old source, fall back to non-selective serialization.
		this.wts.serializeDOM(doc, cb, finalcb);
	} else {
		// Use provided diff-marked DOM (used during testing)
		// or generate one (used in production)
		var diff = this.env.page.domdiff || new DOMDiff(this.env).diff( doc );

		if ( ! diff.isEmpty ) {

			doc = diff.dom;

			// Add the serializer info
			// new DiffToSelserConverter(this.env, doc).convert();

			if ( this.trace || ( this.env.conf.parsoid.dumpFlags &&
				this.env.conf.parsoid.dumpFlags.indexOf( 'dom:post-dom-diff' ) !== -1) )
			{
				console.log( '----- DOM after running DOMDiff -----' );
				console.log( doc.outerHTML );
			}

			// Call the WikitextSerializer to do our bidding
			this.wts.serializeDOM(
					doc,
					function(res) {
						self.debug_pp(JSON.stringify(res));
						cb(res);
					},
					finalcb,
					true);
		} else {
			// Nothing was modified, just re-use the original source
			cb( this.env.page.src );
			finalcb();
		}
	}
};

/**
 * @method
 * @private
 *
 * Parse the wikitext source of the page for DOM-diffing purposes.
 *
 * @param {Node} doc The node for which we're getting the source.
 * @param {Function} cb A callback to call after each chunk is serialized.
 * @param {string} cb.res The result of the chunk serialization.
 * @param {Function} finalcb The callback for after we've serialized the entire document.
 * @param {Error} err
 * @param {string} src The wikitext source of the document (optionally
 *                     including page metadata)
 */
SSP.parseOriginalSource = function ( doc, cb, finalcb, err, src ) {
	var self = this,
		parserPipelineFactory = new ParserPipelineFactory( this.env ),
		parserPipeline = parserPipelineFactory.getPipeline( 'text/x-mediawiki/full' );

	// Makes sure that the src is available even when just fetched.
	this.env.setPageSrcInfo( src );

	// Parse the wikitext src to the original DOM, and pass that on to
	// doSerializeDOM
	parserPipeline.once( 'document', function ( origDoc ) {
		var body = DU.parseHTML( DU.serializeNode(origDoc) ).body;
		self.env.page.dom = body;
		//console.log('calling doSerializeDOM');
		//console.log(body.outerHTML);
		self.doSerializeDOM(null, doc, cb, finalcb);
	} );
	parserPipeline.processToplevelDoc(this.env.page.src);
};


/**
 * @method
 *
 * The main serializer handler. Calls detectDOMChanges and prepares and calls
 * WikitextSerializer.serializeDOM if changes were found.
 *
 * @param {Node} doc The document to serialize.
 * @param {Function} cb A callback for any serialized chunks, called whenever we get a chunk of wikitext.
 * @param {string} cb.res The chunk of wikitext just serialized.
 * @param {Function} finalcb The callback fired on completion of the serialization.
 */
SSP.serializeDOM = function ( doc, cb, finalcb ) {
	var self = this;
	if ( this.env.page.dom || this.env.page.domdiff ) {
		this.doSerializeDOM(null, doc, cb, finalcb);
	} else if ( this.env.page.src ) {
		// Have the src, only parse the src to the dom
		this.parseOriginalSource( doc, cb, finalcb, null, this.env.page.src );
	} else if (this.env.page.id && this.env.page.id !== '0') {
		// Start by getting the old text of this page
		if (this.env.conf.parsoid.parsoidCacheURI) {
			var cacheRequest = new ParsoidCacheRequest(this.env,
					this.env.page.name, this.env.page.id, {evenIfNotCached: true});
			// Fetch the page source and previous revison's DOM in parallel
			async.parallel(
					[
						Util.getPageSrc.bind(Util, this.env, this.env.page.name,
							this.env.page.id || null),
						cacheRequest.once.bind(cacheRequest, 'src')
					], function (err, results) {
						if (err) {
							console.error('Error while fetching page source or original DOM!');
						} else {
							// no error.

							// Set the page source.
							self.env.setPageSrcInfo(results[0]);

							// And the original dom. results[1] is an array
							// with the html and the content type. Ignore the
							// content type here.
							self.env.page.dom = DU.parseHTML(results[1][0]).body;
						}

						// Selective serialization if there was no error, full
						// serialization if there was one.
						self.doSerializeDOM(null, doc, cb, finalcb);
					}
			);

		} else {
			Util.getPageSrc( this.env, this.env.page.name,
					this.env.page.id || null,
					this.parseOriginalSource.bind(this, doc, cb, finalcb) );
		}
	} else {
		this.doSerializeDOM(null, doc, cb, finalcb);
	}

};

if ( typeof module === 'object' ) {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}
