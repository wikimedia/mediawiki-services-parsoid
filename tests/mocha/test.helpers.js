'use strict';

var DU = require('../../lib/utils/DOMUtils.js').DOMUtils;
var MWParserEnvironment = require('../../lib/config/MWParserEnvironment.js').MWParserEnvironment;
var Promise = require('../../lib/utils/promise.js');

var parse = Promise.async(function *(parsoidConfig, src, options) {
	options = options || {};
	var env = yield MWParserEnvironment.getParserEnv(parsoidConfig, {
		prefix: options.prefix || 'enwiki',
		pageName: options.pageName || 'Main_Page',
		wrapSections: false,
	});
	if (options.tweakEnv) {
		env = options.tweakEnv(env) || env;
	}
	env.setPageSrcInfo(src);
	if (options.contentmodel) {
		env.page.meta.revision.contentmodel = options.contentmodel;
	}
	var doc = yield env.getContentHandler().toHTML(env);
	// linter tests need the env object
	return { env: env, doc: doc };
});

var serialize = Promise.async(function *(parsoidConfig, doc, pb, options) {
	options = options || {};
	var envOptions = {
		prefix: options.prefix || 'enwiki',
		pageName: options.pageName || 'Main_Page',
	};
	var inlineContentVersion = DU.extractInlinedContentVersion(doc);
	if (inlineContentVersion !== null) { envOptions.originalVersion = inlineContentVersion; }
	var env = yield MWParserEnvironment.getParserEnv(parsoidConfig, envOptions);
	if (options.tweakEnv) {
		env = options.tweakEnv(env) || env;
	}
	if (!env.page.meta) {
		env.page.meta = { revision: {} };
	}
	if (options.contentmodel) {
		env.page.meta.revision.contentmodel = options.contentmodel;
	}
	pb = pb || DU.extractPageBundle(doc);
	if (pb) {
		DU.applyPageBundle(doc, pb);
	}
	if (options.useSelser) {
		env.page.src = options.pageSrc;
		env.page.dom = options.origDOM;
	}
	return env.getContentHandler().fromHTML(env, doc.body, options.useSelser);
});

if (typeof module === 'object') {
	module.exports = {
		parse: parse,
		serialize: serialize,
	};
}
