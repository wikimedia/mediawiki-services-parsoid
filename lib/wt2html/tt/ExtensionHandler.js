/** @module */

'use strict';

var TokenHandler = require('./TokenHandler.js');
var Util = require('../../utils/Util.js').Util;
var DU = require('../../utils/DOMUtils.js').DOMUtils;
var defines = require('../parser.defines.js');

// define some constructor shortcuts
var KV = defines.KV;
var TagTk = defines.TagTk;
var EndTagTk = defines.EndTagTk;


/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 * @constructor
 */
class ExtensionHandler extends TokenHandler { }

ExtensionHandler.prototype.rank = 1.11;

ExtensionHandler.prototype.init = function() {
	// Extension content expansion
	this.manager.addTransform(this.onExtension.bind(this),
		"ExtensionHandler:onExtension", this.rank, 'tag', 'extension');
};

/**
 * Parse the extension HTML content and wrap it in a DOMFragment
 * to be expanded back into the top-level DOM later.
 */
ExtensionHandler.prototype.parseExtensionHTML = function(extToken, unwrapFragment, cb, err, doc) {
	var errType = '';
	var errObj = {};
	if (err) {
		doc = DU.parseHTML('<span></span>');
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

	var psd = this.manager.env.conf.parsoid;
	if (psd.dumpFlags && psd.dumpFlags.has("extoutput")) {
		console.warn("=".repeat(80));
		console.warn("EXTENSION INPUT: " + extToken.getAttribute('source'));
		console.warn("=".repeat(80));
		console.warn("EXTENSION OUTPUT:\n");
		console.warn(doc.body.outerHTML);
		console.warn("-".repeat(80));
	}

	// document -> html -> body -> children
	var state = {
		token: extToken,
		wrapperName: extToken.getAttribute('name'),
		// We are always wrapping extensions with the DOMFragment mechanism.
		wrappedObjectId: this.env.newObjectId(),
		wrapperType: errType + 'mw:Extension/' + extToken.getAttribute('name'),
		wrapperDataMw: errObj,
		unwrapFragment: unwrapFragment,
		isHtmlExt: (extToken.getAttribute('name') === 'html'),
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

	if (nativeExt && nativeExt.toDOM) {
		// Check if the tag wants its DOM fragment not to be unwrapped.
		// The default setting is to unwrap the content DOM fragment automatically.
		const unwrapFragment = nativeExt.unwrapContent !== false;

		var extContent = Util.extractExtBody(token);
		var extArgs = token.getAttribute('options');
		var state = {
			extToken: token,
			manager: this.manager,
			cb: cb,
			parseContext: this.options,
		};
		var p = nativeExt.toDOM(state, extContent, extArgs);
		if (p) {
			p.nodify(this.parseExtensionHTML.bind(this, token, unwrapFragment, cb));
		} else {
			// The extension dropped this instance completely (!!)
			// Should be a rarity and presumably the extension
			// knows what it is doing. Ex: nested refs are dropped
			// in some scenarios.
			cb({ tokens: [], async: false });
		}
	} else if (nativeExt && nativeExt.tokenHandler) {
		// DEPRECATED code path. Native extensions shouldn't use
		// this going forward.
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
			(err, html) => this.parseExtensionHTML(token, true, cb, err, err ? null : DU.parseHTML(html))
		);
	} else {
		// Convert this into a span with extension content as plain text
		var argInfo = Util.getExtArgInfo(token);
		var dataMw = argInfo.dict;
		dataMw.errors = [
			{
				key: 'mw-api-extexpand-error',
				message: 'Could not expand extension source.',
			},
		];
		if (!token.dataAttribs.tagWidths[1]) {
			dataMw.body = undefined;  // Serialize to self-closing.
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

ExtensionHandler.prototype._onDocument = function(state, cb, doc) {
	var argDict = Util.getExtArgInfo(state.token).dict;
	if (!state.token.dataAttribs.tagWidths[1]) {
		argDict.body = undefined;  // Serialize to self-closing.
	}
	var addWrapperAttrs = function(firstNode) {
		// Adds the wrapper attributes to the first element
		firstNode.setAttribute('typeof', state.wrapperType);

		// Set data-mw
		DU.setDataMw(firstNode,
			Object.assign(state.wrapperDataMw || {}, argDict));

		// Update data-parsoid
		var dp = DU.getDataParsoid(firstNode);
		dp.tsr = Util.clone(state.token.dataAttribs.tsr);
		dp.src = state.token.dataAttribs.src;
		dp.tmp.isHtmlExt = state.isHtmlExt;
		DU.setDataParsoid(firstNode, dp);
	};

	var toks = DU.buildDOMFragmentTokens(
		this.manager.env,
		state.token,
		doc.body,
		addWrapperAttrs,
		{
			setDSR: true,
			isForeignContent: true,
			unwrapFragment: state.unwrapFragment,
			wrapperName: state.wrapperName,
		}
	);

	cb({ tokens: toks });
};

if (typeof module === "object") {
	module.exports.ExtensionHandler = ExtensionHandler;
}
