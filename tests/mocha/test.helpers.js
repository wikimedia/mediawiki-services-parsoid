'use strict';
var DU = require('../../lib/utils/DOMUtils.js').DOMUtils;
var MWParserEnvironment = require('../../lib/config/MWParserEnvironment.js').MWParserEnvironment;

var parse = function(parsoidConfig, src, options) {
	options = options || {};
	return MWParserEnvironment.getParserEnv(parsoidConfig, {
		prefix: options.prefix || 'enwiki',
		pageName: options.pageName || 'Main_Page',
	}).then(function(env) {
		if (options.tweakEnv) {
			env = options.tweakEnv(env) || env;
		}
		env.setPageSrcInfo(src);
		return env.pipelineFactory.parse(env, env.page.src)
		.then(function(doc) {
			// linter tests need the env object
			return { env: env, doc: doc };
		});
	});

};

var serialize = function(parsoidConfig, doc, pb, options) {
	options = options || {};
	return MWParserEnvironment.getParserEnv(parsoidConfig, {
		prefix: options.prefix || 'enwiki',
		pageName: options.pageName || 'Main_Page',
	}).then(function(env) {
		if (options.tweakEnv) {
			env = options.tweakEnv(env) || env;
		}
		pb = pb || DU.extractPageBundle(doc);
		if (pb) {
			DU.applyPageBundle(doc, pb);
		}
		return DU.serializeDOM(env, doc.body, false);
	});
};

if (typeof module === 'object') {
	module.exports = {
		parse: parse,
		serialize: serialize,
	};
}
