/* ----------------------------------------------------------------------
 * This file implements <ref> and <references> extension tag handling
 * natively in Parsoid.
 * ---------------------------------------------------------------------- */
"use strict";

var Util = require( './mediawiki.Util.js' ).Util,
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
				new KV('typeof', 'mw:Ext/Ref/Marker'),
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
			extTag: "ref",
			// Always wrap templates for ref-tags
			// SSS FIXME: Document why this is so
			// I wasted an hour because I failed to set this flag
			wrapTemplates: true
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

RefGroup.prototype.add = function(refName, skipLinkback) {
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
			content: null,
			index: n,
			groupIndex: (1+n), // FIXME -- this seems to be wiki-specific
			name: refName,
			group: this.name,
			key: refKey,
			target: 'cite_note-' + refKey,
			linkbacks: []
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

	// Generate the li
	li = ownerDoc.createElement('li');
	li.setAttribute('id', ref.target);

	// Set ref content first, so the HTML gets parsed
	// We then append the rest of the ref nodes before the first node
	li.innerHTML = ref.content;
	var contentNode = li.firstChild;
	// if (!contentNode) console.warn("--empty content for: " + ref.linkbacks[0]);

	// Generate leading linkbacks
	if (ref.linkbacks.length === 1) {
		a = ownerDoc.createElement('a');
		a.setAttribute('href', '#' + ref.linkbacks[0]);
		a.appendChild(arrow);
		li.insertBefore(a, contentNode);
		li.insertBefore(ownerDoc.createTextNode(' '), contentNode);
	} else {
		li.insertBefore(arrow, contentNode);
		$.each(ref.linkbacks, function(i, linkback) {
			a = ownerDoc.createElement('a');
			a.setAttribute('data-type', 'hashlink');
			a.setAttribute('href', '#' + ref.linkbacks[i]);
			a.appendChild(ownerDoc.createTextNode(ref.groupIndex + '.' + i));
			li.insertBefore(a, contentNode);
			// Separate linkbacks with a space
			li.insertBefore(ownerDoc.createTextNode(' '), contentNode);
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

	if ( group ) {
		// have a String, strip whitespace
		group = group.replace(/^\s*(.*)\s$/, '$1');
	}

	// Point invalid / empty groups to null
	if ( ! group ) {
		group = null;
	}

	// Emit a placeholder meta for the references token
	// so that the dom post processor can generate and
	// emit references at this point in the DOM.
	var emitPlaceholderMeta = function() {
		var placeHolder = new SelfclosingTagTk('meta', refsTok.attribs, refsTok.dataAttribs);
		placeHolder.setAttribute('typeof', 'mw:Ext/References');
		placeHolder.setAttribute('about', '#' + manager.env.newObjectId());
		placeHolder.dataAttribs.stx = undefined;
		if (group) {
			placeHolder.setAttribute('group', group);
		}
		cb({ tokens: [placeHolder], async: false });
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
		emptyContentCB: emitPlaceholderMeta,
		chunkCB: function(chunk) {
			// Extract ref-content tokens and discard the rest
			var res = [];
			for (var i = 0, n = chunk.length; i < n; i++) {
				var t = chunk[i];
				if (t.constructor === SelfclosingTagTk &&
					t.name === 'meta' &&
					/^mw:Ext\/Ref\/Marker$/.test(t.getAttribute('typeof')))
				{
					res.push(t);
				}
			}

			// Pass along the ref toks
			cb({ tokens: res, async: true });
		},
		endCB: emitPlaceholderMeta
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
		ref = refGroup.add(refName, skipLinkback);

	// Add ref-index linkback
	if (!skipLinkback) {
		var doc = node.ownerDocument,
			span = doc.createElement('span'),
			endMeta = doc.createElement('meta');

		span.setAttribute('id', ref.linkbacks[ref.linkbacks.length - 1]);
		span.setAttribute('class', 'reference');
		span.setAttribute('about', about);
		span.setAttribute('typeof', 'mw:Object/Ext/Ref');
		span.data = { parsoid: { src: node.data.parsoid.src } };

		var tsr = node.data.parsoid.tsr;
		if (tsr) {
			span.data.parsoid.tsr = tsr;
			endMeta.data = { parsoid: { tsr: [null, tsr[1]] } };
		}

		// refIndex-span
		node.parentNode.insertBefore(span, node);

		// refIndex-a
		var refIndex = doc.createElement('a');
		refIndex.setAttribute('href', '#' + ref.target);
		refIndex.appendChild(doc.createTextNode(
			'[' + ((group === '') ? '' : group + ' ') + ref.groupIndex + ']'
		));
		span.appendChild(refIndex);

		// endMeta
		endMeta.setAttribute('typeof', 'mw:Object/Ext/Ref/End' );
		endMeta.setAttribute('about', about);
		node.parentNode.insertBefore(endMeta, node);
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
			endMeta = refsNode.ownerDocument.createElement('meta'),
			about = refsNode.getAttribute('about');

		ol.setAttribute('class', 'references');
		ol.setAttribute('typeof', 'mw:Object/References');
		ol.setAttribute('about', about);
		ol.data = refsNode.data;
		refGroup.refs.map(refGroup.renderLine.bind(refGroup, ol));
		refsNode.parentNode.replaceChild(ol, refsNode);

		// Since this has a 'mw:Object/*' typeof, this code will be run
		// through template encapsulation code.  Add an end-meta after
		// the list so that that code knows where the references code ends.
		endMeta.setAttribute('typeof', 'mw:Object/References/End' );
		endMeta.setAttribute('about', about);
		// Set end-tsr on the endMeta so that DSR computation can establish
		// a valid DSR range on the references section.
		var tsr = refsNode.data.parsoid.tsr;
		if (tsr) {
			endMeta.data = { parsoid: { tsr: [null, tsr[1]] } };
		}
		ol.parentNode.insertBefore(endMeta, ol.nextSibling);
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
