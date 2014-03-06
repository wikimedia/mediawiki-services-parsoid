"use strict";

var TemplateHandler = require('./ext.core.TemplateHandler.js').TemplateHandler,
	coreutil = require('util'),
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	PHPParseRequest = require('./mediawiki.ApiRequest.js').PHPParseRequest,
	defines = require('./mediawiki.parser.defines.js');
// define some constructor shortcuts
var KV = defines.KV,
    TagTk = defines.TagTk,
    EndTagTk = defines.EndTagTk;

function ExtensionHandler(manager, options) {
	this.manager = manager;
	this.options = options;
	this.usePHPPreProcessor = manager.env.conf.parsoid.usePHPPreProcessor &&
			(manager.env.conf.parsoid.apiURI !== null);

	// Native extension handlers
	var nativeExts = manager.env.conf.parsoid.nativeExtensions,
		ref = nativeExts.cite.ref,
	    references = nativeExts.cite.references;

	this.nativeExtHandlers = {
		"ref": ref.handleRef.bind(ref, manager, options),
		"references": references.handleReferences.bind(references, manager, options)
	};

	// Extension content expansion
	manager.addTransform( this.onExtension.bind(this), "ExtensionHandler:onExtension",
			this.rank, 'tag', 'extension' );
}

// Inherit from TemplateHandler to get access to all the nifty functions there
// (code reuse inheritance -- maybe better to refactor the common code out to
// a helper class and use that in both Template and Extension handlers)
coreutil.inherits(ExtensionHandler, TemplateHandler);

ExtensionHandler.prototype.rank = 1.11;

/**
 * Get the public data-mw structure that exposes the extension name, args, and body
 */
ExtensionHandler.prototype.getArgInfo = function (state) {
	var extToken = state.token,
		extName = state.token.getAttribute("name"),
		extSrc = state.token.getAttribute("source");

	return {
		dict: {
			name: extName,
			attrs: Util.KVtoHash(extToken.getAttribute("options")),
			body: { extsrc: Util.extractExtBody(extName, extSrc) }
		}
	};
};

/**
 * Parse the extension HTML content.
 *
 * TODO gwicke: Use DOMFragment instead of converting back to tokens for
 * template content. For this, we'll have to add the extension-specific
 * encapsulation directly on the DOM before wrapping it.
 */
ExtensionHandler.prototype.parseExtensionHTML = function(extToken, cb, err, html) {
	// document -> html -> body -> children
	var doc = DU.parseHTML(html),
		topNodes = doc.body.childNodes,
		toks = [];

	var state = { token: extToken };

	// We are always wrapping extensions with the DOMFragment mechanism.
	state.wrapperType = 'mw:Extension/' + extToken.getAttribute('name');
	state.wrappedObjectId = this.manager.env.newObjectId();
	// DOMFragment-based encapsulation.
	this._onDocument(state, cb, doc);
};

/**
 * Fetch the preprocessed wikitext for an extension
 */
ExtensionHandler.prototype.fetchExpandedExtension = function ( title, text, parentCB, cb ) {
	var env = this.manager.env;
	// We are about to start an async request for an extension
	env.dp( 'Note: trying to expand ', text );

	// Start a new request if none is outstanding
	//env.dp( 'requestQueue: ', env.requestQueue );
	if ( env.requestQueue[text] === undefined ) {
		env.tp( 'Note: Starting new request for ' + text );
		env.requestQueue[text] = new PHPParseRequest( env, title, text );
	}
	// append request, process in document order
	env.requestQueue[text].once( 'src', cb );

	parentCB ( { async: true } );
};

ExtensionHandler.prototype.onExtension = function ( token, frame, cb ) {
	function normalizeExtOptions(options) {
		// Normalize whitespace in extension attribute values
		// Mimics Sanitizer::decodeTagAttributes from the PHP parser
		//
		// Expects all values to have been fully expanded to string
		for (var i = 0, n = options.length; i < n; i++) {
			var o = options[i];
			// SSS FIXME: This wont normalize options in all cases.
			if (o.v.constructor === String) {
				o.v = o.v.trim().replace(/(\s+)/g, ' ');
			}
		}
		return options;
	}

	var env = this.manager.env,
		extensionName = token.getAttribute('name'),
	    nativeHandler = this.nativeExtHandlers[extensionName],
		// TODO: use something order/quoting etc independent instead of src
		cacheKey = token.dataAttribs.src,
		cachedExpansion = env.extensionCache[cacheKey];
	if ( nativeHandler ) {
		// No caching for native extensions for now.
		token.setAttribute('options', normalizeExtOptions(token.getAttribute('options')));

		// SSS FIXME: We seem to have a problem on our hands here.
		//
		// AttributeExpander runs after ExtensionHandler which means
		// the native handlers will not receive fully expanded tokens.
		//
		// In the case of Cite.ref and Cite.references, this is not an issue
		// since the final processing takes place in the DOM PP phase,
		// by which time the marker tokens would have had everything expanded.
		// But, this may not be true for other exensions.
		//
		// So, we wont be able to robustly support templated ext. attributes
		// without a fix for this since attribute values might be ext-generated
		// and ext-attribute values might be templated.
		//
		// The fix might require breaking this cycle by expliclitly-expanding
		// ext-attribute-values here in a new pipeline.  TO BE DONE.

		nativeHandler(token, cb);
	} else if ( cachedExpansion ) {
		//console.log('cache hit for', JSON.stringify(cacheKey.substr(0, 50)));
		// cache hit. Reuse extension expansion.
		var toks = DU.encapsulateExpansionHTML(env, token, cachedExpansion, { setDSR: true} );
		cb({ tokens: toks });
	} else if ( env.conf.parsoid.expandExtensions &&
			env.conf.parsoid.usePHPPreProcessor )
	{
		// Use MediaWiki's action=parse preprocessor
		this.fetchExpandedExtension(
			extensionName,
			token.getAttribute('source'),
			cb,
			this.parseExtensionHTML.bind(this, token, cb)
		);
	} else {
		/* Convert this into a span with extension content as plain text */
		var span = new TagTk('span', [
					new KV('typeof', 'mw:Extension/' + extensionName),
					new KV('about', token.getAttribute('about'))
				], token.dataAttribs);

		cb({ tokens: [span, token.getAttribute('source'), new EndTagTk('span')] });
	}
};

if (typeof module === "object") {
	module.exports.ExtensionHandler = ExtensionHandler;
}
