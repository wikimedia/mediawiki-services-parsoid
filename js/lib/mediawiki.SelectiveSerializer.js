/**
 * This is a Serializer class that will run through a DOM looking for special
 * change markers, usually supplied by an HTML5 WYSIWYG editor (like the
 * VisualEditor for MediaWiki), and determining what needs to be
 * serialized and what can simply be copied over.
 */

'use strict';

var WikitextSerializer = require( './mediawiki.WikitextSerializer.js' ).WikitextSerializer,
	Util = require( './mediawiki.Util.js' ).Util,
	apirql = require( './mediawiki.ApiRequest.js' ),
	DoesNotExistError = apirql.DoesNotExistError,
	Node = require('./mediawiki.wikitext.constants.js').Node;

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
	this.wtChunks = [];
	this.trace = this.env.debug || (
		this.env.traceFlags && (this.env.traceFlags.indexOf("selser") !== -1)
	);

	if ( this.trace ) {
		SelectiveSerializer.prototype.debug_pp = function () {
			Util.debug_pp.apply(Util, arguments);
		};

		SelectiveSerializer.prototype.debug = function ( ) {
			this.debug_pp.apply(this, ["SS: ", ''].concat([].slice.apply(arguments)));
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
		cb(
			new Error(
				'Error in Selective Serializer: fetching the original page source for revision ' +
				this.oldid + ' of ' + this.target + ' failed.'
			), ''
		);
	}
};

function SelserState(selser, sourceWT) {
	// Used "everywhere"
	this.foundChange = false;

	// Used to assign serialize-ids
	this.selser = selser; // required only for debug/trace flags
	this.sourceWT = sourceWT;
	this.currentId = 1;
	this.startdsr = 0; // start offset of the current unmodified chunk
	this.lastdsr = null; // end offset of the last processed node
	this.missingSourceChunkId = null; // serialize-id for which we couldn't assign an unmodified source chunk

	// Set during serialize-id assignment
	// and used during serialization
	this.originalSourceChunks = [];
	this.lastModifiedChunkEnd = null; // end offset of the last modified chunk

	// Used only during serialization
	this.inModifiedContent = false;
	this.lastNLChunk = null;

	this.getUnmodifiedSource = function(serID) {
		return this.originalSourceChunks[serID];
	};

	this.assignSourceChunk = function( serID, start, end ) {
		var chunk = this.getUnmodifiedSource(serID);
		if ( chunk === undefined || chunk === null ) {
			// Sanity check
			if (start > end) {
				if (selser.trace) {
					console.error("ERROR: (start > end) for " + serID + ";  start: " + start + "; end: " + end);
					console.trace();
				}
				return;
			}

			// Strip all leading/trailing newlines since they
			// will come through via the regular serializer
			chunk = this.sourceWT.substring( start, end ).replace(/(^\n+|\n+$)/g, '');
			this.originalSourceChunks[serID] = chunk;
			selser.debug(
				"serId: ", serID,
				", start:", start,
				", end:", end,
				", chunk:", chunk);
		} else if (selser.trace) {
			// Sanity check
			console.error("ERROR: (duplicate assignment) for " + serID + "; start: " + start + "; end: " + end);
			console.trace();
		}
	};

	this.clearSourceChunk = function(serID) {
		this.originalSourceChunks[serID] = null;
	};

	this.updateSourceChunk = function( serID, start, end ) {
		this.clearSourceChunk(serID);
		if (start === null) {
			this.missingSourceChunkId = serID;
		} else {
			this.assignSourceChunk(serID, start, end);
			this.startdsr = null;
		}
	};
};

/**
 * Determine what needs to be serialized and what we can just carry over from
 * the old text, by assigning IDs to each node in the DOM that has changed.
 */
SSP.assignSerializerIds = function ( node, state ) {
	/**
	 * Helper function to check for a change marker.
	 */
	function hasChangeMarker( dataVeChanged ) {
		return dataVeChanged && (
			dataVeChanged['new'] || dataVeChanged.attributes ||
			dataVeChanged.content || dataVeChanged.annotations ||
			dataVeChanged.childrenRemoved || dataVeChanged.rebuilt
		);
	}

	var thisda, thisdsr, childHasStartDsr, oldstartdsr, oldId, tname, childname;

	for ( var i = 0; i < node.childNodes.length; i++ ) {
		var child = node.childNodes[i],
			nodeType = child.nodeType,
			modified = false;

		// console.warn("n: " + child.nodeName + "; s: " + state.startdsr + "; l: " + state.lastdsr);

		// data-ve-changed is what we watch for the change markers.
		thisda = Util.getJSONAttribute( child, 'data-ve-changed', {} );

		// data-parsoid has DSR information and possibly some things we'll need to
		// duplicate later for special cases.
		thisdsr = Util.getJSONAttribute( child, 'data-parsoid', {} ).dsr;

		childHasStartDsr = thisdsr && thisdsr[0] !== null;

		if ( !thisdsr && (nodeType === Node.TEXT_NODE || nodeType === Node.COMMENT_NODE) ) {
			// Update dsr values
			if ( state.startdsr === null && state.lastdsr !== null ) {
				state.startdsr = state.lastdsr;
				state.lastdsr = null;
			}
		} else if ( !childHasStartDsr && state.startdsr === null ) {
			// This node does not have have a start-dsr ==> cannot be copied from src.
			// So treat it as a modified node and move on.

			// console.warn("--missing start dsr--");

			child.setAttribute( 'data-serialize-id', state.currentId++ );
			modified = true;

			if ( hasChangeMarker( thisda ) ) {
				state.foundChange = true;
			}

			// Make sure we reset lastdsr whenever we fully serialize
			// something that already existed in the original document.
			// Otherwise, the DSR would lead to duplication.
			if ( (!thisda || !thisda['new']) && ( !thisdsr || !thisdsr[1] )) {
				state.lastdsr = null;
			}

			// FIXME: This can overwrite previously set values.  What is the
			// expected behavior in that case?
			//
			// Set this flag to indicate that something changed in a child, and the
			// parent should probably be marked with the same serialize ID. This helps
			// with processing tough things like lists and tables that might not work
			// otherwise.
			state.markedNodeName = child.tagName ? child.tagName.toLowerCase() : null;
		} else if ( hasChangeMarker( thisda ) ) {

			// console.warn("--found change marker--");

			if (state.startdsr !== null || !state.foundChange) {
				// SSS FIXME: Not sure what this check is doing ...
				var usableDsr0 = childHasStartDsr && (state.lastdsr === null || thisdsr[0] < state.lastdsr );
				if (usableDsr0 || state.lastdsr !== null) {
					// In the case that we were in the middle of processing a series of
					// unchanged nodes, we use this node's startdsr as the end index if
					// possible.
					state.assignSourceChunk(
						state.currentId,
						state.startdsr,
						usableDsr0 ? thisdsr[0] : state.lastdsr
					);
				} else {
					// console.warn("== missing! ==");
					state.missingSourceChunkId = state.currentId;
				}
			}

			state.foundChange = true;
			child.setAttribute( 'data-serialize-id', state.currentId++ );
			modified = true;

			// No longer in an unmodified chunk
			state.startdsr = null;

			// Make sure we reset lastdsr whenever we fully serialize
			// something that already existed in the original document.
			// Otherwise, the DSR would lead to duplication.
			if ( (!thisda || !thisda['new']) && ( !thisdsr || !thisdsr[1] )) {
				state.lastdsr = null;
			}

			// FIXME: This can overwrite previously set values.  What is the
			// expected behavior in that case?
			//
			// Set this flag to indicate that something changed in a child, and the
			// parent should probably be marked with the same serialize ID. This helps
			// with processing tough things like lists and tables that might not work
			// otherwise.
			state.markedNodeName = child.tagName ? child.tagName.toLowerCase() : null;
		} else {
			// This node wasn't marked, but its children might be. Check first.
			oldId = state.currentId;
			oldstartdsr = state.startdsr;

			// Process DOM rooted at 'child'
			this.assignSerializerIds( child, state );

			if (state.missingSourceChunkId) {
				modified = true;
				child.setAttribute( 'data-serialize-id', state.missingSourceChunkId );
				if (childHasStartDsr && oldstartdsr !== null) {
					state.assignSourceChunk(
						state.missingSourceChunkId,
						oldstartdsr,
						thisdsr[0]
					);
					state.missingSourceChunkId = null;
					state.startdsr = null;
				}
			} else if ( oldId === state.currentId && (childHasStartDsr || state.startdsr === null)) {
				// No modifications in child's DOM.
				// It can be copied over from src.
				if ( state.startdsr === null ) {
					state.startdsr = thisdsr[0];
				}
			} else if ( oldId !== state.currentId && state.markedNodeName !== null ) {
				// If the serializeID changed while processing this node's children, then
				// we can't copy it over entirely. If this particular node type needs
				// special handling, we need to do that now.

				// Special case handling for specific tags.
				tname = child.tagName ? child.tagName.toLowerCase() : 'tbody';
				childname = state.markedNodeName;
				if ( tname === 'tbody' || tname === 'thead' ) {
					child.setAttribute( 'data-serialize-id', oldId );
					modified = true;
					state.parentMarked = true;
					state.updateSourceChunk(
						oldId,
						oldstartdsr,
						childHasStartDsr ? thisdsr[0] : state.lastdsr
					);
				} else if (
						tname === 'ul' ||
						tname === 'ol' ||
						childname === 'i' ||
						childname === 'b' )
				{
					child.setAttribute( 'data-serialize-id', oldId );
					modified = true;
					state.markedNodeName = null;
					state.parentMarked = false;

					state.updateSourceChunk(
						oldId,
						oldstartdsr,
						childHasStartDsr ? thisdsr[0] : state.lastdsr
					);
				} else if ( state.lastdsr !== null && state.startdsr === null ) {
					state.startdsr = state.lastdsr;
				}
			} else if ( oldId !== state.currentId && state.parentMarked ) {
				// This is a special case for parents who were marked as
				// changed because of a child, if a child was not tbody or
				// thead then we can safely copy this source chunk into the
				// final list.

				// First get the DSR of the parent from our backup.
				state.startdsr = oldstartdsr;
				if ( oldstartdsr !== null ) {
					// If there's a chunk of unmodified code in progress,
					// finish it first.
					state.updateSourceChunk(
						oldId,
						oldstartdsr,
						childHasStartDsr ? thisdsr[0] : state.lastdsr
					);
				}
				child.setAttribute( 'data-serialize-id', oldId );
				state.markedNodeName = null;
				state.parentMarked = false;
			}
		}

		if ( thisdsr ) {
			if (modified) {
				state.lastModifiedChunkEnd = thisdsr[1];
			}

			// Make sure we have the dsr[1] of the last node we processed, so
			// we can use it as a backup later if a changed node doesn't have
			// dsr[0]. Fall back to the last known dsr[1] otherwise.
			state.lastdsr = thisdsr[1] || state.lastdsr;
		}

		// If this node has a serialize-id but we couldn't
		// assign an unmodified source chunk to it, we bail and
		// mark the parent instead.
		if (state.missingSourceChunkId) {
			return;
		}
	}

	return;
};

SSP.handleSerializedResult = function( state, res, serID ) {

	var before = state.inModifiedContent;
	this.debug("---- serID: ", serID || '', " ----");

	if ( serID ) {
		if (!state.inModifiedContent) {
			// 1. original unmodified source preceding this
			// modified serialized content
			state.inModifiedContent = true;
			var origSrc = state.getUnmodifiedSource(serID) || '';
			this.wtChunks.push( origSrc);
			this.debug("[Original]: ", origSrc);

			// 2. separator nls between the unmodified & modified content
			if (state.lastNLChunk) {
				this.wtChunks.push( state.lastNLChunk );
				this.debug("[NLs]: ", state.lastNLChunk);
				state.lastNLChunk = null;
			}
		}

		// modified serialized content
		this.debug("[MOD]: ", res);
		this.wtChunks.push( res );
	} else if (res.match(/^\n*$/)) {
		// NL-separators
		// - push out if we are in modified content
		// - stash if we are in unmodified content
		if (state.inModifiedContent) {
			this.debug("[MOD]: ", res);
			this.wtChunks.push( res );
		} else {
			this.debug("saved NLS: ", res);
			state.lastNLChunk = res;
		}
	} else {
		// in unmodified content -- ignore and clear saved nl-chunk
		this.debug("cleared NLS");
		state.inModifiedContent = false;
		state.lastNLChunk = null;
	}

	this.debug("inModified-before: ", before, ", inModified-after: ", state.inModifiedContent);
};

SSP.serializeDOM = function( doc, cb, finalcb ) {
	var selser = this;

	// Get the old text of this page
	this.getOldText( function ( err, src ) {
		if ( err ) {
			throw err;
		}

		var matchedRes, nonNewline, nls = 0, latestSerID = null;
		Util.stripFirstParagraph( doc );

		if ( src === null ) {
			// If there's no old source, fall back to non-selective serialization.
			selser.wts.serializeDOM(doc, cb, finalcb);
		} else {
			// If we found text, then use this chunk callback.
			var state = new SelserState(selser, src);
			selser.assignSerializerIds( doc, state );

			// If we found text, then use this chunk callback.
			if ( selser.trace || ( selser.env.dumpFlags &&
				selser.env.dumpFlags.indexOf( 'dom:serialize-ids' ) !== -1) )
			{
				console.log( '----- DOM after assigning serialize-ids -----' );
				console.log( doc.outerHTML );
				console.log( '-------- state: --------- ');
				console.log('startdsr: ' + state.startdsr);
				console.log('lastdsr: ' + state.lastdsr);
				console.log('last-mod-chunk-end: ' + state.lastModifiedChunkEnd);
			}

			if ( state && state.foundChange === true ) {
				// Call the WikitextSerializer to do our bidding
				selser.wtChunks = [];
				selser.wts.serializeDOM(
					doc,
					selser.handleSerializedResult.bind(selser, state),
					function () {
						if ( state.lastModifiedChunkEnd !== null ) {
							var startSrc = src.substring( state.lastModifiedChunkEnd ).replace(/^\n*/, '');
							selser.debug("[startdsr], src: ", startSrc);
							selser.wtChunks.push( startSrc );
						}

						cb( selser.wtChunks.join( '' ) );
						finalcb();
					}
				);
			} else {
				cb( src );
				finalcb();
			}
		}
	} );
};

if ( typeof module === 'object' ) {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}

