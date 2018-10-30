/** @module */

'use strict';

const TokenHandler = require('./TokenHandler.js');
const { TokenUtils } = require('../../utils/TokenUtils.js');
const { Util } = require('../../utils/Util.js');
const { DOMUtils } = require('../../utils/DOMUtils.js');
const { KV, TagTk, EndTagTk } = require('../parser.defines.js');

// shortcuts
const DU = DOMUtils;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class ExtensionHandler extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		// Extension content expansion
		this.manager.addTransform(
			(token, frame, cb) => this.onExtension(token, frame, cb),
			"ExtensionHandler:onExtension", ExtensionHandler.rank(),
			'tag', 'extension'
		);
	}

	static rank() { return 1.11; }

	/**
	 * Parse the extension HTML content and wrap it in a DOMFragment
	 * to be expanded back into the top-level DOM later.
	 */
	parseExtensionHTML(extToken, unwrapFragment, cb, err, doc) {
		let errType = '';
		let errObj = {};
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
			this.env.log(
				'error/extension', 'Error', err, ' parsing extension token: ',
				JSON.stringify(extToken)
			);
		}

		const psd = this.manager.env.conf.parsoid;
		if (psd.dumpFlags && psd.dumpFlags.has("extoutput")) {
			console.warn("=".repeat(80));
			console.warn("EXTENSION INPUT: " + extToken.getAttribute('source'));
			console.warn("=".repeat(80));
			console.warn("EXTENSION OUTPUT:\n");
			console.warn(doc.body.outerHTML);
			console.warn("-".repeat(80));
		}

		// document -> html -> body -> children
		const state = {
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
	}

	/**
	 * Fetch the preprocessed wikitext for an extension.
	 */
	fetchExpandedExtension(text, parentCB, cb) {
		const env = this.env;
		// We are about to start an async request for an extension
		env.log('debug', 'Note: trying to expand ', text);
		parentCB({ async: true });
		// Pass the page title to the API.
		const title = env.page.name || '';
		env.batcher.parse(title, text).nodify(cb);
	}

	static normalizeExtOptions(options) {
		// Mimics Sanitizer::decodeTagAttributes from the PHP parser
		//
		// Extension options should always be interpreted as plain text. The
		// tokenizer parses them to tokens in case they are for an HTML tag,
		// but here we use the text source instead.
		const n = options.length;
		for (let i = 0; i < n; i++) {
			const o = options[i];
			if (!o.v && !o.vsrc) {
				continue;
			}

			// Use the source if present. If not use the value, but ensure it's a
			// string, as it can be a token stream if the parser has recognized it
			// as a directive.
			const v = o.vsrc ||
				((o.v.constructor === String) ? o.v :
				TokenUtils.tokensToString(o.v, false, { includeEntities: true }));
			// Normalize whitespace in extension attribute values
			o.v = v.replace(/[\t\r\n ]+/g, ' ').trim();
			// Decode character references
			o.v = Util.decodeEntities(o.v);
		}
		return options;
	}

	onExtension(token, frame, cb) {
		const env = this.env;
		const extensionName = token.getAttribute('name');
		const nativeExt = env.conf.wiki.extConfig.tags.get(extensionName);
		// TODO: use something order/quoting etc independent instead of src
		const cachedExpansion = env.extensionCache[token.dataAttribs.src];

		const options = token.getAttribute('options');
		token.setAttribute('options', ExtensionHandler.normalizeExtOptions(options));

		if (nativeExt && nativeExt.toDOM) {
			// Check if the tag wants its DOM fragment not to be unwrapped.
			// The default setting is to unwrap the content DOM fragment automatically.
			const unwrapFragment = nativeExt.unwrapContent !== false;

			const extContent = Util.extractExtBody(token);
			const extArgs = token.getAttribute('options');
			const state = {
				extToken: token,
				manager: this.manager,
				cb: cb,
				parseContext: this.options,
			};
			const p = nativeExt.toDOM(state, extContent, extArgs);
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
			const toks = DU.encapsulateExpansionHTML(env, token, cachedExpansion, { setDSR: true });
			cb({ tokens: toks });
		} else if (env.conf.parsoid.expandExtensions) {
			// Use MediaWiki's action=parse
			this.fetchExpandedExtension(
				token.getAttribute('source'),
				cb,
				(err, html) => {
					// FIXME: This is a hack to account for the php parser's
					// gratuitous trailing newlines after parse requests.
					// Trimming keeps the top-level nodes length down to just
					// the <style> tag, so it can keep that dom fragment
					// representation as it's tunnelled through to the dom.
					if (!err && token.getAttribute('name') === 'templatestyles') { html = html.trim(); }
					this.parseExtensionHTML(token, true, cb, err, err ? null : DU.parseHTML(html));
				}
			);
		} else {
			// Convert this into a span with extension content as plain text
			const argInfo = Util.getExtArgInfo(token);
			const dataMw = argInfo.dict;
			dataMw.errors = [
				{
					key: 'mw-api-extexpand-error',
					message: 'Could not expand extension source.',
				},
			];
			if (!token.dataAttribs.tagWidths[1]) {
				dataMw.body = undefined;  // Serialize to self-closing.
			}
			const span = new TagTk('span', [
				new KV('typeof', 'mw:Error mw:Extension/' + extensionName),
				new KV('about', token.getAttribute('about')),
				new KV('data-mw', JSON.stringify(dataMw)),
			], {
				tsr: Util.clone(token.dataAttribs.tsr),
				tmp: { nativeExt: true },  // Suppress dsr warnings
			});
			cb({ tokens: [ span, token.getAttribute('source'), new EndTagTk('span') ] });
		}
	}

	_onDocument(state, cb, doc) {
		const argDict = Util.getExtArgInfo(state.token).dict;
		if (!state.token.dataAttribs.tagWidths[1]) {
			argDict.body = undefined;  // Serialize to self-closing.
		}
		const addWrapperAttrs = function(firstNode) {
			// Adds the wrapper attributes to the first element
			firstNode.setAttribute('typeof', state.wrapperType);

			// Set data-mw
			DU.setDataMw(
				firstNode,
				Object.assign(state.wrapperDataMw || {}, argDict)
			);

			// Update data-parsoid
			const dp = DU.getDataParsoid(firstNode);
			dp.tsr = Util.clone(state.token.dataAttribs.tsr);
			dp.src = state.token.dataAttribs.src;
			dp.tmp.isHtmlExt = state.isHtmlExt;
			DU.setDataParsoid(firstNode, dp);
		};

		const toks = DU.buildDOMFragmentTokens(
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
	}
}

if (typeof module === "object") {
	module.exports.ExtensionHandler = ExtensionHandler;
}
