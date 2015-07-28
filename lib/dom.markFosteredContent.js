'use strict';

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;


/* ------------------------------------------------------------------------
 * Non-IEW (inter-element-whitespace) can only be found in <td> <th> and
 * <caption> tags in a table.  If found elsewhere within a table, such
 * content will be moved out of the table and be "adopted" by the table's
 * sibling ("foster parent"). The content that gets adopted is "fostered
 * content".
 *
 * http://www.w3.org/TR/html5/syntax.html#foster-parent
 * ------------------------------------------------------------------------ */

// cleans up transclusion shadows, keeping track of fostered transclusions
function removeTransclusionShadows(node) {
	var sibling;
	var fosteredTransclusions = false;
	if (DU.isElt(node)) {
		var dp = DU.getDataParsoid(node);
		if (DU.isMarkerMeta(node, "mw:TransclusionShadow")) {
			DU.deleteNode(node);
			return true;
		} else if (dp.inTransclusion) {
			fosteredTransclusions = true;
			dp.inTransclusion = undefined;
		}
		node = node.firstChild;
		while (node) {
			sibling = node.nextSibling;
			if (removeTransclusionShadows(node)) {
				fosteredTransclusions = true;
			}
			node = sibling;
		}
	}
	return fosteredTransclusions;
}

// inserts metas around the fosterbox and table
function insertTransclusionMetas(env, fosterBox, table) {
	var aboutId = env.newAboutId();
	var dp = DU.getDataParsoid(table);

	// You might be asking yourself, why is table.data.parsoid.tsr[1] always
	// present? The earlier implementation searched the table's siblings for
	// their tsr[0]. However, encapsulation doesn't happen when the foster box,
	// and thus the table, are in the transclusion.
	var s = DU.createNodeWithAttributes(fosterBox.ownerDocument, "meta", {
		"about": aboutId,
		"id": aboutId.substring(1),
		"typeof": "mw:Transclusion",
		"data-parsoid": JSON.stringify({ "tsr": dp.tsr }),
	});
	fosterBox.parentNode.insertBefore(s, fosterBox);

	var e = DU.createNodeWithAttributes(table.ownerDocument, "meta", {
		"about": aboutId,
		"typeof": "mw:Transclusion/End",
	});

	var sibling = table.nextSibling;
	var beforeText;

	// skip pass the table end mw:shadow and any transclusions that
	// start inside the table. there may be newlines and comments in
	// between so keep track of that, and backtrack when necessary.
	while (sibling) {
		if (!DU.isTplStartMarkerMeta(sibling) && (
			DU.isTplOrExtToplevelNode(sibling) ||
			DU.isMarkerMeta(sibling, "mw:EndTag") ||
			DU.isMarkerMeta(sibling, "mw:TransclusionShadow")
		)) {
			sibling = sibling.nextSibling;
			beforeText = null;
		} else if (DU.isComment(sibling) || DU.isText(sibling)) {
			if (!beforeText) {
				beforeText = sibling;
			}
			sibling = sibling.nextSibling;
		} else {
			break;
		}
	}

	table.parentNode.insertBefore(e, beforeText ? beforeText : sibling);

}

// Searches for FosterBoxes and does two things when it hits one:
// * Marks all nextSiblings as fostered until the accompanying table.
// * Wraps the whole thing (table + fosterbox) with transclusion metas if
//   there is any fostered transclusion content.
function markFosteredContent(node, env) {
	function getFosterContentHolder(doc, inPTag) {
		var fosterContentHolder = doc.createElement(inPTag ? "span" : "p");
		DU.setNodeData(fosterContentHolder, { parsoid: { fostered: true } });
		return fosterContentHolder;
	}

	var span, sibling, next, dp, fosteredTransclusions;
	var c = node.firstChild;

	while (c) {
		sibling = c.nextSibling;
		fosteredTransclusions = false;

		if (DU.isNodeOfType(c, "table", "mw:FosterBox")) {
			var inPTag = DU.hasAncestorOfName(c.parentNode, "p");
			var fosterContentHolder = getFosterContentHolder(c.ownerDocument, inPTag);

			// mark as fostered until we hit the table
			while (sibling && (!DU.isElt(sibling) || !DU.hasNodeName(sibling, "table"))) {
				next = sibling.nextSibling;
				if (DU.isElt(sibling)) {
					if (DU.isBlockNode(sibling) || DU.emitsSolTransparentSingleLineWT(env, sibling, true)) {
						// Block nodes don't need to be wrapped in a p-tag either.
						// Links, includeonly directives, and other rendering-transparent
						// nodes dont need wrappers. sol-transparent wikitext generate
						// rendering-transparent nodes and we use that helper as a proxy here.
						dp = DU.getDataParsoid(sibling);
						dp.fostered = true;

						// If the foster content holder is not empty,
						// close it and get a new content holder.
						if (fosterContentHolder.childNodes.length > 0) {
							sibling.parentNode.insertBefore(fosterContentHolder, sibling);
							fosterContentHolder = getFosterContentHolder(sibling.ownerDocument, inPTag);
						}
					} else {
						fosterContentHolder.appendChild(sibling);
					}

					if (removeTransclusionShadows(sibling)) {
						fosteredTransclusions = true;
					}
				} else {
					fosterContentHolder.appendChild(sibling);
				}
				sibling = next;
			}

			var table = sibling;

			// we should be able to reach the table from the fosterbox
			console.assert(table && DU.isElt(table) && DU.hasNodeName(table, "table"),
				"Table isn't a sibling. Something's amiss!");

			if (fosterContentHolder.childNodes.length > 0) {
				table.parentNode.insertBefore(fosterContentHolder, table);
			}

			// we have fostered transclusions
			// wrap the whole thing in a transclusion
			if (fosteredTransclusions) {
				insertTransclusionMetas(env, c, sibling);
			}

			// remove the foster box
			DU.deleteNode(c);

		} else if (DU.isMarkerMeta(c, "mw:TransclusionShadow")) {
			DU.deleteNode(c);
		} else if (DU.isElt(c)) {
			dp = DU.getDataParsoid(c);
			dp.inTransclusion = undefined;
			if (c.childNodes.length > 0) {
				markFosteredContent(c, env);
			}
		}

		c = sibling;
	}
}

if (typeof module === "object") {
	module.exports.markFosteredContent = markFosteredContent;
}
