'use strict';

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var ReferencesData = require('./ext.Cite.js').ReferencesData;


/* --------------------------------------------
 * This handles wikitext like this:
 *
 *   <references> <ref>foo</ref> </references>
 *   <references> <ref>bar</ref> </references>
 * -------------------------------------------- */
var _processRefs, _processRefsInReferences;

_processRefsInReferences = function(cite, refsData, node, referencesId,
									referencesGroup, nestedRefsHTML) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		if (DU.isElt(child)) {
			var typeOf = child.getAttribute('typeof');
			if ((/(?:^|\s)mw:Extension\/ref\/Marker(?=$|\s)/).test(typeOf)) {
				cite.references.extractRefFromNode(child, refsData,
					_processRefs.bind(null, cite, refsData),
					referencesId, referencesGroup, nestedRefsHTML);
			} else if (child.childNodes.length > 0) {
				_processRefsInReferences(cite, refsData,
					child, referencesId, referencesGroup, nestedRefsHTML);
			}
		}

		child = nextChild;
	}
};

_processRefs = function(cite, refsData, node) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		if (DU.isElt(child)) {
			var typeOf = child.getAttribute('typeof');
			if ((/(?:^|\s)mw:Extension\/ref\/Marker(?=$|\s)/).test(typeOf)) {
				cite.references.extractRefFromNode(child, refsData,
					_processRefs.bind(null, cite, refsData));
			} else if ((/(?:^|\s)mw:Extension\/references(?=$|\s)/).test(typeOf)) {
				var referencesId = child.getAttribute("about");
				var referencesGroup = DU.getDataParsoid(child).group;
				var nestedRefsHTML = ["\n"];
				_processRefsInReferences(cite, refsData,
					child, referencesId, referencesGroup, nestedRefsHTML);
				cite.references.insertReferencesIntoDOM(child, refsData, nestedRefsHTML);
			} else if (child.childNodes.length > 0) {
				_processRefs(cite, refsData, child);
			}
		}

		child = nextChild;
	}
};

function processRefs(cite, node, env, options, atTopLevel) {
	if (atTopLevel) {
		var refsData = new ReferencesData();
		_processRefs(cite, refsData, node);
		cite.references.insertMissingReferencesIntoDOM(env, refsData, node);
	}
}

if (typeof module === "object") {
	module.exports.processRefs = processRefs;
}
