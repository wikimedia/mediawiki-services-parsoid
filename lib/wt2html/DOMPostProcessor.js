/**
 * Perform post-processing steps on an already-built HTML DOM.
 * @module
 */

'use strict';

require('../../core-upgrade');

var domino = require('domino');
var events = require('events');
var url = require('url');
var util = require('util');
var semver = require('semver');
var fs = require('fs');

var ContentUtils = require('../utils/ContentUtils.js').ContentUtils;
var DOMDataUtils = require('../utils/DOMDataUtils.js').DOMDataUtils;
var Util = require('../utils/Util.js').Util;
var DOMTraverser = require('../utils/DOMTraverser.js').DOMTraverser;
var LanguageConverter = require('../language/LanguageConverter').LanguageConverter;
var Promise = require('../utils/promise.js');
var JSUtils = require('../utils/jsutils.js').JSUtils;

// processors
var requireProcessor = function(p, className) {
	return require('./pp/processors/' + p + '.js')[className || p];
};
var MarkFosteredContent = requireProcessor('markFosteredContent', 'MarkFosteredContent');
var linter = requireProcessor('linter');
var ProcessTreeBuilderFixups = requireProcessor('processTreeBuilderFixups', 'ProcessTreeBuilderFixups');
var MigrateTemplateMarkerMetas = requireProcessor('migrateTemplateMarkerMetas', 'MigrateTemplateMarkerMetas');
var HandlePres = requireProcessor('handlePres', 'HandlePres');
var MigrateTrailingNLs = requireProcessor('migrateTrailingNLs', 'MigrateTrailingNLs');
var ComputeDSR = requireProcessor('computeDSR', 'ComputeDSR');
var WrapTemplates = requireProcessor('wrapTemplates', 'WrapTemplates');
var WrapSections = requireProcessor('wrapSections', 'WrapSections');
var AddExtLinkClasses = requireProcessor('addExtLinkClasses', 'AddExtLinkClasses');
var PWrap = requireProcessor('pwrap', 'PWrap');

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
var dedupeStyles = requireHandlers('deduplicateStyles');
var prepareDOM = requireHandlers('prepareDOM');

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
	DOMDataUtils.addAttributes(elt, attrs || Object.create(null));
	document.head.appendChild(elt);
}

/**
 * @class
 * @extends EventEmitter
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
	var addPP = (name, shortcut, proc, skipNested) => {
		this.processors.push({
			name: name,
			shortcut: shortcut || name,
			proc: proc,
			skipNested: skipNested,
		});
	};

	// DOM traverser that runs before the in-order DOM handlers.
	var dataParsoidLoader = new DOMTraverser(env);
	dataParsoidLoader.addHandler(null, prepareDOM.prepareDOM);

	// Common post processing
	addPP('dpLoader', 'dpload',
		(node, env, opts, atTopLevel) => dataParsoidLoader.traverse(node, env, opts, atTopLevel)
	);
	addPP('MarkFosteredContent', 'fostered', (...args) => (new MarkFosteredContent()).run(...args));
	addPP('ProcessTreeBuilderFixups', 'process-fixups', (...args) => (new ProcessTreeBuilderFixups()).run(...args));
	addPP('normalize', null, (body) => { body.normalize(); });
	addPP('PWrap', 'pwrap', (...args) => (new PWrap()).run(...args), true);

	// Run this after 'ProcessTreeBuilderFixups' because the mw:StartTag
	// and mw:EndTag metas would otherwise interfere with the
	// firstChild/lastChild check that this pass does.
	addPP('migrateTemplateMarkerMetas', 'migrate-metas', (...args) => (new MigrateTemplateMarkerMetas()).run(...args));
	addPP('HandlePres', 'pres', (...args) => (new HandlePres()).run(...args));
	addPP('MigrateTrailingNLs', 'migrate-nls', (...args) => (new MigrateTrailingNLs()).run(...args));

	if (!options.inTemplate) {
		// dsr computation and tpl encap are only relevant for top-level content
		addPP('ComputeDSR', 'dsr', (...args) => (new ComputeDSR()).run(...args));
		addPP('WrapTemplates', 'tplwrap', (...args) => (new WrapTemplates()).run(...args));
	}

	// 1. Link prefixes and suffixes
	// 2. Unpack DOM fragments
	// FIXME: Picked a terse 'v' varname instead of trying to find
	// a suitable name that addresses both functions above.
	const v = new DOMTraverser(env);
	v.addHandler('a', handleLinkNeighbours);
	v.addHandler(null, unpackDOMFragments);
	addPP('linkNbrs+unpackDOMFragments', 'dom-unpack',
		(node, env, opts, atTopLevel) => v.traverse(node, env, opts, atTopLevel)
	);

	// FIXME: There are two potential ordering problems here.
	//
	// 1. unpackDOMFragment should always run immediately
	//    before these extensionPostProcessors, which we do currently.
	//    This ensures packed content get processed correctly by extensions
	//    before additional transformations are run on the DOM.
	//
	// This ordering issue is handled through documentation.
	//
	// 2. This has existed all along (in the PHP parser as well as Parsoid
	//    which is probably how the ref-in-ref hack works - because of how
	//    parser functions and extension tags are procesed, #tag:ref doesn't
	//    see a nested ref anymore) and this patch only exposes that problem
	//    more clearly with the unwrapFragments property.
	//
	// * Consider the set of extensions that
	//   (a) process wikitext
	//   (b) provide an extensionPostProcessor
	//   (c) run the extensionPostProcessor only on the top-level
	//   As of today, there is exactly one extension (Cite) that has all
	//   these properties, so the problem below is a speculative problem
	//   for today. But, this could potentially be a problem in the future.
	//
	// * Let us say there are at least two of them, E1 and E2 that
	//   support extension tags <e1> and <e2> respectively.
	//
	// * Let us say in an instance of <e1> on the page, <e2> is present
	//   and in another instance of <e2> on the page, <e1> is present.
	//
	// * In what order should E1's and E2's extensionPostProcessors be
	//   run on the top-level? Depending on what these handlers do, you
	//   could get potentially different results. You can see this quite
	//   starkly with the unwrapFragments flag.
	//
	// * The ideal solution to this problem is to require that every extension's
	//   extensionPostProcessor be idempotent which lets us run these
	//   post processors repeatedly till the DOM stabilizes. But, this
	//   still doesn't necessarily guarantee that ordering doesn't matter.
	//   It just guarantees that with the unwrapFragments flag set on
	//   multiple extensions, all sealed fragments get fully processed.
	//   So, we still need to worry about that problem.
	//
	//   But, idempotence *could* potentially be a sufficient property in most cases.
	//   To see this, consider that there is a Footnotes extension which is similar
	//   to the Cite extension in that they both extract inline content in the
	//   page source to a separate section of output and leave behind pointers to
	//   the global section in the output DOM. Given this, the Cite and Footnote
	//   extension post processors would essentially walk the dom and
	//   move any existing inline content into that global section till it is
	//   done. So, even if a <footnote> has a <ref> and a <ref> has a <footnote>,
	//   we ultimately end up with all footnote content in the footnotes section
	//   and all ref content in the references section and the DOM stabilizes.
	//   Ordering is irrelevant here.
	//
	//   So, perhaps one way of catching these problems would be in code review
	//   by analyzing what the DOM postprocessor does and see if it introduces
	//   potential ordering issues.

	env.conf.wiki.extConfig.domProcessors.forEach(function(extProcs) {
		addPP('tag:' + extProcs.extName, null, extProcs.procs.wt2htmlPostProcessor);
	});

	const fixupsVisitor = new DOMTraverser(env);
	// 1. Deal with <li>-hack and move trailing categories in <li>s out of the list
	fixupsVisitor.addHandler('li', liFixups.handleLIHack);
	fixupsVisitor.addHandler('li', liFixups.migrateTrailingCategories);
	fixupsVisitor.addHandler('dt', liFixups.migrateTrailingCategories);
	fixupsVisitor.addHandler('dd', liFixups.migrateTrailingCategories);
	// 2. Fix up issues from templated table cells and table cell attributes
	const tableFixer = new TableFixups(env);
	fixupsVisitor.addHandler('td', (node, env) => tableFixer.stripDoubleTDs(node, env));
	fixupsVisitor.addHandler('td', (node, env) => tableFixer.handleTableCellTemplates(node, env));
	fixupsVisitor.addHandler('th', (node, env) => tableFixer.handleTableCellTemplates(node, env));
	// 3. Add heading anchors
	fixupsVisitor.addHandler(null, headings.genAnchors);
	// 4. Deduplicate template styles
	//   (should run after dom-fragment expansion + after extension post-processors)
	fixupsVisitor.addHandler('style', dedupeStyles.dedupe);
	addPP('(li+table)Fixups+headings', 'fixups',
		(node, env, opts, atTopLevel) => fixupsVisitor.traverse(node, env, opts, atTopLevel),
		true
	);

	// Add <section> wrappers around sections
	addPP('WrapSections', 'sections', (...args) => (new WrapSections()).run(...args), true);

	// Make heading IDs unique
	const headingVisitor = new DOMTraverser(env);
	headingVisitor.addHandler(null, (node, env) => headings.dedupeHeadingIds(this.seenIds, node, env));
	addPP('heading id uniqueness', 'heading-ids',
		(node, env, opts, atTopLevel) => headingVisitor.traverse(node, env, opts, atTopLevel),
		true
	);

	// Language conversion
	addPP('LanguageConverter', 'lang-converter', (rootNode, env, options) => {
		LanguageConverter.maybeConvert(
			env, rootNode.ownerDocument,
			env.htmlVariantLanguage, env.wtVariantLanguage
		);
	}, true /* skipNested */);

	if (env.conf.parsoid.linting) {
		addPP('linter', null, linter, true);
	}

	// Strip marker metas -- removes left over marker metas (ex: metas
	// nested in expanded tpl/extension output).
	const markerMetasVisitor = new DOMTraverser(env);
	markerMetasVisitor.addHandler('meta', CleanUp.stripMarkerMetas);
	addPP('stripMarkerMetas', 'strip-metas',
		(node, env, opts, atTopLevel) => markerMetasVisitor.traverse(node, env, opts, atTopLevel)
	);

	const cleanupVisitor = new DOMTraverser(env);
	// Strip empty elements from template content
	cleanupVisitor.addHandler(null, CleanUp.handleEmptyElements);
	// Save data.parsoid into data-parsoid html attribute.
	// Make this its own thing so that any changes to the DOM
	// don't affect other handlers that run alongside it.
	cleanupVisitor.addHandler(null, CleanUp.cleanupAndSaveDataParsoid);
	addPP('handleEmptyElts+cleanupAndSaveDP', 'cleanup',
		(node, env, opts, atTopLevel) => cleanupVisitor.traverse(node, env, opts, atTopLevel)
	);

	addPP('AddExtLinkClasses', 'linkclasses', (...args) => (new AddExtLinkClasses()).run(...args), true);
	// (Optional) red links
	addPP('addRedLinks', 'redlinks', function(rootNode, env, options) {
		if (env.conf.parsoid.useBatchAPI) {
			// Async; returns promise for completion.
			return ContentUtils.addRedLinks(env, rootNode.ownerDocument);
		}
	}, true);

	// (Optional) downgrade
	addPP('downgrade2to1', 'downgrade', function(rootNode, env, options) {
		if (semver.lt(env.outputContentVersion, '2.0.0')) {
			return ContentUtils.replaceAudioWithVideo(rootNode.ownerDocument);
		}
	}, true);
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

// FIXME: consider moving to DOMUtils or MWParserEnvironment.
DOMPostProcessor.addMetaData = function(env, document) {
	// add <head> element if it was missing
	if (!document.head) {
		document.documentElement
			.insertBefore(document.createElement('head'), document.body);
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
	// FIXME: Should we be using http-equiv for this?
	appendToHead(document, 'meta', {
		'property': 'mw:html:version',
		'content': env.outputContentVersion,
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
	env.conf.wiki.extConfig.styles.forEach(function(mo) {
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
		DOMDataUtils.injectPageBundle(document, DOMDataUtils.getDataParsoid(document).pagebundle);
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

	var lang = env.page.pagelanguage || env.conf.wiki.lang || 'en';
	var dir = env.page.pagelanguagedir || (env.conf.wiki.rtl ? "rtl" : "ltr");

	// Indicate whether LanguageConverter is enabled, so that downstream
	// caches can split on variant (if necessary)
	appendToHead(document, 'meta', {
		'http-equiv': 'content-language',
		'content': env.htmlContentLanguage(),
	});
	appendToHead(document, 'meta', {
		'http-equiv': 'vary',
		'content': env.htmlVary(),
	});

	// Indicate language & directionality on body
	document.body.setAttribute('lang', Util.bcp47(lang));
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

function processDumpAndGentestFlags(psd, body, shortcut, opts, preOrPost) {
	// We don't support --dump & --genTest flags at the same time.
	// Only one or the other can be used and if both are present,
	// dumping takes precedence.
	if (psd.dumpFlags && psd.dumpFlags.has('dom:' + preOrPost + '-' + shortcut)) {
		ContentUtils.dumpDOM(body, 'DOM: ' + preOrPost + '-' + shortcut, opts);
	} else if (psd.generateFlags && psd.generateFlags.handlers) {
		opts.quiet = true;
		psd.generateFlags.handlers.forEach(function(handler) {
			if (handler === ('dom:' + shortcut)) {
				opts.outStream = fs.createWriteStream(psd.generateFlags.directory + psd.generateFlags.pageName + '-' + shortcut + '-' + preOrPost + '.txt');
				opts.dumpFragmentMap = psd.generateFlags.fragments;
				ContentUtils.dumpDOM(body, 'DOM: ' + preOrPost + '-' + shortcut, opts);
			}
		});
	}
}

DOMPostProcessor.prototype.doPostProcess = Promise.async(function *(document) {
	var env = this.env;

	var psd = env.conf.parsoid;
	if (psd.dumpFlags && psd.dumpFlags.has("dom:post-builder")) {
		ContentUtils.dumpDOM(document.body, 'DOM: after tree builder');
	}

	var tracePP = psd.traceFlags && (psd.traceFlags.has("time/dompp") || psd.traceFlags.has("time"));

	// Holder for data-* attributes
	if (this.atTopLevel && env.pageBundle) {
		DOMDataUtils.setDataParsoid(document, {
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
		startTime = JSUtils.startTime();
		env.log(logLevel, prefix + "; start=" + startTime);
	}

	if (this.atTopLevel && psd.generateFlags && psd.generateFlags.handlers) {
		// Pre-set data-parsoid.dsr for <body>
		// Useful for genTest mode for ComputeDSR tests
		//
		// NOTE: This runs immediately after tree building and before
		// dp-loader has run => we cannot use dom utils to set this on
		// the cached node.data.parsoid object.
		const bodyDP = DOMDataUtils.getJSONAttribute(document.body, 'data-parsoid', {});
		bodyDP.dsr = [0, env.page.src.length, 0, 0];
		DOMDataUtils.setJSONAttribute(document.body, 'data-parsoid', bodyDP);
	}

	for (var i = 0; i < this.processors.length; i++) {
		var pp = this.processors[i];
		if (pp.skipNested && !this.atTopLevel) {
			continue;
		}
		try {
			var body = document.body;

			// Trace
			var ppStart, ppElapsed, ppName;
			if (tracePP) {
				ppName = pp.name + ' '.repeat(pp.name.length < 30 ? 30 - pp.name.length : 0);
				ppStart = JSUtils.startTime();
				env.log(logLevel, prefix + "; " + ppName + " start");
			}
			var opts;
			if (this.atTopLevel) {
				opts = {
					env: env,
					dumpFragmentMap: true,
					outerHTML: true
				};
				processDumpAndGentestFlags(psd, body, pp.shortcut, opts, 'pre');
			}

			var ret = pp.proc(document.body, env, this.options, this.atTopLevel);
			if (ret) {
				// Processors can return a Promise iff they need to be async.
				yield ret;
			}

			if (this.atTopLevel) {
				processDumpAndGentestFlags(psd, body, pp.shortcut, opts, 'post');
			}
			if (tracePP) {
				ppElapsed = JSUtils.elapsedTime(ppStart);
				env.log(logLevel, prefix + "; " + ppName + " end; time = " + ppElapsed.toFixed(5));
				env.bumpTimeUse(resourceCategory, ppElapsed, 'DOM');
			}
		} catch (e) {
			env.log('fatal', e);
			return;
		}
	}
	if (tracePP) {
		endTime = JSUtils.startTime();
		env.log(logLevel, prefix + "; end=" + endTime.toFixed(5) + "; time = " + JSUtils.elapsedTime(startTime).toFixed(5));
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
	emitter.addListener('document', (document) => {
		this.doPostProcess(document).done();
	});
};

if (typeof module === "object") {
	module.exports.DOMPostProcessor = DOMPostProcessor;
}
