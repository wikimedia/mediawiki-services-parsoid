/**
 * Kurdish conversion code.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const { Language } = require('./Language.js');
const { LanguageConverter } = require('./LanguageConverter.js');
const { ReplacementMachine } = require('wikimedia-langconv');

class KuConverter extends LanguageConverter {
	loadDefaultTables() {
		this.mTables = new ReplacementMachine('ku', 'ku-arab', 'ku-latn');
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

class LanguageKu extends Language {
	constructor() {
		super();
		const variants = ['ku', 'ku-arab', 'ku-latn'];
		const variantfallbacks = new Map([
			['ku', 'ku-latn'],
			['ku-arab', 'ku-latn'],
			['ku-latn', 'ku-arab'],
		]);
		this.mConverter = new KuConverter(
			this, 'ku', variants, variantfallbacks
		);
	}
}

module.exports = LanguageKu;
