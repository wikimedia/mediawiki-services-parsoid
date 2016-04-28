'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var Util = require('../../../utils/Util.js').Util;

// Extension/ref/Marker nodes are now processed on the final top-level dom only
// and have to be preserved all the way till that time. So, don't strip them
// from non-top level DOMs. Since <ref> tags can be templated, we don't want
// a "mw:Transclusion mw:Extension/ref/Marker" meta tag to be stripped.
// So, we are using an exact match regexp here.
var nonTopLevelRE = /^mw:(StartTag|EndTag|TSRMarker|Transclusion)\/?[^\s]*$/;

// For top-level DOMs, we cannot have any of these types left behind.
var topLevelRE = /(?:^|\s)mw:(StartTag|EndTag|Extension\/ref\/Marker|TSRMarker|Transclusion)\/?[^\s]*/;

function stripMarkerMetas(rtTestMode, node, env, atTopLevel) {
	var metaType = node.getAttribute("typeof");
	if (!metaType) {
		return true;
	}

	// Sometimes a non-tpl meta node might get the mw:Transclusion typeof
	// element attached to it. So, check if the node has data-mw,
	// in which case we also have to keep it, except if it's also a mw:extension/ref/Marker
	// in which case it'll have data-mw but we have to remove the node.
	var metaTestRE = atTopLevel ? topLevelRE : nonTopLevelRE;
	if ((!rtTestMode && metaType === "mw:Placeholder/StrippedTag")
		|| (metaTestRE.test(metaType) &&
			(!DU.validDataMw(node) ||
			metaType.match(/mw:Extension\/ref\/Marker/)))) {
		var nextNode = node.nextSibling;
		DU.deleteNode(node);
		// stop the traversal, since this node is no longer in the DOM.
		return nextNode;
	} else {
		return true;
	}
}

function findEnclosingTemplateName(tplInfo) {
	var dmw = DU.getDataMw(tplInfo.first);
	if (dmw.parts && dmw.parts.length === 1) {
		return dmw.parts[0].template.target.wt.trim();
	} else {
		return 'Multi-part-template: ' + JSON.stringify(dmw);
	}
}

function stripEmptyElements(node, env, atTopLevel, tplInfo) {
	if (!atTopLevel || !tplInfo || !DU.isElt(node)) {
		return true;
	}

	// Cannot delete if:
	// * it is the first node since that carries the transclusion
	//   information (typeof, data-mw). We could delete and migrate
	//   the info over, but more pain than worth it. We can reconsider if
	//   this ever becomes an issue.
	// * it has any attributes.
	if (!node.firstChild && node !== tplInfo.first &&
		node.nodeName in {'TR': 1, 'LI': 1} && node.attributes.length === 0
	) {
		env.log('warning/empty/' + node.nodeName.toLowerCase(),
			'Template', findEnclosingTemplateName(tplInfo),
			'produces stripped empty elements');
		var nextNode = node.nextSibling;
		DU.deleteNode(node);
		return nextNode;
	} else {
		return true;
	}
}

function isRefText(node) {
	while (!DU.atTheTop(node)) {
		if (node.classList.contains("mw-reference-text")) {
			return true;
		}
		node = node.parentNode;
	}
	return false;
}

/**
 * Perform some final cleanup and save data-parsoid attributes on each node.
 */
function cleanupAndSaveDataParsoid(node, env, atTopLevel, tplInfo) {
	if (!DU.isElt(node)) { return true; }

	var dp = DU.getDataParsoid(node);
	var next;

	// Delete empty auto-inserted elements
	if (dp.autoInsertedStart && dp.autoInsertedEnd &&
		!DU.isTplOrExtToplevelNode(node) && (
			node.childNodes.length === 0 || (
				node.childNodes.length === 1 && !DU.isElt(node.firstChild) &&
				/^\s*$/.test(node.textContent)
			)
	)) {
		next = node.nextSibling;
		if (node.firstChild) {
			// migrate the ws out
			node.parentNode.insertBefore(node.firstChild, node);
		}
		DU.deleteNode(node);
		return next;
	}

	// Remove dp.src from elements that have valid data-mw and dsr.
	// This should reduce data-parsoid bloat.
	var validDSR = DU.validDataMw(node) && Util.isValidDSR(dp.dsr);
	var isPageProp = (node.nodeName === 'META' &&
			/^mw\:PageProp\/(.*)$/.test(node.getAttribute('property')));
	if (validDSR && !isPageProp) {
		dp.src = undefined;
	} else if (tplInfo && tplInfo.first === node && (!atTopLevel || !dp.tsr)) {
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
	if (dp.fostered && dp.dsr && !(tplInfo && tplInfo.first === node)) {
		dp.dsr[0] = dp.dsr[1];
	}

	if (atTopLevel) {
		// Strip nowiki spans from templated content
		// but leave behind wrappers on root nodes (they have valid about ids)
		if (tplInfo && !DU.isTplOrExtToplevelNode(node) &&
			/^mw:Nowiki$/.test(node.getAttribute('typeof'))) {
			next = node.nextSibling;
			DU.migrateChildren(node, node.parentNode, next);

			// Replace the span with an empty text node.
			// (better for perf instead of deleting the node)
			node.parentNode.replaceChild(node.ownerDocument.createTextNode(''), node);
			return next;
		}

		var discardDataParsoid = env.discardDataParsoid;

		// Strip data-parsoid from templated content, where unnecessary.
		if (tplInfo
			// Always keep info for the first node
			&& tplInfo.first !== node
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
		) { discardDataParsoid = true; }

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
	module.exports.stripEmptyElements = stripEmptyElements;
	module.exports.stripMarkerMetas = stripMarkerMetas;
}
