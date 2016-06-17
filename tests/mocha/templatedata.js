/** Cases for spec'ing use of templatedata while converting HTML to wikitext */
'use strict';
/*global describe, it, before*/

var apiServer = require('../apiServer.js');
var request = require('supertest');
var path = require('path');
require('chai').should();

var configPath = path.resolve(__dirname, './apitest.localsettings.js');
var fakeConfig = {
	setMwApi: function() {},
	limits: { wt2html: {}, html2wt: {} },
	timeouts: { mwApi: {} },
};
require(configPath).setup(fakeConfig);  // Set limits

var api;

function verifyTransformation(newHTML, origHTML, origWT, expectedWT, done, dpVersion) {
	// Default version is the latest
	if (!dpVersion) {
		dpVersion = '0.0.2';
	}

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
					'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"',
				},
				body: origHTML,
			},
			// HACK! Passing dummy data-parsoid since origHTML has inline data-parsoid.
			// Without the dummy data-parsoid, we scream murder.
			"data-parsoid": {
				headers: {
					'content-type': 'application/json;profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/' + dpVersion + '"',
				},
				body: {
					'counter': 0,
					'ids': {},
				},
			},
		};
	}

	return request(api)
		.post('mock.domain/v3/transform/html/to/wikitext')
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
			'edited':      '{{InlineTplNoParamOrder|f1 = BAR|f2 = foo}}',
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
			'new_content': '{{BlockTplNoParamOrder\n | f1 = foo\n| f2 = foo\n}}',
			'edited':      '{{BlockTplNoParamOrder\n | f1 = BAR\n <!--ha--> | f2 = foo\n}}',
		},
	},

	// 7. inline-tpl (but written in block format originally); with param order
	{
		'name': 'Enforce inline format + param order',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f2","spc":[""," "," ","\\n"]},{"k":"f1","spc":[""," "," ","\\n"]}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"InlineTplWithParamOrder\\n","href":"./Template:InlineTplWithParamOrder"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'no_selser':   '{{InlineTplWithParamOrder\n|f2 = foo\n|f1 = foo\n}}',
			'new_content': '{{InlineTplWithParamOrder|f1=foo|f2=foo}}',
			'edited':      '{{InlineTplWithParamOrder|f1 = BAR|f2 = foo}}',
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
			'edited':      '{{BlockTplWithParamOrder\n| f1 = BAR\n| f2 = foo\n}}SOME TEXT{{InlineTplNoParamOrder|f2 = foo|f1 = foo}}',
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
		'dpVersion': '0.0.2',
		'html': '<span about="#mwt1" typeof="mw:Transclusion" data-parsoid=' + "'" + '{"pi":[[{"k":"f1"},{"k":"f1"}]]}' + "' data-mw='" + '{"parts":[{"template":{"target":{"wt":"TplWithoutTemplateData","href":"./Template:TplWithoutTemplateData"},"params":{"f1":{"wt":"foo"},"f2":{"wt":"foo"}},"i":0}}]}' + "'" + '>foo</span>',
		'wt': {
			'orig':   '{{TplWithoutTemplateData|f1=foo|f2=foo}}',
			'edited': '{{TplWithoutTemplateData|f1=BAR|f2=foo}}',
		},
	},
];

describe('[TemplateData]', function() {
	before(function() {
		var p = apiServer.startMockAPIServer({}).then(function(ret) {
			return apiServer.startParsoidServer({
				mockUrl: ret.url,
				serverArgv: [
					'--num-workers', '1',
					'--config', configPath,
				],
			});
		}).then(function(ret) {
			api = ret.url;
		});
		apiServer.exitOnProcessTerm();
		return p;
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
});
