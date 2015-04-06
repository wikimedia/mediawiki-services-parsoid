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

function ExtensionHandler( manager, options ) {
	TemplateHandler.apply( this, arguments );
}

// Inherit from TemplateHandler to get access to all the nifty functions there
// (code reuse inheritance -- maybe better to refactor the common code out to
// a helper class and use that in both Template and Extension handlers)
coreutil.inherits(ExtensionHandler, TemplateHandler);

ExtensionHandler.prototype.rank = 1.11;

ExtensionHandler.prototype.register = function() {
	this.usePHPPreProcessor = this.env.conf.parsoid.usePHPPreProcessor &&
		(this.env.conf.parsoid.apiURI !== null);

	// Native extension handlers
	var nativeExts = this.env.conf.parsoid.nativeExtensions,
		ref = nativeExts.cite.ref,
		references = nativeExts.cite.references;

	this.nativeExtHandlers = {
		"ref": ref.handleRef.bind(ref, this.manager, this.options),
		"references": references.handleReferences.bind(references, this.manager, this.options)
	};

	// Extension content expansion
	this.manager.addTransform( this.onExtension.bind(this),
		"ExtensionHandler:onExtension", this.rank, 'tag', 'extension' );
};

/**
 * Get the public data-mw structure that exposes the extension name, args, and body
 */
ExtensionHandler.prototype.getArgInfo = function(state) {
	var extToken = state.token,
		extName = state.token.getAttribute("name"),
		extSrc = state.token.getAttribute("source");

	return {
		dict: {
			name: extName,
			attrs: Util.KVtoHash(extToken.getAttribute("options"), true),
			body: { extsrc: Util.extractExtBody(extName, extSrc) }
		}
	};
};

/**
 * Parse the extension HTML content and wrap it in a DOMFragment
 * to be expanded back into the top-level DOM later.
 */
ExtensionHandler.prototype.parseExtensionHTML = function(extToken, cb, err, html) {
	// document -> html -> body -> children
	var doc = DU.parseHTML(html),
		state = { token: extToken };

	// We are always wrapping extensions with the DOMFragment mechanism.
	state.wrapperType = 'mw:Extension/' + extToken.getAttribute('name');
	state.wrappedObjectId = this.env.newObjectId();

	// DOMFragment-based encapsulation.
	this._onDocument(state, cb, doc);
};

/**
 * Fetch the preprocessed wikitext for an extension
 */
ExtensionHandler.prototype.fetchExpandedExtension = function( title, text, parentCB, cb ) {
	var env = this.env;
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

function normalizeExtOptions(options) {
	// Mimics Sanitizer::decodeTagAttributes from the PHP parser
	//
	// Extension options should always be interpreted as plain text. The
	// tokenizer parses them to tokens in case they are for an HTML tag,
	// but here we use the text source instead.
	for (var i = 0, n = options.length; i < n; i++) {
		var o = options[i], v;
		if (!o.v && !o.vsrc) {
			continue;
		}

		// Use the source if present. If not use the value, but ensure it's a
		// string, as it can be a token stream if the parser has recognized it
		// as a directive.
		v = o.vsrc || ((o.v.constructor === String) ? o.v : Util.tokensToString(o.v));
		// Normalize whitespace in extension attribute values
		o.v = v.trim().replace(/(\s+)/g, ' ');
	}
	return options;
}

ExtensionHandler.prototype.onExtension = function( token, frame, cb ) {
	var env = this.env,
		extensionName = token.getAttribute('name'),
		nativeHandler = this.nativeExtHandlers[extensionName],
		// TODO: use something order/quoting etc independent instead of src
		cacheKey = token.dataAttribs.src,
		cachedExpansion = env.extensionCache[cacheKey];

	if ( nativeHandler ) {
		// No caching for native extensions for now.
		token.setAttribute('options', normalizeExtOptions(token.getAttribute('options')));
		nativeHandler(token, cb);
	} else if ( cachedExpansion ) {
		//console.log('cache hit for', JSON.stringify(cacheKey.substr(0, 50)));
		// cache hit. Reuse extension expansion.
		var toks = DU.encapsulateExpansionHTML(env, token, cachedExpansion, { setDSR: true });
		cb({ tokens: toks });
	} else if ( env.conf.parsoid.expandExtensions && env.conf.parsoid.usePHPPreProcessor ) {
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
