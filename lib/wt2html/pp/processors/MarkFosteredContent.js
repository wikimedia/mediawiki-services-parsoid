/**
 * Non-IEW (inter-element-whitespace) can only be found in <td> <th> and
 * <caption> tags in a table.  If found elsewhere within a table, such
 * content will be moved out of the table and be "adopted" by the table's
 * sibling ("foster parent"). The content that gets adopted is "fostered
 * content".
 *
 * http://www.w3.org/TR/html5/syntax.html#foster-parent
 * @module
 */

'use strict';

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { Util } = require('../../../utils/Util.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

class MarkFosteredContent {
	/**
	 * Create a new DOM node with attributes.
	 */
	createNodeWithAttributes(document, type, attrs) {
		var node = document.createElement(type);
		DOMDataUtils.addAttributes(node, attrs);
		return node;
	}

	// cleans up transclusion shadows, keeping track of fostered transclusions
	removeTransclusionShadows(node) {
		var sibling;
		var fosteredTransclusions = false;
		if (DOMUtils.isElt(node)) {
			if (DOMUtils.isMarkerMeta(node, "mw:TransclusionShadow")) {
				node.parentNode.removeChild(node);
				return true;
			} else if (DOMDataUtils.getDataParsoid(node).tmp.inTransclusion) {
				fosteredTransclusions = true;
			}
			node = node.firstChild;
			while (node) {
				sibling = node.nextSibling;
				if (this.removeTransclusionShadows(node)) {
					fosteredTransclusions = true;
				}
				node = sibling;
			}
		}
		return fosteredTransclusions;
	}

	// inserts metas around the fosterbox and table
	insertTransclusionMetas(env, fosterBox, table) {
		var aboutId = env.newAboutId();

		// You might be asking yourself, why is table.data.parsoid.tsr[1] always
		// present? The earlier implementation searched the table's siblings for
		// their tsr[0]. However, encapsulation doesn't happen when the foster box,
		// and thus the table, are in the transclusion.
		var s = this.createNodeWithAttributes(fosterBox.ownerDocument, "meta", {
			"about": aboutId,
			"id": aboutId.substring(1),
			"typeof": "mw:Transclusion",
		});
		DOMDataUtils.setDataParsoid(s, {
			tsr: Util.clone(DOMDataUtils.getDataParsoid(table).tsr),
			tmp: { fromFoster: true },
		});
		fosterBox.parentNode.insertBefore(s, fosterBox);

		var e = this.createNodeWithAttributes(table.ownerDocument, "meta", {
			"about": aboutId,
			"typeof": "mw:Transclusion/End",
		});

		var sibling = table.nextSibling;
		var beforeText;

		// Skip past the table end, mw:shadow and any transclusions that
		// start inside the table. There may be newlines and comments in
		// between so keep track of that, and backtrack when necessary.
		while (sibling) {
			if (!WTUtils.isTplStartMarkerMeta(sibling) && (
				WTUtils.hasParsoidAboutId(sibling) ||
				DOMUtils.isMarkerMeta(sibling, "mw:EndTag") ||
				DOMUtils.isMarkerMeta(sibling, "mw:TransclusionShadow")
			)) {
				sibling = sibling.nextSibling;
				beforeText = null;
			} else if (DOMUtils.isComment(sibling) || DOMUtils.isText(sibling)) {
				if (!beforeText) {
					beforeText = sibling;
				}
				sibling = sibling.nextSibling;
			} else {
				break;
			}
		}

		table.parentNode.insertBefore(e, beforeText || sibling);
	}

	getFosterContentHolder(doc, inPTag) {
		var fosterContentHolder = doc.createElement(inPTag ? 'span' : 'p');
		DOMDataUtils.setDataParsoid(fosterContentHolder, { fostered: true, tmp: {} });
		return fosterContentHolder;
	}

	/**
	 * Searches for FosterBoxes and does two things when it hits one:
	 * - Marks all nextSiblings as fostered until the accompanying table.
	 * - Wraps the whole thing (table + fosterbox) with transclusion metas if
	 *   there is any fostered transclusion content.
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	markFosteredContent(node, env) {
		var sibling, next, fosteredTransclusions;
		var c = node.firstChild;

		while (c) {
			sibling = c.nextSibling;
			fosteredTransclusions = false;

			if (DOMUtils.hasNameAndTypeOf(c, "TABLE", "mw:FosterBox")) {
				var inPTag = DOMUtils.hasAncestorOfName(c.parentNode, "p");
				var fosterContentHolder = this.getFosterContentHolder(c.ownerDocument, inPTag);

				// mark as fostered until we hit the table
				while (sibling && (!DOMUtils.isElt(sibling) || sibling.nodeName !== "TABLE")) {
					next = sibling.nextSibling;
					if (DOMUtils.isElt(sibling)) {
						// TODO: Note the similarity here with the p-wrapping pass.
						// This can likely be combined in some more maintainable way.
						if (DOMUtils.isBlockNode(sibling) || WTUtils.emitsSolTransparentSingleLineWT(sibling)) {
							// Block nodes don't need to be wrapped in a p-tag either.
							// Links, includeonly directives, and other rendering-transparent
							// nodes dont need wrappers. sol-transparent wikitext generate
							// rendering-transparent nodes and we use that helper as a proxy here.
							DOMDataUtils.getDataParsoid(sibling).fostered = true;

							// If the foster content holder is not empty,
							// close it and get a new content holder.
							if (fosterContentHolder.hasChildNodes()) {
								sibling.parentNode.insertBefore(fosterContentHolder, sibling);
								fosterContentHolder = this.getFosterContentHolder(sibling.ownerDocument, inPTag);
							}
						} else {
							fosterContentHolder.appendChild(sibling);
						}

						if (this.removeTransclusionShadows(sibling)) {
							fosteredTransclusions = true;
						}
					} else {
						fosterContentHolder.appendChild(sibling);
					}
					sibling = next;
				}

				var table = sibling;

				// we should be able to reach the table from the fosterbox
				console.assert(table && DOMUtils.isElt(table) && table.nodeName === "TABLE",
					"Table isn't a sibling. Something's amiss!");

				if (fosterContentHolder.hasChildNodes()) {
					table.parentNode.insertBefore(fosterContentHolder, table);
				}

				// we have fostered transclusions
				// wrap the whole thing in a transclusion
				if (fosteredTransclusions) {
					this.insertTransclusionMetas(env, c, table);
				}

				// remove the foster box
				c.parentNode.removeChild(c);

			} else if (DOMUtils.isMarkerMeta(c, "mw:TransclusionShadow")) {
				c.parentNode.removeChild(c);
			} else if (DOMUtils.isElt(c)) {
				if (c.hasChildNodes()) {
					this.markFosteredContent(c, env);
				}
			}

			c = sibling;
		}
	}

	run(node, env) {
		this.markFosteredContent(node, env);
	}
}

if (typeof module === "object") {
	module.exports.MarkFosteredContent = MarkFosteredContent;
}
