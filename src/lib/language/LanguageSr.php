/**
 * Serbian (Српски / Srpski) specific code.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const { Language } = require('./Language.js');
const { LanguageConverter } = require('./LanguageConverter.js');
const { ReplacementMachine } = require('wikimedia-langconv');

class SrConverter extends LanguageConverter {
	loadDefaultTables() {
		this.mTables = new ReplacementMachine('sr', 'sr-ec', 'sr-el');
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

	/**
	 * Guess if a text is written in Cyrillic or Latin.
	 * Overrides LanguageConverter::guessVariant()
	 */
	guessVariant(text, variant) {
		return this.guessVariantParsoid(text, variant);
	}

	// Variant based on the ReplacementMachine's bracketing abilities
	guessVariantParsoid(text, variant) {
		const r = [];
		for (const code of this.mTables.codes) {
			for (const othercode of this.mTables.codes) {
				if (code === othercode) { return; }
				r.push({
					code,
					othercode,
					stats: this.mTables.countBrackets(text, code, othercode),
				});
			}
		}
		r.sort((a,b) => a.stats.unsafe - b.stats.unsafe);
		return r[0].othercode === variant;
	}

	// Faithful translation of PHP heuristic
	guessVariantPHP(text, variant) {
		// XXX: Should use the `u` regexp flag, in Node 6
		// but for these particular regexps it's actually not needed.
		// http://node.green/#ES2015-syntax-RegExp--y--and--u--flags--u--flag
		const numCyrillic = text.match(/[шђчћжШЂЧЋЖ]/g).length;
		const numLatin = text.match(/[šđčćžŠĐČĆŽ]/g).length;
		if (variant === 'sr-ec') {
			return numCyrillic > numLatin;
		} else if (variant === 'sr-el') {
			return numLatin > numCyrillic;
		} else {
			return false;
		}
	}
}

class LanguageSr extends Language {
	constructor() {
		super();
		const variants = ['sr', 'sr-ec', 'sr-el'];
		const variantfallbacks = new Map([
			['sr','sr-ec'],
			['sr-ec','sr'],
			['sr-el','sr']
		]);
		const flags = new Map([
			['S', 'S'], ['писмо', 'S'], ['pismo', 'S'],
			['W', 'W'], ['реч', 'W'], ['reč', 'W'], ['ријеч', 'W'],
			['riječ', 'W']
		]);
		this.mConverter = new SrConverter(
			this, 'sr', variants, variantfallbacks, flags
		);
	}
}

module.exports = LanguageSr;
