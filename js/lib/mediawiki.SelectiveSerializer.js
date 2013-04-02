/*
 * This is a Serializer class that will run through a DOM looking for special
 * change markers, usually supplied by an HTML5 WYSIWYG editor (like the
 * VisualEditor for MediaWiki), and determining what needs to be
 * serialized and what can simply be copied over.
 */

'use strict';

var WikitextSerializer = require( './mediawiki.WikitextSerializer.js' ).WikitextSerializer,
	Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js' ).DOMUtils,
	apirql = require( './mediawiki.ApiRequest.js' ),
	DoesNotExistError = apirql.DoesNotExistError,
	// don't redefine Node
	NODE = require('./mediawiki.wikitext.constants.js').Node,
	ParserPipelineFactory = require('./mediawiki.parser.js').ParserPipelineFactory,
	DOMDiff = require('./mediawiki.DOMDiff.js').DOMDiff;

/**
 * @class
 * @private
 *
 * Creates a Selser DOM from a diff-annotated DOM
 *
 * Traverses a diff-annotated DOM and adds selser information based on it
 *
 * TODO: make this a nested class with a less misleading name? SelserAnnotater
 * sounds a bit weird.
 *
 * @constructor
 * @param {MWParserEnvironment} env The environment to use for the serialization.
 * @param {Node} diffDOM The DOM to annotate with selser information.
 */
function DiffToSelserConverter ( env, diffDOM ) {
	this.env = env;
	this.currentId = 0;
	this.startPos = 0; // start offset of the current unmodified chunk
	this.curPos = 0; // end offset of the last processed node
	this.dom = diffDOM;
	// TODO: abstract the debug method setup!
	this.debug = env.conf.parsoid.debug ||
		(env.conf.parsoid.traceFlags && env.conf.parsoid.traceFlags.indexOf('selser') !== -1) ?
						console.error : function(){};
}

/**
 * @method
 */
DiffToSelserConverter.prototype.convert = function () {
	//console.log('convert dom', this.dom);
	this.doConvert(this.dom);
};

/**
 * @method
 * @private
 *
 * Internal conversion method.
 *
 * @param {Node} parentNode The node at which we start the conversion.
 * @param {Array} parentDSR The DSR information for the parent node.
 */
DiffToSelserConverter.prototype.doConvert = function ( parentNode, parentDSR ) {
	var node;

	var lastModified = false;
	for ( var i = 0; i < parentNode.childNodes.length; i++ ) {
		node = parentNode.childNodes[i];
		var dvec = null,
			dp = null,
			src = '',
			nodeType = node.nodeType,
			nodeName = node.nodeName.toLowerCase(),
			inIndentPre = this.inIndentPre,
			isModified = false;

		//console.warn("n: " + node.nodeName + "; s: " +
		//		this.startPos + "; c: " + this.curPos);

		if ( nodeType === NODE.TEXT_NODE || nodeType === NODE.COMMENT_NODE ) {
			src = (node.nodeValue || '');
			if (nodeType === NODE.COMMENT_NODE) {
				src = '<!--' + src + '-->';
			}
			// Get the wikitext source length adjusted for any stripped
			// leading ws in indent-pre context
			var srcLen = this.srcTextLen(src, inIndentPre);
			if ( this.startPos === null ) {
				// not included in a source range, so make sure it is fully
				// serialized
				if (! DU.isIEW(node) &&
						! DU.hasCurrentDiffMark(node.parentNode, this.env))
				{
					this.markTextOrCommentNode(node, false);
				}
			} else if ( !lastModified &&
					( ! node.nextSibling ||
					  !DU.isIEW(node) ||
					  !DU.isNodeModified(node.nextSibling))  )
			{
				this.movePos(srcLen);
			}
		} else if ( nodeType === NODE.ELEMENT_NODE )
		{

			// data-parsoid-changed is what we watch for the change markers.
			dvec = Util.getJSONAttribute(node, 'data-parsoid-changed', {});
			// get data-parsoid
			dp = Util.getJSONAttribute( node, 'data-parsoid', null);


			isModified =
				// Comment this out to ignore the VE's change markers!
				//DU.isModificationChangeMarker(dvec) ||

				// Marked as modified by our diff algo
				(DU.hasCurrentDiffMark(node, this.env) &&
				 ( DU.isNodeModified(node) ||
				   // The deleted-child case where no chilren are left
				   ! node.childNodes.length )) ||
				// no data-parsoid: new content
				! dp;
				// TODO: also *detect* element modifications without change
				// markers! use outerHTML?
			lastModified = isModified;

			if (DU.isTplElementNode(this.env, node))
			{
				// Don't descend into template content
				var type = node.getAttribute('typeof');
				if(dp && dp.dsr && type && type.match(/^mw:Object/)) {
					// Only use the dsr from the typeof-marked elements
					this.updatePos(dp.dsr[1]);
				}
				this.debug('tpl', this.startPos, this.curPos);
				// nothing to see here, move along..
				continue;
			} else if ( // need to fully serialize if there is no startPos
					this.startPos === null ||
					isModified ||
					// No DSR / DSR mismatch. TODO: ignore minor variations in
					// separator newlines
					!dp.dsr || dp.dsr[0] !== this.curPos )
			{

				// Mark element for serialization.
				this.markElementNode(node, isModified, dp );
				// And don't descend.
				continue;

			}

			if ( node.childNodes.length &&
					dp.dsr[2] !== null &&
					// Don't descend into html-pres for now.
					// FIXME: Handle pres properly in general!
					(nodeName !== 'pre' || dp.stx !== 'html') )
			{
				// Prepare for recursion
				if ( DU.isIndentPre(node) ) {
					this.inIndentPre = true;
				}

				// Remember positions before adjusting them for the child
				var lastID = this.currentId,
					lastRange = [this.startPos, this.curPos];
				// Try to update the position for the child
				if (dp && dp.dsr) {
					this.updatePos(dp.dsr[0] + dp.dsr[2]);
				}

				// Handle the subdom.
				this.doConvert(node, dp.dsr);

				if ( this.currentId !== lastID ) {
					// something was modified
					// gwicke: Try to disable this table / list heuristic- our
					// DSR is better now?
					if (nodeName === 'table' ||
							nodeName === 'ul' ||
							nodeName === 'ol' ||
							nodeName === 'dl' )
					{
						this.debug('lastrange', lastRange);
						// We want to fully serialize elements of this type
						// until our support for selective serialization in
						// these elements is improved. Hence, mark this node
						// for full serialization.
						this.markElementNode(node, true, dp, lastRange);
						lastModified = true;
					}
				}
				// reset pre state
				this.inIndentPre = inIndentPre;
			}

			// Move the position past the element.
			if (dp && dp.dsr && dp.dsr[1]) {
				//console.log( 'back up, update pos to', dp.dsr[1]);
				this.updatePos(dp.dsr[1]);
			}
		}
	}

	// Check if the expected end source offset still matches. If it does not,
	// content was removed.
	if ( parentDSR && parentDSR[3] !== null ) {
		var endPos = parentDSR[1] - parentDSR[3];
		if (this.curPos !== endPos) {
			this.debug('end pos mismatch', this.curPos, endPos, parentDSR);
			if ( this.startPos === null ) {
				this.startPos = this.curPos;
			}
			// Insert a modification marker
			this.insertModificationMarker(parentNode, null);
		}
		// Now jump over the gap
		this.debug('updating end pos to', endPos);
		this.updatePos(endPos);
	} else if ( parentNode.nodeName.toLowerCase() === 'body' &&
			this.startPos !== null &&
			this.startPos !== this.curPos )
	{
		this.insertModificationMarker(parentNode, null);
	}
};

/**
 * @method
 * @private
 *
 * Calculate the wikitext source text length for the content of a DOM
 * text node, depending on whether the text node is inside an indent-pre block
 * or not.
 *
 * FIXME: Fix DOMUtils.indentPreDSRCorrection to properly handle text nodes
 * that are not direct children of pre nodes, and use it instead of this code.
 * This code might break when the (optional) leading newline is stripped by
 * the HTML parser.
 *
 * @param {string} src
 * @param {boolean} inIndentPre Whether the text is in a pre.
 * @return {number} The length of the text.
 */
DiffToSelserConverter.prototype.srcTextLen = function( src, inIndentPre ) {
	if ( ! inIndentPre ) {
		return src.length;
	} else {
		var nlMatch = src.match(/\n/g),
			nlCount = nlMatch ? nlMatch.length : 0;
		return src.length + nlCount;
	}
};

/**
 * @method
 * @private
 *
 * Insert a modification marker meta with the current position. This starts a
 * new serialization chunk. Used to handle gaps in unmodified content.
 *
 * @param {Node} parentNode
 * @param {Node} beforeNode
 */
DiffToSelserConverter.prototype.insertModificationMarker = function ( parentNode, beforeNode ) {
	var modMarker = parentNode.ownerDocument.createElement('meta');
	modMarker.setAttribute('typeof', 'mw:DiffMarker');
	parentNode.insertBefore(modMarker, beforeNode);
	this.markElementNode(modMarker, false);
	this.startPos = null;
};

/**
 * @method
 * @private
 *
 * Wrap a bare (DSR-less) text or comment node in a span and set modification
 * markers on that, so that it is serialized out using the WTS.
 *
 * @param {TextNode/CommentNode} node
 * @param {boolean} modified
 * @param {Array} srcRange The range of the node's source.
 * @returns {HTMLElement} The wrapper span.
 */
DiffToSelserConverter.prototype.markTextOrCommentNode = function ( node, modified, srcRange ) {
	var wrapper = DU.wrapTextInTypedSpan(node, 'mw:DiffMarker');
	this.markElementNode(wrapper, modified, null, srcRange);
	return wrapper;
};

/**
 * @method
 * @private
 *
 * Set change information on an element node
 *
 * @param {HTMLElement} node
 * @param {boolean} modified
 * @param {Object} dp The future contents of the data-parsoid attribute on the node.
 * @param {Array} srcRange The range of the wikitext source of the node.
 */
DiffToSelserConverter.prototype.markElementNode = function ( node, modified, dp, srcRange ) {
	if ( ! srcRange && this.startPos !== null ) {
		srcRange = [this.startPos, this.curPos];
	}

	// Add serialization info to this node
	DU.setJSONAttribute(node, 'data-parsoid-serialize',
			{
				modified: modified,
				// might be undefined
				srcRange: srcRange
			} );

	if(modified) {
		// Increment the currentId
		this.currentId++;
		if( dp && dp.dsr ) {
			this.startPos = dp.dsr[1];
			this.updatePos(dp.dsr[1]);
		} else {
			this.startPos = null;
			this.curPos = null;
		}
	} else {
		if( dp && dp.dsr ) {
			this.startPos = dp.dsr[0];
			this.updatePos(dp.dsr[1]);
		} else {
			this.startPos = null;
			this.curPos = null;
		}
	}
};

/**
 * @method
 * @private
 *
 * Set startPos to curPos if it is null and move curPos by passed-in delta.
 *
 * @param {Number} delta
 */
DiffToSelserConverter.prototype.movePos = function ( delta ) {
	if ( this.curPos !== null && delta !== null ) {
		this.updatePos( this.curPos + delta );
	}
};

/**
 * @method
 * @private
 *
 * Update startPos (if null) and curPos to the passed-in position
 *
 * @param {Number} pos
 */
DiffToSelserConverter.prototype.updatePos = function ( pos ) {
	//console.log(pos);
	//console.trace();
	if ( pos !== undefined && pos !== null ) {
		if ( this.startPos === null ) {
			this.startPos = pos;
		}
		this.curPos = pos;
	}
};



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
	this.env = options.env || { conf : { parsoid : {} } };
	this.env.conf.parsoid.editMode = true;

	this.wts = options.wts || new WikitextSerializer( options );

	// The output wikitext collector
	this.wtChunks = [];

	this.serializeID = null;

	// Debug options
	this.trace = this.env.conf.parsoid.debug || (
		this.env.conf.parsoid.traceFlags &&
		(this.env.conf.parsoid.traceFlags.indexOf("selser") !== -1)
	);

	if ( this.trace ) {
		SelectiveSerializer.prototype.debug_pp = function () {
			Util.debug_pp.apply(Util, arguments);
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
 * Get a substring of the original wikitext
 *
 * @param {number} start The beginning of the source range.
 * @param {number} end The end of the source range.
 * @returns {string} The requested substring.
 */
SSP.getSource = function(start, end) {
	return this.env.page.src.substring( start, end );
};

/**
 * @method
 * @private
 *
 * The chunkCB handler for the WTS
 *
 * Assumption: separator source is passed in a single call.
 *
 * Selser uses WTS output in these cases:
 *
 * - separator: if adjacent node or parent is marked as modified
 *		-> pass flag from wts
 * - regular src: if node (or parent) is marked as modified
 *		-> flag
 * - regular src: if node (or parent) is marked for serialization, but is not
 *   actually modified (needed if dsr is not available)
 *		-> handled implicitly
 *
 * Otherwise, we pick up the original source from data-parsoid-serialize.
 *
 * TODO: Replace these callbacks with a single, simple chunkCB that gets an
 * 'unmodified', 'separator', 'modified' flag from the WTS.
 *
 * Only need to remember last flag state and last separator(s) then. Use
 * unmodified source (from range annotation on *modified* node) plus
 * separator, then fully serialized source.
 *
 * Consequence: Range annotations should not include IEW between unmodified
 * and modified elements.
 *
 * @param {string} res The Wikitext result of serialization.
 * @param {string/Object/null} dpsSource A JSON object representing the data-parsoid-serialize attribute of the node we're serializing.
 */
SSP.handleSerializedResult = function( res, dps, node ) {

	this.debug("---- dps:", dps || 'null', "----", JSON.stringify(res));

	if (dps) {
		// Possibly modified element source
		// Insert unmodified source from a srcRange in any case
		if (dps.srcRange) {
			if (!dps.modified && res && res.match(/^\s+$/)) {
				// separator
				this.wtChunks.push(res);
			}
			// ignore repeated callbacks with the same srcRange
			if ( this.rangeStart !== dps.srcRange[0] ) {
				this.rangeStart = dps.srcRange[0];
				var origSrc = this.getSource(dps.srcRange[0], dps.srcRange[1]) || '';
				// console.log('adding selser src', JSON.stringify(origSrc));
				this.wtChunks.push(origSrc);
			}
		}

		if (dps.modified) {
			// console.log('adding res src', JSON.stringify(res));
			// push the newly serialized wikitext
			this.wtChunks.push(res);
		}
	} else if (dps !== null) {
		console.trace();
	}

};

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
	var matchedRes, nonNewline, nls = 0, latestSerID = null,
		self = this;
	// gwicke: This does not seem to be needed any more?
	//Util.stripFirstParagraph( doc );

	if ( err || this.env.page.dom === null ) {
		// If there's no old source, fall back to non-selective serialization.
		this.wts.serializeDOM(doc, cb, finalcb);
	} else {
		// If we found text, then use this chunk callback.
		var diff = new DOMDiff(this.env).diff( doc );

		if ( ! diff.isEmpty ) {

			doc = diff.dom;

			// Add the serializer info
			new DiffToSelserConverter(this.env, doc).convert();

			if ( this.trace || ( this.env.conf.parsoid.dumpFlags &&
						this.env.conf.parsoid.dumpFlags.indexOf( 'dom:serialize-ids' ) !== -1) )
			{
				console.log( '----- DOM after assigning serializer state -----' );
				console.log( doc.outerHTML );
			}

			// Call the WikitextSerializer to do our bidding
			this.wts.serializeDOM(
					doc,
					this.handleSerializedResult.bind(this),
					function () {
						//console.log( 'chunks', self.wtChunks );
						cb( self.wtChunks.join( '' ) );
						finalcb();
					});
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
 * @param {string} src The wikitext source of the document.
 */
SSP.parseOriginalSource = function ( doc, cb, finalcb, err, src ) {
	var self = this,
		parserPipelineFactory = new ParserPipelineFactory( this.env ),
		parserPipeline = parserPipelineFactory.makePipeline( 'text/x-mediawiki/full' );

	// Makes sure that the src is available even when just fetched.
	this.env.page.src = src;

	// Parse the wikitext src to the original DOM, and pass that on to
	// doSerializeDOM
	parserPipeline.once( 'document', function ( origDoc ) {
		// XXX: need to get body with .tree.document.childNodes[0].childNodes[1] ?
		var body = origDoc.firstChild.childNodes[1];
		self.env.page.dom = body;
		console.log('calling doSerializeDOM');
		console.log(body.outerHTML);
		self.doSerializeDOM(null, doc, cb, finalcb);
	} );
	parserPipeline.process(src);
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
	if ( this.env.page.dom ) {
		this.doSerializeDOM(null, doc, cb, finalcb);
	} else if ( this.env.page.src ) {
		// Have the src, only parse the src to the dom
		this.parseOriginalSource( doc, cb, finalcb, null, this.env.page.src );
	} else {
		// Start by getting the old text of this page
		Util.getPageSrc( this.env, this.env.page.name,
				this.parseOriginalSource.bind(this, doc, cb, finalcb),
				this.env.page.id || null );
	}
};

if ( typeof module === 'object' ) {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}
