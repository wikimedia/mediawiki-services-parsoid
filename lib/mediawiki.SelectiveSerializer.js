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
 * If we have the page source (this.env.page.src), we use the selective
 * serialization method, only reporting the serialized wikitext for parts of
 * the page that changed. Else, we fall back to serializing the whole DOM.
 *
 * @param options {Object} Options for the serializer.
 * @param options.env {MWParserEnvironment}
 * @param options.oldid {string} The revision ID you want to compare to (defaults to latest revision)
 */
var SelectiveSerializer = function ( options ) {
	// Set edit mode
	this.env = options.env || { conf : { parsoid : {} }, performance : {} };
	this.env.conf.parsoid.rtTestMode = false;
	this.env.performance.selser = true;

	this.wts = options.wts || new WikitextSerializer( options );

	// Debug options
	this.trace = this.env.conf.parsoid.traceFlags && (this.env.conf.parsoid.traceFlags.indexOf("selser") !== -1);

	// Performance Timing option
	this.timer = this.env.conf.parsoid.performanceTimer;
};

var SSP = SelectiveSerializer.prototype;

/**
 * @method
 * @private
 *
 * Run the DOM serialization on a node.
 *
 * @param {Error} err
 * @param {Node} body
 * @param {Function} cb Callback that is called for each chunk.
 * @param {string} cb.res The wikitext of the chunk we've just serialized.
 * @param {Function} finalcb The callback for when we've finished serializing the DOM.
 */
SSP.doSerializeDOM = function( err, body, cb, finalcb ) {
	var self = this;
	var startTimers = new Map();

	if ( err || (!this.env.page.dom && !this.env.page.domdiff) || !this.env.page.src ) {
		if ( this.timer ) {
			startTimers.set( 'html2wt.serialize.full', Date.now() );
		}

		// If there's no old source, fall back to non-selective serialization.
		this.wts.serializeDOM( body, cb, false, finalcb );

		if ( this.timer ) {
			this.timer.timing( 'html2wt.serialize.full', '', startTimers.get( 'html2wt.serialize.full' ) );
			this.timer.count( 'html2wt.serialize.full.count', '' );
		}
	} else {
		// Use provided diff-marked DOM (used during testing)
		// or generate one (used in production)
		if ( this.timer ) {
			startTimers.set( 'html2wt.serialize.selser', Date.now() );
			startTimers.set( 'html2wt.domDiff', Date.now() );
		}

		var diff = this.env.page.domdiff || new DOMDiff( this.env ).diff( body );

		if ( this.timer ) {
			this.timer.timing( 'html2wt.domDiff', '', startTimers.get( 'html2wt.domDiff' ) );
		}

		if ( !diff.isEmpty ) {
			body = diff.dom;

			// Add the serializer info
			// new DiffToSelserConverter(this.env, body).convert();

			if ( this.trace || ( this.env.conf.parsoid.dumpFlags &&
				this.env.conf.parsoid.dumpFlags.indexOf( 'dom:post-dom-diff' ) !== -1) )
			{
				console.log( '----- DOM after running DOMDiff -----' );
				console.log( body.outerHTML );
			}

			// Call the WikitextSerializer to do our bidding
			this.wts.serializeDOM( body, cb, true, finalcb );

			if ( this.timer ) {
				this.timer.timing( 'html2wt.serialize.selser', '', startTimers.get( 'html2wt.serialize.selser' ) );
				this.timer.count( 'html2wt.serialize.selser.count', '' );
			}
		} else {
			// Nothing was modified, just re-use the original source
			cb( this.env.page.src );
			finalcb();
			if ( this.timer ) {
				this.timer.count( 'html2wt.serialize.none.count', '' );
			}
		}
	}
};

/**
 * @method
 * @private
 *
 * Parse the wikitext source of the page for DOM-diffing purposes.
 *
 * @param {Node} body The node for which we're getting the source.
 * @param {Function} cb A callback to call after each chunk is serialized.
 * @param {string} cb.res The result of the chunk serialization.
 * @param {Function} finalcb The callback for after we've serialized the entire document.
 * @param {Error} err
 * @param {string} src The wikitext source of the document (optionally
 *                     including page metadata)
 */
SSP.parseOriginalSource = function( body, cb, finalcb, err, src ) {
	var self = this,
		parserPipelineFactory = new ParserPipelineFactory( this.env ),
		parserPipeline = parserPipelineFactory.getPipeline( 'text/x-mediawiki/full' );

	// Makes sure that the src is available even when just fetched.
	this.env.setPageSrcInfo( src );

	// Parse the wikitext src to the original DOM, and pass that on to
	// doSerializeDOM
	parserPipeline.once( 'document', function( origDoc ) {
		self.env.page.dom = DU.parseHTML( DU.serializeNode( origDoc ) ).body;
		self.doSerializeDOM( null, body, cb, finalcb );
	} );
	parserPipeline.processToplevelDoc( this.env.page.src );
};


/**
 * @method
 *
 * The main serializer handler. Calls detectDOMChanges and prepares and calls
 * WikitextSerializer.serializeDOM if changes were found.
 *
 * @param {Node} body The document to serialize.
 * @param {Function} cb A callback for any serialized chunks, called whenever we get a chunk of wikitext.
 * @param {string} cb.res The chunk of wikitext just serialized.
 * @param {Function} finalcb The callback fired on completion of the serialization.
 */
SSP.serializeDOM = function( body, cb, dummy, finalcb ) {
	// dummy preserves the wt serializer interface
	var self = this;
	if ( this.env.page.dom || this.env.page.domdiff ) {
		this.doSerializeDOM( null, body, cb, finalcb );
	} else if ( this.env.page.src ) {
		// Have the src, only parse the src to the dom
		this.parseOriginalSource( body, cb, finalcb, null, this.env.page.src );
	} else if ( this.env.page.id && this.env.page.id !== '0' ) {
		// Start by getting the old text of this page
		if ( this.env.conf.parsoid.parsoidCacheURI ) {
			var cacheRequest = new ParsoidCacheRequest(
				this.env, this.env.page.name, this.env.page.id, { evenIfNotCached: true }
			);
			// Fetch the page source and previous revision's DOM in parallel
			async.parallel([
				Util.getPageSrc.bind( Util, this.env, this.env.page.name, this.env.page.id || null ),
				cacheRequest.once.bind( cacheRequest, 'src' )
			], function( err, results ) {
				if ( err ) {
					self.env.log("error", "Error while fetching page source or original DOM!");
				} else {
					// Set the page source.
					self.env.setPageSrcInfo(results[0]);

					// And the original dom. results[1] is an array
					// with the html and the content type. Ignore the
					// content type here.
					self.env.page.dom = DU.parseHTML(results[1][0]).body;
				}

				// Selective serialization if there was no error, full
				// serialization if there was one.
				self.doSerializeDOM( err, body, cb, finalcb );
			});
		} else {
			Util.getPageSrc(
				this.env, this.env.page.name, this.env.page.id || null,
				this.parseOriginalSource.bind( this, body, cb, finalcb )
			);
		}
	} else {
		this.doSerializeDOM( null, body, cb, finalcb );
	}

};

if ( typeof module === 'object' ) {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}
