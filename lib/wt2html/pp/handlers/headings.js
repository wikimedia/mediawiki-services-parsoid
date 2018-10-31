/** @module */

'use strict';

var DOMDataUtils = require('../../../utils/DOMDataUtils.js').DOMDataUtils;
var Util = require('../../../utils/Util.js').Util;
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
		DOMDataUtils.getDataParsoid(node).reusedId = true;
		return true;
	}

	// Our own version of node.textContent which handles LanguageVariant
	// markup the same way PHP does (ie, uses the source wikitext), and
	// handles <style>/<script> tags the same way PHP does (ie, ignores
	// the contents)
	var textContentOf = function(node, r) {
		Array.from(node.childNodes || []).forEach(function(n) {
			if (n.nodeType === n.TEXT_NODE) {
				r.push(n.nodeValue);
			} else if (DOMDataUtils.hasTypeOf(n, 'mw:LanguageVariant')) {
				// Special case for -{...}-
				var dp = DOMDataUtils.getDataParsoid(n);
				r.push(dp.src || '');
			} else if (DOMDataUtils.hasTypeOf(n, 'mw:DisplaySpace')) {
				r.push(' ');
			} else if (n.nodeName === 'STYLE' || n.nodeName === 'SCRIPT') {
				/* ignore children */
			} else {
				textContentOf(n, r);
			}
		});
		return r;
	};

	// see Parser::normalizeSectionName in Parser.php and T90902
	var normalizeSectionName = function(text) {
		try {
			var title = env.makeTitleFromURLDecodedStr(`#${text}`);
			return title.getFragment();
		} catch (e) {
			return text;
		}
	};

	var anchorText = Sanitizer.normalizeSectionIdWhiteSpace(
		textContentOf(node, []).join('')
	);
	anchorText = normalizeSectionName(anchorText);

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
		var nodeDsr = DOMDataUtils.getDataParsoid(node).dsr;
		// Set a zero-width dsr range for the fallback id
		if (Util.isValidDSR(nodeDsr)) {
			var offset = nodeDsr[0] + (nodeDsr[3] || 0);
			DOMDataUtils.getDataParsoid(span).dsr = [offset, offset];
		}
		node.insertBefore(span, node.firstChild);
	}

	return true;
}

if (typeof module === 'object') {
	module.exports.genAnchors = genAnchors;
}
