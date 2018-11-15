/** @module */

'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var Util = require('../../../utils/Util.js').Util;
var Consts = require('../../../config/WikitextConstants.js').WikitextConstants;

/**
 */
function stripMarkerMetas(rtTestMode, node, env, atTopLevel) {
	var metaType = node.getAttribute("typeof");
	if (!metaType) {
		return true;
	}

	// Sometimes a non-tpl meta node might get the mw:Transclusion typeof
	// element attached to it. So, check if the node has data-mw,
	// in which case we also have to keep it.
	var metaTestRE = /(?:^|\s)mw:(StartTag|EndTag|TSRMarker|Transclusion)\/?[^\s]*/;

	if ((!rtTestMode && metaType === "mw:Placeholder/StrippedTag")
			|| (metaTestRE.test(metaType) && !DU.validDataMw(node))) {
		var nextNode = node.nextSibling;
		node.parentNode.removeChild(node);
		// stop the traversal, since this node is no longer in the DOM.
		return nextNode;
	} else {
		return true;
	}
}

/**
 */
function handleEmptyElements(node, env, unused, tplInfo) {
	if (!DU.isElt(node) ||
		!Consts.Output.FlaggedEmptyElts.has(node.nodeName) ||
		(!tplInfo && node.attributes.length > 0) ||
		(tplInfo && node.attributes.length > 1) ||
		(tplInfo && node.attributes.length === 1 && !DU.hasParsoidAboutId(node)) ||
		!DU.nodeEssentiallyEmpty(node)
	) {
		return true;
	}

	// The node is known to be empty and a deletion candidate
	// * If node is part of template content, it can be deleted
	//   (since we know it has no attributes, it won't be the
	//    first node that has about, typeof, and other attrs)
	// * If not, we add the mw-empty-elt class so that wikis
	//   can decide what to do with them.
	if (tplInfo) {
		var nextNode = node.nextSibling;
		node.parentNode.removeChild(node);
		return nextNode;
	} else {
		node.classList.add('mw-empty-elt');
		return true;
	}
}

// FIXME: Leaky Cite-specific info
function isRefText(node) {
	while (!DU.atTheTop(node)) {
		if (node.classList.contains("mw-reference-text")) {
			return true;
		}
		node = node.parentNode;
	}
	return false;
}

// Whitespace in this function refers to [ \t] only
function trimWhiteSpace(node) {
	let c, next, prev;

	// Trim leading ws (on the first line)
	for (c = node.firstChild; c; c = next) {
		next = c.nextSibling;
		if (DU.isText(c) && c.data.match(/^[ \t]*$/)) {
			node.removeChild(c);
		} else if (!DU.isRenderingTransparentNode(c)) {
			break;
		}
	}

	if (DU.isText(c)) {
		c.data = c.data.replace(/^[ \t]+/, '');
	}

	// Trim trailing ws (on the last line)
	for (c = node.lastChild; c; c = prev) {
		prev = c.previousSibling;
		if (DU.isText(c) && c.data.match(/^[ \t]*$/)) {
			node.removeChild(c);
		} else if (!DU.isRenderingTransparentNode(c)) {
			break;
		}
	}

	if (DU.isText(c)) {
		c.data = c.data.replace(/[ \t]+$/, '');
	}
}

/**
 * Perform some final cleanup and save data-parsoid attributes on each node.
 */
function cleanupAndSaveDataParsoid(node, env, atTopLevel, tplInfo) {
	if (!DU.isElt(node)) {
		return true;
	}

	var dp = DU.getDataParsoid(node);
	var next;

	// Delete from data parsoid, wikitext originating autoInsertedEnd info
	if (dp.autoInsertedEnd && !DU.hasLiteralHTMLMarker(dp) &&
		Consts.WTTagsWithNoClosingTags.has(node.nodeName)) {
		dp.autoInsertedEnd = undefined;
	}

	var isFirstEncapsulationWrapperNode = (tplInfo && tplInfo.first === node) ||
		// Traversal isn't done with tplInfo for section tags, but we should
		// still clean them up as if they are the head of encapsulation.
		DU.isParsoidSectionTag(node);

	// Remove dp.src from elements that have valid data-mw and dsr.
	// This should reduce data-parsoid bloat.
	//
	// Presence of data-mw is a proxy for us knowing how to serialize
	// this content from HTML. Token handlers should strip src for
	// content where data-mw isn't necessary and html2wt knows how to
	// handle the HTML markup.
	var validDSR = DU.validDataMw(node) && Util.isValidDSR(dp.dsr);
	var isPageProp = (node.nodeName === 'META' &&
			/^mw\:PageProp\/(.*)$/.test(node.getAttribute('property')));
	if (validDSR && !isPageProp) {
		dp.src = undefined;
	} else if (isFirstEncapsulationWrapperNode && (!atTopLevel || !dp.tsr)) {
		// Transcluded nodes will not have dp.tsr set
		// and don't need dp.src either.
		dp.src = undefined;
	}

	// Remove tsr
	if (dp.tsr) {
		dp.tsr = undefined;
	}

	// Remove temporary information
	dp.tmp = undefined;

	// Make dsr zero-range for fostered content
	// to prevent selser from duplicating this content
	// outside the table from where this came.
	//
	// But, do not zero it out if the node has template encapsulation
	// information.  That will be disastrous (see T54638, T54488).
	if (dp.fostered && dp.dsr && !isFirstEncapsulationWrapperNode) {
		dp.dsr[0] = dp.dsr[1];
	}

	if (atTopLevel) {
		// Strip nowiki spans from encapsulated content but leave behind
		// wrappers on root nodes since they have valid about ids and we
		// don't want to break the about-chain by stripping the wrapper
		// and associated ids (we cannot add an about id on the nowiki-ed
		// content since that would be a text node).
		if (tplInfo && !DU.hasParsoidAboutId(node) &&
			/^mw:Nowiki$/.test(node.getAttribute('typeof'))) {
			next = node.nextSibling;
			DU.migrateChildren(node, node.parentNode, next);

			// Replace the span with an empty text node.
			// (better for perf instead of deleting the node)
			node.parentNode.replaceChild(node.ownerDocument.createTextNode(''), node);
			return next;
		}

		// Trim whitespace from some wikitext markup
		// not involving explicit HTML tags (T157481)
		if (!DU.hasLiteralHTMLMarker(dp) &&
			Consts.WikitextTagsWithTrimmableWS.has(node.nodeName)
		) {
			trimWhiteSpace(node);
		}

		var discardDataParsoid = env.discardDataParsoid;

		// Strip data-parsoid from templated content, where unnecessary.
		if (tplInfo
			// Always keep info for the first node
			&& !isFirstEncapsulationWrapperNode
			// We can't remove data-parsoid from inside <references> text,
			// as that's the only HTML representation we have left for it.
			&& !isRefText(node)
			// FIXME: We can't remove dp from nodes with stx information
			// because the serializer uses stx information in some cases to
			// emit the right newline separators.
			//
			// For example, "a\n\nb" and "<p>a</p><p>b/p>" both generate
			// identical html but serialize to different wikitext.
			//
			// This is only needed for the last top-level node .
			&& (!dp.stx || tplInfo.last !== node)
		) {
			discardDataParsoid = true;
		}

		DU.storeDataAttribs(node, {
			discardDataParsoid: discardDataParsoid,
			// Even though we're passing in the `env`, this is the only place
			// we want the storage to happen, so don't refactor this in there.
			storeInPageBundle: env.pageBundle,
			env: env,  // We only need the env in this case.
		});
	}
	return true;
}

if (typeof module === "object") {
	module.exports.cleanupAndSaveDataParsoid = cleanupAndSaveDataParsoid;
	module.exports.handleEmptyElements = handleEmptyElements;
	module.exports.stripMarkerMetas = stripMarkerMetas;
}
