"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

/* --------------------------------------------
 * This handles wikitext like this:
 *
 *   <references> <ref>foo</ref> </references>
 *   <references> <ref>bar</ref> </references>
 * -------------------------------------------- */
var _processRefs, _processRefsInReferences;

_processRefsInReferences = function(refsExt, node, referencesId, referencesGroup, nestedRefsHTML) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		if (DU.isElt(child)) {
			var typeOf = child.getAttribute('typeof');
			if ((/(?:^|\s)mw:Extension\/ref\/Marker(?=$|\s)/).test(typeOf)) {
				refsExt.extractRefFromNode(child, _processRefs.bind(null), referencesId, referencesGroup, nestedRefsHTML);
			} else if (child.childNodes.length > 0) {
				_processRefsInReferences(refsExt, child, referencesId, referencesGroup, nestedRefsHTML);
			}
		}

		child = nextChild;
	}
};

_processRefs = function(refsExt, node) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		if (DU.isElt(child)) {
			var typeOf = child.getAttribute('typeof');
			if ((/(?:^|\s)mw:Extension\/ref\/Marker(?=$|\s)/).test(typeOf)) {
				refsExt.extractRefFromNode(child, _processRefs.bind(null));
			} else if ((/(?:^|\s)mw:Extension\/references(?=$|\s)/).test(typeOf)) {
				var referencesId = child.getAttribute("about");
				var referencesGroup = DU.getDataParsoid(child).group;
				var nestedRefsHTML = ["\n"];
				_processRefsInReferences(refsExt, child, referencesId, referencesGroup, nestedRefsHTML);
				refsExt.insertReferencesIntoDOM(child, nestedRefsHTML);
			} else if (child.childNodes.length > 0) {
				_processRefs(refsExt, child);
			}
		}

		child = nextChild;
	}
};

function processRefs(refsExt, node, env, options, atTopLevel) {
	if (atTopLevel) {
		_processRefs(refsExt, node);
		refsExt.insertMissingReferencesIntoDOM(env, node);
	}
}

if (typeof module === "object") {
	module.exports.processRefs = processRefs;
}
