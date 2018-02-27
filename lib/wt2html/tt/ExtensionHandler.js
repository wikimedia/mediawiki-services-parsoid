/** @module */

'use strict';

var TemplateHandler = require('./TemplateHandler.js').TemplateHandler;
var Util = require('../../utils/Util.js').Util;
var DU = require('../../utils/DOMUtils.js').DOMUtils;
var defines = require('../parser.defines.js');

// define some constructor shortcuts
var KV = defines.KV;
var TagTk = defines.TagTk;
var EndTagTk = defines.EndTagTk;


/**
 * @class
 * @extends module:wt2html/tt/TemplateHandler~TemplateHandler
 * @constructor
 */
class ExtensionHandler extends TemplateHandler { }

ExtensionHandler.prototype.rank = 1.11;

ExtensionHandler.prototype.init = function() {
	// Extension content expansion
	this.manager.addTransform(this.onExtension.bind(this),
		"ExtensionHandler:onExtension", this.rank, 'tag', 'extension');
};

/**
 * Get the public data-mw structure that exposes the extension name, args, and body.
 */
ExtensionHandler.prototype.getArgInfo = function(state) {
	return Util.getArgInfo(state.token);
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
		isExt: true,
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
 * Fetch the preprocessed wikitext for an extension.
 */
ExtensionHandler.prototype.fetchExpandedExtension = function(text, parentCB, cb) {
	var env = this.env;
	// We are about to start an async request for an extension
	env.log('debug', 'Note: trying to expand ', text);
	parentCB({ async: true });
	// Pass the page title to the API.
	var title = env.page.name || '';
	env.batcher.parse(title, text).nodify(cb);
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
		var v = o.vsrc || ((o.v.constructor === String) ? o.v :
			Util.tokensToString(o.v, false, { includeEntities: true }));
		// Normalize whitespace in extension attribute values
		o.v = v.replace(/[\t\r\n ]+/g, ' ').trim();
		// Decode character references
		o.v = Util.decodeEntities(o.v);
	}
	return options;
}

ExtensionHandler.prototype.onExtension = function(token, frame, cb) {
	var env = this.env;
	var extensionName = token.getAttribute('name');
	var nativeExt = env.conf.wiki.extensionTags.get(extensionName);
	// TODO: use something order/quoting etc independent instead of src
	var cachedExpansion = env.extensionCache[token.dataAttribs.src];

	var options = token.getAttribute('options');
	token.setAttribute('options', normalizeExtOptions(options));

	if (nativeExt && nativeExt.tokenHandler) {
		// No caching for native extensions for now.
		nativeExt.tokenHandler(this.manager, this.options, token, cb);
	} else if (cachedExpansion) {
		// cache hit. Reuse extension expansion.
		var toks = DU.encapsulateExpansionHTML(env, token, cachedExpansion, { setDSR: true });
		cb({ tokens: toks });
	} else if (env.conf.parsoid.expandExtensions) {
		// Use MediaWiki's action=parse
		this.fetchExpandedExtension(
			token.getAttribute('source'),
			cb,
			this.parseExtensionHTML.bind(this, token, cb)
		);
	} else {
		// Convert this into a span with extension content as plain text
		var argInfo = Util.getArgInfo(token);
		var dataMw = argInfo.dict;
		dataMw.errors = [
			{
				key: 'mw-api-extexpand-error',
				message: 'Could not expand extension source.',
			},
		];
		if (!token.dataAttribs.tagWidths[1]) {
			dataMw.body = null;  // Serialize to self-closing.
		}
		var span = new TagTk('span', [
			new KV('typeof', 'mw:Error mw:Extension/' + extensionName),
			new KV('about', token.getAttribute('about')),
			new KV('data-mw', JSON.stringify(dataMw)),
		], {
			tsr: Util.clone(token.dataAttribs.tsr),
			tmp: { nativeExt: true },  // Suppress dsr warnings
		});
		cb({ tokens: [ span, token.getAttribute('source'), new EndTagTk('span') ] });
	}
};

if (typeof module === "object") {
	module.exports.ExtensionHandler = ExtensionHandler;
}
