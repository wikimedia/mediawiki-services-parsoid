'use strict';

/* global describe, it */

require('../../core-upgrade.js');

require("chai").should();
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

function validateId(expectedIds, doc) {
	var body = doc.body;
	var elts = body.querySelectorAll('body > h1');
	elts.length.should.equal(expectedIds.length);
	expectedIds.forEach(function(id, i) {
		var h = elts[i];
		var fallback = h.querySelectorAll('span[typeof="mw:FallbackId"]:empty');
		if (typeof id === 'string') {
			h.getAttribute('id').should.equal(id);
			fallback.length.should.equal(0);
		} else {
			h.getAttribute('id').should.equal(id[0]);
			fallback.length.should.equal(1);
			fallback[0].getAttribute('id').should.equal(id[1]);
		}
	});
}

function runTests(name, tests, description) {
	describe('Id Assignment: ' + name, function() {
		tests.forEach(function(test) {
			var heading = test.shift();
			var expectedIds = test;
			it(description + ' ' + JSON.stringify(heading) + ' (ids=' + expectedIds.join(',') + ')', function() {
				return parse(heading).then(function(doc) {
					validateId(expectedIds, doc);
				});
			});
		});
	});
}

var simpleHeadings = [
	[ '=Test=', 'Test' ],
	[ '=Test 1 2 3=', 'Test_1_2_3' ],
	[ '=   Test   1 _2   3  =', 'Test_1_2_3' ],
];
runTests('Simple Headings', simpleHeadings, 'should be valid for');

var headingsWithWtChars = [
	[ '=This is a [[Link]]=', 'This_is_a_Link' ],
	[ "=Some '''bold''' and '''italic''' text=", 'Some_bold_and_italic_text' ],
	[ "=Some {{1x|transclusion}} here=", 'Some_transclusion_here' ],
	[ "={{1x|1=a and ''b'' and [[c]] and {{1x|1=d}} and e}}=", "a_and_b_and_c_and_d_and_e"],
	[ "=Some {{convert|1|km}} here=", ["Some_1_kilometre_(0.62_mi)_here","Some_1_kilometre_.280.62_mi.29_here"]],
];
runTests('Headings with wikitext', headingsWithWtChars, 'wikitext chars should be ignored in');

var headingsWithHTML = [
	[ "=Some <span>html</span> <b>tags</b> here=", 'Some_html_tags_here' ],
	/* PHP parser output is a bit weird on a heading with these contents */
	[ "=a <div>b <span>c</span>d</div> e=", 'a_b_cd_e' ],
];
runTests('Headings with HTML', headingsWithHTML, 'HTML tags should be stripped in');

var headingsWithEntities = [
	[ '=Red, Blue, Yellow=', ['Red,_Blue,_Yellow','Red.2C_Blue.2C_Yellow']],
	[ '=!@#$%^&*()=', ['!@#$%^&*()',".21.40.23.24.25.5E.26.2A.28.29"]],
	[ '=:=', ":"],
];
runTests('Headings with Entities', headingsWithEntities, 'Entities should be encoded');

var nonEnglishHeadings = [
	[ "=Références=", ['Références', "R.C3.A9f.C3.A9rences"]],
	[ "=बादलों का वगीर्करण=",['बादलों_का_वगीर्करण',".E0.A4.AC.E0.A4.BE.E0.A4.A6.E0.A4.B2.E0.A5.8B.E0.A4.82_.E0.A4.95.E0.A4.BE_.E0.A4.B5.E0.A4.97.E0.A5.80.E0.A4.B0.E0.A5.8D.E0.A4.95.E0.A4.B0.E0.A4.A3" ]],
];
runTests('Headings with non English characters', nonEnglishHeadings, 'Ids should be valid');

var edgeCases = [
	[ '=a=\n=a=', 'a', 'a_2' ],
	[ '=a/b=\n=a.2Fb=', ['a/b','a.2Fb'], 'a.2Fb_2' ],
	[ "<h1 id='bar'>foo</h1>", 'bar' ],
	[ "<h1>foo</h1>\n=foo=\n<h1 id='foo'>bar</h1>", 'foo', 'foo_2', 'foo_3' ],
];
runTests('Edge Case Tests:', edgeCases, 'Ids should be valid');
