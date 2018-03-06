/** Test cases for Kurdish language conversion */

'use strict';

/* global describe, it */

require('../../../core-upgrade.js');
require('chai').should();

const domino = require('domino');

describe('LanguageKu tests', function() {

	const { LanguageConverter } =
		require('../../../lib/language/LanguageConverter.js');

	const testCases = [
		{
			title: "Test (1)",
			output: {
				'ku'      : '١',
				'ku-arab' : '١',
				'ku-latn' : '1',
			},
			input: '١'
		},
		{
			title: "Test (2)",
			output: {
				'ku'      : 'Wîkîpediya ensîklopediyeke azad bi rengê wîkî ye.',
				// XXX broken!
				// 'ku-arab' : 'ویکیپەدیائە نسیکلۆپەدیەکەئا زاد ب رەنگێ ویکی یە.',
				'ku-latn' : 'Wîkîpediya ensîklopediyeke azad bi rengê wîkî ye.',
			},
			input: 'Wîkîpediya ensîklopediyeke azad bi rengê wîkî ye.',
		},
		{
			title: "Test (3)",
			output: {
				'ku'      : 'ویکیپەدیا ەنسیکلۆپەدیەکەئا زاد ب رەنگێ ویکی یە.',
				'ku-arab' : 'ویکیپەدیا ەنسیکلۆپەدیەکەئا زاد ب رەنگێ ویکی یە.',
				'ku-latn' : 'wîkîpedîa ensîklopedîekea zad b rengê wîkî îe.',
			},
			input: 'ویکیپەدیا ەنسیکلۆپەدیەکەئا زاد ب رەنگێ ویکی یە.'
		},
	];

	const Language = LanguageConverter.loadLanguage(null, 'ku');
	const machine = (new Language()).getConverter().getMachine();
	['ku-arab','ku-latn'].forEach((variantCode) => {
		const invCode = variantCode === 'ku-arab' ? 'ku-latn' : 'ku-arab';
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
