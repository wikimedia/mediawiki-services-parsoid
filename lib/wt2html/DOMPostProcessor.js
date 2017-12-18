/* Perform post-processing steps on an already-built HTML DOM. */

'use strict';

require('../../core-upgrade');

var domino = require('domino');
var events = require('events');
var url = require('url');
var util = require('util');

var DU = require('../utils/DOMUtils.js').DOMUtils;
var DOMTraverser = require('../utils/DOMTraverser.js').DOMTraverser;
var Promise = require('../utils/promise.js');

// processors
var requireProcessor = function(p) {
	return require('./pp/processors/' + p + '.js')[p];
};
var markFosteredContent = requireProcessor('markFosteredContent');
var handleUnbalancedTables = requireProcessor('handleUnbalancedTables');
var linter = requireProcessor('linter');
var markTreeBuilderFixups = requireProcessor('markTreeBuilderFixups');
var normalize = requireProcessor('normalize');
var cleanupFormattingTagFixup = requireProcessor('cleanupFormattingTagFixup');
var migrateTemplateMarkerMetas = requireProcessor('migrateTemplateMarkerMetas');
var handlePres = requireProcessor('handlePres');
var migrateTrailingNLs = requireProcessor('migrateTrailingNLs');
var computeDSR = requireProcessor('computeDSR');
var wrapTemplates = requireProcessor('wrapTemplates');
var wrapSections = requireProcessor('wrapSections');

// handlers
var requireHandlers = function(file) {
	return require('./pp/handlers/' + file + '.js');
};

var CleanUp = requireHandlers('cleanup');
var headings = requireHandlers('headings');
var unpackDOMFragments = requireHandlers('unpackDOMFragments').unpackDOMFragments;
var TableFixups = requireHandlers('tableFixups').TableFixups;
var handleLinkNeighbours = requireHandlers('handleLinkNeighbours').handleLinkNeighbours;
var liFixups = requireHandlers('liFixups');

// map from mediawiki metadata names to RDFa property names
var metadataMap = {
	ns: {
		property: 'mw:pageNamespace',
		content: '%d',
	},
	id: {
		property: 'mw:pageId',
		content: '%d',
	},

	// DO NOT ADD rev_user, rev_userid, and rev_comment (See T125266)

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
	throw 'Your DOM version appears to be out of date! \n' +
			'Please run npm update in the js directory.';
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
	this.seenIds = new Set();

	/* ---------------------------------------------------------------------------
	 * FIXME:
	 * 1. PipelineFactory caches pipelines per env
	 * 2. PipelineFactory.parse uses a default cache key
	 * 3. ParserTests uses a shared/global env object for all tests.
	 * 4. ParserTests also uses PipelineFactory.parse (via env.getContentHandler())
	 *    => the pipeline constructed for the first test that runs wt2html
	 *       is used for all subsequent wt2html tests
	 * 5. If we are selectively turning on/off options on a per-test basis
	 *    in parser tests, those options won't work if those options are
	 *    also used to configure pipeline construction (including which DOM passes
	 *    are enabled).
	 *
	 *    Ex: if (env.wrapSections) { addPP('wrapSections', wrapSections); }
	 *
	 *    This won't do what you expect it to do. This is primarily a
	 *    parser tests script issue -- but given the abstraction layers that
	 *    are on top of the parser pipeline construction, fixing that is
	 *    not straightforward right now. So, this note is a warning to future
	 *    developers to pay attention to how they construct pipelines.
	 * --------------------------------------------------------------------------- */

	this.processors = [];
	var self = this;
	var addPP = function(name, proc) {
		self.processors.push({
			name: name,
			proc: proc,
		});
	};

	// DOM traverser that runs before the in-order DOM handlers.
	var dataParsoidLoader = new DOMTraverser(env);
	dataParsoidLoader.addHandler(null, this.prepareDOM.bind(this));

	// Common post processing
	addPP('dpLoader', dataParsoidLoader.traverse.bind(dataParsoidLoader));
	addPP('markFosteredContent', markFosteredContent);
	addPP('handleUnbalancedTables', handleUnbalancedTables);
	addPP('markTreeBuilderFixups', markTreeBuilderFixups);
	addPP('normalize', normalize);
	addPP('cleanupFormattingTagFixup', cleanupFormattingTagFixup);
	// Run this after 'markTreeBuilderFixups' because the mw:StartTag
	// and mw:EndTag metas would otherwise interfere with the
	// firstChild/lastChild check that this pass does.
	addPP('migrateTemplateMarkerMetas', migrateTemplateMarkerMetas);
	addPP('handlePres', handlePres);
	addPP('migrateTrailingNLs', migrateTrailingNLs);

	if (options.wrapTemplates && !options.inTemplate) {
		// dsr computation and tpl encap are only relevant
		// for top-level content that is not wrapped in an extension
		addPP('computeDSR', computeDSR);
		addPP('wrapTemplates', wrapTemplates);
	}

	// 1. Link prefixes and suffixes
	// 2. Unpack DOM fragments (reused transclusion and extension content)
	var domVisitor = new DOMTraverser(env);
	domVisitor.addHandler('a', handleLinkNeighbours);
	domVisitor.addHandler(null, unpackDOMFragments);
	addPP('linkNbrs+unpackDOMFragments', domVisitor.traverse.bind(domVisitor));

	// A pure DOM transformation
	env.conf.wiki.extensionPostProcessors.forEach(function(extPP) {
		addPP(extPP.name, extPP.proc);
	});

	// Strip empty elements from template content
	domVisitor = new DOMTraverser(env);
	domVisitor.addHandler(null, CleanUp.handleEmptyElements);
	addPP('handleEmptyElts', domVisitor.traverse.bind(domVisitor));

	domVisitor = new DOMTraverser(env);
	var tableFixer = new TableFixups(env);
	// 1. Deal with <li>-hack and move trailing categories in <li>s out of the list
	domVisitor.addHandler('li', liFixups.handleLIHack);
	domVisitor.addHandler('li', liFixups.migrateTrailingCategories);
	// 2. Fix up issues from templated table cells and table cell attributes
	domVisitor.addHandler('td', tableFixer.stripDoubleTDs.bind(tableFixer));
	domVisitor.addHandler('td', tableFixer.handleTableCellTemplates.bind(tableFixer));
	domVisitor.addHandler('th', tableFixer.handleTableCellTemplates.bind(tableFixer));
	// 3. Add heading anchors
	domVisitor.addHandler(null, headings.genAnchors);
	addPP('(li+table)Fixups+headings', domVisitor.traverse.bind(domVisitor));

	// Add <section> wrappers around sections
	addPP('wrapSections', wrapSections);

	// Make heading IDs unique
	domVisitor = new DOMTraverser(env);
	domVisitor.addHandler(null, function(node, env) {
		// NOTE: This is not completely compliant with how PHP parser does it.
		// If there is an id in the doc elsewhere, this will assign
		// the heading a suffixed id, whereas the PHP parser processes
		// headings in textual order and can introduce duplicate ids
		// in a document in the process.
		//
		// However, we believe this implemention behavior is more
		// consistent when handling this edge case, and in the common
		// case (where heading ids won't conflict with ids elsewhere),
		// matches PHP parser behavior.
		if (!node.hasAttribute) { return true; /* not an Element */ }
		if (!node.hasAttribute('id')) { return true; }
		// Must be case-insensitively unique (T12721)
		// ...but note that PHP uses strtolower, which only does A-Z :(
		var key = node.getAttribute('id');
		key = key.replace(/[A-Z]+/g, function(s) { return s.toLowerCase(); });
		if (!self.seenIds.has(key)) {
			self.seenIds.add(key);
			return true;
		}
		// Only update headings and legacy links (first children of heading)
		if (
			/^H\d$/.test(node.nodeName) ||
			node.getAttribute('typeof') === 'mw:FallbackId'
		) {
			var suffix = 2;
			while (self.seenIds.has(key + '_' + suffix)) {
				suffix++;
			}
			node.setAttribute('id', node.getAttribute('id') + '_' + suffix);
			self.seenIds.add(key + '_' + suffix);
		}
		return true;
	});
	addPP('heading id uniqueness', domVisitor.traverse.bind(domVisitor));

	if (env.conf.parsoid.linting) {
		addPP('linter', linter);
	}

	// Save data.parsoid into data-parsoid html attribute.
	// Make this its own thing so that any changes to the DOM
	// don't affect other handlers that run alongside it.
	domVisitor = new DOMTraverser(env);
	// Strip marker metas -- removes left over marker metas (ex: metas
	// nested in expanded tpl/extension output).
	domVisitor.addHandler('meta', CleanUp.stripMarkerMetas.bind(null, env.conf.parsoid.rtTestMode));
	domVisitor.addHandler(null, CleanUp.cleanupAndSaveDataParsoid);
	addPP('stripMarkerMetas+cleanupAndSaveDP', domVisitor.traverse.bind(domVisitor));

	// (Optional) red links
	addPP('addRedLinks', function(rootNode, env, options, atTopLevel) {
		if (atTopLevel && env.conf.parsoid.useBatchAPI) {
			// Async; returns promise for completion.
			return DU.addRedLinks(env, rootNode.ownerDocument);
		}
	});
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
	this.env.page.meta.displayTitle = null;
	this.seenIds.clear();
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
			env.page.meta.displayTitle = node.getAttribute("content");
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
					env.log("warn", "prepareDOM: Dropped invalid attribute",
						attr.nodeName);
				}
			});
			node.parentNode.replaceChild(meta, node);
			return meta;
		}

	}
	return true;
};

// FIXME: consider moving to DOMUtils or MWParserEnvironment.
DOMPostProcessor.addMetaData = function(env, document) {
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

	// Normalize before comparison
	if (env.conf.wiki.mainpage.replace(/_/g, ' ') === env.page.name.replace(/_/g, ' ')) {
		appendToHead(document, 'meta', {
			'property': 'isMainPage',
			'content': true,
		});
	}

	// Set the parsoid content-type strings
	appendToHead(document, 'meta', {
		'property': 'mw:html:version',
		'content': env.contentVersion,
	});
	var wikiPageUrl = env.conf.wiki.baseURI +
		env.page.name.split('/').map(encodeURIComponent).join('/');
	appendToHead(document, 'link',
		{ rel: 'dc:isVersionOf', href: wikiPageUrl });

	document.title = env.page.meta.displayTitle || env.page.meta.title || '';

	// Add base href pointing to the wiki root
	appendToHead(document, 'base', { href: env.conf.wiki.baseURI });

	// Hack: link styles
	var modules = new Set([
		'mediawiki.legacy.commonPrint,shared',
		'mediawiki.skinning.content.parsoid',
		'mediawiki.skinning.interface',
		'skins.vector.styles',
		'site.styles',
	]);
	// Styles from native extensions
	env.conf.wiki.extensionStyles.forEach(function(mo) {
		modules.add(mo);
	});
	// Styles from modules returned from preprocessor / parse requests
	if (env.page.extensionModuleStyles) {
		env.page.extensionModuleStyles.forEach(function(mo) {
			modules.add(mo);
		});
	}
	var styleURI = env.getModulesLoadURI() +
		'?modules=' + encodeURIComponent(Array.from(modules).join('|')) + '&only=styles&skin=vector';
	appendToHead(document, 'link', { rel: 'stylesheet', href: styleURI });

	// Stick data attributes in the head
	if (env.pageBundle) {
		DU.injectPageBundle(document, DU.getDataParsoid(document).pagebundle);
	}

	// html5shiv
	var shiv = document.createElement('script');
	var src =  env.getModulesLoadURI() + '?modules=html5shiv&only=scripts&skin=vector&sync=1';
	shiv.setAttribute('src', src);
	var fi = document.createElement('script');
	fi.appendChild(document.createTextNode('html5.addElements(\'figure-inline\');'));
	var comment = document.createComment(
		'[if lt IE 9]>' + shiv.outerHTML + fi.outerHTML + '<![endif]'
	);
	document.head.appendChild(comment);

	// Indicate language & directionality on body
	var lang = env.page.pagelanguage || env.conf.wiki.lang || 'en';
	var dir = env.page.pagelanguagedir || (env.conf.wiki.rtl ? "rtl" : "ltr");
	document.body.setAttribute('lang', DU.bcp47(lang));
	document.body.classList.add('mw-content-' + dir);
	document.body.classList.add('sitedir-' + dir);
	document.body.classList.add(dir);
	document.body.setAttribute('dir', dir);

	// Set 'mw-body-content' directly on the body.
	// This is the designated successor for #bodyContent in core skins.
	document.body.classList.add('mw-body-content');
	// Set 'parsoid-body' to add the desired layout styling from Vector.
	document.body.classList.add('parsoid-body');
	// Also, add the 'mediawiki' class.
	// Some Mediawiki:Common.css seem to target this selector.
	document.body.classList.add('mediawiki');
	// Set 'mw-parser-output' directly on the body.
	// Templates target this class as part of the TemplateStyles RFC
	document.body.classList.add('mw-parser-output');
};

DOMPostProcessor.prototype.doPostProcess = Promise.async(function *(document) {
	var env = this.env;

	var psd = env.conf.parsoid;
	if (psd.dumpFlags && psd.dumpFlags.has("dom:post-builder")) {
		DU.dumpDOM(document.body, 'DOM: after tree builder');
	}

	var tracePP = psd.traceFlags && (psd.traceFlags.has("time/dompp") || psd.traceFlags.has("time"));

	// Holder for data-* attributes
	if (this.atTopLevel && env.pageBundle) {
		DU.setDataParsoid(document, {
			pagebundle: {
				parsoid: { counter: -1, ids: {} },
				mw: { ids: {} },
			},
		});
	}

	var startTime, endTime, prefix, logLevel, resourceCategory;
	if (tracePP) {
		if (this.atTopLevel) {
			prefix = "TOP";
			// Turn off DOM pass timing tracing on non-top-level documents
			logLevel = "trace/time/dompp";
			resourceCategory = "DOMPasses:TOP";
		} else {
			prefix = "---";
			logLevel = "debug/time/dompp";
			resourceCategory = "DOMPasses:NESTED";
		}
		startTime = Date.now();
		env.log(logLevel, prefix + "; start=" + startTime);
	}
	for (var i = 0; i < this.processors.length; i++) {
		var pp = this.processors[i];
		try {
			var ppStart, ppEnd, ppName;
			if (tracePP) {
				ppName = pp.name + ' '.repeat(pp.name.length < 30 ? 30 - pp.name.length : 0);
				ppStart = Date.now();
				env.log(logLevel, prefix + "; " + ppName + " start");
			}
			// Processors can return a Promise iff they need to be async.
			yield pp.proc(document.body, env, this.options, this.atTopLevel);
			if (tracePP) {
				ppEnd = Date.now();
				env.log(logLevel, prefix + "; " + ppName + " end; time = " + (ppEnd - ppStart));
				env.bumpTimeUse(resourceCategory, (ppEnd - ppStart));
			}
		} catch (e) {
			env.log('fatal', e);
			return;
		}
	}
	if (tracePP) {
		endTime = Date.now();
		env.log(logLevel, prefix + "; end=" + endTime + "; time = " + (endTime - startTime));
	}

	// For sub-pipeline documents, we are done.
	// For the top-level document, we generate <head> and add it.
	if (this.atTopLevel) {
		DOMPostProcessor.addMetaData(env, document);
		if (psd.traceFlags && psd.traceFlags.has('time')) {
			env.printTimeProfile();
		}
		if (psd.dumpFlags && psd.dumpFlags.has('wt2html:limits')) {
			env.printParserResourceUsage({ 'HTML Size': document.outerHTML.length });
		}
	}

	this.emit('document', document);
});

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
