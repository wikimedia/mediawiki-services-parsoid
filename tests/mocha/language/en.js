/** Test cases for English language conversion */

'use strict';

/* global describe, it */

require('../../../core-upgrade.js');
require('chai').should();

const domino = require('domino');

describe('LanguageEn tests', function() {

	const { LanguageConverter } =
		require('../../../lib/language/LanguageConverter.js');

	const testCases = [
		{
			title: "Converting to Pig Latin",
			output: {
				'en' : '123 Pigpen pig latin of 123 don\'t stop believing in yourself queen JavaScript NASA',
				'en-x-piglatin' : '123 Igpenpay igpay atinlay ofway 123 on\'tday opstay elievingbay inway ourselfyay eenquay JavaScript NASA',
			},
			input: '123 Pigpen pig latin of 123 don\'t stop believing in yourself queen JavaScript NASA',
			code: 'en',
		},
		{
			title: "Converting from Pig Latin",
			output: {
				'en' : '123 Pigpen pig latin of 123 don\'t tops believing in yourself queen avaScriptJay ASANAY',
				'en-x-piglatin' : '123 Igpenpayway igpayway atinlayway ofwayway 123 on\'tdayway opstayway elievingbayway inwayway ourselfyayway eenquayway avaScriptJay ASANAY',
			},
			input: '123 Igpenpay igpay atinlay ofway 123 on\'tday opstay elievingbay inway ourselfyay eenquay avaScriptJay ASANAY',
			// XXX: this is currently treated as just a guess, so it doesn't
			// prevent pig latin from being double-encoded.
			code: 'en-x-piglatin',
		},
	];

	const Language = LanguageConverter.loadLanguage(null, 'en');
	const machine = (new Language()).getConverter().getMachine();
	['en','en-x-piglatin'].forEach((variantCode) => {
		const invCode = variantCode === 'en' ? 'en-x-piglatin' : 'en';
		testCases.forEach((test) => {
			if (variantCode in test.output) {
				it(`${test.title} [${variantCode}]`, function() {
					const doc = domino.createDocument();
					const out = machine.convert(
						doc, test.input, variantCode, test.code || invCode
					);
					out.textContent.should.equal(test.output[variantCode]);
				});
			}
		});
	});
});
