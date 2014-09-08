"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

// Extension/ref/Marker nodes are now processed on the final top-level dom only
// and have to be preserved all the way till that time.
//
// TODO: Use /Start for all Transclusion / Param markers!
var topLevelRE = /(?:^|\s)mw:(StartTag|EndTag|Extension\/ref\/Marker|TSRMarker)\/?[^\s]*/;
var nonTopLevelRE = /(?:^|\s)mw:(StartTag|EndTag|TSRMarker)\/?[^\s]*/;

function stripMarkerMetas(rtTestMode, node, atTopLevel) {
	// Sometimes a non-tpl meta node might get the mw:Transclusion typeof
	// element attached to it. So, check the property to make sure it is not
	// of those metas before deleting it.
	//
	// Ex: {{compactTOC8|side=yes|seealso=yes}} generates a mw:PageProp/notoc meta
	// that gets the mw:Transclusion typeof attached to it.  It is not okay to
	// delete it!
	var metaType = node.getAttribute("typeof");
	var metaTestRE = atTopLevel ? topLevelRE : nonTopLevelRE;
	if (metaType
		&& ((metaTestRE.test(metaType) && !node.getAttribute("property"))
			|| (!rtTestMode && metaType === "mw:Placeholder/StrippedTag"))
		)
	{
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
function cleanupAndSaveDataParsoid( env, node ) {
	if ( DU.isElt(node) ) {
		var dp = DU.getDataParsoid( node );
		if (dp) {
			// Delete empty auto-inserted elements
			var next = node.nextSibling;
			if (dp.autoInsertedStart && dp.autoInsertedEnd &&
				!DU.isTplOrExtToplevelNode(env, node) &&
				(node.childNodes.length === 0 ||
				node.childNodes.length === 1 && !DU.isElt(node.firstChild) && /^\s*$/.test(node.textContent)))
			{
				if (node.firstChild) {
					// migrate the ws out
					node.parentNode.insertBefore(node.firstChild, node);
				}
				DU.deleteNode(node);
				return next;
			}

			dp.tagId = undefined;

			var validDM = !!Object.keys(DU.getDataMw(node)).length;
			if ( !validDM ) {
				// strip it
				DU.setDataMw(node, undefined);
			}

			// Remove data-parsoid.src from templates and extensions that have
			// valid data-mw and dsr.  This should reduce data-parsoid bloat.
			//
			// Transcluded nodes will not have dp.tsr set and dont need dp.src either
			if (/(?:^|\s)mw:(Transclusion|Extension)(?=$|\s)/.test(node.getAttribute("typeof")) &&
				(!dp.tsr || validDM && dp.dsr && dp.dsr[0] && dp.dsr[1]))
			{
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

			if ( env.conf.parsoid.storeDataParsoid ) {
				DU.stripDataParsoid( node, dp );
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
