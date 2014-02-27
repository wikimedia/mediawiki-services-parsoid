"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

/* ------------------------------------------------------------------------
 * Non-IEW (inter-element-whitespace) can only be found in <td> <th> and
 * <caption> tags in a table.  If found elsewhere within a table, such
 * content will be moved out of the table and be "adopted" by the table's
 * sibling ("foster parent"). The content that gets adopted is "fostered
 * content".
 *
 * http://dev.w3.org/html5/spec-LC/tree-construction.html#foster-parenting
 * ------------------------------------------------------------------------ */

// cleans up transclusion shadows, keeping track of fostered transclusions
function removeTransclusionShadows( node ) {
	var sibling, dp, fosteredTransclusions = false;
	if ( DU.isElt( node ) ) {
		dp = DU.getDataParsoid( node );
		if ( DU.isMarkerMeta( node, "mw:TransclusionShadow" ) ) {
			DU.deleteNode( node );
			return true;
		} else if ( dp.inTransclusion ) {
			fosteredTransclusions = true;
			delete dp.inTransclusion;
		}
		node = node.firstChild;
		while ( node ) {
			sibling = node.nextSibling;
			if ( removeTransclusionShadows( node ) ) {
				fosteredTransclusions = true;
			}
			node = sibling;
		}
	}
	return fosteredTransclusions;
}

// inserts metas around the fosterbox and table
function insertTransclusionMetas( env, fosterBox, table ) {

	var aboutId = env.newAboutId(),
		dp = DU.getDataParsoid( table );

    // You might be asking yourself, why is table.data.parsoid.tsr[1] always
	// present? The earlier implementation searched the table's siblings for
	// their tsr[0]. However, encapsulation doesn't happen when the foster box,
	// and thus the table, are in the transclusion.
	var s = DU.createNodeWithAttributes( fosterBox.ownerDocument, "meta", {
		"about": aboutId,
		"id": aboutId.substring( 1 ),
		"typeof": "mw:Transclusion",
		"data-parsoid": JSON.stringify({ "tsr": dp.tsr })
	});
	fosterBox.parentNode.insertBefore( s, fosterBox );

	var e = DU.createNodeWithAttributes( table.ownerDocument, "meta", {
		"about": aboutId,
		"typeof": "mw:Transclusion/End"
	});

	var sibling = table.nextSibling;

	// skip table end mw:shadow
	if ( sibling && DU.isMarkerMeta( sibling, "mw:EndTag" ) ) {
		sibling = sibling.nextSibling;
	}

	// special case where the table end and inner transclusion coincide
	if ( sibling && DU.isMarkerMeta( sibling, "mw:Transclusion/End" ) ) {
		sibling = sibling.nextSibling;
	}

	table.parentNode.insertBefore( e, sibling );

}

// Searches for FosterBoxes and does two things when it hits one:
// * Marks all nextSiblings as fostered until the accompanying table.
// * Wraps the whole thing (table + fosterbox) with transclusion metas if
//   there is any fostered transclusion content.
function markFosteredContent( node, env ) {
	var span, sibling, next, dp, fosteredTransclusions, c = node.firstChild;

	while ( c ) {
		sibling = c.nextSibling;
		fosteredTransclusions = false;

		if ( DU.isNodeOfType( c, "table", "mw:FosterBox" ) ) {

			// mark as fostered until we hit the table
			while ( sibling && ( !DU.isElt( sibling ) || !DU.hasNodeName( sibling, "table" ) ) ) {
				next = sibling.nextSibling;
				if ( DU.isElt( sibling ) ) {
					dp = DU.getDataParsoid( sibling );
					dp.fostered = true;
					if ( removeTransclusionShadows( sibling ) ) {
						fosteredTransclusions = true;
					}
				} else {
					span = sibling.ownerDocument.createElement( "span" );
					DU.setNodeData( span, { parsoid: { fostered: true } } );
					sibling.parentNode.insertBefore( span, sibling );
					span.appendChild( sibling );
				}
				sibling = next;
			}

			// we should be able to reach the table from the fosterbox
			console.assert( sibling && DU.isElt( sibling ) && DU.hasNodeName( sibling, "table" ), "Table isn't a sibling. Something's amiss!" );

			// we have fostered transclusions
			// wrap the whole thing in a transclusion
			if ( fosteredTransclusions ) {
				insertTransclusionMetas( env, c, sibling );
			}

			// remove the foster box
			DU.deleteNode( c );

		} else if ( DU.isMarkerMeta( c, "mw:TransclusionShadow" ) ) {
			DU.deleteNode( c );
		} else if ( DU.isElt( c ) ) {
			dp = DU.getDataParsoid( c );
			delete dp.inTransclusion;
			if ( c.childNodes.length > 0 ) {
				markFosteredContent( c, env );
			}
		}

		c = sibling;
	}

}

if ( typeof module === "object" ) {
	module.exports.markFosteredContent = markFosteredContent;
}
