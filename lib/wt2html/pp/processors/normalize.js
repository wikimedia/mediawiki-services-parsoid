'use strict';

var domino = require('domino');

// Test for domino > 1.0.30, where childNodes was made a proper read-only
// property. Not coincidentally, the workaround below for a slow implementation
// of Node#normalize in domino became unnecessary after 1.0.30.
var DOMINO_AFTER_1_0_30 = false;
try {
	domino.createDocument('test').body.childNodes = new domino.impl.NodeList();
} catch (e) {
	DOMINO_AFTER_1_0_30 = true;
}


var DU = require('../../../utils/DOMUtils').DOMUtils;

// Like Node.normalize() but it clones the childNodes arrays in order to avoid
// O(N^2) runtime, at the cost of breaking liveness of childNodes references.
function normalizeNode(parent) {
	var i, j;
	var kids = parent.childNodes;
	var newChunks = [];
	var chunkStart = 0;
	for (i = 0; i < kids.length; i++) {
		var child = kids[i];

		if (DU.isElt(child)) {
			normalizeNode(child);
			continue;
		} else if (!DU.isText(child)) {
			continue;
		}
		if (child.nodeValue === '') {
			// Delete the current node, by adding a slice to the chunk list,
			// not including the current node, and making the node after be
			// the start of the following chunk.
			if (i > chunkStart) {
				newChunks.push(kids.slice(chunkStart, i));
			}
			chunkStart = i + 1;
		} else {
			// Concatenate text from adjacent text nodes into this one
			for (j = i + 1;
				j < kids.length && DU.isText(kids[j]);
				j++) {
				child.appendData(kids[j].nodeValue);
			}
			// j is now equal to the end of the text node range plus one,
			// i.e. the range of text nodes is [i, j).
			if (j > i + 1) {
				// Delete the surplus text nodes by adding a chunk which
				// includes the current node but not the rest of the text node
				// range. Then set chunkStart to follow the text node range.
				if (i + 1 > chunkStart) {
					newChunks.push(kids.slice(chunkStart, i + 1));
				}
				chunkStart = j;
				// Advance the cursor to skip the deleted nodes. Minus one
				// since i will soon be incremented.
				i = j - 1;
			}
		}
	}
	// If any nodes have been deleted, chunkStart will have moved
	if (chunkStart !== 0) {
		if (kids.length > chunkStart) {
			newChunks.push(kids.slice(chunkStart));
		}
		// Clone childNodes by concatenating the chunks
		// XXX: childNodes isn't really writable in DOM; this only works
		// for domino <= 1.0.30
		parent.childNodes = new domino.impl.NodeList([].concat.apply([], newChunks));
	}
}

function normalize(body, env) {
	if (DOMINO_AFTER_1_0_30) {
		body.normalize();
	} else {
		normalizeNode(body);
	}
}

if (typeof module === "object") {
	module.exports = {
		normalize: normalize,
	};
}
