"use strict";

var Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Util = require('./mediawiki.Util.js').Util;

/**
 * Delete a meta node and try to merge adjacent text nodes
 *
 * TODO: move to DU.deleteNode and make it the default behavior after auditing
 * all uses of DU.deleteNode?
 */
function deleteShadowMeta(node) {
	var previousSibling = node.previousSibling,
		nextSibling = node.nextSibling;
	DU.deleteNode(node);
	// Try nextSibling first to avoid deleting it in loops that keep a copy of
	// nextSibling (text nodes are added into nextSibling if possible).
	if (nextSibling && DU.isText(nextSibling)) {
		DU.mergeSiblingTextNodes(nextSibling);
	} else if (previousSibling && DU.isText(previousSibling)) {
		DU.mergeSiblingTextNodes(previousSibling);
	}
}

function addPlaceholderMeta( env, node, dp, name, opts ) {
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

	if ( src ) {
		var placeHolder;

		placeHolder = node.ownerDocument.createElement('meta');
		placeHolder.setAttribute('typeof', 'mw:Placeholder/StrippedTag');
		DU.setNodeData( placeHolder, { parsoid: { src: src, name: name.toUpperCase() } } );

		// Insert the placeHolder
		node.parentNode.insertBefore(placeHolder, node);
	}
}

// Search forward for a shadow meta, skipping over other end metas
function findMetaShadowNode( node, type, name ) {
	while ( node ) {
		var sibling = node.nextSibling;
		if (!sibling || !DU.isMarkerMeta( sibling, type )) {
			return null;
		}

		if (sibling.getAttribute('data-etag') === name ) {
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
			var dp = DU.getDataParsoid( c );
			if (DU.hasNodeName(c, "meta")) {
				var metaType = c.getAttribute("typeof");
				if (metaType === "mw:StartTag") {
					var dataStag = c.getAttribute('data-stag'),
						data = dataStag.split(":"),
						cdp = DU.getDataParsoid(c),
						expectedName = data[0];
					var prevSibling = c.previousSibling;
					if (( prevSibling && prevSibling.nodeName.toLowerCase() !== expectedName ) ||
						(!prevSibling && c.parentNode.nodeName.toLowerCase() !== expectedName))
					{
						//console.log( 'start stripped! ', expectedName, c.parentNode.innerHTML );
						if (c && cdp.stx !== 'html'
								&& ( expectedName === 'td'
									|| expectedName === 'tr'
									|| expectedName === 'th'))
						{
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
							if(cdp.tsr
									&& cdp.tsr[0] !== null && cdp.tsr[1] !== null
									&& env.page.src)
							{
								origTxt = env.page.src.substring( cdp.tsr[0], cdp.tsr[1]);
								var origTxtNode = c.ownerDocument.createTextNode(origTxt);
								c.parentNode.insertBefore(origTxtNode, c);
							} else {
								switch(expectedName) {
									case 'td': origTxt = '|'; break;
									case 'tr': origTxt = '|-'; break;
									case 'th': origTxt = '!'; break;
									default: origTxt = ''; break;
								}
								c.parentNode.insertBefore(
										c.ownerDocument.createTextNode(origTxt), c);
							}
						} else {
							addPlaceholderMeta(env, c, dp, expectedName, {start: true, tsr: cdp.tsr});
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
	var c = node.firstChild,
		sibling, expectedName, reg;

	while (c !== null) {
		// Skip over template/extension content
		if (DU.isTplElementNode( env, node )) {
			var about = node.getAttribute( 'about' );
			c = c.nextSibling;
			while (c && node.getAttribute('about') === about) {
				c = c.nextSibling;
			}

			if (!c) {
				return;
			}
		}

		if (DU.isElt(c)) {
			// Process subtree first
			findAutoInsertedTags(env, c);

			var dp = DU.getDataParsoid( c ),
				cNodeName = c.nodeName.toLowerCase();

			// Dont bother detecting auto-inserted start/end if:
			// -> c is a void element
			// -> c is not self-closed
			// -> c is not tbody unless it is a literal html tag
			//    tbody-tags dont exist in wikitext and are always
			//    closed properly.  How about figure, caption, ... ?
			//    Is this last check useless optimization?????
			if (!Util.isVoidElement(cNodeName) &&
				!dp.selfClose &&
				(cNodeName !== 'tbody' || DU.hasLiteralHTMLMarker(dp)))
			{
				// Detect auto-inserted end-tags
				var metaNode = findMetaShadowNode(c, 'mw:EndTag', cNodeName);
				if (!metaNode) {
					//console.log( c.nodeName, c.parentNode.outerHTML );
					// 'c' is a html node that has tsr, but no end-tag marker tag
					// => its closing tag was auto-generated by treebuilder.
					dp.autoInsertedEnd = true;
				}

				if (dp.tagId) {
					// Detect auto-inserted start-tags
					var fc = c.firstChild;
					while (fc) {
						if (!DU.isElt(fc)) {
							break;
						}
						var fcDP = DU.getDataParsoid( fc );
						if (fcDP.autoInsertedStart) {
							fc = fc.firstChild;
						} else {
							break;
						}
					}

					expectedName = cNodeName + ":" + dp.tagId;
					reg = new RegExp( "^" + expectedName + "(:.*)?$" );

					if (fc &&
						DU.isMarkerMeta(fc, "mw:StartTag") &&
						reg.test( fc.getAttribute('data-stag') )
					) {
						// Strip start-tag marker metas that has its matching node
						deleteShadowMeta(fc);
					} else {
						//console.log('autoInsertedStart:', c.outerHTML);
						dp.autoInsertedStart = true;
					}
				} else {
					// If the tag-id is missing, this is clearly a sign that the
					// start tag was inserted by the builder
					dp.autoInsertedStart = true;
				}
			} else if (cNodeName === 'meta') {
				var type = c.getAttribute('typeof');
				if ( type === 'mw:EndTag' ) {
					// Got an mw:EndTag meta element, see if the previous sibling
					// is the corresponding element.
					sibling = c.previousSibling;
					expectedName = c.getAttribute('data-etag');
					if (!sibling || sibling.nodeName.toLowerCase() !== expectedName) {
						// Not found, the tag was stripped. Insert an
						// mw:Placeholder for round-tripping
						//console.log('autoinsertedEnd', c.innerHTML, c.parentNode.innerHTML);
						// console.warn("expected.nodeName: " + expectedName + "; sibling.nodeName: " + sibling.nodeName);
						addPlaceholderMeta(env, c, dp, expectedName, {end: true});
					} else if ( dp.stx ) {
						// transfer stx
						DU.getDataParsoid( sibling ).stx = dp.stx;
					}
				} else {
					// Jump over this meta tag, but preserve it
					c = c.nextSibling;
					continue;
				}
			}
		}

		c = c.nextSibling;
	}
}

function cleanupFormattingTagFixup(env, node) {
	node = node.firstChild;
	while (node !== null) {
		if (DU.isGeneratedFigure(node)) {
			var c = node.firstChild;
			// <a> tags are formatting elts as well
			if (DU.isFormattingElt(c) && !DU.hasNodeName(c, "a") && !c.nextSibling) {
				// Fix up DOM appropriately
				var fig = node;
				var formattingElt = c;
				DU.migrateChildren(formattingElt, fig);
				var caption = fig.lastChild;
				DU.migrateChildren(caption, formattingElt);
				caption.appendChild(formattingElt);

				// If both the start and end tags are auto-inserted,
				// DSR algo will automatically ignore the tag.
				// Otherwise, TSR needs clearing. However,
				// for simpler logic and code readability reasons,
				// we are unconditionally clearing it out.
				DU.getDataParsoid(formattingElt).tsr = null;
			}
		} else if (DU.isElt(node)) {
			cleanupFormattingTagFixup(env, node);
		}
		node = node.nextSibling;
	}
}

function markTreeBuilderFixups(body, env) {
	findAutoInsertedTags(env, body);
	findDeletedStartTags(env, body);

	// Bug 63642 and friend
	cleanupFormattingTagFixup(env, body);
}

if (typeof module === "object") {
	module.exports.markTreeBuilderFixups = markTreeBuilderFixups;
}
