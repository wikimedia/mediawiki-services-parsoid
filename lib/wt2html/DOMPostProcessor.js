/* Perform post-processing steps on an already-built HTML DOM. */

'use strict';
require('../../core-upgrade');

var domino = require('domino');
var events = require('events');
var url = require('url');
var util = require('util');

var DU = require('../utils/DOMUtils.js').DOMUtils;
var DOMTraverser = require('../utils/DOMTraverser.js').DOMTraverser;

// processors
var markFosteredContent = require('./pp/processors/markFosteredContent.js').markFosteredContent;
var handleUnbalancedTables = require('./pp/processors/handleUnbalancedTables.js').handleUnbalancedTables;
var markTreeBuilderFixups = require('./pp/processors/markTreeBuilderFixups.js').markTreeBuilderFixups;
var normalize = require('./pp/processors/normalize.js').normalize;
var cleanupFormattingTagFixup = require('./pp/processors/cleanupFormattingTagFixup.js').cleanupFormattingTagFixup;
var migrateTemplateMarkerMetas = require('./pp/processors/migrateTemplateMarkerMetas.js').migrateTemplateMarkerMetas;
var handlePres = require('./pp/processors/handlePres.js').handlePres;
var migrateTrailingNLs = require('./pp/processors/migrateTrailingNLs.js').migrateTrailingNLs;
var computeDSR = require('./pp/processors/computeDSR.js').computeDSR;
var wrapTemplates = require('./pp/processors/wrapTemplates.js').wrapTemplates;

// handlers
var logWikitextFixup = require('./pp/handlers/linter.js').logWikitextFixups;
var CleanUp = require('./pp/handlers/cleanup.js');
var unpackDOMFragments = require('./pp/handlers/unpackDOMFragments.js').unpackDOMFragments;
var TableFixups = require('./pp/handlers/tableFixups.js').TableFixups;
var handleLinkNeighbours = require('./pp/handlers/handleLinkNeighbours.js').handleLinkNeighbours;
var liFixups = require('./pp/handlers/liFixups.js');

// map from mediawiki metadata names to RDFa property names
var metadataMap = {
	ns: {
		property: 'mw:articleNamespace',
		content: '%d',
	},
	// the articleID is not stable across article deletion/restore, while
	// the revisionID is.  So we're going to omit the articleID from the
	// parsoid API for now; uncomment if we find a use case.
	//  id: 'mw:articleId',

	// 'rev_revid' is used to set the overall subject of the document, we don't
	// need to add a specific <meta> or <link> element for it.

	rev_parentid: {
		rel: 'dc:replaces',
		resource: 'mwr:revision/%d',
	},
	rev_timestamp: {
		property: 'dc:modified',
		content: function(m) {
			return new Date(m.get('rev_timestamp')).toISOString();
		},
	},
	rev_sha1: {
		property: 'mw:revisionSHA1',
		content: '%s',
	},
};

// Sanity check for dom behavior: we are
// relying on DOM level 4 getAttribute. In level 4, getAttribute on a
// non-existing key returns null instead of the empty string.
var testDom = domino.createWindow('<h1>Hello world</h1>').document;
if (testDom.body.getAttribute('somerandomstring') === '') {
	throw('Your DOM version appears to be out of date! \n' +
			'Please run npm update in the js directory.');
}

/**
 * Create an element in the document.head with the given attrs.
 */
function appendToHead(document, tagName, attrs) {
	var elt = document.createElement(tagName);
	DU.addAttributes(elt, attrs || Object.create(null));
	document.head.appendChild(elt);
}

/**
 * @class
 * @extends EventEmitter
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {Object} options
 */
function DOMPostProcessor(env, options) {
	events.EventEmitter.call(this);
	this.env = env;
	this.options = options;

	// DOM traverser that runs before the in-order DOM handlers.
	var dataParsoidLoader = new DOMTraverser(env);
	dataParsoidLoader.addHandler(null, this.prepareDOM.bind(this));

	// Common post processing
	this.processors = [
		dataParsoidLoader.traverse.bind(dataParsoidLoader),
		markFosteredContent,
		handleUnbalancedTables,
		markTreeBuilderFixups,
		normalize,
		cleanupFormattingTagFixup,
		// Run this after 'markTreeBuilderFixups' because the mw:StartTag
		// and mw:EndTag metas would otherwise interfere with the
		// firstChild/lastChild check that this pass does.
		migrateTemplateMarkerMetas,
		handlePres,
		migrateTrailingNLs,
	];

	if (options.wrapTemplates && !options.inTemplate) {
		// dsr computation and tpl encap are only relevant
		// for top-level content that is not wrapped in an extension
		this.processors.push(computeDSR);
		this.processors.push(wrapTemplates);
	}

	// 1. Link prefixes and suffixes
	// 2. Unpack DOM fragments (reused transclusion and extension content)
	var domVisitor = new DOMTraverser(env);
	domVisitor.addHandler('a', handleLinkNeighbours);
	domVisitor.addHandler(null, unpackDOMFragments);
	this.processors.push(domVisitor.traverse.bind(domVisitor));

	// A pure DOM transformation
	env.conf.wiki.nativeExtPostProcessors.forEach(function(pp) {
		this.processors.push(pp);
	}, this);

	// Strip empty elements from template content
	domVisitor = new DOMTraverser(env);
	domVisitor.addHandler(null, CleanUp.stripEmptyElements);
	this.processors.push(domVisitor.traverse.bind(domVisitor));

	if (env.conf.parsoid.linting) {
		domVisitor = new DOMTraverser(env);
		domVisitor.addHandler(null, logWikitextFixup);
		this.processors.push(domVisitor.traverse.bind(domVisitor));
	}

	domVisitor = new DOMTraverser(env);
	var tableFixer = new TableFixups(env);
	// 1. Strip marker metas -- removes left over marker metas (ex: metas
	//    nested in expanded tpl/extension output).
	domVisitor.addHandler('meta',
		CleanUp.stripMarkerMetas.bind(null, env.conf.parsoid.rtTestMode));
	// 2. Deal with <li>-hack and move trailing categories in <li>s out of the list
	domVisitor.addHandler('li', liFixups.handleLIHack);
	domVisitor.addHandler('li', liFixups.migrateTrailingCategories);
	// 3. Fix up issues from templated table cells and table cell attributes
	domVisitor.addHandler('td', tableFixer.stripDoubleTDs.bind(tableFixer));
	domVisitor.addHandler('td', tableFixer.handleTableCellTemplates.bind(tableFixer));
	domVisitor.addHandler('th', tableFixer.handleTableCellTemplates.bind(tableFixer));
	this.processors.push(domVisitor.traverse.bind(domVisitor));

	// Save data.parsoid into data-parsoid html attribute.
	// Make this its own thing so that any changes to the DOM
	// don't affect other handlers that run alongside it.
	domVisitor = new DOMTraverser(env);
	domVisitor.addHandler(null, CleanUp.cleanupAndSaveDataParsoid);
	this.processors.push(domVisitor.traverse.bind(domVisitor));
}

// Inherit from EventEmitter
util.inherits(DOMPostProcessor, events.EventEmitter);

/**
 * Debugging aid: set pipeline id
 */
DOMPostProcessor.prototype.setPipelineId = function(id) {
	this.pipelineId = id;
};

DOMPostProcessor.prototype.setSourceOffsets = function(start, end) {
	this.options.sourceOffsets = [start, end];
};

DOMPostProcessor.prototype.resetState = function(opts) {
	this.atTopLevel = opts && opts.toplevel;
	this.displayTitle = null;
};

/**
 * Migrate data-parsoid attributes into a property on each DOM node.
 * We may migrate them back in the final DOM traversal.
 *
 * Various mw metas are converted to comments before the tree build to
 * avoid fostering. Piggy-backing the reconversion here to avoid excess
 * DOM traversals.
 */
DOMPostProcessor.prototype.prepareDOM = function(node, env) {
	if (DU.isElt(node)) {
		// Load data-(parsoid|mw) attributes that came in from the tokenizer
		// and remove them from the DOM.
		DU.loadDataAttribs(node);
		// Set title to display when present (last one wins).
		if (DU.hasNodeName(node, "meta") &&
				node.getAttribute("property") === "mw:PageProp/displaytitle") {
			this.displayTitle = node.getAttribute("content");
		}
	} else if (DU.isComment(node) && /^\{[^]+\}$/.test(node.data)) {
		// Convert serialized meta tags back from comments.
		// We use this trick because comments won't be fostered,
		// providing more accurate information about where tags are expected
		// to be found.
		var data, type;
		try {
			data = JSON.parse(node.data);
			type = data["@type"];
		} catch (e) {
			// not a valid json attribute, do nothing
			return true;
		}
		if (/^mw:/.test(type)) {
			var meta = node.ownerDocument.createElement("meta");
			data.attrs.forEach(function(attr) {
				try {
					meta.setAttribute(attr.nodeName, attr.nodeValue);
				} catch (e) {
					env.log("warning", "prepareDOM: Dropped invalid attribute",
						attr.nodeName);
				}
			});
			node.parentNode.replaceChild(meta, node);
			return meta;
		}

	}
	return true;
};

DOMPostProcessor.prototype.addMetaData = function(document) {
	var env = this.env;

	// add <head> element if it was missing
	if (!document.head) {
		document.documentElement.
			insertBefore(document.createElement('head'), document.body);
	}

	// add mw: and mwr: RDFa prefixes
	var prefixes = [
		'dc: http://purl.org/dc/terms/',
		'mw: http://mediawiki.org/rdf/',
	];
	// add 'http://' to baseURI if it was missing
	var mwrPrefix = url.resolve('http://',
		env.conf.wiki.baseURI + 'Special:Redirect/');
	document.documentElement.setAttribute('prefix', prefixes.join(' '));
	document.head.setAttribute('prefix', 'mwr: ' + mwrPrefix);

	// add <head> content based on page meta data:

	// Set the charset first.
	appendToHead(document, 'meta', { charset: 'utf-8' });

	// collect all the page meta data (including revision metadata) in 1 object
	var m = new Map();
	Object.keys(env.page.meta || {}).forEach(function(k) {
		m.set(k, env.page.meta[k]);
	});
	// include some other page properties
	["ns", "id"].forEach(function(p) {
		m.set(p, env.page[p]);
	});
	var rev = m.get('revision');
	Object.keys(rev || {}).forEach(function(k) {
		m.set('rev_' + k, rev[k]);
	});
	// use the metadataMap to turn collected data into <meta> and <link> tags.
	m.forEach(function(g, f) {
		var mdm = metadataMap[f];
		if (!m.has(f) || m.get(f) === null || m.get(f) === undefined || !mdm) {
			return;
		}
		// generate proper attributes for the <meta> or <link> tag
		var attrs = Object.create(null);
		Object.keys(mdm).forEach(function(k) {
			// evaluate a function, or perform sprintf-style formatting, or
			// use string directly, depending on value in metadataMap
			var v = (typeof (mdm[k]) === 'function') ? mdm[k](m) :
				mdm[k].indexOf('%') >= 0 ? util.format(mdm[k], m.get(f)) :
				mdm[k];
			attrs[k] = v;
		});
		// <link> is used if there's a resource or href attribute.
		appendToHead(document,
			(attrs.resource || attrs.href) ? 'link' : 'meta',
			attrs);
	});
	if (m.has('rev_revid')) {
		document.documentElement.setAttribute(
			'about', mwrPrefix + 'revision/' + m.get('rev_revid'));
	}
	// Set the parsoid content-type strings
	appendToHead(document, 'meta', {
		'property': 'mw:html:version',
		'content': env.contentVersion,
	});
	// TODO(arlolra): Remove when this version is no longer supported.
	if (!env.pageBundle && env.contentVersion === '1.2.1') {
		// For inline data-parsoid, add version information
		appendToHead(document, 'meta', {
			'property': 'mw:data-parsoid:version',
			'content': '0.0.2',
		});
	}
	var wikiPageUrl = env.conf.wiki.baseURI +
		env.page.name.split('/').map(encodeURIComponent).join('/');
	appendToHead(document, 'link',
		{ rel: 'dc:isVersionOf', href: wikiPageUrl });

	document.title = this.displayTitle || env.page.meta.title || '';

	// Add base href pointing to the wiki root
	appendToHead(document, 'base', { href: env.conf.wiki.baseURI });

	// Hack: link styles
	// We assume that load.php is available at the same location as api.php
	if (env.conf.wiki.apiURI) {
		var modules = [
				'mediawiki.legacy.commonPrint,shared',
				'mediawiki.skinning.elements',
				'mediawiki.skinning.content',
				'mediawiki.skinning.interface',
				'skins.vector.styles',
				'site',
				'mediawiki.skinning.content.parsoid',
				'ext.cite.style',
			];
		if (env.page.extensionModuleStyles) {
			env.page.extensionModuleStyles.forEach(function(module) {
				modules.push(module);
			});
		}
		var styleURI = env.conf.parsoid.getModulesLoadURI(env.conf.wiki) +
			'?modules=' + modules.join('|') + '&only=styles&skin=vector';
		appendToHead(document, 'link', { rel: 'stylesheet', href: styleURI });
	}

	// Stick data attributes in the head
	if (env.pageBundle) {
		var pb = JSON.stringify(DU.getDataParsoid(document).pagebundle);
		var script = document.createElement('script');
		DU.addAttributes(script, {
			id: 'mw-pagebundle',
			type: 'application/x-mw-pagebundle',
		});
		script.appendChild(document.createTextNode(pb));
		document.head.appendChild(script);
	}

	// Indicate language & directionality on body
	var dir = env.conf.wiki.rtl ? "rtl" : "ltr";
	document.body.setAttribute('lang', env.conf.wiki.lang);
	document.body.classList.add('mw-content-' + dir);
	document.body.classList.add('sitedir-' + dir);
	document.body.classList.add(dir);
	document.body.setAttribute('dir', dir);

	// Set mw-body and mw-body-content directly on the body. These are the
	// designated successors for #content (mw-body) and #bodyContent
	// (mw-body-content) in core skins.
	document.body.classList.add('mw-body');
	document.body.classList.add('mw-body-content');
	// Also add 'mediawiki' class
	document.body.classList.add('mediawiki');
};

DOMPostProcessor.prototype.doPostProcess = function(document) {
	var env = this.env;

	var psd = env.conf.parsoid;
	if (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:post-builder") !== -1)) {
		DU.dumpDOM(document.body, 'DOM: after tree builder');
	}

	// Holder for data-* attributes
	if (this.atTopLevel && env.pageBundle) {
		DU.setDataParsoid(document, {
			pagebundle: {
				parsoid: { counter: -1, ids: {} },
				mw: { ids: {} },
			},
		});
	}

	for (var i = 0; i < this.processors.length; i++) {
		try {
			this.processors[i](document.body, env, this.options, this.atTopLevel);
		} catch (e) {
			env.log('fatal', e);
			return;
		}
	}

	// For sub-pipeline documents, we are done.
	// For the top-level document, we generate <head> and add it.
	if (this.atTopLevel) {
		this.addMetaData(document);
	}

	this.emit('document', document);
};

/**
 * Register for the 'document' event, normally emitted from the HTML5 tree
 * builder.
 */
DOMPostProcessor.prototype.addListenersOn = function(emitter) {
	emitter.addListener('document', this.doPostProcess.bind(this));
};

if (typeof module === "object") {
	module.exports.DOMPostProcessor = DOMPostProcessor;
}
