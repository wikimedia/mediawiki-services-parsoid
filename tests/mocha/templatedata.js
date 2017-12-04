/** Cases for spec'ing use of templatedata while converting HTML to wikitext */

'use strict';

/* global describe, it, before, after */

var fs = require('fs');
var yaml = require('js-yaml');
var request = require('supertest');
var path = require('path');
require('chai').should();

var serviceWrapper = require('../serviceWrapper.js');

var optionsPath = path.resolve(__dirname, './test.config.yaml');
var optionsYaml = fs.readFileSync(optionsPath, 'utf8');
var parsoidOptions = yaml.load(optionsYaml).services[0].conf;

var api, runner;
var defaultContentVersion = '1.6.0';
var mockDomain = 'customwiki';

function verifyTransformation(newHTML, origHTML, origWT, expectedWT, done, dpVersion) {
	var payload = { html: newHTML };
	if (origHTML) {
		payload.original = {
			revid: 1,
			title: 'Foo',
			wikitext: {
				headers: {
					'content-type': 'text/plain;profile="https://www.mediawiki.org/wiki/Specs/wikitext/1.0.0"',
				},
				body: origWT,
			},
			html: {
				headers: {
					'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/' + defaultContentVersion + '"',
				},
				body: origHTML,
			},
			// HACK! data-parsoid is no longer versioned independently.
			// Passing dummy data-parsoid since origHTML has inline data-parsoid.
			"data-parsoid": {
				headers: {
					'content-type': 'application/json;profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/' + (dpVersion || defaultContentVersion) + '"',
				},
				body: {
					'counter': 0,
					'ids': {},
				},
			},
		};
	}

	return request(api)
		.post(mockDomain + '/v3/transform/pagebundle/to/wikitext')
		.send(payload)
		.expect(function(res) {
			res.text.should.equal(expectedWT);
		})
		.end(done);
}

var tests = [
	// 1. Transclusions without template data
	{
		'name': 'Transclusions without template data',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f2","spc":[""," "," ","\\n"]},{"k":"f1","spc":[""," "," ","\\n"]}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"TplWithoutTemplateData\\n","href":"./Template:TplWithoutTemplateData"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{TplWithoutTemplateData\n|f2 = foo\n|f1 = foo\n}}',
			'new_content': '{{TplWithoutTemplateData|f1=foo|f2=foo}}',
			'edited':      '{{TplWithoutTemplateData\n|f2 = foo\n|f1 = BAR\n}}',
		},
	},

	// 2. normal
	{
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"f2"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"NoFormatWithParamOrder","href":"./Template:NoFormatWithParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{NoFormatWithParamOrder|f1=foo|f2=foo}}',
			'new_content': '{{NoFormatWithParamOrder|f1=foo|f2=foo}}',
			'edited':      '{{NoFormatWithParamOrder|f1=BAR|f2=foo}}',
		},
	},

	// 3. flipped f1 & f2 in data-parsoid
	{
		'name': 'Enforce param order',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f2"},{"k":"f1"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"NoFormatWithParamOrder","href":"./Template:NoFormatWithParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{NoFormatWithParamOrder|f2=foo|f1=foo}}',
			'new_content': '{{NoFormatWithParamOrder|f1=foo|f2=foo}}',
			'edited':      '{{NoFormatWithParamOrder|f1=BAR|f2=foo}}',
		},
	},

	// 4. inline-tpl (but written in block format originally); no param order
	{
		'name': 'Enforce inline format',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1","spc":[""," "," ","\\n"]},{"k":"f2","spc":[""," "," ","\\n"]}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"InlineTplNoParamOrder\\n","href":"./Template:InlineTplNoParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{InlineTplNoParamOrder\n|f1 = foo\n|f2 = foo\n}}',
			'new_content': '{{InlineTplNoParamOrder|f1=foo|f2=foo}}',
			'edited':      '{{InlineTplNoParamOrder|f1=BAR|f2=foo}}',
		},
	},

	// 5. block-tpl (but written in inline format originally); no param order
	{
		'name': 'Enforce block format',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"f2"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"BlockTplNoParamOrder","href":"./Template:BlockTplNoParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{BlockTplNoParamOrder|f1=foo|f2=foo}}',
			'new_content': '{{BlockTplNoParamOrder\n| f1 = foo\n| f2 = foo\n}}',
			'edited':      '{{BlockTplNoParamOrder\n| f1 = BAR\n| f2 = foo\n}}',
		},
	},

	// 6. block-tpl (with non-standard spaces before pipe); no param order
	{
		'name': 'Enforce block format (while preserving non-standard space before pipes)',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1","spc":[" ", " ", " ", "\\n <!--ha--> "]},{"k":"f2","spc":[" ", " ", " ", ""]}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"BlockTplNoParamOrder\\n ","href":"./Template:BlockTplNoParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{BlockTplNoParamOrder\n | f1 = foo\n <!--ha--> | f2 = foo}}',
			'new_content': '{{BlockTplNoParamOrder\n| f1 = foo\n| f2 = foo\n}}',
			'edited':      '{{BlockTplNoParamOrder\n| f1 = BAR\n <!--ha--> | f2 = foo\n}}',
		},
	},

	// 7. inline-tpl (but written in block format originally); with param order
	{
		'name': 'Enforce inline format + param order',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f2","spc":[""," "," ","\\n"]},{"k":"f1","spc":[""," "," ","\\n"]}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"InlineTplWithParamOrder\\n","href":"./Template:InlineTplWithParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{InlineTplWithParamOrder\n|f2 = foo\n|f1 = foo\n}}',
			'new_content': '{{InlineTplWithParamOrder|f1=foo|f2=foo}}',
			'edited':      '{{InlineTplWithParamOrder|f1=BAR|f2=foo}}',
		},
	},

	// 8. block-tpl (but written in inline format originally); with param order
	{
		'name': 'Enforce block format + param order',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f2"},{"k":"f1"}]]}' + "'" + ' data-mw=' + "'" + '{"parts":[{"template":{"target":{"wt":"BlockTplWithParamOrder","href":"./Template:BlockTplWithParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{BlockTplWithParamOrder|f2=foo|f1=foo}}',
			'new_content': '{{BlockTplWithParamOrder\n| f1 = foo\n| f2 = foo\n}}',
			'edited':      '{{BlockTplWithParamOrder\n| f1 = BAR\n| f2 = foo\n}}',
		},
	},

	// 9. Multiple transclusions
	{
		'name': 'Multiple transclusions',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f2","spc":[""," "," ","\\n"]},{"k":"f1","spc":[""," "," ","\\n"]}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"TplWithoutTemplateData\\n","href":"./Template:TplWithoutTemplateData"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>' + ' <span about="#mwt2" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f2"},{"k":"f1"}]]}' + "'" + ' data-mw=' + "'" + '{"parts":[{"template":{"target":{"wt":"BlockTplWithParamOrder","href":"./Template:BlockTplWithParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{TplWithoutTemplateData\n|f2 = foo\n|f1 = foo\n}} {{BlockTplWithParamOrder|f2=foo|f1=foo}}',
			'new_content': '{{TplWithoutTemplateData|f1=foo|f2=foo}} {{BlockTplWithParamOrder\n| f1 = foo\n| f2 = foo\n}}',
			'edited':      '{{TplWithoutTemplateData\n|f2 = foo\n|f1 = BAR\n}} {{BlockTplWithParamOrder|f2=foo|f1=foo}}',
		},
	},

	// 10. data-mw with multiple transclusions
	{
		'name': 'Multiple transclusions',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f2"},{"k":"f1"}], [{"k":"f2","spc":[""," "," ","\\n"]},{"k":"f1","spc":[""," "," ","\\n"]}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"BlockTplWithParamOrder","href":"./Template:BlockTplWithParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}},"SOME TEXT",{"template":{"target":{"wt":"InlineTplNoParamOrder\\n","href":"./Template:InlineTplNoParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":1}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{BlockTplWithParamOrder|f2=foo|f1=foo}}SOME TEXT{{InlineTplNoParamOrder\n|f2 = foo\n|f1 = foo\n}}',
			'new_content': '{{BlockTplWithParamOrder\n| f1 = foo\n| f2 = foo\n}}SOME TEXT{{InlineTplNoParamOrder|f1=foo|f2=foo}}',
			'edited':      '{{BlockTplWithParamOrder\n| f1 = BAR\n| f2 = foo\n}}SOME TEXT{{InlineTplNoParamOrder|f2=foo|f1=foo}}',
		},
	},

	// 11. Alias sort order
	{
		'name': 'Enforce param order with aliases',
		'html': '<span about="#mwt1" typeof="mw:Transclusion"' + " data-mw='" + '{"parts":[{"template":{"target":{"wt":"WithParamOrderAndAliases\\n","href":"./Template:WithParamOrderAndAliases"},"params":{"f2":{"wt":"foo"},"f3":{"wt":"foo"}},"i":1}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{WithParamOrderAndAliases|f3=foo|f2=foo}}',
			'new_content': '{{WithParamOrderAndAliases|f3=foo|f2=foo}}',
			'edited':      '{{WithParamOrderAndAliases|f3=foo|f2=BAR}}',
		},
	},
	// 12. Inline Formatted template 1
	{
		'html': 'x <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"x"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"InlineFormattedTpl_1","href":"./Template:InlineFormattedTpl_1"},"params":{"f1":{"wt":""},"x":{"wt":"foo"}},"i":0}}]}' + "'" + '>something</span> y',
		'wt': {
			'no_selser':   'x {{InlineFormattedTpl_1|f1=|x=foo}} y',
			'new_content': 'x {{InlineFormattedTpl_1|f1=|x=foo}} y',
			'edited':      'x {{InlineFormattedTpl_1|f1=|x=BAR}} y',
		},
	},
	// 13. Inline Formatted template 2
	{
		'html': 'x <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"x"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"InlineFormattedTpl_2","href":"./Template:InlineFormattedTpl_2"},"params":{"f1":{"wt":""},"x":{"wt":"foo"}},"i":0}}]}' + "'" + '>something</span> y',
		'wt': {
			'no_selser':   'x {{InlineFormattedTpl_2|f1=|x=foo}} y',
			'new_content': 'x \n{{InlineFormattedTpl_2 | f1 =  | x = foo}} y',
			'edited':      'x \n{{InlineFormattedTpl_2 | f1 =  | x = BAR}} y',
		},
	},
	// 14. Inline Formatted template 3
	{
		'html': 'x <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"x"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"InlineFormattedTpl_3","href":"./Template:InlineFormattedTpl_3"},"params":{"f1":{"wt":""},"x":{"wt":"foo"}},"i":0}}]}' + "'" + '>something</span> y',
		'wt': {
			'no_selser':   'x {{InlineFormattedTpl_3|f1=|x=foo}} y',
			'new_content': 'x {{InlineFormattedTpl_3| f1    = | x     = foo}} y',
			'edited':      'x {{InlineFormattedTpl_3| f1    = | x     = BAR}} y',
		},
	},
	// 15. Custom block formatting 1
	{
		'html': 'x<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"f2"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"BlockFormattedTpl_1","href":"./Template:BlockFormattedTpl_1"},"params":{"f1":{"wt":""},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>something</span>y',
		'wt': {
			'no_selser':   'x{{BlockFormattedTpl_1|f1=|f2=foo}}y', // data-parsoid spacing info is preserved
			'new_content': 'x{{BlockFormattedTpl_1\n| f1 = \n| f2 = foo\n}}y', // normalized
			'edited':      'x{{BlockFormattedTpl_1\n| f1 = \n| f2 = BAR\n}}y', // normalized
		},
	},
	// 16. Custom block formatting 2
	{
		'html': 'x<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"f2"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"BlockFormattedTpl_2","href":"./Template:BlockFormattedTpl_2"},"params":{"f1":{"wt":""},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>something</span>y',
		'wt': {
			'no_selser':   'x{{BlockFormattedTpl_2|f1=|f2=foo}}y', // data-parsoid spacing info is preserved
			'new_content': 'x\n{{BlockFormattedTpl_2\n| f1 = \n| f2 = foo\n}}\ny', // normalized
			'edited':      'x\n{{BlockFormattedTpl_2\n| f1 = \n| f2 = BAR\n}}\ny', // normalized
		},
	},
	// 17. Custom block formatting 3
	{
		'html': 'x<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"f2"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"BlockFormattedTpl_3","href":"./Template:BlockFormattedTpl_3"},"params":{"f1":{"wt":""},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>something</span>y',
		'wt': {
			'no_selser':   'x{{BlockFormattedTpl_3|f1=|f2=foo}}y', // data-parsoid spacing info is preserved
			'new_content': 'x{{BlockFormattedTpl_3|\n f1    = |\n f2    = foo}}y', // normalized
			'edited':      'x{{BlockFormattedTpl_3|\n f1    = |\n f2    = BAR}}y', // normalized
		},
	},
];

var dataParsoidVersionTests = [
	{
		'dpVersion': '0.0.1',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"f1"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"TplWithoutTemplateData","href":"./Template:TplWithoutTemplateData"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'orig':   '{{TplWithoutTemplateData|f1 = foo|f2 = foo}}',
			'edited': '{{TplWithoutTemplateData|f1 = BAR|f2 = foo}}',
		},
	},
	{
		'dpVersion': defaultContentVersion,
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"f1"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"TplWithoutTemplateData","href":"./Template:TplWithoutTemplateData"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'orig':   '{{TplWithoutTemplateData|f1=foo|f2=foo}}',
			'edited': '{{TplWithoutTemplateData|f1=BAR|f2=foo}}',
		},
	},
];

describe('[TemplateData]', function() {
	before(function() {
		return serviceWrapper.runServices({
			parsoidOptions: parsoidOptions,
		})
		.then(function(ret) {
			api = ret.parsoidURL;
			runner = ret.runner;
		});
	});

	tests.forEach(function(test, i) {
		var html = test.html;
		var name = 'Single Template Test ' + (i + 1);
		if (test.name) {
			name += ' (' + test.name + ')';
		}
		name += ': ';

		// Non-selser test
		it(name + 'Default non-selser serialization should ignore templatedata', function(done) {
			verifyTransformation(html, null, null, test.wt.no_selser, done);
		});

		// New content test
		it(name + 'Serialization of new content (no data-parsoid) should respect templatedata', function(done) {
			// Remove data-parsoid making it look like new content
			var newHTML = html.replace(/data-parsoid.*? data-mw/g, ' data-mw');
			verifyTransformation(newHTML, '', '', test.wt.new_content, done);
		});

		// Transclusion edit test
		it(name + 'Serialization of edited content should respect templatedata', function(done) {
			// Replace only the first instance of 'foo' with 'BAR'
			// to simulate an edit of a transclusion.
			var newHTML = html.replace(/foo/, 'BAR');
			verifyTransformation(newHTML, html, test.wt.no_selser, test.wt.edited, done);
		});
	});

	dataParsoidVersionTests.forEach(function(test) {
		it('Serialization should use correct arg space defaults for data-parsoid version ' + test.dpVersion, function(done) {
			// Replace only the first instance of 'foo' with 'BAR'
			// to simulate an edit of a transclusion.
			var newHTML = test.html.replace(/foo/, 'BAR');
			verifyTransformation(newHTML, test.html, test.wt.orig, test.wt.edited, done, test.dpVersion);
		});
	});

	after(function() {
		return runner.stop();
	});
});
