/* ----------------------------------------------------------------------
 * This file implements <ref> and <references> extension tag handling
 * natively in Parsoid.
 * ---------------------------------------------------------------------- */
"use strict";

var Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js').DOMUtils,
	coreutil = require('util'),
	defines = require('./mediawiki.parser.defines.js'),
	$ = require( './fakejquery' );

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
	// FIXME: SSS: This stripping maybe be unecessary after all.
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
		opts.srcOffsets = [ tsr[0]+tagWidths[0]+leadingWS.length, tsr[1]-tagWidths[1] ];

		// Process ref content
		Util.processContentInPipeline( manager, content, opts );
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
	// Nested <ref> tags at the top level are considered errors
	// But, inside templates, they are supported
	if (!pipelineOpts.inTemplate && pipelineOpts.extTag === "ref") {
		cb({ tokens: [refTok.getAttribute("source")] });
		return;
	}

	var inReferencesExt = pipelineOpts.extTag === "references",
		refOpts = $.extend({ name: null, group: null }, Util.KVtoHash(refTok.getAttribute("options"))),
		about = manager.env.newAboutId(),
		finalCB = function(toks, content) {
			// Marker meta with ref content
			var da = Util.clone(refTok.dataAttribs);
			// Clear stx='html' so that sanitizer doesn't barf
			da.stx = undefined;
			if (!da.tmp) {
				da.tmp = {};
			}

			da.tmp.group = refOpts.group || '';
			da.tmp.name = refOpts.name || '';
			da.tmp.content = content || '';
			da.tmp.skiplinkback = inReferencesExt ? 1 : 0;

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
			inTemplate: pipelineOpts.inTemplate,
			noPre: true,
			extTag: "ref"
		},
		res: [],
		parentCB: cb,
		emptyContentCB: finalCB,
		documentCB: function(refContentDoc) {
			finalCB([], DU.serializeChildren(refContentDoc.body));
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

RefGroup.prototype.add = function(refName, about, skipLinkback) {
	var ref;
	if ( refName && this.indexByName.has( refName ) ) {
		ref = this.indexByName.get( refName );
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
			this.indexByName.set( refName, ref );
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

function getRefGroup(refGroups, groupName, allocIfMissing) {
	groupName = groupName || '';
	if ( !refGroups.has( groupName ) && allocIfMissing ) {
		refGroups.set( groupName, new RefGroup( groupName ) );
	}
	return refGroups.get( groupName );
}

function References(cite) {
	this.cite = cite;
	this.reset();
}

References.prototype.reset = function(group) {
	if (group) {
		this.refGroups.set( group, undefined );
	} else {
		this.refGroups = new Map();
		/* -----------------------------------------------------------------
		 * Map: references-about-id --> HTML of any nested refs
		 *
		 * Ex: Given this wikitext:
		 *
		 *   <references> <ref>foo</ref> </references>
		 *   <references> <ref>bar</ref> </references>
		 *
		 * during processing, each of the references tag gets an about-id
		 * assigned to it.  The ref-tags nested inside it have a data-attribute
		 * with the references about-id.  When processing the ref-tokens and
		 * generating the HTML, we then collect the HTML for each nested
		 * ref-token and add it to this map by about-id.
		 * ----------------------------------------------------------------- */
		this.nestedRefsHTMLMap = new Map();
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

	// Assign an about id and intialize the nested refs html
	var referencesId = manager.env.newAboutId();

	// Emit a marker mw:DOMFragment for the references
	// token so that the dom post processor can generate
	// and emit references at this point in the DOM.
	var emitReferencesFragment = function() {
		var type = refsTok.getAttribute('typeof');
		var buf = [
			"<ol class='references'",
			" typeof='", "mw:Extension/references", "'",
			" about='", referencesId, "'",
			"></ol>"
		];
		var olProcessor = function(ol) {
			var dp = DU.getJSONAttribute(ol, "data-parsoid", {});
			dp.src = refsTok.getAttribute('source');
			if (group) {
				dp.group = group;
			}
			DU.setJSONAttribute(ol, "data-parsoid", dp);
		};

		cb({
			async: false,
			tokens: DU.buildDOMFragmentForTokenStream(
				refsTok,
				buf.join(''),
				manager.env,
				olProcessor,
				{ aboutId: referencesId, isForeignContent: true }
			)
		});
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
					var da = t.dataAttribs;
					if (!da.tmp) {
						da.tmp = {};
					}
					da.tmp['references-id'] = referencesId;
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
	var dp = node.data.parsoid,
		group = dp.tmp.group,
		refName = dp.tmp.name,
		about = node.getAttribute("about"),
		skipLinkback = dp.tmp.skiplinkback,
		refGroup = getRefGroup(this.refGroups, group, true),
		ref = refGroup.add(refName, about, skipLinkback),
		nodeType = (node.getAttribute("typeof") || '').replace(/mw:Extension\/ref\/Marker/, '');

	// Add ref-index linkback
	var doc = node.ownerDocument,
		span = doc.createElement('span'),
		content = dp.tmp.content,
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
		'id': skipLinkback ? undefined : ref.linkbacks[ref.linkbacks.length - 1],
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

	// refIndex-a
	var refIndex = doc.createElement('a');
	refIndex.setAttribute('href', '#' + ref.target);
	refIndex.appendChild(doc.createTextNode(
		'[' + ((group === '') ? '' : group + ' ') + ref.groupIndex + ']'
	));
	span.appendChild(refIndex);

	if (!skipLinkback) {
		// refIndex-span
		node.parentNode.insertBefore(span, node);
	} else {
		var referencesAboutId = dp.tmp["references-id"];
		// Init
		if ( !this.nestedRefsHTMLMap.has( referencesAboutId ) ) {
			this.nestedRefsHTMLMap.set( referencesAboutId, ["\n"] );
		}
		this.nestedRefsHTMLMap.get( referencesAboutId ).push( DU.serializeNode( span ), "\n" );
	}

	// This effectively ignores content from later references with the same name.
	// The implicit assumption is that that all those identically named refs. are
	// of the form <ref name='foo' />
	if (!ref.content) {
		ref.content = dp.tmp.content;
	}
};

References.prototype.insertReferencesIntoDOM = function(refsNode) {
	var about = refsNode.getAttribute('about'),
		group = refsNode.data.parsoid.group || '',
		src = refsNode.data.parsoid.src || '<references/>', // fall back so we don't crash
		// Extract ext-source for <references>..</references> usage
		body = Util.extractExtBody("references", src).trim(),
		refGroup = getRefGroup(this.refGroups, group);

	var dataMW = refsNode.getAttribute('data-mw');
	if (!dataMW) {
		var datamwBody;
		// We'll have to output data-mw.body.extsrc in
		// scenarios where original wikitext was of the form:
		// "<references> lot of refs here </references>"
		// Ex: See [[en:Barack Obama]]
		if (body.length > 0) {
			datamwBody = {
				'extsrc': body,
				'html': ( this.nestedRefsHTMLMap.get( about ) || [] ).join('')
			};
		}

		dataMW = JSON.stringify({
			'name': 'references',
			'body': datamwBody,
			'attrs': {
				// Dont emit empty keys
				'group': group || undefined
			}
		});
	}

	refsNode.setAttribute('data-mw', dataMW);

	// Remove all children from the references node
	//
	// Ex: When {{Reflist}} is reused from the cache, it comes with
	// a bunch of references as well. We have to remove all those cached
	// references before generating fresh references.
	while (refsNode.firstChild) {
		refsNode.removeChild(refsNode.firstChild);
	}

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

Cite.prototype.resetState = function() {
	this.ref.reset();
	this.references.reset();
};

if (typeof module === "object") {
	module.exports.Cite = Cite;
}
