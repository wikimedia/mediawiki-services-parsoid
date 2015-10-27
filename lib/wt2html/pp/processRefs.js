'use strict';

var DU = require('../../utils/DOMUtils.js').DOMUtils;
var ReferencesData = require('../../ext/Cite.js').ReferencesData;


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
			} else {
				// inline image -- look inside the data-mw attribute
				if (DU.isInlineImage(child)) {
					/* -----------------------------------------------------------------
					 * SSS FIXME: This works but feels very special-cased in 2 ways:
					 *
					 * 1. special cased to images vs. any node that might have
					 *    serialized HTML embedded in data-mw
					 * 2. special cased to global cite handling -- the general scenario
					 *    is DOM post-processors that do different things on the
					 *    top-level vs not.
					 *    - Cite needs to process these fragments in the context of the
					 *      top-level page, and has to be done in order of how the nodes
					 *      are encountered.
					 *    - DOM cleanup can be done on embedded fragments without
					 *      any page-level context and in any order.
					 *    - So, some variability here.
					 *
					 * We should be running dom.cleanup.js passes on embedded html
					 * in data-mw and other attributes. Since correctness doesn't
					 * depend on that cleanup, I am not adding more special-case
					 * code in dom.cleanup.js.
					 *
					 * Doing this more generically will require creating a DOMProcessor
					 * class and adding state to it.
					 * ----------------------------------------------------------------- */
					var dmw = DU.getDataMw(child);
					var caption = dmw.caption;
					if (caption) {
						// Extract the caption HTML, build the DOM, process refs,
						// save data attribs, serialize to HTML, update the caption HTML.
						var captionDOM = DU.parseHTML(caption);
						_processRefs(cite, refsData, captionDOM.body);
						DU.saveDataAttribsForDOM(captionDOM.body);
						// FIXME: We do this in a lot of places with embedded HTML,
						// but, should we be running the XML-serializer on it?
						// Once again, this is a generic cleanup to be done unrelated
						// to this patch.
						dmw.caption = captionDOM.body.innerHTML;
					}
				}
				if (child.childNodes.length > 0) {
					_processRefs(cite, refsData, child);
				}
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
