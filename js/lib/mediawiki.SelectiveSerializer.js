'use strict';

/**
 * This is a Serializer class that will run through a DOM looking for special
 * change markers, usually supplied by an HTML5 WYSIWYG editor (like the
 * VisualEditor for MediaWiki), and determining what needs to be
 * serialized and what can simply be copied over.
 */

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
	var child, thisda, thisdp, thisdsr, dsr, nodesrc, hasRun,
		oldstartdsr, oldId, tname, backi, backdp,
		parentChangeMarkers, contentChanged;

	// state will hold our local state, this is different from the
	// WikitextSerializer state but will eventually be returned as the new
	// state for the SelectiveSerializer.
	state = state || {
		currentId: 1,
		originalSourceChunks: [],
		startdsr: null,
		foundChange: false,
		lastdsr: null
	};

	var assignSourceChunk = function ( index, start, end ) {
		if ( index && !state.originalSourceChunks[index] ) {
			state.originalSourceChunks[index] = src.substring( start, end );
		}
	};

	for ( var i = 0; i < node.childNodes.length; i++ ) {
		child = node.childNodes[i];

		// data-ve-changed is what we watch for the change markers.
		thisda = Util.getJSONAttribute( child, 'data-ve-changed', {} );

		// data-parsoid has DSR information and possibly some things we'll need to
		// duplicate later for special cases.
		thisdp = Util.getJSONAttribute( child, 'data-parsoid', {} );

		thisdsr = thisdp.dsr;

		if ( !thisdp.dsr && !child.setAttribute ) {
			// We can't mess with a text node, but we do need to avoid the
			// error caused by calling setAttribute on it.
			// However, we try to do the right thing by setting state.startdsr
			// to indicate where the previous element ended. Hopefully that
			// will make up for text and comment nodes not having any DSR.
			if ( state.startdsr === null && state.lastdsr !== null ) {
				state.startdsr = state.lastdsr;
				state.lastdsr = null;
			}
		} else if (
				(
					( state.foundChange && state.startdsr === null ) && (
						!thisdp.dsr || thisdp.dsr[0] === null 
					)
				) || hasChangeMarker( thisda ) ) {
			// This is either a changed node that needs to be serialized or a node
			// without opening DSR that can't be copied over anyway, so we mark it
			// to the best of our ability and move on.
			if (
					(
					 state.startdsr !== null || !state.foundChange
					) && thisdsr && thisdsr[0] && (
						!state.lastdsr || thisdsr[0] < state.lastdsr ) ) {
				// In the case that we were in the middle of processing a series of
				// unchanged nodes, we use this node's startdsr as the end index if
				// possible.
				if ( state.startdsr === null ) {
					state.startdsr = 0;
				}
				assignSourceChunk( state.currentId, state.startdsr, thisdsr[0] );

				// Reset the start DSR, because we aren't processing identical nodes now.
				state.startdsr = null;
			} else if (
					state.lastdsr && (
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

			if ( !thisda || !thisda.new ) {
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
			state.parentMarked = false;
		} else {
			// This node wasn't marked, but its children might be. Check first.
			oldId = state.currentId;
			oldstartdsr = state.startdsr;
			this.assignSerializerIds( child, src, state );

			if ( oldId === state.currentId && thisdsr && (
					thisdsr[0] !== null ) ) {
				// If no children were bothered, then this entire node can be copied
				// over verbatim. If there's no startdsr yet, set it.
				if ( state.startdsr === null ) {
					state.startdsr = thisdsr[0];
				}
			} else if ( oldId !== state.currentId && state.parentMarked === false ) {
				// If the serializeID changed while processing this node's children, then
				// we can't copy it over entirely. If this particular node type needs
				// special handling, we need to do that now.

				// Special case handling for specific tags.
				tname = child.tagName ? child.tagName.toLowerCase() : 'tbody';
				if ( tname === 'tbody' || tname === 'thead' ) {
					child.setAttribute( 'data-serialize-id', oldId );

					state.parentMarked = true;
				} else if ( tname === 'ul' || tname === 'ol' ) {
					child.setAttribute( 'data-serialize-id', oldId );
					delete state.parentMarked;
				} else if ( state.lastdsr !== null && state.startdsr === null ) {
					state.startdsr = state.lastdsr;
				}
			} else if ( oldId !== state.currentId && state.parentMarked === true ) {
				// This is a special case for parents who were marked as
				// changed because of a child, if a child was not tbody or
				// thead then we can safely copy this source chunk into the
				// final list.

				// First get the DSR of the parent from our backup.
				state.startdsr = oldstartdsr;
				if ( oldstartdsr !== null ) {
					// If there's a chunk of unmodified code in progress,
					// finish it first.
					if ( thisdsr && thisdsr[0] !== null ) {
						state.originalSourceChunks[oldId] = src.substring(
							oldstartdsr,
							thisdsr[0] );
					} else if ( state.lastdsr ) {
						state.originalSourceChunks[oldId] = src.substring( oldstartdsr, state.lastdsr );
					}
					state.startdsr = null;
				}
				child.setAttribute( 'data-serialize-id', oldId );
				delete state.parentMarked;
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
	var _this = this;

	// Get the old text of this page
	this.getOldText( function ( err, src ) {
		var foundRevisions = err === null;
		var resWikitextChunks = [];
		var chunkCB;
		var matchedRes, nonNewline, nls = 0, latestSerID = null;
		Util.stripFirstParagraph( doc );
		if ( foundRevisions ) {
			// If we found text, then use this chunk callback.
			var state = _this.assignSerializerIds( doc, src );
			if ( _this.env.debug ) {
				console.log( doc.outerHTML );
			}
			var getLeadingNls = function ( chunk ) {
				return ( chunk.match( /^\n+/ ) || [ '' ] )[0];
			};

			var pushIdentical = function ( index ) {
				var identicalChunk = state.originalSourceChunks[index] || '';
				var leadingNewlines = getLeadingNls( identicalChunk );

				if ( identicalChunk && leadingNewlines.length < identicalChunk.length ) {
					resWikitextChunks.push( identicalChunk );
					state.originalSourceChunks[index] = null;
				}
			};

			if ( state && state.foundChange === true ) {
				chunkCB = function ( res, serID ) {
					var lnls;

					// Special handling for preceding newlines
					if (
							nls &&
							latestSerID !== null &&
							serID === null &&
							res !== '' ) {
						matchedRes = getLeadingNls( res );
						nonNewline = ( res.match( /[^\n]/ ) || [ '' ] )[0];

						if ( matchedRes.length > nls ) {
							resWikitextChunks.push( matchedRes.substring( 0, nls ) );
							nls = 0;
						} else {
							resWikitextChunks.push( matchedRes );
							nls -= matchedRes.length;
						}
						if ( nonNewline ) {
							nls = 0;
							latestSerID = null;
						}
					}

					if ( res === '' ) {
						nls++;
					}
					
					// Only handle something that actually has a serialize-ID,
					// else skip it for now.
					if ( serID  ) {
						serID = Number( serID );

						if ( latestSerID !== serID && nls !== 0 ) {
							pushIdentical( latestSerID );
						}

						latestSerID = serID;
						if ( res !== '' ) {
							nls = 0;
							pushIdentical( serID );

							// Unconditionally add the result of the serialization to
							// the end result.
							resWikitextChunks.push( res );
						}
					}
				};
			}
		} else if ( err === null ) {
			// If there's no old source, fall back to non-selective serialization.
			chunkCB = cb;
		} else {
			throw err;
		}

		if ( state && state.foundChange === true ) {
			// Call the WikitextSerializer to do our bidding
			_this.wts.serializeDOM( doc, chunkCB, function () {
				if ( foundRevisions ) {
					if ( state.startdsr !== null ) {
						resWikitextChunks.push( src.substring( state.startdsr ) );
					} else if ( state.lastdsr !== null ) {
						resWikitextChunks.push( src.substring( state.lastdsr ) );
					}

					cb( resWikitextChunks.join( '' ) );
				}

				finalcb();
			} );
		} else if ( foundRevisions ) {
			cb( src );
			finalcb();
		} else {
			throw new Error( 'Could not figure any way to serialize.' );
		}
	} );
};

if ( typeof module === 'object' ) {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}

