"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Util = require('./mediawiki.Util.js').Util;

// Extension/ref/Marker nodes are now processed on the final top-level dom only
// and have to be preserved all the way till that time.
var topLevelRE = /(?:^|\s)mw:(StartTag|EndTag|Extension\/ref\/Marker|TSRMarker|Transclusion)\/?[^\s]*/;
var nonTopLevelRE = /(?:^|\s)mw:(StartTag|EndTag|TSRMarker|Transclusion)\/?[^\s]*/;

function stripMarkerMetas(rtTestMode, node, atTopLevel) {
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
			(Object.keys(DU.getDataMw(node) || {}).length === 0 ||
			metaType.match(/mw:Extension\/ref\/Marker/)))) {
		var nextNode = node.nextSibling;
		DU.deleteNode(node);
		// stop the traversal, since this node is no longer in the DOM.
		return nextNode;
	} else {
		return true;
	}
}

/**
 * Perform some final cleaup and save data-parsoid attributes on each node.
 */
function cleanupAndSaveDataParsoid( env, node, atTopLevel ) {
	if ( DU.isElt(node) ) {
		var dp = DU.getDataParsoid( node );
		if (dp) {
			// Delete empty auto-inserted elements
			var next = node.nextSibling;
			if (dp.autoInsertedStart && dp.autoInsertedEnd &&
				!DU.isTplOrExtToplevelNode(node) &&
				(node.childNodes.length === 0 ||
				node.childNodes.length === 1 && !DU.isElt(node.firstChild) && /^\s*$/.test(node.textContent))) {
				if (node.firstChild) {
					// migrate the ws out
					node.parentNode.insertBefore(node.firstChild, node);
				}
				DU.deleteNode(node);
				return next;
			}

			dp.tagId = undefined;

			var validDataMW = !!Object.keys(DU.getDataMw(node)).length;
			if ( !validDataMW ) {
				// strip it
				DU.setDataMw(node, undefined);
			}

			// Remove dp.src from elements that have valid data-mw and dsr. This
			// should reduce data-parsoid bloat.
			if (validDataMW && Util.isValidDSR(dp.dsr)) {
				dp.src = undefined;
			} else if (/(?:^|\s)mw:(Transclusion|Extension)(\/[^\s]+)*(?=$|\s)/.test(node.getAttribute("typeof")) &&
				(!atTopLevel || !dp.tsr)) {
				// Transcluded nodes will not have dp.tsr set and dont need dp.src either
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
			// information.  That will be disastrous (see bug 52638, 52488).
			if (dp.fostered && dp.dsr && !DU.isFirstEncapsulationWrapperNode(node)) {
				dp.dsr[0] = dp.dsr[1];
			}

			if ( atTopLevel && env.storeDataParsoid ) {
				DU.stripDataParsoid( env, node, dp );
			}
		}
		DU.saveDataAttribs( node );
	}
	return true;
}

if (typeof module === "object") {
	module.exports.cleanupAndSaveDataParsoid = cleanupAndSaveDataParsoid;
	module.exports.stripMarkerMetas = stripMarkerMetas;
}
