/*
 * A bidirectional Language Converter, capable of round-tripping variant
 * conversion.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

/**
 * Base class for language variant conversion.
 */
class LanguageConverter {

	/**
	 * Convert a text in the "base variant" to a specific variant, given
	 * by `env.variantLanguage`.
	 * @param {MWParserEnvironment} env
	 * @param {Node} rootNode The root node of a fragment to convert.
	 */
	static baseToVariant(env, rootNode) {
		// XXX Not yet implemented
	}
}

if (typeof module === 'object') {
	module.exports.LanguageConverter = LanguageConverter;
}
