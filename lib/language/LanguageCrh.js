/**
 * Crimean Tatar (Qırımtatarca) conversion code.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const { Language } = require('./Language.js');
const { LanguageConverter } = require('./LanguageConverter.js');
const { ReplacementMachine } = require('wikimedia-langconv');

class CrhConverter extends LanguageConverter {
	loadDefaultTables() {
		this.mTables = new ReplacementMachine('crh', 'crh-latn', 'crh-cyrl');
	}
	// do not try to find variants for usernames
	findVariantLink(link, nt, ignoreOtherCond) {
		const ns = nt.getNamespace();
		if (ns.isUser() || ns.isUserTalk) {
			return { nt, link };
		}
		// FIXME check whether selected language is 'crh'
		return super.findVariantLink(link, nt, ignoreOtherCond);
	}
}

class LanguageCrh extends Language {
	constructor() {
		super();
		const variants = ['crh', 'crh-cyrl', 'crh-latn'];
		const variantfallbacks = new Map([
			['crh', 'crh-latn'],
			['crh-cyrl', 'crh-latn'],
			['crh-latn', 'crh-cyrl'],
		]);
		this.mConverter = new CrhConverter(
			this, 'crh', variants, variantfallbacks
		);
	}
}

module.exports = LanguageCrh;
