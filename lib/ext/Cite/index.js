/**
 * This module implements `<ref>` and `<references>` extension tag handling
 * natively in Parsoid.
 * @module ext/Cite
 */

'use strict';

var domino = require('domino');

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.9.0');
var Util = ParsoidExtApi.Util;
var DU = ParsoidExtApi.DOMUtils;
var Promise = ParsoidExtApi.Promise;
var Sanitizer = module.parent.require('../wt2html/tt/Sanitizer.js').Sanitizer;

/**
 * Simple token transform version of the Ref extension tag.
 *
 * @class
 */
function Ref(cite) {
	this.cite = cite;
}

function hasRef(node) {
	var c = node.firstChild;
	while (c) {
		if (DU.isElt(c)) {
			if (DU.isSealedFragmentOfType(c, 'ref')) {
				return true;
			}
			if (hasRef(c)) {
				return true;
			}
		}
		c = c.nextSibling;
	}
	return false;
}

Ref.prototype.toDOM = function(state, content, args) {
	// Drop nested refs entirely, unless we've explicitly allowed them
	if (state.parseContext.extTag === 'ref' && !state.parseContext.allowNestedRef) {
		return null;
	}

	// The one supported case for nested refs is from the {{#tag:ref}} parser
	// function.  However, we're overly permissive here since we can't
	// distinguish when that's nested in another template.
	// The php preprocessor did our expansion.
	const allowNestedRef = state.parseContext.inTemplate && state.parseContext.extTag !== 'ref';

	return ParsoidExtApi.parseWikitextToDOM(state, args, '', content, {
		// NOTE: sup's content model requires it only contain phrasing
		// content, not flow content. However, since we are building an
		// in-memory DOM which is simply a tree data structure, we can
		// nest flow content in a <sup> tag.
		wrapperTag: 'sup',
		extTag: 'ref',
		inTemplate: state.parseContext.inTemplate,
		allowNestedRef: allowNestedRef,
		noPWrapping: true,
		noPre: true,
	});
};

Ref.prototype.serialHandler = {
	handle: Promise.async(function *(node, state, wrapperUnmodified) {
		var startTagSrc = yield state.serializer.serializeExtensionStartTag(node, state);
		var dataMw = DU.getDataMw(node);
		var env = state.env;
		var html;
		if (!dataMw.body) {
			return startTagSrc;  // We self-closed this already.
		} else if (typeof dataMw.body.html === 'string') {
			// First look for the extension's content in data-mw.body.html
			html = dataMw.body.html;
		} else if (typeof dataMw.body.id === 'string') {
			// If the body isn't contained in data-mw.body.html, look if
			// there's an element pointed to by body.id.
			var bodyElt = node.ownerDocument.getElementById(dataMw.body.id);
			if (!bodyElt && env.page.editedDoc) {
				// Try to get to it from the main page.
				// This can happen when the <ref> is inside another
				// extension, most commonly inside a <references>.
				// The recursive call to serializeDOM puts us inside
				// inside a new document.
				bodyElt = env.page.editedDoc.getElementById(dataMw.body.id);
			}
			if (bodyElt) {
				// n.b. this is going to drop any diff markers but since
				// the dom differ doesn't traverse into extension content
				// none should exist anyways.
				html = DU.ppToXML(bodyElt, { innerXML: true });
			} else {
				// Some extra debugging for VisualEditor
				var extraDebug = '';
				var firstA = node.querySelector('a[href]');
				if (firstA && /^#/.test(firstA.getAttribute('href'))) {
					var href = firstA.getAttribute('href');
					try {
						var ref = node.ownerDocument.querySelector(href);
						if (ref) {
							extraDebug += ' [own doc: ' + ref.outerHTML + ']';
						}
						ref = env.page.editedDoc.querySelector(href);
						if (ref) {
							extraDebug += ' [main doc: ' + ref.outerHTML + ']';
						}
					} catch (e) { }  // eslint-disable-line
					if (!extraDebug) {
						extraDebug = ' [reference ' + href + ' not found]';
					}
				}
				env.log('error/' + dataMw.name,
						'extension src id ' + dataMw.body.id +
						' points to non-existent element for:', node.outerHTML,
						'. More debug info: ', extraDebug);
				return '';  // Drop it!
			}
		} else {
			env.log('error', 'Ref body unavailable for: ' + node.outerHTML);
			return '';  // Drop it!
		}
		var src = yield state.serializer.serializeHTML({
			env: state.env,
			extName: dataMw.name,
		}, html);
		return startTagSrc + src + '</' + dataMw.name + '>';
	}),
};

Ref.prototype.lintHandler = function(ref, env, tplInfo, domLinter) {
	// Don't lint the content of ref in ref, since it can lead to cycles
	// using named refs
	if (DU.fromExtensionContent(ref, 'references')) { return ref.nextNode; }

	var linkBackId = ref.firstChild.getAttribute('href').replace(/[^#]*#/, '');
	var refNode = ref.ownerDocument.getElementById(linkBackId);
	if (refNode) {
		// Ex: Buggy input wikitext without ref content
		domLinter(refNode.lastChild, env, tplInfo.isTemplated ? tplInfo : null);
	}
	return ref.nextNode;
};

/**
 * Helper class used by `<references>` implementation.
 * @class
 */
function RefGroup(group) {
	this.name = group || '';
	this.refs = [];
	this.indexByName = new Map();
}

function makeValidIdAttr(val) {
	// Looks like Cite.php doesn't try to fix ids that already have
	// a "_" in them. Ex: name="a b" and name="a_b" are considered
	// identical. Not sure if this is a feature or a bug.
	// It also considers entities equal to their encoding
	// (i.e. '&' === '&amp;'), which is done:
	//  in PHP: Sanitizer#decodeTagAttributes and
	//  in Parsoid: ExtensionHandler#normalizeExtOptions
	return Sanitizer.escapeIdForAttribute(val);
}

RefGroup.prototype.renderLine = function(env, refsList, ref) {
	var ownerDoc = refsList.ownerDocument;

	// Generate the li and set ref content first, so the HTML gets parsed.
	// We then append the rest of the ref nodes before the first node
	var li = ownerDoc.createElement('li');
	DU.addAttributes(li, {
		'about': "#" + ref.target,
		'id': ref.target,
	});
	var reftextSpan = ownerDoc.createElement('span');
	DU.addAttributes(reftextSpan, {
		'id': "mw-reference-text-" + ref.target,
		'class': "mw-reference-text",
	});
	if (ref.content) {
		var content = env.fragmentMap.get(ref.content)[0];
		DU.migrateChildrenBetweenDocs(content, reftextSpan);
		DU.visitDOM(reftextSpan, DU.loadDataAttribs);
	}
	li.appendChild(reftextSpan);

	// Generate leading linkbacks
	var createLinkback = function(href, group, text) {
		var a = ownerDoc.createElement('a');
		var s = ownerDoc.createElement('span');
		var textNode = ownerDoc.createTextNode(text + " ");
		a.setAttribute('href', env.page.titleURI + '#' + href);
		s.setAttribute('class', 'mw-linkback-text');
		if (group) {
			a.setAttribute('data-mw-group', group);
		}
		s.appendChild(textNode);
		a.appendChild(s);
		return a;
	};
	if (ref.linkbacks.length === 1) {
		var linkback = createLinkback(ref.id, ref.group, '↑');
		linkback.setAttribute('rel', 'mw:referencedBy');
		li.insertBefore(linkback, reftextSpan);
	} else {
		// 'mw:referencedBy' span wrapper
		var span = ownerDoc.createElement('span');
		span.setAttribute('rel', 'mw:referencedBy');
		li.insertBefore(span, reftextSpan);

		ref.linkbacks.forEach(function(lb, i) {
			span.appendChild(createLinkback(lb, ref.group, i + 1));
		});
	}

	// Space before content node
	li.insertBefore(ownerDoc.createTextNode(' '), reftextSpan);

	// Add it to the ref list
	refsList.appendChild(li);
};

/**
 * @class
 */
function ReferencesData(env) {
	this.index = 0;
	this.env = env;
	this.refGroups = new Map();
}

ReferencesData.prototype.getRefGroup = function(groupName, allocIfMissing) {
	groupName = groupName || '';
	if (!this.refGroups.has(groupName) && allocIfMissing) {
		this.refGroups.set(groupName, new RefGroup(groupName));
	}
	return this.refGroups.get(groupName);
};

ReferencesData.prototype.removeRefGroup = function(groupName) {
	if (groupName !== null && groupName !== undefined) {
		// '' is a valid group (the default group)
		this.refGroups.delete(groupName);
	}
};

ReferencesData.prototype.add = function(env, groupName, refName, about, skipLinkback) {
	var group = this.getRefGroup(groupName, true);
	refName = makeValidIdAttr(refName);

	var ref;
	if (refName && group.indexByName.has(refName)) {
		ref = group.indexByName.get(refName);
		if (ref.content) {
			ref.hasMultiples = true;
			// Use the non-pp version here since we've already stored attribs
			// before putting them in the map.
			ref.cachedHtml = DU.toXML(env.fragmentMap.get(ref.content)[0], { innerXML: true });
		}
	} else {
		// The ids produced Cite.php have some particulars:
		// Simple refs get 'cite_ref-' + index
		// Refs with names get 'cite_ref-' + name + '_' + index + (backlink num || 0)
		// Notes (references) whose ref doesn't have a name are 'cite_note-' + index
		// Notes whose ref has a name are 'cite_note-' + name + '-' + index
		var n = this.index;
		var refKey = (1 + n) + '';
		var refIdBase = 'cite_ref-' + (refName ? refName + '_' + refKey : refKey);
		var noteId = 'cite_note-' + (refName ? refName + '-' + refKey : refKey);

		// bump index
		this.index += 1;

		ref = {
			about: about,
			content: null,
			group: group.name,
			groupIndex: group.refs.length + 1,
			index: n,
			key: refIdBase,
			id: (refName ? refIdBase + '-0' : refIdBase),
			linkbacks: [],
			name: refName,
			target: noteId,
			hasMultiples: false,
			// Just used for comparison when we have multiples
			cachedHtml: '',
		};
		group.refs.push(ref);
		if (refName) {
			group.indexByName.set(refName, ref);
		}
	}

	if (!skipLinkback) {
		ref.linkbacks.push(ref.key + '-' + ref.linkbacks.length);
	}
	return ref;
};

/**
 * @class
 */
function References(cite) {
	this.cite = cite;
}

var dummyDoc = domino.createDocument();

var createReferences = function(env, body, refsOpts, modifyDp, autoGenerated) {
	var doc = body ? body.ownerDocument : dummyDoc;

	var ol = doc.createElement('ol');
	ol.classList.add('mw-references');
	ol.classList.add('references');

	if (body) {
		DU.migrateChildren(body, ol);
	}

	// Support the `responsive` parameter
	var rrOpts = env.conf.wiki.responsiveReferences;
	var responsiveWrap = rrOpts.enabled;
	if (refsOpts.responsive !== null) {
		responsiveWrap = refsOpts.responsive !== '0';
	}

	var frag;
	if (responsiveWrap) {
		var div = doc.createElement('div');
		div.classList.add('mw-references-wrap');
		div.appendChild(ol);
		frag = div;
	} else {
		frag = ol;
	}

	if (autoGenerated) {
		DU.addAttributes(frag, {
			typeof: 'mw:Extension/references',
			about: env.newAboutId(),
		});
	}

	var dp = DU.getDataParsoid(frag);
	if (refsOpts.group) {  // No group for the empty string either
		dp.group = refsOpts.group;
		ol.setAttribute('data-mw-group', refsOpts.group);
	}
	if (refsOpts.responsive !== null) {
		// Pass along the `responsive` parameter
		dp.tmp.responsive = refsOpts.responsive;
	}
	if (typeof modifyDp === 'function') {
		modifyDp(dp);
	}

	return frag;
};

References.prototype.toDOM = function(state, content, args) {
	return ParsoidExtApi.parseWikitextToDOM(state, args, '', content, {
		wrapperTag: 'div',
		extTag: 'references',
		inTemplate: state.parseContext.inTemplate,
		noPWrapping: true,
		noPre: true,
	}).then(function(doc) {
		var refsOpts = Object.assign({
			group: null,
			responsive: null,
		}, Util.kvToHash(args, true));

		var frag = createReferences(state.manager.env, doc.body, refsOpts, function(dp) {
			dp.src = state.extToken.getAttribute('source');
			dp.selfClose = state.extToken.dataAttribs.selfClose;
		});
		doc.body.appendChild(frag);

		return doc;
	});
};

var _processRefs;

References.prototype.extractRefFromNode = function(node, refsData, cite,
	referencesAboutId, referencesGroup, nestedRefsHTML) {
	var env = refsData.env;
	var nestedInReferences = referencesAboutId !== undefined;
	var isTplWrapper = /\bmw:Transclusion\b/.test(node.getAttribute('typeof'));

	var tplDmw;
	var dp = DU.getDataParsoid(node);
	var refDmw = Util.clone(DU.getDataMw(node));
	if (isTplWrapper) {
		tplDmw = refDmw;
		refDmw = dp.nestedDmw;
	}

	// SSS FIXME: Need to clarify semantics here.
	// If both the containing <references> elt as well as the nested <ref>
	// elt has a group attribute, what takes precedence?
	var group = refDmw.attrs.group || referencesGroup || '';
	var refName = refDmw.attrs.name || '';
	var about = node.getAttribute("about");
	var ref = refsData.add(env, group, refName, about, nestedInReferences);
	var nodeType = (node.getAttribute("typeof") || '').replace(/mw:DOMFragment\/sealed\/ref/, '');

	// Add ref-index linkback
	var doc = node.ownerDocument;
	var linkBack = doc.createElement('sup');
	var content = dp.html;

	var c = env.fragmentMap.get(content)[0];
	DU.visitDOM(c, DU.loadDataAttribs); // FIXME: Lot of useless work for an edge case
	if (DU.getDataParsoid(c).empty) {
		// Discard wrapper if there was no input wikitext
		content = null;
		// Setting to null seems unnecessary.
		// undefined might be sufficient.
		// But, can be cleaned up separately.
		refDmw.body = null;
	} else {
		if (hasRef(c)) { // nested ref-in-ref
			_processRefs(cite, refsData, c);
		}
		DU.visitDOM(c, DU.storeDataAttribs);

		// If there are multiple <ref>s with the same name, but different content,
		// the content of the first <ref> shows up in the <references> section.
		// in order to ensure lossless RT-ing for later <refs>, we have to record
		// HTML inline for all of them.
		var html = '';
		var contentDiffers = false;
		if (ref.hasMultiples) {
			// Use the non-pp version here since we've already stored attribs
			// before putting them in the map.
			html = DU.toXML(env.fragmentMap.get(content)[0], { innerXML: true });
			contentDiffers = html !== ref.cachedHtml;
		}
		if (contentDiffers) {
			refDmw.body = { 'html': html };
		} else {
			refDmw.body = { 'id': "mw-reference-text-" + ref.target };
		}
	}

	DU.addAttributes(linkBack, {
		'about': about,
		'class': 'mw-ref',
		'id': nestedInReferences ? undefined :
		(ref.name ? ref.linkbacks[ref.linkbacks.length - 1] : ref.id),
		'rel': 'dc:references',
		'typeof': nodeType,
	});
	DU.addTypeOf(linkBack, "mw:Extension/ref");
	var dataParsoid = {
		src: dp.src,
		dsr: dp.dsr,
		pi: dp.pi,
	};
	DU.setDataParsoid(linkBack, dataParsoid);
	if (isTplWrapper) {
		DU.setDataMw(linkBack, tplDmw);
	} else {
		DU.setDataMw(linkBack, refDmw);
	}

	// refLink is the link to the citation
	var refLink = doc.createElement('a');
	DU.addAttributes(refLink, {
		'href': env.page.titleURI + '#' + ref.target,
		'style': 'counter-reset: mw-Ref ' + ref.groupIndex + ';',
	});
	if (ref.group) {
		refLink.setAttribute('data-mw-group', ref.group);
	}

	// refLink-span which will contain a default rendering of the cite link
	// for browsers that don't support counters
	var refLinkSpan = doc.createElement('span');
	refLinkSpan.setAttribute('class', 'mw-reflink-text');
	refLinkSpan.appendChild(doc.createTextNode("[" +
		(ref.group ? ref.group + " " : "") + ref.groupIndex + "]"));
	refLink.appendChild(refLinkSpan);
	linkBack.appendChild(refLink);

	if (!nestedInReferences) {
		node.parentNode.replaceChild(linkBack, node);
	} else {
		// We don't need to delete the node now since it'll be removed in
		// `insertReferencesIntoDOM` when all the children all cleaned out.
		nestedRefsHTML.push(DU.ppToXML(linkBack), '\n');
	}

	// Keep the first content to compare multiple <ref>s with the same name.
	if (!ref.content) {
		ref.content = content;
	}
};

References.prototype.insertReferencesIntoDOM = function(refsNode, refsData, nestedRefsHTML, autoGenerated) {
	var env = refsData.env;
	var isTplWrapper = /\bmw:Transclusion\b/.test(refsNode.getAttribute('typeof'));
	var dp = DU.getDataParsoid(refsNode);
	var group = dp.group || '';
	if (!isTplWrapper) {
		var dataMw = DU.getDataMw(refsNode);
		if (!Object.keys(dataMw).length) {
			dataMw = {
				'name': 'references',
				'attrs': {
					'group': group || undefined, // Dont emit empty keys
				},
			};
			DU.setDataMw(refsNode, dataMw);
		}
		dataMw.attrs.responsive = dp.tmp.responsive; // Rt the `responsive` parameter

		// Mark this auto-generated so that we can skip this during
		// html -> wt and so that clients can strip it if necessary.
		if (autoGenerated) {
			dataMw.autoGenerated = true;
		} else if (nestedRefsHTML.length > 0) {
			dataMw.body = { 'html': '\n' + nestedRefsHTML.join('') };
		} else if (!dp.selfClose) {
			dataMw.body = { 'html': '' };
		} else {
			dataMw.body = undefined;
		}
		dp.selfClose = undefined;
	}

	var refGroup = refsData.getRefGroup(group);

	// Deal with responsive wrapper
	if (refsNode.classList.contains('mw-references-wrap')) {
		var rrOpts = env.conf.wiki.responsiveReferences;
		if (refGroup && refGroup.refs.length > rrOpts.threshold) {
			refsNode.classList.add('mw-references-columns');
		}
		refsNode = refsNode.firstChild;
	}

	// Remove all children from the references node
	//
	// Ex: When {{Reflist}} is reused from the cache, it comes with
	// a bunch of references as well. We have to remove all those cached
	// references before generating fresh references.
	while (refsNode.firstChild) {
		refsNode.removeChild(refsNode.firstChild);
	}

	if (refGroup) {
		refGroup.refs.forEach(refGroup.renderLine.bind(refGroup, env, refsNode));
	}

	// Remove the group from refsData
	refsData.removeRefGroup(group);
};

/**
 * Process `<ref>`s left behind after the DOM is fully processed.
 * We process them as if there was an implicit `<references />` tag at
 * the end of the DOM.
 */
References.prototype.insertMissingReferencesIntoDOM = function(refsData, node) {
	var env = refsData.env;
	var doc = node.ownerDocument;

	refsData.refGroups.forEach((refsValue, refsGroup) => {
		var frag = createReferences(env, null, {
			group: refsGroup,
			responsive: null,
		}, function(dp) {
			// The new references come out of "nowhere", so to make selser work
			// propertly, add a zero-sized DSR pointing to the end of the document.
			dp.dsr = [env.page.src.length, env.page.src.length, 0, 0];
		}, true);

		// Add a \n before the <ol> so that when serialized to wikitext,
		// each <references /> tag appears on its own line.
		node.appendChild(doc.createTextNode("\n"));
		node.appendChild(frag);

		this.insertReferencesIntoDOM(frag, refsData, [""], true);
	});
};

References.prototype.serialHandler = {
	handle: Promise.async(function *(node, state, wrapperUnmodified) {
		var dataMw = DU.getDataMw(node);
		if (dataMw.autoGenerated && state.rtTestMode) {
			// Eliminate auto-inserted <references /> noise in rt-testing
			return '';
		} else {
			var startTagSrc = yield state.serializer.serializeExtensionStartTag(node, state);
			if (!dataMw.body) {
				return startTagSrc;  // We self-closed this already.
			} else if (typeof dataMw.body.html === 'string') {
				var src = yield state.serializer.serializeHTML({
					env: state.env,
					extName: dataMw.name,
				}, dataMw.body.html);
				return startTagSrc + src + '</' + dataMw.name + '>';
			} else {
				state.env.log('error',
					'References body unavailable for: ' + node.outerHTML);
				return '';  // Drop it!
			}
		}
	}),
	before: function(node, otherNode, state) {
		// Serialize new references tags on a new line.
		if (DU.isNewElt(node)) {
			return { min: 1, max: 2 };
		} else {
			return null;
		}
	},
};

References.prototype.lintHandler = function(refs, env, tplInfo, domLinter) {
	// Nothing to do
	//
	// FIXME: Not entirely true for scenarios where the <ref> tags
	// are defined in the references section that is itself templated.
	//
	// {{1x|<references>\n<ref name='x'><b>foo</ref>\n</references>}}
	//
	// In this example, the references tag has the right tplInfo and
	// when the <ref> tag is processed in the body of the article where
	// it is accessed, there is no relevant template or dsr info available.
	//
	// Ignoring for now.
	return refs.nextNode;
};

/**
 * This handles wikitext like this:
 * ```
 *   <references> <ref>foo</ref> </references>
 *   <references> <ref>bar</ref> </references>
 * ```
 * @private
 */
var _processRefsInReferences = function(cite, refsData, node, referencesId,
	referencesGroup, nestedRefsHTML) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		if (DU.isElt(child)) {
			if (DU.isSealedFragmentOfType(child, 'ref')) {
				cite.references.extractRefFromNode(child, refsData, cite,
					referencesId, referencesGroup, nestedRefsHTML);
			} else if (child.hasChildNodes()) {
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
			if (DU.isSealedFragmentOfType(child, 'ref')) {
				cite.references.extractRefFromNode(child, refsData, cite);
			} else if ((/(?:^|\s)mw:Extension\/references(?=$|\s)/).test(child.getAttribute('typeOf'))) {
				var referencesId = child.getAttribute("about");
				var referencesGroup = DU.getDataParsoid(child).group;
				var nestedRefsHTML = [];
				_processRefsInReferences(cite, refsData,
					child, referencesId, referencesGroup, nestedRefsHTML);
				cite.references.insertReferencesIntoDOM(child, refsData, nestedRefsHTML);
			} else {
				// inline media -- look inside the data-mw attribute
				if (DU.isInlineMedia(child)) {
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
						// serialize to HTML, update the caption HTML.
						var captionDOM = DU.ppToDOM(caption);
						_processRefs(cite, refsData, captionDOM);
						dmw.caption = DU.ppToXML(captionDOM, { innerXML: true });
					}
				}
				if (child.hasChildNodes()) {
					_processRefs(cite, refsData, child);
				}
			}
		}
		child = nextChild;
	}
};

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together `<ref>` and `<references>`.
 */
var Cite = function() {
	this.ref = new Ref(this);
	this.references = new References(this);
	this.config = {
		domPostProcessor: {
			name: 'cite',
			proc: this.domPostProcessor.bind(this),
		},
		tags: [
			{
				name: 'ref',
				toDOM: this.ref.toDOM.bind(this.ref),
				unwrapContent: false,
				serialHandler: this.ref.serialHandler,
				lintHandler: this.ref.lintHandler,
			}, {
				name: 'references',
				toDOM: this.references.toDOM.bind(this.ref),
				serialHandler: this.references.serialHandler,
				lintHandler: this.references.lintHandler,
			},
		],
		styles: [
			'ext.cite.style',
			'ext.cite.styles',
		],
	};
};

/**
 * DOM Post Processor.
 */
Cite.prototype.domPostProcessor = function(node, env, options, atTopLevel) {
	if (atTopLevel) {
		var refsData = new ReferencesData(env);
		_processRefs(this, refsData, node);
		this.references.insertMissingReferencesIntoDOM(refsData, node);
	}
};


if (typeof module === "object") {
	module.exports = Cite;
}
