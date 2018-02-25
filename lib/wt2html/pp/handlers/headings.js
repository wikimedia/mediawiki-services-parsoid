/** @module */

'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var Sanitizer = require('../../tt/Sanitizer.js').Sanitizer;

/**
 * Generate anchor ids that the PHP parser assigns to headings.
 * This is to ensure that links that are out there in the wild
 * continue to be valid links into Parsoid HTML.
 */
function genAnchors(node, env) {
	if (!/^H[1-6]$/.test(node.nodeName)) {
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

	// Our own version of node.textContent which handles LanguageVariant
	// markup the same way PHP does (ie, uses the source wikitext).
	var textContentOf = function(node, r) {
		Array.from(node.childNodes || []).forEach(function(n) {
			if (n.nodeType === n.TEXT_NODE) {
				r.push(n.nodeValue);
			} else if (DU.hasTypeOf(n, 'mw:LanguageVariant')) {
				// Special case for -{...}-
				var dp = DU.getDataParsoid(n);
				r.push(dp.src || '');
			} else if (DU.hasTypeOf(n, 'mw:DisplaySpace')) {
				r.push(' ');
			} else {
				textContentOf(n, r);
			}
		});
		return r;
	};

	var anchorText = Sanitizer.normalizeSectionIdWhiteSpace(
		textContentOf(node, []).join('')
	);

	// Create an anchor with a sanitized id
	var anchorId = Sanitizer.escapeIdForAttribute(anchorText);
	var fallbackId = Sanitizer.escapeIdForAttribute(anchorText, {
		fallback: true,
	});
	if (anchorId === fallbackId) { fallbackId = null; /* not needed */ }

	// The ids need to be unique, but we'll enforce this in a post-processing
	// step.

	node.setAttribute('id', anchorId);
	if (fallbackId) {
		var span = node.ownerDocument.createElement('span');
		span.setAttribute('id', fallbackId);
		span.setAttribute('typeof', 'mw:FallbackId');
		node.insertBefore(span, node.firstChild);
	}

	return true;
}

if (typeof module === 'object') {
	module.exports.genAnchors = genAnchors;
}
