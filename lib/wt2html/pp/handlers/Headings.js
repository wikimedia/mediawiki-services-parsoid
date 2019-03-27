/** @module */

'use strict';

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { Util } = require('../../../utils/Util.js');
const { Sanitizer } = require('../../tt/Sanitizer.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

class Headings {
	/**
	 * Generate anchor ids that the PHP parser assigns to headings.
	 * This is to ensure that links that are out there in the wild
	 * continue to be valid links into Parsoid HTML.
	 */
	static genAnchors(node, env) {
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
		if (node.hasAttribute('id')) {
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

	// FIXME: Why do we need global 'seenIds' state?
	// Can't we make it local to DOMPostProcessor for
	// the top-level document?
	static dedupeHeadingIds(seenIds, node, env) {
		// NOTE: This is not completely compliant with how PHP parser does it.
		// If there is an id in the doc elsewhere, this will assign
		// the heading a suffixed id, whereas the PHP parser processes
		// headings in textual order and can introduce duplicate ids
		// in a document in the process.
		//
		// However, we believe this implemention behavior is more
		// consistent when handling this edge case, and in the common
		// case (where heading ids won't conflict with ids elsewhere),
		// matches PHP parser behavior.
		if (!node.hasAttribute) { return true; /* not an Element */ }
		if (!node.hasAttribute('id')) { return true; }
		// Must be case-insensitively unique (T12721)
		// ...but note that PHP uses strtolower, which only does A-Z :(
		var key = node.getAttribute('id');
		key = key.replace(/[A-Z]+/g, function(s) { return s.toLowerCase(); });
		if (!seenIds.has(key)) {
			seenIds.add(key);
			return true;
		}
		// Only update headings and legacy links (first children of heading)
		if (
			/^H\d$/.test(node.nodeName) ||
			WTUtils.isFallbackIdSpan(node)
		) {
			var suffix = 2;
			while (seenIds.has(key + '_' + suffix)) {
				suffix++;
			}
			node.setAttribute('id', node.getAttribute('id') + '_' + suffix);
			seenIds.add(key + '_' + suffix);
		}
		return true;
	}
}

if (typeof module === 'object') {
	module.exports.Headings = Headings;
}
