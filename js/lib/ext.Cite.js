"use strict";

var Util = require( './mediawiki.Util.js' ).Util,
	$ = require( './fakejquery' );

function RefGroup(group) {
	this.name = group || '';
	this.refs = [];
	this.indexByName = {};
}

RefGroup.prototype.add = function(refName) {
	var ref;
	if (refName && this.indexByName[refName]) {
		ref = this.indexByName[refName];
	} else {
		var n = this.refs.length,
			refKey = n + '';

		if (refName) {
			refKey = refName + '-' + refKey;
		}

		ref = {
			content: null,
			index: n,
			groupIndex: n, // @fixme
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
	ref.linkbacks.push('cite_ref-' + ref.key + '-' + ref.linkbacks.length);
	return ref;
};

RefGroup.prototype.renderLine = function(refsList, ref) {
	var ownerDoc = refsList.ownerDocument,
		arrow = ownerDoc.createTextNode('↑'),
		li, a;

	// Generate the li
	li = ownerDoc.createElement('li'),
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

/**
 * Simple token transform version of the Cite extension.
 *
 * @class
 * @constructor
 */
function Cite () {
	this.resetState();
}

/**
 * Reset state before each top-level parse -- this lets us share a pipeline
 * to parse unrelated pages.
 */
Cite.prototype.resetState = function() {
	this.refGroups = {};
};

/**
 * Handle ref tokens
 */
Cite.prototype.handleRef = function ( manager, refTok, cb ) {
	var tsr = refTok.dataAttribs.tsr,
		options = $.extend({ name: null, group: null }, Util.KVtoHash(refTok.getAttribute("options"))),
		group = this.refGroups[options.group] || newRefGroup(this.refGroups, options.group),
		ref = group.add(options.name),
		//console.warn( 'added tokens: ' + JSON.stringify( this.refGroups, null, 2 ));
		linkback = ref.linkbacks[ref.linkbacks.length - 1],
		bits = [];

	if (options.group) {
		bits.push(options.group);
	}

	//bits.push(Util.formatNum( ref.groupIndex + 1 ));
	bits.push(ref.groupIndex + 1);

	var about = "#" + manager.env.newObjectId(),
		span  = new TagTk('span', [
				new KV('id', linkback),
				new KV('class', 'reference'),
				new KV('about', about),
				new KV('typeof', 'mw:Object/Ext/Cite')
			], { src: refTok.dataAttribs.src }),
		endMeta = new SelfclosingTagTk( 'meta', [
				new KV( 'typeof', 'mw:Object/Ext/Cite/End' ),
				new KV( 'about', about)
			]);

	if (tsr) {
		span.dataAttribs.tsr = tsr;
		endMeta.dataAttribs.tsr = [null, tsr[1]];
	}

	var res = [
		span,
		new TagTk( 'a', [ new KV('href', '#' + ref.target) ]),
		'[' + bits.join(' ')  + ']',
		new EndTagTk( 'a' ),
		new EndTagTk( 'span' ),
		endMeta
	];

	var extSrc = refTok.getAttribute('source'),
		tagWidths = refTok.dataAttribs.tagWidths,
		content = extSrc.substring(tagWidths[0], extSrc.length - tagWidths[1]);

	if (!content || content.length === 0) {
		var contentMeta = new SelfclosingTagTk( 'meta', [
				new KV( 'typeof', 'mw:Ext/Ref/Content' ),
				new KV( 'about', about),
				new KV( 'group', options.group || ''),
				new KV( 'name', options.name || ''),
				new KV( 'content', '')
			]);
		res.push(contentMeta);
		cb({tokens: res, async: false});
	} else {
		// The content meta-token is yet to be emitted and depends on
		// the ref-content getting processed completely.
		cb({tokens: res, async: true});

		// Full pipeline for processing ref-content
		// No need to encapsulate templates in extension content
		var pipeline = manager.pipeFactory.getPipeline('text/x-mediawiki/full', {
			wrapTemplates: true,
			isExtension: true,
			inBlockToken: true
		});
		pipeline.setSourceOffsets(tsr[0]+tagWidths[0], tsr[1]-tagWidths[1]);
		pipeline.addListener('document', function(refContentDoc) {
			var contentMeta = new SelfclosingTagTk( 'meta', [
					new KV( 'typeof', 'mw:Ext/Ref/Content' ),
					new KV( 'about', about),
					new KV( 'group', options.group || ''),
					new KV( 'name', options.name || ''),
					new KV( 'content', refContentDoc.body.innerHTML)
				]);
			// All done!
			cb ({ tokens: [contentMeta], async: false });
		});

		pipeline.process(content);
	}
};

/**
 * Sanitize the references tag and convert it into a meta-token
 */
Cite.prototype.handleReferences = function ( manager, refsTok, cb ) {
	refsTok = refsTok.clone();

	var placeHolder = new SelfclosingTagTk('meta',
		refsTok.attribs,
		refsTok.dataAttribs);

	// group is the only recognized option?
	var options = Util.KVtoHash(refsTok.getAttribute("options")),
		group = options.group;

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

	// Update properties
	if (group) {
		placeHolder.setAttribute('group', group);
	}
	placeHolder.setAttribute('typeof', 'mw:Ext/References');
	placeHolder.dataAttribs.stx = undefined;

	cb({ tokens: [placeHolder], async: false });
};

function References () {
	this.reset();
}

References.prototype.reset = function() {
	this.refGroups = { };
};

References.prototype.extractRefFromNode = function(node) {
	var group = node.getAttribute("group"),
		refName = node.getAttribute("name"),
		refGroup = this.refGroups[group] || newRefGroup(this.refGroups, group),
		ref = refGroup.add(refName);

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
	this.refGroups[group] = undefined;
};

if (typeof module === "object") {
	module.exports.Cite = Cite;
	module.exports.References = References;
}
