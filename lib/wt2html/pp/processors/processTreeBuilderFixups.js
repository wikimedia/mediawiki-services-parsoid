/** @module */

'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var Util = require('../../../utils/Util.js').Util;


/**
 * Replace a meta node with an empty text node, which will be deleted by
 * the normalize pass. This is faster than just deleting the node if there
 * are many nodes in the sibling array, since node deletion is sometimes
 * done with {@link Array#splice} which is O(N).
 * @private
 */
function deleteShadowMeta(node) {
	node.parentNode.replaceChild(
		node.ownerDocument.createTextNode(''),
		node);
}

function addPlaceholderMeta(env, node, dp, name, opts) {
	// If node is in a position where the placeholder
	// node will get fostered out, dont bother adding one
	// since the browser and other compliant clients will
	// move the placeholder out of the table.
	if (DU.isFosterablePosition(node)) {
		return;
	}

	var src = dp.src;

	if (!src) {
		if (dp.tsr) {
			src = env.page.src.substring(dp.tsr[0], dp.tsr[1]);
		} else if (opts.tsr) {
			src = env.page.src.substring(opts.tsr[0], opts.tsr[1]);
		} else if (DU.hasLiteralHTMLMarker(dp)) {
			if (opts.start) {
				src = "<" + name + ">";
			} else if (opts.end) {
				src = "</" + name + ">";
			}
		}
	}

	if (src) {
		var placeHolder;

		placeHolder = node.ownerDocument.createElement('meta');
		placeHolder.setAttribute('typeof', 'mw:Placeholder/StrippedTag');
		DU.setDataParsoid(placeHolder, {
			src: src,
			name: name.toUpperCase(),
			tmp: {},
		});

		// Insert the placeHolder
		node.parentNode.insertBefore(placeHolder, node);
	}
}

// Search forward for a shadow meta, skipping over other end metas
function findMetaShadowNode(node, type, name) {
	var isHTML = DU.isLiteralHTMLNode(node);
	while (node) {
		var sibling = node.nextSibling;
		if (!sibling || !DU.isMarkerMeta(sibling, type)) {
			return null;
		}

		if (sibling.getAttribute('data-etag') === name &&
			// If the node was literal html, the end tag should be as well.
			// However, the converse isn't true. A node for an
			// autoInsertedStartTag wouldn't have those markers yet.
			// See "Table with missing opening <tr> tag" test as an example.
			(!isHTML || isHTML === DU.isLiteralHTMLNode(sibling))
		) {
			return sibling;
		}

		node = sibling;
	}

	return null;
}

// This pass:
// 1. Finds start-tag marker metas that dont have a corresponding start tag
//    and adds placeholder metas for the purposes of round-tripping.
// 2. Deletes any useless end-tag marker metas
function findDeletedStartTags(env, node) {
	// handle unmatched mw:StartTag meta tags
	var c = node.firstChild;
	while (c !== null) {
		var sibling = c.nextSibling;
		if (DU.isElt(c)) {
			var dp = DU.getDataParsoid(c);
			if (c.nodeName === "META") {
				var metaType = c.getAttribute("typeof");
				if (metaType === "mw:StartTag") {
					var dataStag = c.getAttribute('data-stag');
					var data = dataStag.split(":");
					var cdp = DU.getDataParsoid(c);
					var expectedName = data[0];
					var prevSibling = c.previousSibling;
					if ((prevSibling && prevSibling.nodeName.toLowerCase() !== expectedName) ||
						(!prevSibling && c.parentNode.nodeName.toLowerCase() !== expectedName)) {
						if (c && cdp.stx !== 'html'
								&& (expectedName === 'td'
									|| expectedName === 'tr'
									|| expectedName === 'th')) {
							// A stripped wikitext-syntax td tag outside
							// of a table.  Re-insert the original page
							// source.

							// XXX: Use actual page source if this comes
							// from the top-level page. Can we easily
							// determine whether we are in a transclusion
							// at this point?
							//
							// Also, do the paragraph wrapping on the DOM.
							var origTxt;
							if (cdp.tsr
									&& cdp.tsr[0] !== null && cdp.tsr[1] !== null
									&& env.page.src) {
								origTxt = env.page.src.substring(cdp.tsr[0], cdp.tsr[1]);
								var origTxtNode = c.ownerDocument.createTextNode(origTxt);
								c.parentNode.insertBefore(origTxtNode, c);
							} else {
								switch (expectedName) {
									case 'td': origTxt = '|'; break;
									case 'tr': origTxt = '|-'; break;
									case 'th': origTxt = '!'; break;
									default: origTxt = ''; break;
								}
								c.parentNode.insertBefore(
										c.ownerDocument.createTextNode(origTxt), c);
							}
						} else {
							addPlaceholderMeta(env, c, dp, expectedName, { start: true, tsr: cdp.tsr });
						}
					}
					deleteShadowMeta(c);
				} else if (metaType === "mw:EndTag" && !dp.tsr) {
					// If there is no tsr, this meta is useless for DSR
					// calculations. Remove the meta to avoid breaking
					// other brittle DOM passes working on the DOM.
					deleteShadowMeta(c);

					// TODO: preserve stripped wikitext end tags similar
					// to start tags!
				}
			} else {
				findDeletedStartTags(env, c);
			}
		}
		c = sibling;
	}
}

// This pass tries to match nodes with their start and end tag marker metas
// and adds autoInsertedEnd/Start flags if it detects the tags to be inserted by
// the HTML tree builder
function findAutoInsertedTags(env, node) {
	var c = node.firstChild;
	var sibling, expectedName;

	while (c !== null) {
		// Skip over enscapsulated content
		if (DU.isEncapsulationWrapper(c)) {
			c = DU.skipOverEncapsulatedContent(c);
			continue;
		}

		if (DU.isElt(c)) {
			// Process subtree first
			findAutoInsertedTags(env, c);

			var dp = DU.getDataParsoid(c);
			var cNodeName = c.nodeName.toLowerCase();

			// Dont bother detecting auto-inserted start/end if:
			// -> c is a void element
			// -> c is not self-closed
			// -> c is not tbody unless it is a literal html tag
			//    tbody-tags dont exist in wikitext and are always
			//    closed properly.  How about figure, caption, ... ?
			//    Is this last check useless optimization?????
			if (!Util.isVoidElement(cNodeName) &&
				!dp.selfClose &&
				(cNodeName !== 'tbody' || DU.hasLiteralHTMLMarker(dp))) {
				// Detect auto-inserted end-tags
				var metaNode = findMetaShadowNode(c, 'mw:EndTag', cNodeName);
				if (!metaNode) {
					// 'c' is a html node that has tsr, but no end-tag marker tag
					// => its closing tag was auto-generated by treebuilder.
					dp.autoInsertedEnd = true;
				}

				if (dp.tmp.tagId) {
					// Detect auto-inserted start-tags
					var fc = c.firstChild;
					while (fc) {
						if (!DU.isElt(fc)) {
							break;
						}
						var fcDP = DU.getDataParsoid(fc);
						if (fcDP.autoInsertedStart) {
							fc = fc.firstChild;
						} else {
							break;
						}
					}

					expectedName = cNodeName + ":" + dp.tmp.tagId;
					if (fc &&
						DU.isMarkerMeta(fc, "mw:StartTag") &&
						fc.getAttribute('data-stag').startsWith(expectedName)
					) {
						// Strip start-tag marker metas that has its matching node
						deleteShadowMeta(fc);
					} else {
						dp.autoInsertedStart = true;
					}
				} else {
					// If the tag-id is missing, this is clearly a sign that the
					// start tag was inserted by the builder
					dp.autoInsertedStart = true;
				}
			} else if (cNodeName === 'meta') {
				var type = c.getAttribute('typeof');
				if (type === 'mw:EndTag') {
					// Got an mw:EndTag meta element, see if the previous sibling
					// is the corresponding element.
					sibling = c.previousSibling;
					expectedName = c.getAttribute('data-etag');
					if (!sibling || sibling.nodeName.toLowerCase() !== expectedName) {
						// Not found, the tag was stripped. Insert an
						// mw:Placeholder for round-tripping
						addPlaceholderMeta(env, c, dp, expectedName, { end: true });
					} else if (dp.stx) {
						// Transfer stx flag
						var siblingDP = DU.getDataParsoid(sibling);
						siblingDP.stx = dp.stx;
					}
				}
			}
		}

		c = c.nextSibling;
	}
}

// Done after `findDeletedStartTags` to give it a chance to cleanup any
// leftover meta markers that may trip up the check for whether this element
// is indeed empty.
var removeAutoInsertedEmptyTags = function(env, node) {
	var c = node.firstChild;
	while (c !== null) {
		// FIXME: Encapsulation only happens after this phase, so you'd think
		// we wouldn't encounter any, but the html pre tag inserts extension
		// content directly, rather than passing it through as a fragment for
		// later unpacking.  Same as above.
		if (DU.isEncapsulationWrapper(c)) {
			c = DU.skipOverEncapsulatedContent(c);
			continue;
		}

		if (DU.isElt(c)) {
			removeAutoInsertedEmptyTags(env, c);
			var dp = DU.getDataParsoid(c);

			// We do this down here for all elements since the quote transformer
			// also marks up elements as auto-inserted and we don't want to be
			// constrained by any conditions.  Further, this pass should happen
			// before paragraph wrapping on the dom, since we don't want this
			// stripping to result in empty paragraphs.

			// Delete empty auto-inserted elements
			if (dp.autoInsertedStart && dp.autoInsertedEnd && (
				!c.hasChildNodes() ||
				(DU.hasNChildren(c, 1) && !DU.isElt(c.firstChild) &&
					/^\s*$/.test(c.textContent)))
			) {
				var next = c.nextSibling;
				if (c.firstChild) {
					// migrate the ws out
					c.parentNode.insertBefore(c.firstChild, c);
				}
				DU.deleteNode(c);
				c = next;
				continue;
			}
		}

		c = c.nextSibling;
	}
};

/**
 */
function processTreeBuilderFixups(body, env) {
	findAutoInsertedTags(env, body);
	findDeletedStartTags(env, body);
	removeAutoInsertedEmptyTags(env, body);
}

if (typeof module === "object") {
	module.exports.processTreeBuilderFixups = processTreeBuilderFixups;
}
