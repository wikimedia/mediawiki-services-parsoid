/** @module */

'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var TokenUtils = require('../../../utils/TokenUtils.js').TokenUtils;

function fixedIndentPreText(str, isLastChild) {
	if (isLastChild) {
		return str.replace(/\n(?!$)/g, "\n ");
	} else {
		return str.replace(/\n/g, "\n ");
	}
}

function reinsertLeadingSpace(elt, isLastChild) {
	for (var c = elt.firstChild; c; c = c.nextSibling) {
		var last = (c.nextSibling === null);
		if (DU.isText(c)) {
			c.data = fixedIndentPreText(c.data, isLastChild && last);
		} else {
			// recurse
			reinsertLeadingSpace(c, isLastChild && last);
		}
	}
}

/**
 */
function handlePres(body, env) {
	var document = body.ownerDocument;
	/* --------------------------------------------------------------
	 * Block tags change the behaviour of indent-pres.  This behaviour
	 * cannot be emulated till the DOM is built if we are to avoid
	 * having to deal with unclosed/mis-nested tags in the token stream.
	 *
	 * This function goes through the DOM looking for special kinds of
	 * block tags (as determined by the PHP parser behavior -- which
	 * has its own notion of block-tag which overlaps with, but is
	 * different from, the HTML block tag notion.
	 *
	 * Wherever such a block tag is found, any Parsoid-inserted
	 * pre-tags are removed.
	 * -------------------------------------------------------------- */
	function deleteIndentPreFromDOM(node, blocklevel) {
		var c = node.firstChild;
		while (c) {
			// get sibling before DOM is modified
			var cSibling = c.nextSibling;

			if (c.nodeName === "PRE" && !DU.isLiteralHTMLNode(c)) {
				var f = document.createDocumentFragment();

				// space corresponding to the 'pre'
				f.appendChild(document.createTextNode(' '));

				// transfer children over
				var cChild = c.firstChild;
				while (cChild) {
					var next = cChild.nextSibling;
					if (DU.isText(cChild)) {
						// new child with fixed up text
						cChild = document.createTextNode(fixedIndentPreText(cChild.data, next === null));
					} else if (DU.isElt(cChild)) {
						// recursively process all text nodes to make
						// sure every new line gets a space char added back.
						reinsertLeadingSpace(cChild, next === null);
					}
					f.appendChild(cChild);
					cChild = next;
				}

				if (blocklevel) {
					var p = document.createElement('p');
					p.appendChild(f);
					f = p;
				}

				node.insertBefore(f, c);
				// delete the pre
				c.parentNode.removeChild(c);
			} else if (!TokenUtils.tagClosesBlockScope(c.nodeName.toLowerCase())) {
				deleteIndentPreFromDOM(c, blocklevel);
			}

			c = cSibling;
		}
	}

	function findAndHandlePres(elt, indentPresHandled) {
		var nextChild;
		var blocklevel = false;
		for (var n = elt.firstChild; n; n = nextChild) {
			var processed = false;
			nextChild = n.nextSibling; // store this before n is possibly deleted
			if (!indentPresHandled && DU.isElt(n) &&
					TokenUtils.tagOpensBlockScope(n.nodeName) &&
					(DU.isTplMetaType(n.getAttribute("typeof")) ||
						DU.isLiteralHTMLNode(n))) {
				// This is a special case in the php parser for $inBlockquote
				blocklevel = (n.nodeName === "BLOCKQUOTE");
				deleteIndentPreFromDOM(n, blocklevel);
				processed = true;
			}
			findAndHandlePres(n, indentPresHandled || processed);
		}
	}

	// kick it off
	findAndHandlePres(body, false);
}

if (typeof module === "object") {
	module.exports.handlePres = handlePres;
}
