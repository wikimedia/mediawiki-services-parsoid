/* ----------------------------------------------------------------------
 * This file implements <ref> and <references> extension tag handling
 * natively in Parsoid.
 * ---------------------------------------------------------------------- */
'use strict';

var entities = module.parent.require('entities');

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.5.1');
var Util = ParsoidExtApi.Util;
var DU = ParsoidExtApi.DOMUtils;
var Promise = ParsoidExtApi.Promise;
var defines = ParsoidExtApi.defines;

// define some constructor shortcuts
var KV = defines.KV;
var SelfclosingTagTk = defines.SelfclosingTagTk;


/**
 * Simple token transform version of the Ref extension tag
 *
 * @class
 * @constructor
 */
function Ref(cite) {
	this.cite = cite;
}

function hasRef(node) {
	var c = node.firstChild;
	while (c) {
		if (DU.isElt(c)) {
			var typeOf = c.getAttribute('typeof');
			if ((/(?:^|\s)mw:Extension\/ref\/Marker(?=$|\s)/).test(typeOf)) {
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

/**
 * Handle ref tokens
 */
Ref.prototype.tokenHandler = function(manager, pipelineOpts, refTok, cb) {
	// Nested <ref> tags at the top level are considered errors
	// But, inside templates, they are supported
	if (!pipelineOpts.inTemplate && pipelineOpts.extTag === "ref") {
		cb({ tokens: [refTok.getAttribute("source")] });
		return;
	}

	var refOpts = Object.assign({
		name: null,
		group: null,
	}, Util.KVtoHash(refTok.getAttribute("options"), true));

	var about = manager.env.newAboutId();
	var finalCB = function(toks, contentBody) {
		// Marker meta with ref content
		var da = Util.clone(refTok.dataAttribs);
		// Clear stx='html' so that sanitizer doesn't barf
		da.stx = undefined;
		da.group = refOpts.group || '';
		da.name = refOpts.name || '';
		da.content = contentBody ? DU.ppToXML(contentBody, { innerXML: true }) : '';
		da.hasRefInRef = contentBody ? hasRef(contentBody) : false;
		toks.push(new SelfclosingTagTk('meta', [
			new KV('typeof', 'mw:Extension/ref/Marker'),
			new KV('about', about),
		], da));
		// All done!
		cb({ tokens: toks, async: false });
	};

	Util.processExtSource(manager, refTok, {
		// Full pipeline for processing ref-content
		pipelineType: 'text/x-mediawiki/full',
		pipelineOpts: {
			extTag: "ref",
			inTemplate: pipelineOpts.inTemplate,
			noPre: true,
			noPWrapping: true,
		},
		res: [],
		parentCB: cb,
		emptyContentCB: finalCB,
		documentCB: function(refContentDoc) {
			finalCB([], refContentDoc.body);
		},
	});
};

Ref.prototype.serialHandler = {
	handle: Promise.method(function(node, state, wrapperUnmodified) {
		return state.serializer.serializeExtensionStartTag(node, state)
		.then(function(startTagSrc) {
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
						} catch (e) { }
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
			return state.serializer.serializeHTML({
				env: state.env,
				extName: dataMw.name,
			}, html).then(function(src) {
				return startTagSrc + src + '</' + dataMw.name + '>';
			});
		});
	}),
};

/**
 * Helper class used by <references> implementation
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
	// It also considers entities equal to their encoding (i.e. '&' === '&amp;')
	// and then substitutes % with .
	var v = entities.decodeHTML(val).replace(/\s/g, '_');
	return encodeURIComponent(v).replace(/%/g, ".");
}

RefGroup.prototype.renderLine = function(refsList, ref) {
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
	DU.ppToDOM(ref.content, { node: reftextSpan });
	li.appendChild(reftextSpan);

	// Generate leading linkbacks
	var createLinkback = function(href, group, text) {
		var a = ownerDoc.createElement('a');
		var span = ownerDoc.createElement('span');
		var textNode = ownerDoc.createTextNode(text + " ");
		a.setAttribute('href', href);
		span.setAttribute('class', 'mw-linkback-text');
		if (group) {
			a.setAttribute('data-mw-group', group);
		}
		span.appendChild(textNode);
		a.appendChild(span);
		return a;
	};
	if (ref.linkbacks.length === 1) {
		var linkback = createLinkback('#' + ref.id, ref.group, '↑');
		linkback.setAttribute('rel', 'mw:referencedBy');
		li.insertBefore(linkback, reftextSpan);
	} else {
		// 'mw:referencedBy' span wrapper
		var span = ownerDoc.createElement('span');
		span.setAttribute('rel', 'mw:referencedBy');
		li.insertBefore(span, reftextSpan);

		ref.linkbacks.forEach(function(lb, i) {
			span.appendChild(createLinkback('#' + lb, ref.group, i + 1));
		});
	}

	// Space before content node
	li.insertBefore(ownerDoc.createTextNode(' '), reftextSpan);

	// Add it to the ref list
	refsList.appendChild(li);
};

function ReferencesData() {
	this.index = 0;
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

ReferencesData.prototype.add = function(groupName, refName, about, skipLinkback) {
	var group = this.getRefGroup(groupName, true);
	var ref;
	refName = makeValidIdAttr(refName);
	if (refName && group.indexByName.has(refName)) {
		ref = group.indexByName.get(refName);
		if (ref.content) {
			ref.hasMultiples = true;
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

function References(cite) {
	this.cite = cite;
}

/**
 * Sanitize the references tag and convert it into a meta-token
 */
References.prototype.tokenHandler = function(manager, pipelineOpts, refsTok, cb) {
	var env = manager.env;

	// group is the only recognized option?
	var refsOpts = Object.assign({
		group: null,
	}, Util.KVtoHash(refsTok.getAttribute("options"), true));

	// Assign an about id and intialize the nested refs html
	var referencesId = env.newAboutId();

	// Emit a marker mw:DOMFragment for the references
	// token so that the dom post processor can generate
	// and emit references at this point in the DOM.
	var emitReferencesFragment = function(toks, refsBody) {
		var olHTML = "<ol class='mw-references'" +
			" typeof='mw:Extension/references'" +
			" about='" + referencesId + "'" + ">" + (refsBody || "") + "</ol>";
		var olProcessor = function(ol) {
			var dp = DU.getDataParsoid(ol);
			dp.src = refsTok.getAttribute('source');
			if (refsOpts.group) {
				dp.group = refsOpts.group;
				ol.setAttribute('data-mw-group', refsOpts.group);
			}
		};
		cb({
			async: false,
			tokens: DU.buildDOMFragmentTokens(
				manager.env,
				refsTok,
				olHTML,
				olProcessor,
				// The <ol> HTML above is wrapper HTML added on and doesn't
				// have any DSR on it. We want DSR added to it.
				{ aboutId: referencesId, setDSR: true, isForeignContent: true }
			),
		});
	};

	Util.processExtSource(manager, refsTok, {
		// Partial pipeline for processing ref-content
		// Expand till stage 2 so that all embedded
		// ref tags get processed
		pipelineType: 'text/x-mediawiki/full',
		pipelineOpts: {
			// In order to associated ref-tags nested here with this references
			// object, we have to pass along the references id.
			extTag: "references",
			extTagId: referencesId,
			wrapTemplates: pipelineOpts.wrapTemplates,
			inTemplate: pipelineOpts.inTemplate,
		},
		res: [],
		parentCB: cb,
		emptyContentCB: emitReferencesFragment,
		endCB: emitReferencesFragment,
		documentCB: function(refsDoc) {
			emitReferencesFragment([], DU.ppToXML(refsDoc.body, { innerXML: true }));
		},
	});
};

References.prototype.extractRefFromNode = function(node, refsData,
		refInRefProcessor, referencesAboutId, referencesGroup, refsInReferencesHTML) {
	var nestedInReferences = referencesAboutId !== undefined;
	var dp = DU.getDataParsoid(node);
	// SSS FIXME: Need to clarify semantics here.
	// If both the containing <references> elt as well as the nested <ref>
	// elt has a group attribute, what takes precedence?
	var group = dp.group || referencesGroup || '';
	var refName = dp.name;
	var about = node.getAttribute("about");
	var ref = refsData.add(group, refName, about, nestedInReferences);
	var nodeType = (node.getAttribute("typeof") || '').replace(/mw:Extension\/ref\/Marker/, '');

	// Add ref-index linkback
	var doc = node.ownerDocument;
	var span = doc.createElement('span');
	var content = dp.content;
	var dataMw = Util.clone(DU.getDataMw(node));
	var body;

	if (dp.hasRefInRef) {
		var html = DU.ppToDOM(content);
		refInRefProcessor(html);
		content = DU.ppToXML(html, { innerXML: true });
	}

	if (content) {
		// If there are multiple <ref>s with the same name, but different content,
		// the content of the first <ref> shows up in the <references> section.
		// in order to ensure lossless RT-ing for later <refs>, we have to record
		// HTML inline for all of them.
		if (ref.hasMultiples && content !== ref.content) {
			body = { 'html': content };
		} else {
			body = { 'id': "mw-reference-text-" + ref.target };
		}
	}

	// data-mw will not be empty in scenarios where the <ref> is also templated.
	// In those cases, the transclusion markup takes precedence over the <ref> markup.
	// So, we aren't updating data-mw.
	if (!Object.keys(dataMw).length) {
		dataMw = {
			'name': 'ref',
			// Dont set body if this is a reused reference
			// like <ref name='..' /> with empty content.
			'body': body,
			'attrs': {
				// 1. Use 'dp.group' (which is the group attribute that the ref node had)
				//    rather than use 'group' (which could be the group from an enclosing
				//    <references> tag).
				// 2. Dont emit empty keys
				'group': dp.group || undefined,
				'name': refName || undefined,
			},
		};
	}

	DU.addAttributes(span, {
		'about': about,
		'class': 'mw-ref',
		'id': nestedInReferences ? undefined :
			(ref.name ? ref.linkbacks[ref.linkbacks.length - 1] : ref.id),
		'rel': 'dc:references',
		'typeof': nodeType,
	});
	DU.addTypeOf(span, "mw:Extension/ref");
	var dataParsoid = {
		src: dp.src,
		dsr: dp.dsr,
		pi: dp.pi,
	};
	DU.setDataParsoid(span, dataParsoid);
	DU.setDataMw(span, dataMw);

	// refLink is the link to the citation
	var refLink = doc.createElement('a');
	DU.addAttributes(refLink, {
		'href': '#' + ref.target,
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
		(ref.group? ref.group + " " : "") + ref.groupIndex + "]"));
	refLink.appendChild(refLinkSpan);
	span.appendChild(refLink);

	if (!nestedInReferences) {
		node.parentNode.insertBefore(span, node);
	} else {
		refsInReferencesHTML.push(DU.ppToXML(span), '\n');
	}

	// Keep the first content to compare multiple <ref>s with the same name.
	if (!ref.content) {
		ref.content = content;
	}
};

References.prototype.insertReferencesIntoDOM = function(refsNode, refsData, refsInReferencesHTML, autoGenerated) {
	var dp = DU.getDataParsoid(refsNode);
	var group = dp.group || '';

	var dataMw = DU.getDataMw(refsNode);
	if (!Object.keys(dataMw).length) {
		dataMw = {
			'name': 'references',
			'attrs': {
				// Dont emit empty keys
				'group': group || undefined,
			},
		};

		// Mark this auto-generated so that we can skip this during
		// html -> wt and so that clients can strip it if necessary.
		if (autoGenerated) {
			dataMw.autoGenerated = true;
		}

		var src = dp.src || '<references/>';  // fall back so we don't crash
		// Extract ext-source for <references>..</references> usage
		var body = Util.extractExtBody('references', src).trim();
		if (body.length > 0) {
			dataMw.body = { 'html': refsInReferencesHTML.join('') };
		}

		DU.setDataMw(refsNode, dataMw);
	}

	// Remove all children from the references node
	//
	// Ex: When {{Reflist}} is reused from the cache, it comes with
	// a bunch of references as well. We have to remove all those cached
	// references before generating fresh references.
	while (refsNode.firstChild) {
		refsNode.removeChild(refsNode.firstChild);
	}

	var refGroup = refsData.getRefGroup(group);
	if (refGroup) {
		refGroup.refs.forEach(refGroup.renderLine.bind(refGroup, refsNode));
	}

	// Remove the group from refsData
	refsData.removeRefGroup(group);
};

// Process <ref>s left behind after the DOM is fully processed.
// We process them as if there was an implicit <references /> tag at
// the end of the DOM.
References.prototype.insertMissingReferencesIntoDOM = function(env, refsData, node) {
	var doc = node.ownerDocument;
	var self = this;

	refsData.refGroups.forEach(function(refsValue, refsGroup) {
		var ol = doc.createElement('ol');
		var dp = DU.getDataParsoid(ol);
		DU.addAttributes(ol, {
			'class': 'mw-references',
			typeof: 'mw:Extension/references',
			about: env.newAboutId(),
		});
		// The new references come out of "nowhere", so to make selser work
		// propertly, add a zero-sized DSR pointing to the end of the document.
		dp.dsr = [env.page.src.length, env.page.src.length, 0, 0];
		if (refsGroup) {
			ol.setAttribute('data-mw-group', refsGroup);
			dp.group = refsGroup;
		}

		// Add a \n before the <ol> so that when serialized to wikitext,
		// each <references /> tag appears on its own line.
		node.appendChild(doc.createTextNode("\n"));
		node.appendChild(ol);
		self.insertReferencesIntoDOM(ol, refsData, [""], true);
	});
};

References.prototype.serialHandler = {
	handle: Promise.method(function(node, state, wrapperUnmodified) {
		var dataMw = DU.getDataMw(node);
		if (dataMw.autoGenerated && state.rtTestMode) {
			// Eliminate auto-inserted <references /> noise in rt-testing
			return Promise.resolve('');
		} else {
			return state.serializer.serializeExtensionStartTag(node, state)
			.then(function(startTagSrc) {
				if (!dataMw.body) {
					return startTagSrc;  // We self-closed this already.
				} else if (typeof dataMw.body.html === 'string') {
					return state.serializer.serializeHTML({
						env: state.env,
						extName: dataMw.name,
					}, dataMw.body.html).then(function(src) {
						return startTagSrc + src + '</' + dataMw.name + '>';
					});
				} else {
					state.env.log('error',
						'References body unavailable for: ' + node.outerHTML);
					return '';  // Drop it!
				}
			});
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
						// serialize to HTML, update the caption HTML.
						var captionDOM = DU.ppToDOM(caption);
						_processRefs(cite, refsData, captionDOM);
						dmw.caption = DU.ppToXML(captionDOM, { innerXML: true });
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

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together <ref> and <references>
 */
var Cite = function() {
	this.ref = new Ref(this);
	this.references = new References(this);
	this.config = {
		domPostProcessor: this.domPostProcessor.bind(this),
		tags: [
			{
				name: 'ref',
				tokenHandler: this.ref.tokenHandler.bind(this.ref),
				serialHandler: this.ref.serialHandler,
			}, {
				name: 'references',
				tokenHandler: this.references.tokenHandler.bind(this.references),
				serialHandler: this.references.serialHandler,
			},
		],
	};
};

// DOM Post Processor
Cite.prototype.domPostProcessor = function(node, env, options, atTopLevel) {
	if (atTopLevel) {
		var refsData = new ReferencesData();
		_processRefs(this, refsData, node);
		this.references.insertMissingReferencesIntoDOM(env, refsData, node);
	}
};


if (typeof module === "object") {
	module.exports = Cite;
}
