/** @module */

'use strict';

const fs = require('fs');
const TokenHandler = require('../../../lib/wt2html/tt/TokenHandler.js');
const { TemplateHandler } = require('../../../lib/wt2html/tt/TemplateHandler.js');
const { AttributeExpander } = require('../../../lib/wt2html/tt/AttributeExpander.js');
const { DOMFragmentBuilder } = require('../../../lib/wt2html/tt/DOMFragmentBuilder.js');
const { ExtensionHandler } = require('../../../lib/wt2html/tt/ExtensionHandler.js');
const { LanguageVariantHandler } = require('../../../lib/wt2html/tt/LanguageVariantHandler.js');
const { ExternalLinkHandler } = require('../../../lib/wt2html/tt/ExternalLinkHandler.js');
const { WikiLinkHandler } = require('../../../lib/wt2html/tt/WikiLinkHandler.js');
const { HybridTestUtils }  = require('./HybridTestUtils.js');
const { TokenUtils } = require('../../../lib/utils/TokenUtils.js');

/**
 * Wrapper that invokes a PHP token transformer to do the work
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class PHPTokenTransformer extends TokenHandler {
	constructor(env, manager, name, options) {
		super(manager, options);
		if (!(/^\w+$/.test(name))) {
			console.error("Transformer name " + this.transformerName + " failed sanity check.");
			process.exit(-1);
		}
		this.transformerName = name;
		this.registerHandlers(name);
	}

	processTokens(env, tokens, handler, traceState) {
		const fileName = `/tmp/${this.transformerName}.${process.pid}.tokens`;
		fs.writeFileSync(fileName, tokens.map(t => JSON.stringify(t)).join('\n'));

		const opts = {
			envOpts: HybridTestUtils.mkEnvOpts(env, this.manager.frame),
			pipelineOpts: this.options,
			pipelineId: this.manager.pipelineId,
			toplevel: this.atTopLevel,
		};

		const res = HybridTestUtils.runPHPCode(
			"runTokenTransformer.php",
			[this.transformerName, fileName, handler],
			opts
		);

		// First line will be the new UID for env
		const lines = res.trim().split("\n");
		const newEnvUID = lines.shift();
		this.env.uid = parseInt(newEnvUID, 10);

		const toks = lines.map((str) => {
			return str ? JSON.parse(str, (k, v) => TokenUtils.getToken(v)) : "";
		});

		return toks;
	}

	processTokensSync(env, tokens, traceState) {
		return this.processTokens(env, tokens, '', traceState);
	}

	asyncHandler(token, handler, cb) {
		const toks = this.processTokens(this.env, [ token ], handler, {});
		cb({ tokens: toks });
	}

	/* Register handlers for async transformers since the Async TTM
	 * uses the add/remove/get transform interface */
	registerHandlers(name) {
		switch (name) {
			case 'TemplateHandler':
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					"PHPTemplateHandler:onTemplate", TemplateHandler.RANK(), 'tag', 'template');
				// Template argument expansion
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					"PHPTemplateHandler:onTemplateArg", TemplateHandler.RANK(), 'tag', 'templatearg');
				break;

			case 'AttributeExpander':
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onAny', cb),
					"AttributeExpander:onAny", AttributeExpander.rank(), 'any');
				break;

			case 'DOMFragmentBuilder':
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					"buildDOMFragment", DOMFragmentBuilder.scopeRank(), 'tag', 'mw:dom-fragment-token');
				break;

			case 'ExternalLinkHandler':
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					'ExternalLinkHandler:onUrlLink',
					ExternalLinkHandler.rank(), 'tag', 'urllink');
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					'ExternalLinkHandler:onExtLink',
					ExternalLinkHandler.rank() - 0.001, 'tag', 'extlink');
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onEnd', cb),
					'ExternalLinkHandler:onEnd',
					ExternalLinkHandler.rank(), 'end');
				break;

			case 'ExtensionHandler':
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					"ExtensionHandler:onExtension",
					ExtensionHandler.rank(), 'tag', 'extension'
				);
				break;

			case 'LanguageVariantHandler':
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					"LanguageVariantHandler:onLanguageVariant",
					LanguageVariantHandler.rank(), 'tag', 'language-variant'
				);
				break;

			case 'WikiLinkHandler':
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					'WikiLinkHandler:onRedirect',
					WikiLinkHandler.rank(), 'tag', 'mw:redirect');
				this.manager.addTransform(
					(token, cb) => this.asyncHandler(token, 'onTag', cb),
					'WikiLinkHandler:onWikiLink',
					WikiLinkHandler.rank() + 0.001, 'tag', 'wikilink');
				break;
		}
	}
}

if (typeof module === "object") {
	module.exports.PHPTokenTransformer = PHPTokenTransformer;
}
