/* ----------------------------------------------------------------------
 * This file implements <ref> and <references> extension tag handling
 * natively in Parsoid.
 * ---------------------------------------------------------------------- */
"use strict";
require('./core-upgrade.js');

var Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js').DOMUtils,
	coreutil = require('util'),
	defines = require('./mediawiki.parser.defines.js'),
	entities = require('entities');

// define some constructor shortcuts
var	KV = defines.KV,
    EOFTk = defines.EOFTk,
    SelfclosingTagTk = defines.SelfclosingTagTk;

// FIXME: Move out to some common helper file?
// Helper function to process extension source
function processExtSource(manager, extToken, opts) {
	var extSrc = extToken.getAttribute('source'),
		tagWidths = extToken.dataAttribs.tagWidths,
		content = extSrc.substring(tagWidths[0], extSrc.length - tagWidths[1]);

	// FIXME: Should this be specific to the extension
	// Or is it okay to do this unconditionally for all?
	// Right now, this code is run only for ref and references,
	// so not a real problem, but if this is used on other extensions,
	// requires addressing.
	//
	// FIXME: SSS: This stripping maybe be unnecessary after all.
	//
	// Strip all leading white-space
	var wsMatch = content.match(/^(\s*)([^]*)$/),
		leadingWS = wsMatch[1];

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
		opts.srcOffsets = [ tsr[0] +tagWidths[0] +leadingWS.length, tsr[1] -tagWidths[1] ];

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
	this.reset();
}

/**
 * Reset state before each top-level parse -- this lets us share a pipeline
 * to parse unrelated pages.
 */
Ref.prototype.reset = function() { };

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
Ref.prototype.handleRef = function ( manager, pipelineOpts, refTok, cb ) {
	// Nested <ref> tags at the top level are considered errors
	// But, inside templates, they are supported
	if (!pipelineOpts.inTemplate && pipelineOpts.extTag === "ref") {
		cb({ tokens: [refTok.getAttribute("source")] });
		return;
	}

	var refOpts = Object.assign({
			name: null, group: null
		}, Util.KVtoHash(refTok.getAttribute("options"), true)),
		about = manager.env.newAboutId(),
		finalCB = function(toks, contentBody) {
			// Marker meta with ref content
			var da = Util.clone(refTok.dataAttribs);
			// Clear stx='html' so that sanitizer doesn't barf
			da.stx = undefined;
			da.group = refOpts.group || '';
			da.name = refOpts.name || '';
			da.content = contentBody ? DU.serializeChildren(contentBody) : '';
			da.hasRefInRef = contentBody ? hasRef(contentBody) : false;

			toks.push(new SelfclosingTagTk( 'meta', [
						new KV('typeof', 'mw:Extension/ref/Marker'),
						new KV('about', about)
						], da));

			// All done!
			cb({tokens: toks, async: false});
		};

	processExtSource(manager, refTok, {
		// Full pipeline for processing ref-content
		pipelineType: 'text/x-mediawiki/full',
		pipelineOpts: {
			extTag: "ref",
			inTemplate: pipelineOpts.inTemplate,
			noPre: true,
			noPWrapping: true
		},
		res: [],
		parentCB: cb,
		emptyContentCB: finalCB,
		documentCB: function(refContentDoc) {
			finalCB([], refContentDoc.body);
		}
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
	return encodeURIComponent(v).replace(/%/g,".");
}

RefGroup.prototype.renderLine = function(refsList, ref) {
	var ownerDoc = refsList.ownerDocument,
		arrow = ownerDoc.createTextNode('↑'),
		li, a, textSpan;

	// Generate the li and set ref content first, so the HTML gets parsed.
	// We then append the rest of the ref nodes before the first node
	li = ownerDoc.createElement('li');
	DU.addAttributes(li, {
		'about': "#" + ref.target,
		'id': ref.target
	});
	textSpan = ownerDoc.createElement('span');
	DU.addAttributes(textSpan, {
		'id': "mw-reference-text-" + ref.target,
		'class': "mw-reference-text"
	});
	textSpan.innerHTML = ref.content;
	li.appendChild(textSpan);

	// 'mw:referencedBy' span wrapper
	var span = ownerDoc.createElement('span');
	span.setAttribute('rel', 'mw:referencedBy');
	li.insertBefore(span, textSpan);

	// Generate leading linkbacks
	if (ref.linkbacks.length === 1) {
		a = ownerDoc.createElement('a');
		DU.addAttributes(a, {
			'href': '#' + ref.id
		});
		a.appendChild(arrow);
		span.appendChild(a);
	} else {
		span.appendChild(arrow);
		ref.linkbacks.forEach(function(linkback, i) {
			a = ownerDoc.createElement('a');
			DU.addAttributes(a, {
				'href': '#' + ref.linkbacks[i]
			});
			a.appendChild(ownerDoc.createTextNode(ref.groupIndex + '.' + i));
			// Separate linkbacks with a space
			span.appendChild(ownerDoc.createTextNode(' '));
			span.appendChild(a);
		});
	}

	// Space before content node
	li.insertBefore(ownerDoc.createTextNode(' '), textSpan);

	// Add it to the ref list
	refsList.appendChild(li);
};

function ReferencesData() {
	this.index = 0;
	this.refGroups = new Map();
}

ReferencesData.prototype.getRefGroup = function (groupName, allocIfMissing) {
	groupName = groupName || '';
	if ( !this.refGroups.has( groupName ) && allocIfMissing ) {
		this.refGroups.set( groupName, new RefGroup( groupName ) );
	}
	return this.refGroups.get( groupName );
};

ReferencesData.prototype.removeRefGroup = function (groupName) {
	if (groupName !== null && groupName !== undefined) {
		// '' is a valid group (the default group)
		this.refGroups.delete(groupName);
	}
};

ReferencesData.prototype.add = function(groupName, refName, about, skipLinkback) {
	var group = this.getRefGroup(groupName, true),
		ref;
	refName = makeValidIdAttr(refName);
	if ( refName && group.indexByName.has( refName ) ) {
		ref = group.indexByName.get( refName );
		if (ref.content) {
				ref.hasMultiples = true;
		}
	} else {
		// The ids produced Cite.php have some particulars:
		// Simple refs get 'cite_ref-' + index
		// Refs with names get 'cite_ref-' + name + '_' + index + (backlink num || 0)
		// Notes (references) whose ref doesn't have a name are 'cite_note-' + index
		// Notes whose ref has a name are 'cite_note-' + name + '-' + index
		var n = this.index,
			refKey = (1 +n) + '',
			refIdBase = 'cite_ref-' + (refName ? refName + '_' + refKey : refKey),
			noteId = 'cite_note-' + (refName ? refName + '-' + refKey : refKey);

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
			target: noteId
		};
		group.refs.push( ref );
		if (refName) {
			group.indexByName.set( refName, ref );
		}
	}

	if (!skipLinkback) {
		ref.linkbacks.push(ref.key + '-' + ref.linkbacks.length);
	}

	return ref;
};

function References(cite) {
	this.cite = cite;
	this.reset();
}

References.prototype.reset = function() {};

/**
 * Sanitize the references tag and convert it into a meta-token
 */
References.prototype.handleReferences = function ( manager, pipelineOpts, refsTok, cb ) {
	var env = manager.env;

	// group is the only recognized option?
	var refsOpts = Object.assign({
			group: null
		}, Util.KVtoHash(refsTok.getAttribute("options"), true));

	// Assign an about id and intialize the nested refs html
	var referencesId = env.newAboutId();

	// Emit a marker mw:DOMFragment for the references
	// token so that the dom post processor can generate
	// and emit references at this point in the DOM.
	var emitReferencesFragment = function(toks, refsBody) {
		var type = refsTok.getAttribute('typeof');
		var olHTML = "<ol class='references'" +
			" typeof='mw:Extension/references'" +
			" about='" + referencesId + "'" + ">" + (refsBody || "") + "</ol>";
		var olProcessor = function(ol) {
			var dp = DU.getDataParsoid( ol );
			dp.src = refsTok.getAttribute('source');
			if ( refsOpts.group ) {
				dp.group = refsOpts.group;
			}
			DU.storeDataParsoid( ol, dp );
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
			)
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
			inTemplate: pipelineOpts.inTemplate
		},
		res: [],
		parentCB: cb,
		emptyContentCB: emitReferencesFragment,
		endCB: emitReferencesFragment,
		documentCB: function(refsDoc) {
			emitReferencesFragment([], DU.serializeChildren(refsDoc.body));
		}
	});
};

References.prototype.extractRefFromNode = function(node, refsData,
		refInRefProcessor, referencesAboutId, referencesGroup, refsInReferencesHTML) {
	var nestedInReferences = referencesAboutId !== undefined,
		dp = DU.getDataParsoid( node ),
		// SSS FIXME: Need to clarify semantics here.
		// If both the containing <references> elt as well as the nested <ref> elt has
		// a group attribute, what takes precedence?
		group = dp.group || referencesGroup || '',
		refName = dp.name,
		about = node.getAttribute("about"),
		ref = refsData.add(group, refName, about, nestedInReferences),
		nodeType = (node.getAttribute("typeof") || '').replace(/mw:Extension\/ref\/Marker/, '');

	// Add ref-index linkback
	var doc = node.ownerDocument,
		span = doc.createElement('span'),
		content = dp.content,
		dataMW = Util.clone(DU.getDataMw(node)),
		body;

	if (dp.hasRefInRef) {
		var html = DU.parseHTML(content).body;
		refInRefProcessor(html);
		content = DU.serializeChildren(html);
	}

	if (content) {
		// If there are multiple <ref>s with the same name, but different
		// content, we need to record this one's content instead of
		// linking to <references>.
		if (ref.hasMultiples && content !== ref.content) {
			body = {'html': content};
		} else {
			body = {'id': "mw-reference-text-" + ref.target};
		}
	}

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
				'name': refName || undefined
			}
		};
	}

	DU.addAttributes(span, {
		'about': about,
		'class': 'reference',
		'id': nestedInReferences ? undefined :
			(ref.name ? ref.linkbacks[ref.linkbacks.length - 1] : ref.id),
		'rel': 'dc:references',
		'typeof': nodeType
	});
	DU.addTypeOf(span, "mw:Extension/ref");
	var dataParsoid = {
		src: dp.src,
		dsr: dp.dsr
	};
	DU.setDataParsoid( span, dataParsoid );
	DU.setDataMw( span, dataMW );

	// refIndex-a
	var refIndex = doc.createElement('a');
	refIndex.setAttribute('href', '#' + ref.target);
	refIndex.appendChild(doc.createTextNode(
		'[' + ((group === '') ? '' : group + ' ') + ref.groupIndex + ']'
	));
	span.appendChild(refIndex);

	if (!nestedInReferences) {
		node.parentNode.insertBefore(span, node);
	} else {
		DU.storeDataParsoid( span, dataParsoid );
		DU.storeDataMw( span, dataMW );
		refsInReferencesHTML.push( DU.serializeNode(span), "\n" );
	}

	// Keep the first content to compare multiple <ref>s with the same name.
	if (!ref.content) {
		ref.content = content;
	}
};

References.prototype.insertReferencesIntoDOM = function(refsNode, refsData, refsInReferencesHTML) {
	var about = refsNode.getAttribute('about'),
		dp = DU.getDataParsoid( refsNode ),
		group = dp.group || '',
		src = dp.src || '<references/>', // fall back so we don't crash
		// Extract ext-source for <references>..</references> usage
		body = Util.extractExtBody("references", src).trim(),
		refGroup = refsData.getRefGroup(group);

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
				'html': refsInReferencesHTML.join('')
			};
		}
		dataMW = {
			'name': 'references',
			'body': datamwBody,
			'attrs': {
				// Dont emit empty keys
				'group': group || undefined
			}
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

References.prototype.insertMissingReferencesIntoDOM = function (env, refsData, node) {
	var doc = node.ownerDocument,
		self = this;

	refsData.refGroups.forEach(function (refsValue, refsGroup) {
		var ol = doc.createElement('ol'),
			dp = DU.getDataParsoid(ol);
		DU.addAttributes(ol, {
			'class': 'references',
			typeof: 'mw:Extension/references',
			about: env.newAboutId()
		});
		// The new references come out of "nowhere", so to make selser work
		// propertly, add a zero-sized DSR pointing to the end of the document.
		dp.dsr = [env.page.src.length, env.page.src.length, 0, 0];
		if (refsGroup) {
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

Cite.prototype.resetState = function(opts) {
	if (opts && opts.toplevel) {
		this.ref.reset();
		this.references.reset();
	}
};

if (typeof module === "object") {
	module.exports.Cite = Cite;
	module.exports.ReferencesData = ReferencesData;
}
