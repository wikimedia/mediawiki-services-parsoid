'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var Sanitizer = require('../../tt/Sanitizer.js').Sanitizer;

// Generate anchor ids that the PHP parser assigns to headings.
// This is to ensure that links that are out there in the wild
// continue to be valid links into Parsoid HTML.
function genAnchors(node, env, atTopLevel) {
	if (!atTopLevel || !/^H[1-6]$/.test(node.nodeName)) {
		return true;
	}

	// Cannot generate an anchor id if the heading already has an id!
	//
	// NOTE: Divergence from PHP parser behavior.
	//
	// The PHP parser generates a <h*><span id="anchor-id-here-">..</span><h*>
	// So, it can preserve the existing id if any. However, in Parsoid, we are
	// generating a <h* id="anchor-id-here"> ..</h*> => we either overwrite or
	// preserve the existing id and use it for TOC, etc. We choose to preserve it.
	if (node.getAttribute('id') !== null) {
		DU.getDataParsoid(node).reusedId = true;
		return true;
	}

	// Use node.textContent to strip HTML tags
	var anchorText = Sanitizer.normalizeSectionIdWhiteSpace(node.textContent);

	// Create an anchor with a sanitized id
	var anchorId = Sanitizer.escapeId(anchorText, { noninitial: true });

	// The ids need to be unique!
	//
	// NOTE: This is not compliant with how PHP parser does it.
	// If there is an id in the doc elsewhere, this will assign
	// the heading a suffixed id, whereas the PHP parser processes
	// headings in textual order and can introduce duplicate ids
	// in a document in the process.
	//
	// However, we believe this implemention behavior is more
	// consistent when handling this edge case, and in the common
	// case (where heading ids won't conflict with ids elsewhere),
	// matches PHP parser behavior.
	var baseId = anchorId;
	var suffix = 1;
	var document = node.ownerDocument;
	while (document.getElementById(anchorId)) {
		suffix++;
		anchorId = baseId + '_' + suffix;
	}

	node.setAttribute('id', anchorId);

	return true;
}

if (typeof module === 'object') {
	module.exports.genAnchors = genAnchors;
}
