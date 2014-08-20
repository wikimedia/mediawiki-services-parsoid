"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

function stripEmptyElements(node, env, options, atTopLevel, tplInfo) {
	// Dont bother with this on sub-pipelines
	if (!atTopLevel) {
		return;
	}

	var c = node.firstChild;
	while (c) {
		var next = c.nextSibling;

		if (DU.isElt(c)) {
			// Identify template/extension content
			if (DU.isTplOrExtToplevelNode(env, c)) {
				var about = c.getAttribute('about');
				tplInfo = { first: c, last: DU.getAboutSiblings(c, about).last() };
			}

			// Process subtree first
			stripEmptyElements(c, env, options, atTopLevel, tplInfo);

			// Delete empty tr-rows and li-nodes from template content
			// Cannot delete the first node that carries the typeof.
			if (tplInfo) {
				if (!c.firstChild && c.nodeName in {'TR':1, 'LI':1} && c !== tplInfo.first) {
					DU.deleteNode(c);
				}

				// Clear tpl info
				if (c === tplInfo.last) {
					tplInfo = null;
				}
			}
		}

		c = next;
	}
}

if (typeof module === "object") {
	module.exports.stripEmptyElements = stripEmptyElements;
}
