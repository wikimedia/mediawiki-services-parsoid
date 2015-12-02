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
		return env.pipelineFactory.parse(env, env.page.src, options.expansions).
			then(function(doc) {
				// linter tests need the env object
				return { env: env, doc: doc };
			});
	});

};

var serialize = function(parsoidConfig, doc, dp, options) {
	options = options || {};
	return MWParserEnvironment.getParserEnv(parsoidConfig, {
		prefix: options.prefix || 'enwiki',
		pageName: options.pageName || 'Main_Page',
	}).then(function(env) {
		if (options.tweakEnv) {
			env = options.tweakEnv(env) || env;
		}
		if (!dp) {
			var dpScriptElt = doc.getElementById('mw-data-parsoid');
			if (dpScriptElt) {
				dpScriptElt.parentNode.removeChild(dpScriptElt);
				dp = JSON.parse(dpScriptElt.text);
			}
		}
		if (dp) {
			DU.applyDataParsoid(doc, dp);
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
