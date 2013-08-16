"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

/* ------------------------------------------------------------------------------------
 * Non-IEW (inter-element-whitespace) can only be found in <td> <th> and <caption> tags
 * in a table.  If found elsewhere within a table, such content will be moved out of
 * the table and be "adopted" by the table's sibling ("foster parent").  The content
 * that gets adopted is "fostered content".
 *
 * See http://dev.w3.org/html5/spec-LC/tree-construction.html#foster-parenting
 * ------------------------------------------------------------------------------------ */
function markFosteredContent(node, env) {
	function findFosteredContent(table) {
		var tableTagId = table.data.parsoid.tagId,
			n = table.previousSibling,
			initPos = table.data.parsoid.tsr ? table.data.parsoid.tsr[0] : null,
			fosteredText = "",
			nodeBuf = [],
			tsrGap = 0;

		while (n) {
			if (DU.isElt(n)) {
				if (typeof(n.data.parsoid.tagId) !== 'number' || n.data.parsoid.tagId < tableTagId) {
					if (initPos && n.data.parsoid.tsr && DU.tsrSpansTagDOM(n, n.data.parsoid)) {
						var expectedGap = initPos - n.data.parsoid.tsr[1];
						if (tsrGap !== expectedGap) {
							/*
							console.log("Fostered text/comments: " +
								JSON.stringify(fosteredText.substring(expectedGap)));
							*/
							while (nodeBuf.length > 0) {
								// Wrap each node in a span wrapper
								var x = nodeBuf.pop();
								var span = table.ownerDocument.createElement('span');
								span.data = { parsoid: { fostered: true } };
								x.parentNode.insertBefore(span, x);
								span.appendChild(x);
							}
						}
					} else {
						/* jshint noempty: false */

						// No clue if the text in fosteredText is really fostered content.
						// If we ran this pass post-dsr-computation, we might be able to
						// detect this in more scenarios. Something to consider.

						/*
						console.warn("initPos: " + initPos);
						console.warn("have tsr: " + n.data.parsoid.tsr);
						console.warn("spans tsr: " + (n.data.parsoid.tsr && DU.tsrSpansTagDOM(n, n.data.parsoid)));
						*/
					}
					// All good at this point
					break;
				} else {
					n.data.parsoid.fostered = true;
				}
			} else {
				var str = DU.isText(n) ? n.nodeValue : "<!--" + n.nodeValue + "-->";
				tsrGap += str.length;
				fosteredText = str + fosteredText;
				nodeBuf.push(n);
			}
			n = n.previousSibling;
		}
	}

	var c = node.firstChild;
	while (c) {
		var sibling = c.nextSibling;

		if (DU.isElt(c) && c.nodeName === 'TABLE') {
			findFosteredContent(c);
		}

		if (c.childNodes.length > 0) {
			markFosteredContent(c, env);
		}
		c = sibling;
	}
}

if (typeof module === "object") {
	module.exports.markFosteredContent = markFosteredContent;
}
