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

function markFosteredContent( node, env ) {
	var span, sibling, c = node.firstChild;

	while ( c ) {
		sibling = c.nextSibling;

		if ( DU.isMarkerMeta( c, "mw:FosterBox" ) ) {
			while ( sibling && (
				!DU.isElt( sibling ) || !DU.hasNodeName( sibling, "table" )
			) ) {
				if ( DU.isElt( sibling ) ) {
					sibling.data.parsoid.fostered = true;
				} else {
					span = sibling.ownerDocument.createElement( "span" );
					span.data = { parsoid: { fostered: true } };
					sibling.parentNode.insertBefore( span, sibling );
					span.appendChild( sibling );
				}
				sibling = sibling.nextSibling;
			}
			DU.deleteNode( c );
		}

		if ( c.childNodes.length > 0 ) {
			markFosteredContent( c, env );
		}

		c = sibling;
	}

}

if ( typeof module === "object" ) {
	module.exports.markFosteredContent = markFosteredContent;
}