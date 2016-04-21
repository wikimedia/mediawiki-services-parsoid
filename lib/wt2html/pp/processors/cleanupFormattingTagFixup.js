'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;

function cleanupFormattingTagFixup(node, env) {
	node = node.firstChild;
	while (node !== null) {
		if (DU.isGeneratedFigure(node)) {
			// Find path of formatting elements.
			// NOTE: <a> is a formatting elts as well and should be explicitly skipped
			var fpath = [];
			var c = node.firstChild;
			while (DU.isFormattingElt(c) && c.nodeName !== 'A' && !c.nextSibling) {
				fpath.push(c);
				c = c.firstChild;
			}

			// Make sure that that we stopped at an A-tag and the last child is a caption
			var fpathHead = fpath[0];
			var fpathTail = fpath[fpath.length - 1];
			if (fpathHead && fpathTail.firstChild.nodeName === 'A') {
				var anchor = fpathTail.firstChild;
				var maybeCaption = fpathTail.lastChild;

				// Fix up DOM appropriately
				var fig = node;
				DU.migrateChildren(fpathTail, fig);
				if (maybeCaption.nodeName === 'FIGCAPTION') {
					DU.migrateChildren(maybeCaption, fpathTail);
					maybeCaption.appendChild(fpathHead);

					// For the formatting elements, if both the start and end tags
					// are auto-inserted, DSR algo will automatically ignore the tag.
					//
					// Otherwise, we need to clear out the TSR for DSR accuracy.
					// For simpler logic and code readability reasons, we are
					// unconditionally clearing out TSR for the formatting path that
					// got displaced from its original location so that DSR computation
					// can "recover properly" despite the extra wikitext chars
					// that interfere with it.
					fpath.forEach(function(n) {
						DU.getDataParsoid(n).tsr = null;
					});
				} else if (maybeCaption === anchor) {
					console.assert(maybeCaption.firstChild.nodeName === 'IMG', 'Expected first child of linked image to be an <img> tag.');
					// Delete the formatting elements since bolding/<small>-ing an image
					// is useless and doesn't make sense.
					while (fpath.length > 0) {
						DU.deleteNode(fpath.pop());
					}
				}
			}
		} else if (DU.isElt(node)) {
			cleanupFormattingTagFixup(node, env);
		}
		node = node.nextSibling;
	}
}

if (typeof module === "object") {
	module.exports.cleanupFormattingTagFixup = cleanupFormattingTagFixup;
}
