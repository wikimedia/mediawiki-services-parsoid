/* ----------------------------------------------------------------------
 * This file implements <ref> and <references> extension tag handling
 * natively in Parsoid.
 * ---------------------------------------------------------------------- */
'use strict';
require('./core-upgrade.js');

var Util = require('./mediawiki.Util.js').Util;
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var coreutil = require('util');
var defines = require('./mediawiki.parser.defines.js');
var entities = require('entities');

// define some constructor shortcuts
var KV = defines.KV;
var EOFTk = defines.EOFTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;


// FIXME: Move out to some common helper file?
// Helper function to process extension source
function processExtSource(manager, extToken, opts) {
	var extSrc = extToken.getAttribute('source');
	var tagWidths = extToken.dataAttribs.tagWidths;
	var content = extSrc.substring(tagWidths[0], extSrc.length - tagWidths[1]);

	// FIXME: Should this be specific to the extension
	// Or is it okay to do this unconditionally for all?
	// Right now, this code is run only for ref and references,
	// so not a real problem, but if this is used on other extensions,
	// requires addressing.
	//
	// FIXME: SSS: This stripping maybe be unnecessary after all.
	//
	// Strip all leading white-space
	var wsMatch = content.match(/^(\s*)([^]*)$/);
	var leadingWS = wsMatch[1];

	// Update content to normalized form
	content = wsMatch[2];

	if (!content || content.length === 0) {
		opts.emptyContentCB(opts.res);
	} else {
		// Pass an async signal since the ext-content is not processed completely.
		opts.parentCB({tokens: opts.res, async: true});

		// Wrap templates always
		opts.pipelineOpts = Util.extendProps({}, opts.pipelineOpts, { wrapTemplates: true });

		var tsr = extToken.dataAttribs.tsr;
		opts.srcOffsets = [ tsr[0] + tagWidths[0] + leadingWS.length, tsr[1] - tagWidths[1] ];

		// Process ref content
		Util.processContentInPipeline(manager.env, manager.frame, content, opts);
	}
}

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
Ref.prototype.handleRef = function(manager, pipelineOpts, refTok, cb) {
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
		da.content = contentBody ? DU.serializeChildren(contentBody) : '';
		da.hasRefInRef = contentBody ? hasRef(contentBody) : false;
		toks.push(new SelfclosingTagTk('meta', [
			new KV('typeof', 'mw:Extension/ref/Marker'),
			new KV('about', about),
		], da));
		// All done!
		cb({ tokens: toks, async: false });
	};

	processExtSource(manager, refTok, {
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
	reftextSpan.innerHTML = ref.content;
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
			var linkback = createLinkback('#' + lb, ref.group, i + 1);
			span.appendChild(linkback);
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
References.prototype.handleReferences = function(manager, pipelineOpts, refsTok, cb) {
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
		var type = refsTok.getAttribute('typeof');
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
			DU.storeDataParsoid(ol, dp);
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

	processExtSource(manager, refsTok, {
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
			emitReferencesFragment([], DU.serializeChildren(refsDoc.body));
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
	var dataMW = Util.clone(DU.getDataMw(node));
	var body;

	if (dp.hasRefInRef) {
		var html = DU.parseHTML(content).body;
		refInRefProcessor(html);
		// Save data attribs for the nested DOM
		// since we are serializing it to a string.
		DU.saveDataAttribsForDOM(html);
		content = DU.serializeChildren(html);
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
	if (!Object.keys(dataMW).length) {
		dataMW = {
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
	DU.setDataMw(span, dataMW);

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
		DU.storeDataParsoid(span, dataParsoid);
		DU.storeDataMw(span, dataMW);
		refsInReferencesHTML.push(DU.serializeNode(span).str, '\n');
	}

	// Keep the first content to compare multiple <ref>s with the same name.
	if (!ref.content) {
		ref.content = content;
	}
};

References.prototype.insertReferencesIntoDOM = function(refsNode, refsData, refsInReferencesHTML) {
	var about = refsNode.getAttribute('about');
	var dp = DU.getDataParsoid(refsNode);
	var group = dp.group || '';
	var src = dp.src || '<references/>';  // fall back so we don't crash
	// Extract ext-source for <references>..</references> usage
	var body = Util.extractExtBody("references", src).trim();
	var refGroup = refsData.getRefGroup(group);

	var dataMW =  DU.getDataMw(refsNode);
	if (!Object.keys(dataMW).length) {
		var datamwBody;
		// We'll have to output data-mw.body.extsrc in
		// scenarios where original wikitext was of the form:
		// "<references> lot of refs here </references>"
		// Ex: See [[en:Barack Obama]]
		if (body.length > 0) {
			datamwBody = {
				'extsrc': body,
				'html': refsInReferencesHTML.join(''),
			};
		}
		dataMW = {
			'name': 'references',
			'body': datamwBody,
			'attrs': {
				// Dont emit empty keys
				'group': group || undefined,
			},
		};
		DU.setDataMw(refsNode, dataMW);
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
		refGroup.refs.forEach(refGroup.renderLine.bind(refGroup, refsNode));
	}

	// Remove the group from refsData
	refsData.removeRefGroup(group);
};

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
		DU.storeDataParsoid(ol, dp);

		// Add a \n before the <ol> so that when serialized to wikitext,
		// each <references /> tag appears on its own line.
		node.appendChild(doc.createTextNode("\n"));
		node.appendChild(ol);
		self.insertReferencesIntoDOM(ol, refsData, [""]);
	});
};

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together <ref> and <references>
 */
var Cite = function() {
	this.ref = new Ref(this);
	this.references = new References(this);
};

if (typeof module === "object") {
	module.exports.Cite = Cite;
	module.exports.ReferencesData = ReferencesData;
}
