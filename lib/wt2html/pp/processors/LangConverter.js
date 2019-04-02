/** @module */

'use strict';

const LanguageConverter = require('../../../language/LanguageConverter').LanguageConverter;

/**
 * @class
 */
class LangConverter {
	run(rootNode, env, options) {
		LanguageConverter.maybeConvert(
			env, rootNode.ownerDocument,
			env.htmlVariantLanguage, env.wtVariantLanguage
		);
	}
}

module.exports.LangConverter = LangConverter;
