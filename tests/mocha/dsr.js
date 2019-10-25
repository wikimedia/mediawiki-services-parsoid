'use strict';

/* global describe, it */

require('../../core-upgrade.js');

var should = require("chai").should();
var DOMDataUtils = require('../../lib/utils/DOMDataUtils.js').DOMDataUtils;
var ParsoidConfig = require('../../lib/config/ParsoidConfig.js').ParsoidConfig;
var helpers = require('./test.helpers.js');

// FIXME: MWParserEnvironment.getParserEnv and switchToConfig both require
// mwApiMap to be setup. This forces us to load WMF config. Fixing this
// will require some changes to ParsoidConfig and MWParserEnvironment.
var parsoidConfig = new ParsoidConfig(null, {
	loadWMF: true,
	defaultWiki: 'enwiki',
});
var parse = function(src, options) {
	return helpers.parse(parsoidConfig, src, options).then(function(ret) {
		return ret.doc;
	});
};

function validateSpec(wt, doc, spec) {
	var body = doc.body;
	var elts = body.querySelectorAll(spec.selector);
	elts.length.should.equal(1);
	var dp = DOMDataUtils.getDataParsoid(elts[0]);
	var dsr = dp.dsr;
	should.exist(dsr);
	dsr.should.be.an.instanceof(Array);
	// FIXME: Unclear if this is actually always true
	// But, since we are currently testing for it below,
	// I'm going to add this in. If we come across scenarios
	// where this isn't valid, we can either fix code or fix specs.
	dsr.length.should.equal(4);
	wt.substring(dsr[0], dsr[1]).should.equal(spec.dsrContent[0]);
	wt.substring(dsr[0], dsr[0] + dsr[2]).should.equal(spec.dsrContent[1]);
	wt.substring(dsr[1] - dsr[3], dsr[1]).should.equal(spec.dsrContent[2]);
}

function runTests(name, tests) {
	describe('DSR assignment: ' + name, function() {
		tests.forEach(function(test) {
			var wt = test.wt;
			it('should be valid for ' + JSON.stringify(wt), function() {
				return parse(wt).then(function(doc) {
					DOMDataUtils.visitAndLoadDataAttribs(doc.body);
					test.specs.forEach(spec => validateSpec(wt, doc, spec));
				});
			});
		});
	});
}

/*
 * For every test with a 'wt' property, provide the 'spec' property that is
 * an array of DSR specs that need to be verified on the parsed output of 'wt'.
 * Every spec should have:
 *   selector: a CSS selector for picking a DOM node in the parsed output.
 *   dsrContent: a 3-element array. The first element is the wikitext corresponding
 *               to the wikiext substring between dsr[0]..dsr[1]. The second and
 *               third elements are the opening/closing wikitext tag for that node.
 */
var paraTests = [
	{
		wt: 'a',
		specs: [ { selector: 'body > p', dsrContent: ['a', '', ''] } ],
	},
	{
		wt: 'a\n\nb',
		specs: [
			{ selector: 'body > p:nth-child(1)', dsrContent: ['a', '', ''] },
			{ selector: 'body > p:nth-child(2)', dsrContent: ['b', '', ''] },
		],
	},
];
runTests('Paragraphs', paraTests);

var listTests = [
	{
		wt: '*a\n*b',
		specs: [
			{ selector: 'ul', dsrContent: ['*a\n*b', '', ''] },
			{ selector: 'ul > li:nth-child(1)', dsrContent: ['*a', '*', ''] },
			{ selector: 'ul > li:nth-child(2)', dsrContent: ['*b', '*', ''] },
		],
	},
	{
		wt: '*a\n**b\n***c\n*d',
		specs: [
			{ selector: 'body > ul', dsrContent: ['*a\n**b\n***c\n*d', '', ''] },
			{ selector: 'body > ul > li:first-child', dsrContent: ['*a\n**b\n***c', '*', ''] },
			{ selector: 'body > ul > li:first-child > ul', dsrContent: ['**b\n***c', '', ''] },
			{ selector: 'body > ul > li:first-child > ul > li:first-child', dsrContent: ['**b\n***c', '**', ''] },
			{ selector: 'body > ul > li:first-child > ul > li:first-child > ul > li', dsrContent: ['***c', '***', ''] },
			{ selector: 'body > ul > li:nth-child(2)', dsrContent: ['*d', '*', ''] },
		],
	},
];
runTests('Lists', listTests);

var headingTests = [
	{
		wt: '=A=\n==B==\n===C===\n====D====',
		specs: [
			{ selector: 'body > h1', dsrContent: ['=A=', '=', '='] },
			{ selector: 'body > h2', dsrContent: ['==B==', '==', '=='] },
			{ selector: 'body > h3', dsrContent: ['===C===', '===', '==='] },
			{ selector: 'body > h4', dsrContent: ['====D====', '====', '===='] },
		],
	},
	{
		wt: '=A New Use for the = Sign=\n==The == Operator==',
		specs: [
			{ selector: 'body > h1', dsrContent: ['=A New Use for the = Sign=', '=', '='] },
			{ selector: 'body > h2', dsrContent: ['==The == Operator==', '==', '=='] },
		],
	},
];
runTests('Headings', headingTests);

var quoteTests = [
	{
		wt: "''a''\n'''b'''",
		specs: [
			{ selector: 'p > i', dsrContent: ["''a''", "''", "''"] },
			{ selector: 'p > b', dsrContent: ["'''b'''", "'''", "'''"] },
		],
	},
];
runTests('Quotes', quoteTests);

var tableTests = [
	{
		wt: '{|\n|-\n|A\n|}',
		specs: [
			{ selector: 'body > table', dsrContent: ['{|\n|-\n|A\n|}', '{|', '|}'] },
			{ selector: 'body > table > tbody > tr', dsrContent: ['|-\n|A', '|-', ''] },
			{ selector: 'body > table > tbody > tr > td', dsrContent: ['|A', '|', ''] },
		],
	},
];
runTests('Tables', tableTests);

var preTests = [
	{
		wt: " Preformatted text ",
		specs: [{ selector: 'body > pre', dsrContent: [" Preformatted text ", " ", ""] }],
	},
];
runTests('Indent-Pre', preTests);

var htmlEltTests = [
	{
		wt:"<small>'''bold'''</small>",
		specs: [
			{ selector: 'body > p', dsrContent: ["<small>'''bold'''</small>", "", ""] },
			{ selector: 'body > p > small', dsrContent: ["<small>'''bold'''</small>", "<small>", "</small>"] }
		],
	},
];
runTests('HTML elements', htmlEltTests);

var magicWordTests = [
];
runTests('Magic Words', magicWordTests);

var simpleTransclusionTests = [
];
runTests('Simple Transclusions', simpleTransclusionTests);

var citeTests = [
];
runTests('Cite', citeTests);

var extensionTests = [
];
runTests('Extensions', extensionTests);
