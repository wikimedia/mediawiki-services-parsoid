/* ----------------------------------------------------------------------
 * This file implements <ref> and <references> extension tag handling
 * natively in Parsoid.
 * ---------------------------------------------------------------------- */
"use strict";

var Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js').DOMUtils,
	coreutil = require('util'),
	ExtensionHandler = require('./ext.core.ExtensionHandler.js').ExtensionHandler,
	defines = require('./mediawiki.parser.defines.js'),
	$ = require( './fakejquery' );

// define some constructor shortcuts
var	KV = defines.KV,
    SelfclosingTagTk = defines.SelfclosingTagTk;

// FIXME: Move out to some common helper file?
// Helper function to process extension source
function processExtSource(manager, extToken, opts) {
	var extSrc = extToken.getAttribute('source'),
		tagWidths = extToken.dataAttribs.tagWidths,
		content = extSrc.substring(tagWidths[0], extSrc.length - tagWidths[1]);

	// FIXME: SSS: This stripping maybe be unecessary after all.
	//
	// FIXME: Should this be specific to the extension
	//
	// or is it okay to do this unconditionally for all?
	// Right now, this code is run only for ref and references,
	// so not a real problem, but if this is used on other extensions,
	// requires addressing.
	//
	// Strip all leading white-space
	var wsMatch = content.match(/^(\s*)((?:.|\n)*)$/),
		leadingWS = wsMatch[1];

	// Update content to normalized form
	content = wsMatch[2];

	if (!content || content.length === 0) {
		opts.emptyContentCB(opts.res);
	} else {
		// Pass an async signal since the ext-content is not processed completely.
		opts.parentCB({tokens: opts.res, async: true});

		// Pipeline for processing ext-content
		var pipeline = manager.pipeFactory.getPipeline(
			opts.pipelineType,
			Util.extendProps({}, opts.pipelineOpts, {
				wrapTemplates: true
			})
		);

		// Set source offsets for this pipeline's content
		var tsr = extToken.dataAttribs.tsr;
		pipeline.setSourceOffsets(tsr[0]+tagWidths[0]+leadingWS.length, tsr[1]-tagWidths[1]);

		// Set up provided callbacks
		if (opts.chunkCB) {
			pipeline.addListener('chunk', opts.chunkCB);
		}
		if (opts.endCB) {
			pipeline.addListener('end', opts.endCB);
		}
		if (opts.documentCB) {
			pipeline.addListener('document', opts.documentCB);
		}

		// Off the starting block ... ready, set, go!
		pipeline.process(content);
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

/**
 * Handle ref tokens
 */
Ref.prototype.handleRef = function ( manager, pipelineOpts, refTok, cb ) {
	// Nested <ref> tags are not supported
	if (!pipelineOpts.inTagRef && pipelineOpts.extTag === "ref" && pipelineOpts.wrapTemplates) {
		cb({ tokens: [refTok.getAttribute("source")] });
		return;
	}

	var inReferencesExt = pipelineOpts.extTag === "references",
		refOpts = $.extend({ name: null, group: null }, Util.KVtoHash(refTok.getAttribute("options"))),
		about = inReferencesExt ? '' : manager.env.newAboutId(),
		finalCB = function(toks, content) {
			// Marker meta with ref content
			var da = Util.clone(refTok.dataAttribs);
			// Clear stx='html' so that sanitizer doesn't barf
			da.stx = undefined;

			toks.push(new SelfclosingTagTk( 'meta', [
						new KV('typeof', 'mw:Extension/ref/Marker'),
						new KV('about', about),
						new KV('group', refOpts.group || ''),
						new KV('name', refOpts.name || ''),
						new KV('content', content || ''),
						new KV('skiplinkback', inReferencesExt ? 1 : 0)
						], da));

			// All done!
			cb({tokens: toks, async: false});
		};

	processExtSource(manager, refTok, {
		// Full pipeline for processing ref-content
		pipelineType: 'text/x-mediawiki/full',
		pipelineOpts: {
			inTagRef: refTok.getAttribute("inTagRef"),
			extTag: "ref"
		},
		res: [],
		parentCB: cb,
		emptyContentCB: finalCB,
		documentCB: function(refContentDoc) {
			finalCB([], refContentDoc.body.innerHTML);
		}
	});
};

/**
 * Helper class used by <references> implementation
 */
function RefGroup(group) {
	this.name = group || '';
	this.refs = [];
	this.indexByName = {};
}

RefGroup.prototype.add = function(refName, about, skipLinkback) {
	// NOTE: prefix name with "ref:" before using it as a property key
	// This is to avoid overwriting predefined keys like 'constructor'

	var ref, indexKey = "ref:" + refName;
	if (refName && this.indexByName[indexKey]) {
		ref = this.indexByName[indexKey];
	} else {
		var n = this.refs.length,
			refKey = (1+n) + '';

		if (refName) {
			refKey = refName + '-' + refKey;
		}

		ref = {
			about: about,
			content: null,
			group: this.name,
			groupIndex: (1+n), // FIXME -- this seems to be wiki-specific
			index: n,
			key: refKey,
			linkbacks: [],
			name: refName,
			target: 'cite_note-' + refKey
		};
		this.refs[n] = ref;
		if (refName) {
			this.indexByName[indexKey] = ref;
		}
	}

	if (!skipLinkback) {
		ref.linkbacks.push('cite_ref-' + ref.key + '-' + ref.linkbacks.length);
	}

	return ref;
};

RefGroup.prototype.renderLine = function(refsList, ref) {
	var ownerDoc = refsList.ownerDocument,
		arrow = ownerDoc.createTextNode('↑'),
		li, a;

	// Generate the li and set ref content first, so the HTML gets parsed.
	// We then append the rest of the ref nodes before the first node
	li = ownerDoc.createElement('li');
	DU.addAttributes(li, {
		'about': "#" + ref.target,
		'id': ref.target
	});
	li.innerHTML = ref.content;

	var contentNode = li.firstChild;

	// 'mw:referencedBy' span wrapper
	var span = ownerDoc.createElement('span');
	span.setAttribute('rel', 'mw:referencedBy');
	li.insertBefore(span, contentNode);

	// Generate leading linkbacks
	if (ref.linkbacks.length === 1) {
		a = ownerDoc.createElement('a');
		DU.addAttributes(a, {
			'href': '#' + ref.linkbacks[0]
		});
		a.appendChild(arrow);
		span.appendChild(a);
	} else {
		span.appendChild(arrow);
		$.each(ref.linkbacks, function(i, linkback) {
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
	li.insertBefore(ownerDoc.createTextNode(' '), contentNode);

	// Add it to the ref list
	refsList.appendChild(li);
};

// NOTE: prefix name with "refgroup:" before using it as a property key
// This is to avoid overwriting predefined keys like 'constructor'
function setRefGroup(refGroups, groupName, group) {
	refGroups["refgroup:" + groupName] = group;
}

function getRefGroup(refGroups, groupName, allocIfMissing) {
	groupName = groupName || '';
	var key = "refgroup:" + groupName;
	if (!refGroups[key] && allocIfMissing) {
		setRefGroup(refGroups, groupName, new RefGroup(groupName));
	}
	return refGroups[key];
}

function References(cite) {
	this.cite = cite;
	this.reset();
}

// Inherit functionality from ExtensionHandler
coreutil.inherits(References, ExtensionHandler);

References.prototype.reset = function(group) {
	if (group) {
		setRefGroup(this.refGroups, group, undefined);
	} else {
		this.refGroups = {};
	}
};

/**
 * Sanitize the references tag and convert it into a meta-token
 */
References.prototype.handleReferences = function ( manager, pipelineOpts, refsTok, cb ) {
	refsTok = refsTok.clone();

	// group is the only recognized option?
	var refsOpts = Util.KVtoHash(refsTok.getAttribute("options")),
		group = refsOpts.group;

	if ( group && group.constructor === Array ) {
		// Array of tokens, convert to string.
		group = Util.tokensToString(group);
	}

	// Point invalid / empty groups to null
	if ( ! group ) {
		group = null;
	}

	// Emit a marker mw:DOMFragment for the references
	// token so that the dom post processor can generate
	// and emit references at this point in the DOM.
	var emitReferencesFragment = function() {
		var about = manager.env.newAboutId(),
			type = refsTok.getAttribute('typeof');
		var buf = [
			"<ol class='references'",
			" typeof='", "mw:Extension/references", "'",
			" about='", about, "'",
			"></ol>"
		];

		var wrapperDOM = Util.parseHTML(buf.join('')).body.childNodes;
		wrapperDOM[0].setAttribute('source', refsTok.getAttribute('source'));
		if (group) {
			wrapperDOM[0].setAttribute('group', group);
		}

		var expansion = {
			nodes: wrapperDOM,
			html: wrapperDOM.map(function(n) { return n.outerHTML; }).join('')
		};

		// TemplateHandler wants a manager property
		//
		// FIXME: Seems silly -- maybe we should move encapsulateExpansionHTML
		// into Util and pass env into it .. can avoid extending ExtensionHandler
		// as well.
		this.manager = manager;

		cb({ tokens: this.encapsulateExpansionHTML(refsTok, expansion), async: false });
	}.bind(this);

	processExtSource(manager, refsTok, {
		// Partial pipeline for processing ref-content
		// Expand till stage 2 so that all embedded
		// ref tags get processed
		pipelineType: 'text/x-mediawiki',
		pipelineOpts: {
			extTag: "references",
			wrapTemplates: pipelineOpts.wrapTemplates
		},
		res: [],
		parentCB: cb,
		emptyContentCB: emitReferencesFragment,
		chunkCB: function(chunk) {
			// Extract ref-content tokens and discard the rest
			var res = [];
			for (var i = 0, n = chunk.length; i < n; i++) {
				var t = chunk[i];
				if (t.constructor === SelfclosingTagTk &&
					t.name === 'meta' &&
					/^mw:Extension\/ref\/Marker$/.test(t.getAttribute('typeof')))
				{
					res.push(t);
				}
			}

			// Pass along the ref toks
			cb({ tokens: res, async: true });
		},
		endCB: emitReferencesFragment
	});
};

References.prototype.extractRefFromNode = function(node) {

	var group = node.getAttribute("group"),
		refName = node.getAttribute("name"),
		about = node.getAttribute("about"),
		skipLinkback = node.getAttribute("skiplinkback") === "1",
		refGroup = getRefGroup(this.refGroups, group, true),
		ref = refGroup.add(refName, about, skipLinkback),
		nodeType = (node.getAttribute("typeof") || '').replace(/mw:Extension\/ref\/Marker/, '');

	// Add ref-index linkback
	if (!skipLinkback) {
		var doc = node.ownerDocument,
			span = doc.createElement('span'),
			content = node.getAttribute("content"),
			dataMW = node.getAttribute('data-mw');

		if (!dataMW) {
			dataMW = JSON.stringify({
				'name': 'ref',
				// Dont set body if this is a reused reference
				// like <ref name='..' /> with empty content.
				'body': content ? { 'html': content } : undefined,
				'attrs': {
					// Dont emit empty keys
					'group': group || undefined,
					'name': refName || undefined
				}
			});
		}

		DU.addAttributes(span, {
			'about': about,
			'class': 'reference',
			'data-mw': dataMW,
			'id': ref.linkbacks[ref.linkbacks.length - 1],
			'rel': 'dc:references',
			'typeof': nodeType
		});
		DU.addTypeOf(span, "mw:Extension/ref");
		span.data = {
			parsoid: {
				src: node.data.parsoid.src,
				dsr: node.data.parsoid.dsr
			}
		};

		// refIndex-span
		node.parentNode.insertBefore(span, node);

		// refIndex-a
		var refIndex = doc.createElement('a');
		refIndex.setAttribute('href', '#' + ref.target);
		refIndex.appendChild(doc.createTextNode(
			'[' + ((group === '') ? '' : group + ' ') + ref.groupIndex + ']'
		));
		span.appendChild(refIndex);
	}

	// This effectively ignores content from later references with the same name.
	// The implicit assumption is that that all those identically named refs. are
	// of the form <ref name='foo' />
	if (!ref.content) {
		ref.content = node.getAttribute("content");
	}
};

References.prototype.insertReferencesIntoDOM = function(refsNode) {
	var group = refsNode.getAttribute("group") || '',
		about = refsNode.getAttribute('about'),
		src = refsNode.getAttribute('source'),
		// Extract ext-source for <references>..</references> usage
		body = Util.extractExtBody("references", src).trim(),
		refGroup = getRefGroup(this.refGroups, group);

	var dataMW = refsNode.getAttribute('data-mw');
	if (!dataMW) {
		dataMW = JSON.stringify({
			'name': 'references',
			// We'll have to output data-mw.body.extsrc in
			// scenarios where original wikitext was of the form:
			// "<references> lot of refs here </references>"
			// Ex: See [[en:Barack Obama]]
			'body': body.length > 0 ? { 'extsrc': body } : undefined,
			'attrs': {
				// Dont emit empty keys
				'group': group || undefined
			}
		});
	}

	refsNode.removeAttribute('source');
	refsNode.setAttribute('data-mw', dataMW);

	if (refGroup) {
		refGroup.refs.map(refGroup.renderLine.bind(refGroup, refsNode));
	}

	// reset
	this.reset(group);
};

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together <ref> and <references>
 */
var Cite = function() {
	this.ref = new Ref(this);
	this.references = new References(this);
};

Cite.prototype.resetState = function(group) {
	this.ref.reset();
	this.references.reset(group);
};

if (typeof module === "object") {
	module.exports.Cite = Cite;
}
