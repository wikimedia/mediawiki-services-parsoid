"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

function stripMarkerMetas(editMode, node) {
	// Sometimes a non-tpl meta node might get the mw:Transclusion typeof
	// element attached to it. So, check the property to make sure it is not
	// of those metas before deleting it.
	//
	// Ex: {{compactTOC8|side=yes|seealso=yes}} generates a mw:PageProp/notoc meta
	// that gets the mw:Transclusion typeof attached to it.  It is not okay to
	// delete it!
	var metaType = node.getAttribute("typeof");
	if (metaType &&
		// TODO: Use /Start for all Transclusion / Param markers!
		(/(?:^|\s)mw:(StartTag|EndTag|Extension\/ref\/Marker|TSRMarker)\/?[^\s]*/.test(metaType) &&
		!node.getAttribute("property")) ||
		(editMode && metaType === "mw:Placeholder/StrippedTag")
	) {
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

			delete dp.tagId;

			// Remove data-parsoid.src from templates and extensions that have
			// valid data-mw and dsr.  This should reduce data-parsoid bloat.
			//
			// Transcluded nodes will not have dp.tsr set and dont need dp.src either
			if (/(?:^|\s)mw:(Transclusion|Extension)(?=$|\s)/.test(node.getAttribute("typeof")) &&
				(!dp.tsr ||
				node.getAttribute("data-mw") && dp.dsr && dp.dsr[0] && dp.dsr[1]))
			{
				delete dp.src;
			}

			// Remove tsr
			if (dp.tsr) {
				delete dp.tsr;
			}

			// Remove temporary information
			delete dp.tmp;

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
				DU.storeDataParsoid( node, dp );
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
