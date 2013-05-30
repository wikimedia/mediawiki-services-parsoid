/* ----------------------------------------------------------------------
 * This file implements <ref> and <references> extension tag handling
 * natively in Parsoid.
 * ---------------------------------------------------------------------- */
"use strict";

var Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js').DOMUtils,
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

	// FIXME: Should this be specific to the extension
	// or is it okay to do this unconditionally for all?
	// Right now, this code is run only for ref and references,
	// so not a real problem, but if this is used on other extensions,
	// requires addressing.
	//
	// Strip white-space only lines
	var wsMatch = content.match(/^((?:\s*\n)?)((?:.|\n)*)$/),
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
				wrapTemplates: true,
				// SSS FIXME: Doesn't seem right.
				// Should this be the default in all cases?
				inBlockToken: true
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

	var inReferencesExt = pipelineOpts.extTag === "references",
		refOpts = $.extend({ name: null, group: null }, Util.KVtoHash(refTok.getAttribute("options"))),
		about = inReferencesExt ? '' : "#" + manager.env.newObjectId(),
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
	var ref;
	if (refName && this.indexByName[refName]) {
		ref = this.indexByName[refName];
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
			this.indexByName[refName] = ref;
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

	// If ref-content has block nodes, wrap it in a div, else in a span
	var contentNode = ownerDoc.createElement(DU.hasBlockContent(li) ? 'div' : 'span');

	// Move all children from li to contentNode
	DU.migrateChildren(li, contentNode);
	li.appendChild(contentNode);

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

		// Space between span-wrapper and content node
		li.insertBefore(ownerDoc.createTextNode(' '), contentNode);
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

	// Add it to the ref list
	refsList.appendChild(li);
};

function References(cite) {
	this.cite = cite;
	this.reset();
}

References.prototype.reset = function(group) {
	if (group) {
		this.refGroups[group] = undefined;
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

	// Emit a placeholder meta for the references token
	// so that the dom post processor can generate and
	// emit references at this point in the DOM.
	var emitMarkerMeta = function() {
		var marker = new SelfclosingTagTk('meta', refsTok.attribs, refsTok.dataAttribs);

		marker.dataAttribs.stx = undefined;
		DU.addAttributes(marker, {
			'about': '#' + manager.env.newObjectId(),
			'group': group,
			'typeof': 'mw:Extension/references/Marker'
		});
		cb({ tokens: [marker], async: false });
	};

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
		emptyContentCB: emitMarkerMeta,
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
		endCB: emitMarkerMeta
	});
};

References.prototype.extractRefFromNode = function(node) {
	function newRefGroup(refGroups, group) {
		group = group || '';
		if (!refGroups[group]) {
			refGroups[group] = new RefGroup(group);
		}
		return refGroups[group];
	}

	var group = node.getAttribute("group"),
		refName = node.getAttribute("name"),
		about = node.getAttribute("about"),
		skipLinkback = node.getAttribute("skiplinkback") === "1",
		refGroup = this.refGroups[group] || newRefGroup(this.refGroups, group),
		ref = refGroup.add(refName, about, skipLinkback);

	// Add ref-index linkback
	if (!skipLinkback) {
		var doc = node.ownerDocument,
			span = doc.createElement('span'),
			content = node.getAttribute("content");

		DU.addAttributes(span, {
			'about': about,
			'class': 'reference',
			'data-mw': JSON.stringify({
				'name': 'ref',
				// Dont set body if this is a reused reference
				// like <ref name='..' /> with empty content.
				'body': content ? { 'html': content } : undefined,
				'attrs': {
					// Dont emit empty keys
					'group': group || undefined,
					'name': refName || undefined
				}
			}),
			'id': ref.linkbacks[ref.linkbacks.length - 1],
			'rel': 'dc:references',
			'typeof': 'mw:Extension/ref'
		});
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
		refGroup = this.refGroups[group];

	if (refGroup && refGroup.refs.length > 0) {
		var ol = refsNode.ownerDocument.createElement('ol'),
			about = refsNode.getAttribute('about');

		DU.addAttributes(ol, {
			'about': about,
			'class': 'references',
			// SSS FIXME: data-mw for references is missing.
			// We'll have to output data-mw.body.extsrc in
			// scenarios where original wikitext was of the form:
			// "<references> lot of refs here </references>"
			// Ex: See [[en:Barack Obama]]
			'typeof': 'mw:Extension/references'
		});
		ol.data = refsNode.data;
		refGroup.refs.map(refGroup.renderLine.bind(refGroup, ol));
		refsNode.parentNode.replaceChild(ol, refsNode);
	} else {
		// Not a valid references tag -- convert it to a placeholder tag that will rt as is.
		refsNode.setAttribute('typeof', 'mw:Placeholder');
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
