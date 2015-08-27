'use strict';

var TemplateHandler = require('./ext.core.TemplateHandler.js').TemplateHandler;
var coreutil = require('util');
var Util = require('./mediawiki.Util.js').Util;
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var defines = require('./mediawiki.parser.defines.js');

// define some constructor shortcuts
var KV = defines.KV;
var TagTk = defines.TagTk;
var EndTagTk = defines.EndTagTk;


/**
 * @class
 * @extends TemplateHandler
 * @constructor
 */
function ExtensionHandler(manager, options) {
	TemplateHandler.apply(this, arguments);
}

// Inherit from TemplateHandler to get access to all the nifty functions there
// (code reuse inheritance -- maybe better to refactor the common code out to
// a helper class and use that in both Template and Extension handlers)
coreutil.inherits(ExtensionHandler, TemplateHandler);

ExtensionHandler.prototype.rank = 1.11;

ExtensionHandler.prototype.register = function() {
	this.usePHPPreProcessor = this.env.conf.parsoid.usePHPPreProcessor &&
		(this.env.conf.wiki.apiURI !== null);

	// Native extension handlers
	var nativeExts = this.env.conf.parsoid.nativeExtensions;
	var ref = nativeExts.cite.ref;
	var references = nativeExts.cite.references;

	this.nativeExtHandlers = {
		"ref": ref.handleRef.bind(ref, this.manager, this.options),
		"references": references.handleReferences.bind(references, this.manager, this.options),
	};

	// Extension content expansion
	this.manager.addTransform(this.onExtension.bind(this),
		"ExtensionHandler:onExtension", this.rank, 'tag', 'extension');
};

/**
 * Get the public data-mw structure that exposes the extension name, args, and body
 */
ExtensionHandler.prototype.getArgInfo = function(state) {
	var extToken = state.token;
	var extName = state.token.getAttribute('name');
	var extSrc = state.token.getAttribute('source');
	return {
		dict: {
			name: extName,
			attrs: Util.KVtoHash(extToken.getAttribute('options'), true),
			body: { extsrc: Util.extractExtBody(extName, extSrc) },
		},
	};
};

/**
 * Parse the extension HTML content and wrap it in a DOMFragment
 * to be expanded back into the top-level DOM later.
 */
ExtensionHandler.prototype.parseExtensionHTML = function(extToken, cb, err, html) {
	var errType = '';
	var errObj = {};
	if (err) {
		html = '<span></span>';
		errType = 'mw:Error ';
		// Provide some info in data-mw in case some client can do something with it.
		errObj = {
			errors: [
				{
					key: 'mw-api-extparse-error',
					message: 'Could not parse extension source ' + extToken.getAttribute('source'),
				},
			],
		};
		this.env.log('error/extension', 'Error', err, ' parsing extension token: ',
			JSON.stringify(extToken));
	}

	// document -> html -> body -> children
	var doc = DU.parseHTML(html);
	var state = {
		token: extToken,
		// We are always wrapping extensions with the DOMFragment mechanism.
		wrappedObjectId: this.env.newObjectId(),
		wrapperType: errType + 'mw:Extension/' + extToken.getAttribute('name'),
		wrapperDataMw: errObj,
	};

	// DOMFragment-based encapsulation.
	this._onDocument(state, cb, doc);
};

/**
 * Fetch the preprocessed wikitext for an extension
 */
ExtensionHandler.prototype.fetchExpandedExtension = function(title, text, parentCB, cb) {
	var env = this.env;
	// We are about to start an async request for an extension
	env.dp('Note: trying to expand ', text);
	var cacheEntry = env.batcher.parse(title, text, cb);
	if (cacheEntry !== undefined) {
		// First param is error value.
		cb(null, cacheEntry);
	} else {
		parentCB ({ async: true });
	}
};

function normalizeExtOptions(options) {
	// Mimics Sanitizer::decodeTagAttributes from the PHP parser
	//
	// Extension options should always be interpreted as plain text. The
	// tokenizer parses them to tokens in case they are for an HTML tag,
	// but here we use the text source instead.
	var n = options.length;
	for (var i = 0; i < n; i++) {
		var o = options[i];
		if (!o.v && !o.vsrc) {
			continue;
		}

		// Use the source if present. If not use the value, but ensure it's a
		// string, as it can be a token stream if the parser has recognized it
		// as a directive.
		var v = o.vsrc || ((o.v.constructor === String) ? o.v : Util.tokensToString(o.v));
		// Normalize whitespace in extension attribute values
		o.v = v.trim().replace(/(\s+)/g, ' ');
	}
	return options;
}

ExtensionHandler.prototype.onExtension = function(token, frame, cb) {
	var env = this.env;
	var extensionName = token.getAttribute('name');
	var nativeHandler = this.nativeExtHandlers[extensionName];
	// TODO: use something order/quoting etc independent instead of src
	var cacheKey = token.dataAttribs.src;
	var cachedExpansion = env.extensionCache[cacheKey];

	if (nativeHandler) {
		// No caching for native extensions for now.
		token.setAttribute('options', normalizeExtOptions(token.getAttribute('options')));
		nativeHandler(token, cb);
	} else if (cachedExpansion) {
		// cache hit. Reuse extension expansion.
		var toks = DU.encapsulateExpansionHTML(env, token, cachedExpansion, { setDSR: true });
		cb({ tokens: toks });
	} else if (env.conf.parsoid.expandExtensions && env.conf.parsoid.usePHPPreProcessor) {
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
			new KV('about', token.getAttribute('about')),
		], token.dataAttribs);

		cb({ tokens: [span, token.getAttribute('source'), new EndTagTk('span')] });
	}
};

if (typeof module === "object") {
	module.exports.ExtensionHandler = ExtensionHandler;
}
