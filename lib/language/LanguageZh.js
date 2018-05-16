/**
 * Chinese conversion code.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const { Language } = require('./Language.js');
const { LanguageConverter } = require('./LanguageConverter.js');
const { ReplacementMachine } = require('wikimedia-langconv');

class ZhReplacementMachine extends ReplacementMachine {
	constructor() {
		super(
			'zh',
			'zh-hans',
			'zh-hant',
			'zh-cn',
			'zh-hk',
			'zh-mo',
			'zh-my',
			'zh-sg',
			'zh-tw'
		);
	}
	validCodePair(destCode, invertCode) {
		if (destCode === invertCode) { return true; }
		switch (destCode) {
			case 'zh-cn':
				if (invertCode === 'zh-tw') { return true; }
				// fall through
			case 'zh-sg':
			case 'zh-my':
			case 'zh-hans':
				return invertCode === 'zh-hant';
			case 'zh-tw':
				if (invertCode === 'zh-cn') { return true; }
				// fall through
			case 'zh-hk':
			case 'zh-mo':
			case 'zh-hant':
				return invertCode === 'zh-hans';
			default:
				return false;
		}
	}
}

class ZhConverter extends LanguageConverter {
	loadDefaultTables() {
		this.mTables = new ZhReplacementMachine();
	}
	// do not try to find variants for usernames
	findVariantLink(link, nt, ignoreOtherCond) {
		const ns = nt.getNamespace();
		if (ns.isUser() || ns.isUserTalk) {
			return { nt, link };
		}
		// FIXME check whether selected language is 'zh'
		return super.findVariantLink(link, nt, ignoreOtherCond);
	}
}

class LanguageZh extends Language {
	constructor() {
		super();
		const variants = [
			'zh',
			'zh-hans',
			'zh-hant',
			'zh-cn',
			'zh-hk',
			'zh-mo',
			'zh-my',
			'zh-sg',
			'zh-tw'
		];
		const variantfallbacks = new Map([
			['zh' , [ 'zh-hans', 'zh-hant', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-sg', 'zh-mo', 'zh-my' ]],
			['zh-hans' , [ 'zh-cn', 'zh-sg', 'zh-my' ]],
			['zh-hant' , [ 'zh-tw', 'zh-hk', 'zh-mo' ]],
			['zh-cn' , [ 'zh-hans', 'zh-sg', 'zh-my' ]],
			['zh-sg' , [ 'zh-hans', 'zh-cn', 'zh-my' ]],
			['zh-my' , [ 'zh-hans', 'zh-sg', 'zh-cn' ]],
			['zh-tw' , [ 'zh-hant', 'zh-hk', 'zh-mo' ]],
			['zh-hk' , [ 'zh-hant', 'zh-mo', 'zh-tw' ]],
			['zh-mo' , [ 'zh-hant', 'zh-hk', 'zh-tw' ]]
		]);
		this.mConverter = new ZhConverter(
			this, 'zh', variants, variantfallbacks,
			[],
			new Map([
				['zh', 'disable'],
				['zh-hans', 'unidirectional'],
				['zh-hant', 'unidirectional'],
			])
		);
	}
}

module.exports = LanguageZh;
