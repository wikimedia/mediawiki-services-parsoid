/**
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
	NODE = require('./mediawiki.wikitext.constants.js').Node;

/**
 * Create a selective serializer.
 *
 * @arg options {object} Contains these members:
 *   * env - an instance of MWParserEnvironment, see Util.getParserEnv
 *   * oldtext - the old text of the document, if any
 *   * oldid - the ID of the old revision you want to compare to, if any (default to latest revision)
 *
 * If one of options.env.pageName or options.oldtext is set, we use the selective serialization
 * method, only reporting the serialized wikitext for parts of the page that changed. Else, we
 * fall back to serializing the whole DOM.
 */
var SelectiveSerializer = function ( options ) {
	this.wts = options.wts || new WikitextSerializer( options );
	this.env = options.env || {};
	this.target = this.env.pageName || null;
	this.oldtext = options.oldtext;
	this.oldid = options.oldid;
	this.trace = this.env.debug || (
		this.env.traceFlags && (this.env.traceFlags.indexOf("selser") !== -1)
	);

	if ( this.trace ) {
		SelectiveSerializer.prototype.debug_pp = function () {
			Util.debug_pp.apply(Util, arguments);
		};

		SelectiveSerializer.prototype.debug = function ( ) {
			this.debug_pp.apply(this, ["SS:", ' '].concat([].slice.apply(arguments)));
		};
	} else {
		SelectiveSerializer.prototype.debug_pp = function ( ) {};
		SelectiveSerializer.prototype.debug = function ( ) {};
	}
};

var SSP = SelectiveSerializer.prototype;

SSP.getOldText = function ( cb ) {
	if ( this.oldtext !== undefined ) {
		cb( null, this.oldtext );
	} else if ( this.env && this.target ) {
		Util.getPageSrc( this.env, this.target, cb, this.oldid || null );
	} else {
		cb( null, null );
	}
};

function SelserState(selser, src) {

	// Used to assign serialize-ids
	this.selser = selser; // required only for debug/trace flags
	this.src = src;
	this.wtChunks = [];

	/**
	 * detectDOMChanges state
	 * TODO: move out!
	 */
	this.currentId = 0;
	this.startPos = 0; // start offset of the current unmodified chunk
	this.curPos = 0; // end offset of the last processed node

	// current data-parsoid-serialize info or null
	this.dps = null;

	// Used only during serialization
	this.inModifiedContent = false;
	this.lastNLChunk = null;

	// The selective serializer-specific state exposed to the
	// WikitextSerializer (this.selser in WTS).
	this.selserState = {
		serializeInfo: null
		// callbacks are added in near serializeDOM call
	};

}

var SStateP = SelserState.prototype;

/**
 * Update startPos (if null) and curPos to the passed-in position
 */
SStateP.updatePos = function ( pos ) {
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
 * Set startPos to curPos if it is null and move curPos by passed-in delta.
 */
SStateP.movePos = function (delta) {
	if ( this.curPos !== null && delta !== null ) {
		this.updatePos( this.curPos + delta );
	}
};

/**
 * Get a substring of the original wikitext
 */
SStateP.getSource = function(start, end) {
	return this.src.substring( start, end );
};


/**
 * Helper function to check for a change marker.
 */
function hasChangeMarker( dvec ) {
	return dvec && (
			dvec['new'] || dvec.attributes ||
			dvec.content || dvec.annotations ||
			dvec.childrenRemoved || dvec.rebuilt
			);
}



/**
 * Set change information on an element node
 *
 * TODO: implement!
 */
function markElementNode(node, state, modified, dp, srcRange) {
	// Add serialization info to this node
	DU.setJSONAttribute(node, 'data-parsoid-serialize',
			{
				id: state.currentId,
				modified: modified,
				// let startPos override state.startPos
				srcRange: srcRange || [state.startPos, state.curPos]
			} );

	if ( !srcRange && state.startPos === null ) {
		console.error('startPos is null');
	}

	if(modified) {
		// Increment the currentId
		state.currentId++;
		if( dp && dp.dsr ) {
			// reset state positions
			state.startPos = dp.dsr[1];
			state.updatePos(dp.dsr[1]);
		} else {
			state.startPos = null;
			state.curPos = null;
		}
	} else {
		if( dp && dp.dsr ) {
			// reset state positions
			state.startPos = dp.dsr[0];
			state.updatePos(dp.dsr[1]);
		} else {
			state.startPos = null;
			state.curPos = null;
		}
	}
}

/**
 * Wrap a bare (DSR-less) text or comment node in a span and set modification
 * markers on that, so that it is serialized out using the WTS
 */
function markTextOrCommentNode(node, state, modified, srcRange) {
	var wrapperSpanNode = node.ownerDocument.createElement('span');
	wrapperSpanNode.setAttribute('typeof', 'mw:ChangeMarkerWrapper');
	// insert the span
	node.parentNode.insertBefore(wrapperSpanNode, node);
	// move the node into the wrapper span
	wrapperSpanNode.appendChild(node);
	markElementNode(wrapperSpanNode, state, modified, null, srcRange);
}

/**
 * Insert a modification marker meta with the current position. This starts a
 * new serialization chunk. Used to handle gaps in unmodified content.
 */
function insertModificationMarker(parentNode, beforeNode, state) {
	var modMarker = parentNode.ownerDocument.createElement('meta');
	modMarker.setAttribute('typeof', 'mw:ChangeMarker');
	parentNode.insertBefore(modMarker, beforeNode);
	markElementNode(modMarker, state, false);
	state.startPos = null;
}

/**
 * Utility: Calculate the wikitext source text length for the content of a DOM
 * text node, depending on whether the text node is inside an indent-pre block
 * or not.
 *
 * FIXME: Fix DOMUtils.indentPreDSRCorrection to properly handle text nodes
 * that are not direct children of pre nodes, and use it instead of this code.
 * This code might break when the (optional) leading newline is stripped by
 * the HTML parser.
 */
function srcTextLen ( src, inIndentPre ) {
	if ( ! inIndentPre ) {
		return src.length;
	} else {
		var nlMatch = src.match(/\n/g),
			nlCount = nlMatch ? nlMatch.length : 0;
		return src.length + nlCount;
	}
}

/**
 * Determine what needs to be serialized and what we can just carry over from
 * the old text, by assigning IDs to each node in the DOM that has changed.
 *
 * * track current dsr offset, also using the tsr (or isr?) if available
 * * append a new unmodified chunk / increment serializeID if:
 *	  startdsr !== null && (
 *		change marker
 *		|| element without data-parsoid (new content)
 *		|| dsr does not match up (gap not within separator range)
 *		|| text change: [lastdsr, nextdsr] source substr !== text node content
 *		later: || element change: compare outerHTML?
 *	  )
 *	  * insert span/meta with serializeID (serializing to empty string) for text
 *      change or dsr mismatch
 * * don't descend into mw content (rel, typeof or about with mwt)
 */
SSP.detectDOMChanges = function ( parentNode, state, parentDSR ) {

	var node;

	for ( var i = 0; i < parentNode.childNodes.length; i++ ) {
		node = parentNode.childNodes[i];
		var dvec = null,
			dp = null,
			src = '',
			nodeType = node.nodeType,
			nodeName = node.nodeName.toLowerCase(),
			inIndentPre = state.inIndentPre,
			isModified = false;

		//console.warn("n: " + node.nodeName + "; s: " +
		//		state.startPos + "; c: " + state.curPos);

		if ( nodeType === NODE.TEXT_NODE || nodeType === NODE.COMMENT_NODE ) {
			src = (node.nodeValue || '');
			if (nodeType === NODE.COMMENT_NODE) {
				src = '<!--' + src + '-->';
			}
			// Get the wikitext source length adjusted for any stripped
			// leading ws in indent-pre context
			var srcLen = srcTextLen(src, inIndentPre);
			if ( state.startPos === null )
				// Text diff detection is disabled currently, as it leads to a
				// few spurious change detections, mostly because of slightly
				// faulty dsr.
				// TODO: re-enable text diff detection after fixing some of
				// these dsr issues!
				//|| state.getSource(state.curPos, state.curPos + src.length) !== src
			{
				if (this.trace) {
					console.log('src diff:', JSON.stringify( [src,
								state.getSource(state.curPos, state.curPos + srcLen),
								state.curPos, state.curPos + srcLen]
								));
				}
				isModified = state.startPos !== null;
				// zero-length range
				//state.startPos = state.curPos;
				// TODO: implement
				markTextOrCommentNode(node, state,
						// modified?
						isModified);

				// The text was modified, so our positions are invalid now.
				state.startPos = null;
				state.curPos = null;
			} else {
				// not modified, just move along
				state.movePos(srcLen);
			}

		} else if ( nodeType === NODE.ELEMENT_NODE )
		{

			// data-ve-changed is what we watch for the change markers.
			dvec = Util.getJSONAttribute(node, 'data-ve-changed', {});
			// get data-parsoid
			dp = Util.getJSONAttribute( node, 'data-parsoid', null);


			isModified = hasChangeMarker(dvec) ||
				// no data-parsoid: new content
				! dp;
				// TODO: also *detect* element modifications without change
				// markers! use outerHTML?

			if (DU.isTplElementNode(this.env, node))
			{
				// Don't descend into template content
				var type = node.getAttribute('typeof');
				if(dp && dp.dsr && type.match(/^mw:Object/)) {
					// Only use the dsr from the typeof-marked elements
					state.updatePos(dp.dsr[1]);
				}
				this.debug('tpl', state.startPos, state.curPos);
				// nothing to see here, move along..
				continue;
			} else if ( // need to fully serialize if there is no startPos
					state.startPos === null ||
					isModified ||
					// No DSR / DSR mismatch. TODO: ignore minor variations in
					// separator newlines
					!dp.dsr || dp.dsr[0] !== state.curPos )
			{

				// Mark element for serialization.
				markElementNode(node, state, isModified, dp );
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
					state.inIndentPre = true;
				}

				// Remember positions before adjusting them for the child
				var lastID = state.currentId,
					lastRange = [state.startPos, state.curPos];
				// Try to update the position for the child
				if (dp && dp.dsr) {
					state.updatePos(dp.dsr[0] + dp.dsr[2]);
				}

				// Handle the subdom.
				this.detectDOMChanges(node, state, dp.dsr);

				if ( state.currentId !== lastID ) {
					// something was modified
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
						markElementNode(node, state, true, dp, lastRange);
					}
				}
				// reset pre state
				state.inIndentPre = inIndentPre;
			}

			// Move the position past the element.
			if (dp && dp.dsr && dp.dsr[1]) {
				//console.log( 'back up, update pos to', dp.dsr[1]);
				state.updatePos(dp.dsr[1]);
			}
		}
	}

	// Check if the expected end source offset still matches. If it does not,
	// content was removed.
	if ( parentDSR && parentDSR[3] !== null ) {
		var endPos = parentDSR[1] - parentDSR[3];
		if (state.curPos !== endPos) {
			this.debug('end pos mismatch', state.curPos, endPos, parentDSR);
			if ( state.startPos === null ) {
				state.startPos = state.curPos;
			}
			// Insert a modification marker
			insertModificationMarker(parentNode, null, state);
		}
		// Now jump over the gap
		this.debug('updating end pos to', endPos);
		state.updatePos(endPos);
	} else if ( parentNode.nodeName.toLowerCase() === 'body' &&
			state.startPos !== null &&
			state.startPos !== state.curPos )
	{
		insertModificationMarker(parentNode, null, state);
	}
};

/**
 * Handler that is called by the WikitextSerializer when starting to
 * serialize a node with data-parsoid-serialize set.
 */
SSP.dpsStartCB = function ( state, serializeInfo ) {
	// Reset the (string) data-parsoid-serialize copy watched by the WTS
	state.selserState.serializeInfo = null;
	if ( serializeInfo ) {
		try {
			// Try to decode data-parsoid-serialize
			var dps = JSON.parse(serializeInfo), origSrc;
			this.debug('dps', dps );
			state.dps = dps;
			// Check if this node is modified
			this.debug("inModified: ", state.inModifiedContent,
					" --> ", dps.modified);
			state.inModifiedContent = dps.modified;
			if ( dps.srcRange && dps.srcRange[0] !== dps.srcRange[1] ) {
				// get the unmodified source chunk preceding this node
				origSrc = state.getSource(dps.srcRange[0], dps.srcRange[1]) || '';
				if (dps.srcRange[0] && state.lastNLChunk) {
					// Insert separator newlines that the WTS emitted before
					// entering the marked node
					var leadingNLMatch = origSrc.match(/^\n+/);
					if ( leadingNLMatch ) {
						// don't duplicate newlines
						state.lastNLChunk = state.lastNLChunk.substr(leadingNLMatch[0].length);
					}
					state.wtChunks.push(state.lastNLChunk);
					this.debug("[NLs 1]:", state.lastNLChunk);
				}
				// clear the nl chunk
				state.lastNLChunk = null;
				// Remove trailing newlines from the original source- those
				// are buffered in the WTS and inserted when serializing the
				// content for that.
				origSrc = origSrc.replace(/\n+$/g,'');
				state.wtChunks.push(origSrc);
				this.debug("[Original]:", origSrc);
			} else {
				if (state.lastNLChunk) {
					state.wtChunks.push( state.lastNLChunk );
					this.debug("[NLs 2]:", state.lastNLChunk);
				}
				state.lastNLChunk = null;
			}
			// Set the serializeInfo passed on to callbacks by the WTS to the
			// special 'SEP' value. The first call to chunkCB from the WTS
			// will contain newline separators, and pass along this 'SEP' id.
			// The callback will then update the id to the value of
			// state.dps.id.
			state.selserState.serializeInfo = 'SEP';

		} catch ( e ) {
			console.error(e);
			console.error('ERROR: Could not handle data-parsoid-serialize attribute ' +
					serializeInfo);
		}
		state.afterEnd = false;
	}
};

SSP.handleSerializedResult = function( state, res, serID ) {

	this.debug("---- serID:", serID || '', "----");

	if( serID === undefined ) {
		console.trace();
	}

	if ( serID === 'SEP' ) {
		// NL-separators *before* fully serialized content
		this.debug("[MOD 2]:", res);
		state.wtChunks.push( res );
		state.lastNLChunk = null;
		// NL separators are handled, switch to the real serialize ID
		state.selserState.serializeInfo = state.dps.id;
	} else if ( state.inModifiedContent ) {
		// modified serialized content, append to buffer.
		this.debug("[MOD 1]:", res);
		state.wtChunks.push( res );
		state.lastNLChunk = null;
	} else if ( state.afterEnd && res.match(/^\n+$/) ) {
		// Remember the first (trailing) newline separator.
		if ( state.lastNLChunk === null ) {
			this.debug("saved NLS 2:", res);
			//console.trace();
			state.lastNLChunk = res;
		}
	} else if ( serID !== null ) {
		// unmodified content -- drop and clear saved nl-chunk
		this.debug("cleared NLS:", res);
		state.wtChunks.push( res );
		state.lastNLChunk = null;
	}
	state.afterEnd = false;

};

/**
 * Callback called when leaving a data-parsoid-serialize marked node in the
 * WikitextSerializer
 *
 *
 */
SSP.dpsEndCB = function ( state, serializeInfo ) {
	if ( state.dps ) {
		// Reset the state
		state.dps = null;
		state.selserState.serializeInfo = null;
		// No longer in modified content..
		this.debug("inModified:", state.inModifiedContent,
				" --> ", false);
		state.inModifiedContent = false;
		state.afterEnd = true;
	}
};


/**
 * The main serializer handler. Calls detectDOMChanges and prepares and calls
 * WikitextSerializer.serializeDOM if changes were found.
 */
SSP.serializeDOM = function( doc, cb, finalcb ) {
	var selser = this;

	// Get the old text of this page
	this.getOldText( function ( err, src ) {
		var matchedRes, nonNewline, nls = 0, latestSerID = null;
		Util.stripFirstParagraph( doc );

		if ( err || src === '' || src === null ) {
			// If there's no old source, fall back to non-selective serialization.
			selser.wts.serializeDOM(doc, cb, finalcb);
		} else {
			// If we found text, then use this chunk callback.
			var state = new SelserState(selser, src);
			selser.detectDOMChanges( doc, state );

			// Set up dps start / end callbacks
			state.selserState.dpsStartCB = selser.dpsStartCB.bind(selser, state);
			state.selserState.dpsEndCB = selser.dpsEndCB.bind(selser, state);
			state.selserState.serializeInfo = null;


			// If we found text, then use this chunk callback.
			if ( selser.trace || ( selser.env.dumpFlags &&
				selser.env.dumpFlags.indexOf( 'dom:serialize-ids' ) !== -1) )
			{
				console.log( '----- DOM after assigning serialize-ids -----' );
				console.log( doc.innerHTML );
				console.log( '-------- state: --------- ');
				console.log('startdsr: ' + state.startPos);
				console.log('lastdsr: ' + state.curPos);
			}

			if ( state && state.currentId ) {

				// Call the WikitextSerializer to do our bidding
				selser.wts.serializeDOM(
					doc,
					selser.handleSerializedResult.bind(selser, state),
					function () {
						cb( state.wtChunks.join( '' ) );
						finalcb();
					},
					// pass in selser state
					state.selserState
				);
			} else {
				// Nothing was modified, just re-use the original source
				cb( src );
				finalcb();
			}
		}
	} );
};

if ( typeof module === 'object' ) {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}

