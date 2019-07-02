/** @module */

'use strict';

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { Util } = require('../../../utils/Util.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

class ProcessTreeBuilderFixups {
	/**
	 * Replace a meta node with an empty text node, which will be deleted by
	 * the normalize pass. This is faster than just deleting the node if there
	 * are many nodes in the sibling array, since node deletion is sometimes
	 * done with {@link Array#splice} which is O(N).
	 * @private
	 */
	deleteShadowMeta(node) {
		node.parentNode.replaceChild(
			node.ownerDocument.createTextNode(''),
			node);
	}

	addPlaceholderMeta(frame, node, dp, name, opts) {
		// If node is in a position where the placeholder
		// node will get fostered out, dont bother adding one
		// since the browser and other compliant clients will
		// move the placeholder out of the table.
		if (DOMUtils.isFosterablePosition(node)) {
			return;
		}

		var src = dp.src;

		if (!src) {
			if (dp.tsr) {
				src = frame.srcText.substring(dp.tsr[0], dp.tsr[1]);
			} else if (opts.tsr) {
				src = frame.srcText.substring(opts.tsr[0], opts.tsr[1]);
			} else if (WTUtils.hasLiteralHTMLMarker(dp)) {
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
			DOMDataUtils.setDataParsoid(placeHolder, {
				src: src,
				name: name.toUpperCase(),
				tmp: {},
			});

			// Insert the placeHolder
			node.parentNode.insertBefore(placeHolder, node);
		}
	}

	// Search forward for a shadow meta, skipping over other end metas
	findMetaShadowNode(node, type, name) {
		var isHTML = WTUtils.isLiteralHTMLNode(node);
		while (node) {
			var sibling = node.nextSibling;
			if (!sibling || !DOMUtils.isMarkerMeta(sibling, type)) {
				return null;
			}

			if (sibling.getAttribute('data-etag') === name &&
				// If the node was literal html, the end tag should be as well.
				// However, the converse isn't true. A node for an
				// autoInsertedStartTag wouldn't have those markers yet.
				// See "Table with missing opening <tr> tag" test as an example.
				(!isHTML || isHTML === WTUtils.isLiteralHTMLNode(sibling))
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
	findDeletedStartTags(frame, node) {
		// handle unmatched mw:StartTag meta tags
		var c = node.firstChild;
		while (c !== null) {
			var sibling = c.nextSibling;
			if (DOMUtils.isElt(c)) {
				var dp = DOMDataUtils.getDataParsoid(c);
				if (c.nodeName === "META") {
					var metaType = c.getAttribute("typeof") || '';
					if (metaType === "mw:StartTag") {
						var dataStag = c.getAttribute('data-stag') || '';
						var data = dataStag.split(":");
						var expectedName = data[0];
						var prevSibling = c.previousSibling;
						if ((prevSibling && prevSibling.nodeName.toLowerCase() !== expectedName) ||
							(!prevSibling && c.parentNode.nodeName.toLowerCase() !== expectedName)) {
							if (c && dp.stx !== 'html'
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
								if (dp.tsr
										&& dp.tsr[0] !== null && dp.tsr[1] !== null) {
									origTxt = frame.srcText.substring(dp.tsr[0], dp.tsr[1]);
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
								this.addPlaceholderMeta(frame, c, dp, expectedName, { start: true, tsr: dp.tsr });
							}
						}
						this.deleteShadowMeta(c);
					} else if (metaType === "mw:EndTag" && !dp.tsr) {
						// If there is no tsr, this meta is useless for DSR
						// calculations. Remove the meta to avoid breaking
						// other brittle DOM passes working on the DOM.
						this.deleteShadowMeta(c);

						// TODO: preserve stripped wikitext end tags similar
						// to start tags!
					}
				} else {
					this.findDeletedStartTags(frame, c);
				}
			}
			c = sibling;
		}
	}

	// This pass tries to match nodes with their start and end tag marker metas
	// and adds autoInsertedEnd/Start flags if it detects the tags to be inserted by
	// the HTML tree builder
	findAutoInsertedTags(frame, node) {
		var c = node.firstChild;
		var sibling, expectedName;

		while (c !== null) {
			// Skip over enscapsulated content
			if (WTUtils.isEncapsulationWrapper(c)) {
				c = WTUtils.skipOverEncapsulatedContent(c);
				continue;
			}

			if (DOMUtils.isElt(c)) {
				// Process subtree first
				this.findAutoInsertedTags(frame, c);

				var dp = DOMDataUtils.getDataParsoid(c);
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
					(cNodeName !== 'tbody' || WTUtils.hasLiteralHTMLMarker(dp))) {
					// Detect auto-inserted end-tags
					var metaNode = this.findMetaShadowNode(c, 'mw:EndTag', cNodeName);
					if (!metaNode) {
						// 'c' is a html node that has tsr, but no end-tag marker tag
						// => its closing tag was auto-generated by treebuilder.
						dp.autoInsertedEnd = true;
					}

					if (dp.tmp.tagId) {
						// Detect auto-inserted start-tags
						var fc = c.firstChild;
						while (fc) {
							if (!DOMUtils.isElt(fc)) {
								break;
							}
							var fcDP = DOMDataUtils.getDataParsoid(fc);
							if (fcDP.autoInsertedStart) {
								fc = fc.firstChild;
							} else {
								break;
							}
						}

						expectedName = cNodeName + ":" + dp.tmp.tagId;
						if (fc &&
							DOMUtils.isMarkerMeta(fc, "mw:StartTag") &&
							fc.getAttribute('data-stag').startsWith(expectedName)
						) {
							// Strip start-tag marker metas that has its matching node
							this.deleteShadowMeta(fc);
						} else {
							dp.autoInsertedStart = true;
						}
					} else {
						// If the tag-id is missing, this is clearly a sign that the
						// start tag was inserted by the builder
						dp.autoInsertedStart = true;
					}
				} else if (cNodeName === 'meta') {
					var type = c.getAttribute('typeof') || '';
					if (type === 'mw:EndTag') {
						// Got an mw:EndTag meta element, see if the previous sibling
						// is the corresponding element.
						sibling = c.previousSibling;
						expectedName = c.getAttribute('data-etag') || '';
						if (!sibling || sibling.nodeName.toLowerCase() !== expectedName) {
							// Not found, the tag was stripped. Insert an
							// mw:Placeholder for round-tripping
							this.addPlaceholderMeta(frame, c, dp, expectedName, { end: true });
						} else if (dp.stx) {
							// Transfer stx flag
							var siblingDP = DOMDataUtils.getDataParsoid(sibling);
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
	removeAutoInsertedEmptyTags(frame, node) {
		var c = node.firstChild;
		while (c !== null) {
			// FIXME: Encapsulation only happens after this phase, so you'd think
			// we wouldn't encounter any, but the html pre tag inserts extension
			// content directly, rather than passing it through as a fragment for
			// later unpacking.  Same as above.
			if (WTUtils.isEncapsulationWrapper(c)) {
				c = WTUtils.skipOverEncapsulatedContent(c);
				continue;
			}

			if (DOMUtils.isElt(c)) {
				this.removeAutoInsertedEmptyTags(frame, c);
				var dp = DOMDataUtils.getDataParsoid(c);

				// We do this down here for all elements since the quote transformer
				// also marks up elements as auto-inserted and we don't want to be
				// constrained by any conditions.  Further, this pass should happen
				// before paragraph wrapping on the dom, since we don't want this
				// stripping to result in empty paragraphs.

				// Delete empty auto-inserted elements
				if (dp.autoInsertedStart && dp.autoInsertedEnd && (
					!c.hasChildNodes() ||
					(DOMUtils.hasNChildren(c, 1) && !DOMUtils.isElt(c.firstChild) &&
						/^\s*$/.test(c.textContent)))
				) {
					var next = c.nextSibling;
					if (c.firstChild) {
						// migrate the ws out
						c.parentNode.insertBefore(c.firstChild, c);
					}
					c.parentNode.removeChild(c);
					c = next;
					continue;
				}
			}

			c = c.nextSibling;
		}
	}

	/**
	 */
	run(body, env, options) {
		const frame = options.frame;
		this.findAutoInsertedTags(frame, body);
		this.findDeletedStartTags(frame, body);
		this.removeAutoInsertedEmptyTags(frame, body);
	}
}

if (typeof module === "object") {
	module.exports.ProcessTreeBuilderFixups = ProcessTreeBuilderFixups;
}
