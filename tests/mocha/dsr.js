'use strict';
/*global describe, it, before*/

require('../../core-upgrade.js');

var should = require("chai").should();
var url = require('url');
var DU = require('../../lib/utils/DOMUtils.js').DOMUtils;
var ParsoidConfig = require('../../lib/config/ParsoidConfig.js').ParsoidConfig;
var helpers = require('./test.helpers.js');

/*
 * For every test with a 'wt' property, provide the 'spec' property that is
 * an array of DSR specs that need to be verified on the parsed output of 'wt'.
 * Every spec should have:
 *   selector: a CSS selector for picking a DOM node in the parsed output.
 *   dsrContent: a 3-element array. The first element is the wikitext corresponding
 *               to the wikiext substring between dsr[0]..dsr[1]. The second and
 *               third elements are the opening/closing wikitext tag for that node.
 */
var simpleParaTests = [
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

var listTests = [
	{
		wt: '*a\n*b',
		specs: [
			{ selector: 'ul', dsrContent: ['*a\n*b', '', ''] },
			{ selector: 'ul > li:nth-child(1)', dsrContent: ['*a', '*', ''] },
			{ selector: 'ul > li:nth-child(2)', dsrContent: ['*b', '*', ''] },
		],
	},
];

var allTests = simpleParaTests.concat(listTests);

var parsoidConfig = new ParsoidConfig(null, { defaultWiki: 'enwiki' });
var parse = function(src, options) {
	return helpers.parse(parsoidConfig, src, options).then(function(ret) {
		return ret.doc;
	});
};

function validateSpec(wt, doc, spec) {
	var body = doc.body;
	var elts = body.querySelectorAll(spec.selector);
	elts.length.should.equal(1);
	var dp = DU.getDataParsoid(elts[0]);
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

describe('DSR assignment', function() {
	allTests.forEach(function(test) {
		var wt = test.wt;
		it('should be valid for ' + JSON.stringify(wt), function() {
			return parse(wt).then(function(doc) {
				test.specs.forEach(validateSpec.bind(null, wt, doc));
			});
		});
	});
});
