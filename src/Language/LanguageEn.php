/**
 * English ( / Pig Latin) conversion code.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const { Language } = require('./Language.js');
const { LanguageConverter } = require('./LanguageConverter.js');
const { ReplacementMachine } = require('wikimedia-langconv');

class EnConverter extends LanguageConverter {
	loadDefaultTables() {
		this.mTables = new ReplacementMachine('en', 'en', 'en-x-piglatin');
	}
	// do not try to find variants for usernames
	findVariantLink(link, nt, ignoreOtherCond) {
		const ns = nt.getNamespace();
		if (ns.isUser() || ns.isUserTalk) {
			return { nt, link };
		}
		// FIXME check whether selected language is 'sr'
		return super.findVariantLink(link, nt, ignoreOtherCond);
	}
}

class LanguageEn extends Language {
	constructor() {
		super();
		const variants = ['en', 'en-x-piglatin'];
		this.mConverter = new EnConverter(
			this, 'en', variants
		);
	}
}

module.exports = LanguageEn;
