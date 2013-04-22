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
	TagTk = defines.TagTk,
	SelfclosingTagTk = defines.SelfclosingTagTk,
	EndTagTk = defines.EndTagTk;

/**
 * Helper class used both by <ref> and <references> implementations
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
	li.setAttribute('li', ref.target);

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

function newRefGroup(refGroups, group) {
	group = group || '';
	if (!refGroups[group]) {
		refGroups[group] = new RefGroup(group);
	}
	return refGroups[group];
}

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
Ref.prototype.reset = function() {
	this.refGroups = {};
};

/**
 * Handle ref tokens
 */
Ref.prototype.handleRef = function ( manager, pipelineOpts, refTok, cb ) {

	var tsr = refTok.dataAttribs.tsr,
		refOpts = $.extend({ name: null, group: null }, Util.KVtoHash(refTok.getAttribute("options"))),
		group = this.refGroups[refOpts.group] || newRefGroup(this.refGroups, refOpts.group),
		ref = group.add(refOpts.name, pipelineOpts.extTag === "references"),
		linkback = ref.linkbacks[ref.linkbacks.length - 1],
		bits = [];

	if (refOpts.group) {
		bits.push(refOpts.group);
	}

	//bits.push(Util.formatNum( ref.groupIndex ));
	bits.push(ref.groupIndex);

	var about, res;
	if (pipelineOpts.extTag === "references") {
		about = '';
		res = [];
	} else {
		about = "#" + manager.env.newObjectId();

		var span = new TagTk('span', [
				new KV('id', linkback),
				new KV('class', 'reference'),
				new KV('about', about),
				new KV('typeof', 'mw:Object/Ext/Ref')
			], {
				src: refTok.dataAttribs.src
			}),
			endMeta = new SelfclosingTagTk( 'meta', [
				new KV( 'typeof', 'mw:Object/Ext/Ref/End' ),
				new KV( 'about', about)
			]);

		if (tsr) {
			span.dataAttribs.tsr = tsr;
			endMeta.dataAttribs.tsr = [null, tsr[1]];
		}

		res = [
			span,
			new TagTk( 'a', [ new KV('href', '#' + ref.target) ]),
			'[' + bits.join(' ')  + ']',
			new EndTagTk( 'a' ),
			new EndTagTk( 'span' ),
			endMeta
		];
	}

	var finalCB = function(toks, content) {
			toks.push(new SelfclosingTagTk( 'meta', [
				new KV('typeof', 'mw:Ext/Ref/Content'),
				new KV('about', about),
				new KV('group', refOpts.group || ''),
				new KV('name', refOpts.name || ''),
				new KV('content', content || ''),
				new KV('skiplinkback', pipelineOpts.extTag === "references" ? 1 : 0)
			]));

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
		res: res,
		parentCB: cb,
		emptyContentCB: finalCB,
		documentCB: function(refContentDoc) {
			finalCB([], refContentDoc.body.innerHTML);
		}
	});
};

function References(cite) {
	this.cite = cite;
	this.reset();
}

References.prototype.reset = function() {
	this.refGroups = { };
};

/**
 * Sanitize the references tag and convert it into a meta-token
 */
References.prototype.handleReferences = function ( manager, pipelineOpts, refsTok, cb ) {
	refsTok = refsTok.clone();

	var cite = this.cite;

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
		var placeHolder = new SelfclosingTagTk('meta',
			refsTok.attribs,
			refsTok.dataAttribs);

		// Update properties
		if (group) {
			placeHolder.setAttribute('group', group);
		}
		placeHolder.setAttribute('typeof', 'mw:Ext/References');
		placeHolder.dataAttribs.stx = undefined;

		// All done!
		cb({ tokens: [placeHolder], async: false });

		// FIXME: This is somehow buggy -- needs investigation
		// Reset refs after references token is processed
		// cite.ref.resetState();
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
					t.getAttribute('typeof').match(/mw:Ext\/Ref\/Content/))
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
	var group = node.getAttribute("group"),
		refName = node.getAttribute("name"),
		refGroup = this.refGroups[group] || newRefGroup(this.refGroups, group),
		ref = refGroup.add(refName, node.getAttribute("skiplinkback") === "1");

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
		var ol = refsNode.ownerDocument.createElement('ol');
		ol.setAttribute('class', 'references');
		ol.setAttribute('typeof', 'mw:Object/References');
		ol.setAttribute('data-parsoid', refsNode.getAttribute('data-parsoid'));
		refGroup.refs.map(refGroup.renderLine.bind(refGroup, ol));
		refsNode.parentNode.replaceChild(ol, refsNode);
	} else {
		// Not a valid references tag -- convert it to a placeholder tag that will rt as is.
		refsNode.setAttribute('typeof', 'mw:Placeholder');
	}

	// clear refs group
	if (group) {
		this.refGroups[group] = undefined;
	} else {
		this.refGroups = {};
	}
};

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together <ref> and <references>
 */
var Cite = function() {
	this.ref = new Ref(this);
	this.references = new References(this);
};

Cite.prototype.resetState = function() {
	this.ref.reset();
	this.references.reset();
};

if (typeof module === "object") {
	module.exports.Cite = Cite;
}
