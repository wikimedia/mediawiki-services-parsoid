"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

/* --------------------------------------------
 * This handles wikitext like this:
 *
 *   <references> <ref>foo</ref> </references>
 *   <references> <ref>bar</ref> </references>
 * -------------------------------------------- */
var _processRefs, _processRefsInReferences;

_processRefsInReferences = function(cite, node, referencesId, referencesGroup, nestedRefsHTML) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		if (DU.isElt(child)) {
			var typeOf = child.getAttribute('typeof');
			if ((/(?:^|\s)mw:Extension\/ref\/Marker(?=$|\s)/).test(typeOf)) {
				cite.references.extractRefFromNode(child,
					_processRefs.bind(null), referencesId, referencesGroup, nestedRefsHTML);
			} else if (child.childNodes.length > 0) {
				_processRefsInReferences(cite,
					child, referencesId, referencesGroup, nestedRefsHTML);
			}
		}

		child = nextChild;
	}
};

_processRefs = function(cite, node) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		if (DU.isElt(child)) {
			var typeOf = child.getAttribute('typeof');
			if ((/(?:^|\s)mw:Extension\/ref\/Marker(?=$|\s)/).test(typeOf)) {
				cite.references.extractRefFromNode(child, _processRefs.bind(null));
			} else if ((/(?:^|\s)mw:Extension\/references(?=$|\s)/).test(typeOf)) {
				var referencesId = child.getAttribute("about");
				var referencesGroup = DU.getDataParsoid(child).group;
				var nestedRefsHTML = ["\n"];
				_processRefsInReferences(cite,
					child, referencesId, referencesGroup, nestedRefsHTML);
				cite.references.insertReferencesIntoDOM(child, nestedRefsHTML);
			} else if (child.childNodes.length > 0) {
				_processRefs(cite, child);
			}
		}

		child = nextChild;
	}
};

function processRefs(cite, node, env, options, atTopLevel) {
	if (atTopLevel) {
		_processRefs(cite, node);
		cite.references.insertMissingReferencesIntoDOM(env, node);
		// We have a broken design where all native extension objects
		// are reused across all documents. So, given that Cite is
		// maintaining object state (during a sync pass => it need not do that),
		// we need to reset state so that other documents that are
		// in the middle of being processed don't use that state.
		// Future patches will fix both of these design issues.
		cite.resetState({toplevel: true});
	}
}

if (typeof module === "object") {
	module.exports.processRefs = processRefs;
}
