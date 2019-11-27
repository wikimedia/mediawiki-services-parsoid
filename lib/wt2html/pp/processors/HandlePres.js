/** @module */

'use strict';

const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { TokenUtils } = require('../../../utils/TokenUtils.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

class HandlePres {
	fixedIndentPreText(str, isLastChild) {
		if (isLastChild) {
			return str.replace(/\n(?!$)/g, "\n ");
		} else {
			return str.replace(/\n/g, "\n ");
		}
	}

	reinsertLeadingSpace(elt, isLastChild) {
		for (var c = elt.firstChild; c; c = c.nextSibling) {
			var last = (c.nextSibling === null);
			if (DOMUtils.isText(c)) {
				c.data = this.fixedIndentPreText(c.data, isLastChild && last);
			} else if (DOMUtils.isElt(c)) {
				// recurse
				this.reinsertLeadingSpace(c, isLastChild && last);
			}
		}
	}

	findAndHandlePres(elt, indentPresHandled) {
		var nextChild;
		var blocklevel = false;
		for (var n = elt.firstChild; n; n = nextChild) {
			var processed = false;
			nextChild = n.nextSibling; // store this before n is possibly deleted
			if (!indentPresHandled && DOMUtils.isElt(n) &&
					TokenUtils.tagOpensBlockScope(n.nodeName) &&
					(WTUtils.matchTplType(n) ||
						WTUtils.isLiteralHTMLNode(n))) {
				// This is a special case in the php parser for $inBlockquote
				blocklevel = (n.nodeName === "BLOCKQUOTE");
				this.deleteIndentPreFromDOM(n, blocklevel);
				processed = true;
			}
			this.findAndHandlePres(n, indentPresHandled || processed);
		}
	}

	/* --------------------------------------------------------------
	 * Block tags change the behaviour of indent-pres.  This behaviour
	 * cannot be emulated till the DOM is built if we are to avoid
	 * having to deal with unclosed/mis-nested tags in the token stream.
	 *
	 * This goes through the DOM looking for special kinds of
	 * block tags (as determined by the PHP parser behavior -- which
	 * has its own notion of block-tag which overlaps with, but is
	 * different from, the HTML block tag notion.
	 *
	 * Wherever such a block tag is found, any Parsoid-inserted
	 * pre-tags are removed.
	 * -------------------------------------------------------------- */
	deleteIndentPreFromDOM(node, blocklevel) {
		var document = node.ownerDocument;
		var c = node.firstChild;
		while (c) {
			// get sibling before DOM is modified
			var cSibling = c.nextSibling;

			if (c.nodeName === "PRE" && !WTUtils.isLiteralHTMLNode(c)) {
				var f = document.createDocumentFragment();

				// space corresponding to the 'pre'
				f.appendChild(document.createTextNode(' '));

				// transfer children over
				var cChild = c.firstChild;
				while (cChild) {
					var next = cChild.nextSibling;
					if (DOMUtils.isText(cChild)) {
						// new child with fixed up text
						cChild = document.createTextNode(this.fixedIndentPreText(cChild.data, next === null));
					} else if (DOMUtils.isElt(cChild)) {
						// recursively process all text nodes to make
						// sure every new line gets a space char added back.
						this.reinsertLeadingSpace(cChild, next === null);
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
			} else if (!TokenUtils.tagClosesBlockScope(c.nodeName)) {
				this.deleteIndentPreFromDOM(c, blocklevel);
			}

			c = cSibling;
		}
	}

	run(body, env) {
		this.findAndHandlePres(body, false);
	}
}

if (typeof module === "object") {
	module.exports.HandlePres = HandlePres;
}
