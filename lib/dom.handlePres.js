'use strict';

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var Util = require('./mediawiki.Util.js').Util;


function fixedIndentPreText(str, isLastChild) {
	if (isLastChild) {
		return str.replace(/\n(?!$)/g, "\n ");
	} else {
		return str.replace(/\n/g, "\n ");
	}
}

function reinsertLeadingSpace(elt, isLastChild) {
	var children = elt.childNodes;
	for (var i = 0, n = children.length; i < n; i++) {
		var c = children[i];
		if (DU.isText(c)) {
			c.data = fixedIndentPreText(c.data, isLastChild && i === n - 1);
		} else {
			// recurse
			reinsertLeadingSpace(c, isLastChild && i === n - 1);
		}
	}
}

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

			if (DU.hasNodeName(c, "pre") && !DU.isLiteralHTMLNode(c)) {
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
				DU.deleteNode(c);
			} else if (!Util.tagClosesBlockScope(c.nodeName.toLowerCase())) {
				deleteIndentPreFromDOM(c, blocklevel);
			}

			c = cSibling;
		}
	}

	function findAndHandlePres(elt, indentPresHandled) {
		var children = elt.childNodes;
		var blocklevel = false;
		for (var i = 0; i < children.length; i++) {
			var processed = false;
			var n = children[i];
			if (!indentPresHandled) {
				if (DU.isElt(n)) {
					if (Util.tagOpensBlockScope(n.nodeName.toLowerCase())) {
						if (DU.isTplMetaType(n.getAttribute("typeof")) || DU.isLiteralHTMLNode(n)) {
							// FIXME: Investigate PHP parser to see
							// where else this applies.
							blocklevel = n.nodeName === "BLOCKQUOTE";
							deleteIndentPreFromDOM(n, blocklevel);
							processed = true;
						}
					} else if (n.getAttribute("typeof") === "mw:Extension/References") {
						// SSS FIXME: This may no longer be added after we started
						// stripping leading whitespace in refs in ext.Cite.js.
						// Verify and get rid of this special case.
						//
						// No pre-tags in references
						deleteIndentPreFromDOM(n, false);
						processed = true;
					}
				}
			}

			// Deal with html-pres
			if (DU.hasNodeName(n, "pre") && DU.isLiteralHTMLNode(n)) {
				var fc = n.firstChild;
				if (fc && DU.isText(fc)) {
					if (fc.data.match(/^\n/)) {
						// Always strip because of shadow metas
						fc.data = fc.data.substr(1);
						DU.getDataParsoid(n).strippedNL = true;
					}
				}
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
