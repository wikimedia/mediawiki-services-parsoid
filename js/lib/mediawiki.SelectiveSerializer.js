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
	DoesNotExistError = apirql.DoesNotExistError;

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

	var trace = (this.env.traceFlags && (this.env.traceFlags.indexOf("selser") !== -1));
	if ( this.env.debug || trace ) {
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

/**
 * Helper function to check for a change marker.
 */
function hasChangeMarker( dataVeChanged ) {
	if ( dataVeChanged ) {
		return dataVeChanged['new'] || dataVeChanged.attributes ||
			dataVeChanged.content || dataVeChanged.annotations ||
			dataVeChanged.childrenRemoved || dataVeChanged.rebuilt;
	} else {
		return false;
	}
}

/**
 * Determine what needs to be serialized and what we can just carry over from
 * the old text, by assigning IDs to each node in the DOM that has changed.
 */
SSP.assignSerializerIds = function ( node, src, state ) {
	var child, thisda, thisdsr, dsr, nodesrc, hasRun,
		childHasStartDsr, oldstartdsr, oldId, tname, childname, backi, backdp,
		parentChangeMarkers, contentChanged;

	// state will hold our local state, this is different from the
	// WikitextSerializer state but will eventually be returned as the new
	// state for the SelectiveSerializer.
	state = state || {
		currentId: 1,
		originalSourceChunks: [],
		startdsr: null,
		foundChange: false,
		lastdsr: null,
		probablyPairSep: false,
		pairSeps: []
	};

	var assignSourceChunk = function ( index, start, end ) {
		if ( index && !state.originalSourceChunks[index] ) {
			state.originalSourceChunks[index] = src.substring( start, end );
		}
		if ( state.probablyPairSep === true ) {
			state.pairSeps[index] = true;
			state.probablyPairSep = false;
		}
	};

	for ( var i = 0; i < node.childNodes.length; i++ ) {
		child = node.childNodes[i];

		// data-ve-changed is what we watch for the change markers.
		thisda = Util.getJSONAttribute( child, 'data-ve-changed', {} );

		// data-parsoid has DSR information and possibly some things we'll need to
		// duplicate later for special cases.
		thisdsr = Util.getJSONAttribute( child, 'data-parsoid', {} ).dsr;

		childHasStartDsr = thisdsr && thisdsr[0] !== null;

		if ( !thisdsr && !child.setAttribute ) {
			// We can't mess with a text node, but we do need to avoid the
			// error caused by calling setAttribute on it.
			// However, we try to do the right thing by setting state.startdsr
			// to indicate where the previous element ended. Hopefully that
			// will make up for text and comment nodes not having any DSR.
			if ( state.startdsr === null && state.lastdsr !== null ) {
				state.startdsr = state.lastdsr;
				state.lastdsr = null;
				state.probablyPairSep = true;
			}
		} else if ( ( !childHasStartDsr && state.startdsr === null && state.foundChange ) ||
					hasChangeMarker( thisda ) )
		{
			// This is either a changed node that needs to be serialized or a node
			// without opening DSR that can't be copied over anyway, so we mark it
			// to the best of our ability and move on.
			if ( childHasStartDsr &&
				( state.startdsr !== null || !state.foundChange ) &&
				( state.lastdsr === null || thisdsr[0] < state.lastdsr ))
			{
				// In the case that we were in the middle of processing a series of
				// unchanged nodes, we use this node's startdsr as the end index if
				// possible.
				if ( state.startdsr === null ) {
					state.startdsr = 0;
				}
				assignSourceChunk( state.currentId, state.startdsr, thisdsr[0] );

				// Reset the start DSR, because we aren't processing identical nodes now.
				state.startdsr = null;
			} else if ( state.lastdsr !== null && (
						state.startdsr !== null || !state.foundChange ) ) {
				// If we were processing identical nodes and there is no start DSR on the
				// current node, we use the end DSR of the last node.
				if ( state.startdsr === null ) {
					state.startdsr = 0;
				}
				assignSourceChunk( state.currentId, state.startdsr, state.lastdsr );

				// Reset the start DSR, because we aren't processing identical nodes now.
				state.startdsr = null;
			}

			if ( hasChangeMarker( thisda ) ) {
				// Let the rest of the program know that something changed
				// in the source of the document.
				state.foundChange = true;
			}

			if ( !thisda || !thisda['new'] ) {
				// Make sure we reset lastdsr whenever we fully serialize
				// something that already existed in the original document.
				// Otherwise, the DSR would lead to duplication.
				if ( !thisdsr || !thisdsr[1] ) {
					state.lastdsr = null;
				}
			}

			// Actually set the serialize-id
			child.setAttribute( 'data-serialize-id', state.currentId++ );

			// Set this flag to indicate that something changed in a child, and the
			// parent should probably be marked with the same serialize ID. This helps
			// with processing tough things like lists and tables that might not work
			// otherwise.
			state.markedNodeName = child.tagName ? child.tagName.toLowerCase() : null;
		} else {
			// This node wasn't marked, but its children might be. Check first.
			oldId = state.currentId;
			oldstartdsr = state.startdsr;
			this.assignSerializerIds( child, src, state );

			if ( oldId === state.currentId && childHasStartDsr ) {
				// If no children were bothered, then this entire node can be copied
				// over verbatim. If there's no startdsr yet, set it.
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

					state.parentMarked = true;
				} else if (
						tname === 'ul' ||
						tname === 'ol' ||
						childname === 'i' ||
						childname === 'b' ) {
					child.setAttribute( 'data-serialize-id', oldId );
					state.markedNodeName = null;
					state.parentMarked = false;
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
					if ( childHasStartDsr ) {
						assignSourceChunk( oldId, oldstartdsr, thisdsr[0] );
					} else if ( state.lastdsr !== null ) {
						assignSourceChunk( oldId, oldstartdsr, state.lastdsr );
					}
					state.startdsr = null;
				}
				child.setAttribute( 'data-serialize-id', oldId );
				state.markedNodeName = null;
				state.parentMarked = false;
			}
		}
		if ( thisdsr ) {
			// Make sure we have the dsr[1] of the last node we processed, so
			// we can use it as a backup later if a changed node doesn't have
			// dsr[0]. Fall back to the last known dsr[1] otherwise.
			state.lastdsr = thisdsr[1] || state.lastdsr;
		}
	}

	return state;
};

SSP.serializeDOM = function( doc, cb, finalcb ) {
	var selser = this;

	// Get the old text of this page
	this.getOldText( function ( err, src ) {
		if ( err ) {
			throw err;
		}

		var chunkCB;
		var resWikitextChunks = [];
		var matchedRes, nonNewline, nls = 0, latestSerID = null;
		Util.stripFirstParagraph( doc );

		if ( src === null ) {
			// If there's no old source, fall back to non-selective serialization.
			chunkCB = cb;
			selser.wts.serializeDOM(doc, chunkCB, finalcb);
		} else {
			// If we found text, then use this chunk callback.
			var state = selser.assignSerializerIds( doc, src );

			// If we found text, then use this chunk callback.
			if ( selser.env.debug || ( selser.env.dumpFlags &&
				selser.env.dumpFlags.indexOf( 'dom:serialize-ids' ) !== -1) ) {
				console.log( '----- DOM after assigning serialize-ids -----' );
				console.log( doc.outerHTML );
			}

			// Helper function for accumulating source chunks.
			var originalSourceAccum = function ( index ) {
				var identicalChunk = state.originalSourceChunks[index] || '';

				if ( identicalChunk && (
						state.pairSeps[index] !== true ||
						identicalChunk.match( new RegExp( '[^' + identicalChunk[0] + ']' ) ) ) ) {
					selser.debug("[Identical] serID=", index, ", chunk: ", identicalChunk);
					resWikitextChunks.push( identicalChunk );
					state.originalSourceChunks[index] = null;
				}
			};

			if ( state && state.foundChange === true ) {
				chunkCB = function ( res, serID ) {
					selser.debug("serID=", serID || '', ", res: ", res);
					// Only handle something that actually has a serialize-ID,
					// else skip it for now.
					if ( serID ) {
						originalSourceAccum( Number( serID ));
						resWikitextChunks.push( res );
					}
				};

				// Call the WikitextSerializer to do our bidding
				selser.wts.serializeDOM( doc, chunkCB, function () {
					if ( state.startdsr !== null ) {
						var startSrc = src.substring( state.startdsr );
						selser.debug("[startdsr], src: ", startSrc);
						resWikitextChunks.push( startSrc );
					} else if ( state.lastdsr !== null ) {
						var lastSrc = src.substring( state.lastdsr );
						selser.debug("[lastdsr], src: ", lastSrc);
						resWikitextChunks.push( lastSrc );
					}

					cb( resWikitextChunks.join( '' ) );
					finalcb();
				} );
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

