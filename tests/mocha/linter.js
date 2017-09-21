/** Test cases for the linter */

'use strict';

/* global describe, it */

require('../../core-upgrade.js');
require('chai').should();

var ParsoidConfig = require('../../lib/config/ParsoidConfig.js').ParsoidConfig;
var helpers = require('./test.helpers.js');

describe('Linter Tests', function() {
	// FIXME: MWParserEnvironment.getParserEnv and switchToConfig both require
	// mwApiMap to be setup. This forces us to load WMF config. Fixing this
	// will require some changes to ParsoidConfig and MWParserEnvironment.
	// Parsing the `[[file:...]]` tags below may also require running the
	// mock API to answer imageinfo queries.
	var parsoidConfig = new ParsoidConfig(null, { defaultWiki: 'enwiki', loadWMF: true, linting: true });
	var parseWT = function(wt, opts) {
		return helpers.parse(parsoidConfig, wt, opts).then(function(ret) {
			return ret.env.lintLogger.buffer;
		});
	};

	var expectEmptyResults = function(wt, opts) {
		return parseWT(wt, opts).then(function(result) {
			return result.should.be.empty;
		});
	};

	var expectLinterCategoryToBeAbsent = function(wt, cat) {
		return parseWT(wt).then(function(result) {
			result.forEach(function(r) {
				r.should.not.have.a.property("type", cat);
			});
		});
	};

	describe('#Issues', function() {
		it('should not lint any issues', function() {
			return expectEmptyResults('foo');
		});
	});

	describe('MISSING END TAGS', function() {
		it('should lint missing end tags correctly', function() {
			return parseWT('<div>foo').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].dsr.should.deep.equal([ 0, 8, 5, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "div");
			});
		});
		it('should lint missing end tags found in transclusions correctly', function() {
			return parseWT('{{1x|<div>foo<p>bar</div>}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].dsr.should.deep.equal([ 0, 27, null, null ]);
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "p");
			});
		});
	});

	describe('STRIPPED TAGS', function() {
		it('should lint stripped tags correctly', function() {
			return parseWT('foo</div>').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "stripped-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "DIV");
				result[0].dsr.should.deep.equal([ 3, 9, null, null ]);
			});
		});
		it('should lint stripped tags found in transclusions correctly', function() {
			return parseWT('{{1x|<div>foo</div></div>}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "stripped-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "DIV");
				result[0].dsr.should.deep.equal([ 0, 27, null, null ]);
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
		it('should lint stripped tags correctly in misnested tag situations (</i> is stripped)', function() {
			return parseWT('<b><i>X</b></i>').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misnested-tag");
				result[0].dsr.should.deep.equal([ 3, 7, 3, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "i");
			});
		});
		it('should lint stripped tags correctly in misnested tag situations from template (</i> is stripped)', function() {
			return parseWT('{{1x|<b><i>X</b></i>}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misnested-tag");
				result[0].dsr.should.deep.equal([ 0, 22, null, null ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "i");
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
		it('should lint stripped tags correctly in misnested tag situations (<i> is auto-inserted)', function() {
			return parseWT('<b><i>X</b>Y</i>').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misnested-tag");
				result[0].dsr.should.deep.equal([ 3, 7, 3, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "i");
			});
		});
		it('should lint stripped tags correctly in misnested tag situations (skip over empty autoinserted <small></small>)', function() {
			return parseWT('*a<small>b\n*c</small>d').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misnested-tag");
				result[0].dsr.should.deep.equal([ 2, 10, 7, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "small");
			});
		});
		it('should lint stripped tags correctly in misnested tag situations (formatting tags around lists, but ok for div)', function() {
			return parseWT('<small>a\n*b\n*c\nd</small>\n<div>a\n*b\n*c\nd</div>').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misnested-tag");
				result[0].dsr.should.deep.equal([ 0, 8, 7, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "small");
			});
		});
	});

	describe('OBSOLETE TAGS', function() {
		it('should lint obsolete tags correctly', function() {
			return parseWT('<tt>foo</tt>bar').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "obsolete-tag");
				result[0].dsr.should.deep.equal([ 0, 12, 4, 5 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "tt");
			});
		});
		it('should not lint big as an obsolete tag', function() {
			return expectEmptyResults('<big>foo</big>bar');
		});
		it('should lint obsolete tags found in transclusions correctly', function() {
			return parseWT('{{1x|<div><tt>foo</tt></div>}}foo').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "obsolete-tag");
				result[0].dsr.should.deep.equal([ 0, 30, null, null ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "tt");
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
		it('should not lint auto-inserted obsolete tags', function() {
			return parseWT('<tt>foo\n\n\nbar').then(function(result) {
				// obsolete-tag and missing-end-tag
				result.should.have.length(2);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[1].should.have.a.property("type", "obsolete-tag");
				result[1].dsr.should.deep.equal([ 0, 7, 4, 0 ]);
				result[1].should.have.a.property("params");
				result[1].params.should.have.a.property("name", "tt");
			});
		});
		it('should not have template info for extension tags', function() {
			return parseWT('<gallery>\nFile:Test.jpg|<tt>foo</tt>\n</gallery>')
			.then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property('type', 'obsolete-tag');
				result[0].should.not.have.a.property('templateInfo');
				result[0].dsr.should.deep.equal([ 0, 47, 2, 2 ]);
			});
		});
	});

	describe('FOSTERED CONTENT', function() {
		it('should lint fostered content correctly', function() {
			return parseWT('{|\nfoo\n|-\n| bar\n|}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "fostered");
				result[0].dsr.should.deep.equal([ 0, 18, 2, 2 ]);
			});
		});
		it('should not lint fostered categories', function() {
			return expectEmptyResults('{|\n[[Category:Fostered]]\n|-\n| bar\n|}');
		});
		it('should not lint fostered behavior switches', function() {
			return expectEmptyResults('{|\n__NOTOC__\n|-\n| bar\n|}');
		});
		it('should not lint fostered include directives without fostered content', function() {
			return expectEmptyResults('{|\n<includeonly>boo</includeonly>\n|-\n| bar\n|}');
		});
		it('should lint fostered include directives that has fostered content', function() {
			return parseWT('{|\n<noinclude>boo</noinclude>\n|-\n| bar\n|}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "fostered");
			});
		});
	});

	describe('IGNORED TABLE ATTRIBUTES', function() {
		it('should lint ignored table attributes correctly', function() {
			return parseWT('{|\n|- foo\n|bar\n|}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "ignored-table-attr");
				result[0].dsr.should.deep.equal([ 3, 14, 6, 0 ]);
			});
		});
		it('should lint ignored table attributes found in transclusions correctly', function() {
			return parseWT('{{1x|\n{{{!}}\n{{!}}- foo\n{{!}} bar\n{{!}}}\n}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "ignored-table-attr");
				result[0].dsr.should.deep.equal([ 0, 43, null, null]);
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
		it('should not lint whitespaces as ignored table attributes', function() {
			return expectEmptyResults('{|\n|- \n| 1 ||style="text-align:left;"| p \n|}');
		});
		it('should lint as ignored table attributes', function() {
			return parseWT('{|\n|- <!--bad attr-->attr\n|bar\n|}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "ignored-table-attr");
				result[0].dsr.should.deep.equal([ 3, 30, 22, 0 ]);
			});
		});
	});

	describe('BOGUS IMAGE OPTIONS', function() {
		it('should lint Bogus image options correctly', function() {
			return parseWT('[[file:a.jpg|foo|bar]]').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "bogus-image-options");
				result[0].dsr.should.deep.equal([ 0, 22, null, null ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("items");
				result[0].params.items.should.include.members(["foo"]);
			});
		});
		it('should lint Bogus image options found in transclusions correctly', function() {
			return parseWT('{{1x|[[file:a.jpg|foo|bar]]}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "bogus-image-options");
				result[0].dsr.should.deep.equal([ 0, 29, null, null ]);
				result[0].should.have.a.property("params");
				result[0].params.items.should.include.members(["foo"]);
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
		it('should batch lint Bogus image options correctly', function() {
			return parseWT('[[file:a.jpg|foo|bar|baz]]').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "bogus-image-options");
				result[0].dsr.should.deep.equal([ 0, 26, null, null ]);
				result[0].should.have.a.property("params");
				result[0].params.items.should.include.members(["foo", "bar"]);
			});
		});
		it('should not send any Bogus image options if there are none', function() {
			return expectEmptyResults('[[file:a.jpg|foo]]');
		});
		it('should flag noplayer, noicon, and disablecontrols as bogus options', function() {
			return parseWT('[[File:Video.ogv|noplayer|noicon|disablecontrols=ok|These are bogus.]]')
			.then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "bogus-image-options");
				result[0].dsr.should.deep.equal([ 0, 70, null, null ]);
				result[0].should.have.a.property("params");
				result[0].params.items.should.include.members(["noplayer", "noicon", "disablecontrols=ok"]);
			});
		});
		it('should not crash on gallery images', function() {
			return expectEmptyResults('<gallery>\nfile:a.jpg\n</gallery>');
		});
	});

	describe('SELF-CLOSING TAGS', function() {
		it('should lint self-closing tags corrrectly', function() {
			return parseWT('foo<b />bar<span />baz<hr />boo<br /> <ref name="boo" />').then(function(result) {
				result.should.have.length(2);
				result[0].should.have.a.property("type", "self-closed-tag");
				result[0].dsr.should.deep.equal([ 3, 8, 5, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "b");
				result[1].should.have.a.property("type", "self-closed-tag");
				result[1].dsr.should.deep.equal([ 11, 19, 8, 0 ]);
				result[1].should.have.a.property("params");
				result[1].params.should.have.a.property("name", "span");
			});
		});
		it('should lint self-closing tags in a template correctly', function() {
			return parseWT('{{1x|<b /> <ref name="boo" />}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "self-closed-tag");
				result[0].dsr.should.deep.equal([ 0, 31, null, null ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "b");
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
	});

	describe('MIXED-CONTENT TEMPLATES', function() {
		it('should lint mixed-content templates', function() {
			return parseWT('{{1x|*}}hi').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "mixed-content");
				result[0].dsr.should.deep.equal([ 0, 10, null, null ]);
			});
		});
		it('should lint multi-template', function() {
			return parseWT('{{1x|*}}{{1x|hi}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "multi-template");
				result[0].dsr.should.deep.equal([ 0, 17, null, null ]);
			});
		});
	});

	describe('DELETABLE TABLE TAG', function() {
		it('should identify deletable table tag for T161341 (1)', function() {
			var wt = [
				"{| style='border:1px solid red;'",
				"|a",
				"|-",
				"{| style='border:1px solid blue;'",
				"|b",
				"|c",
				"|}",
				"|}",
			].join('\n');
			return parseWT(wt).then(function(result) {
				result.should.have.length(2);
				result[0].should.have.a.property("type", "deletable-table-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "table");
				result[0].dsr.should.deep.equal([ 39, 72, 0, 0 ]);
			});
		});
		it('should identify deletable table tag for T161341 (2)', function() {
			var wt = [
				"{| style='border:1px solid red;'",
				"|a",
				"|-  ",
				"   <!--boo-->   ",
				"{| style='border:1px solid blue;'",
				"|b",
				"|c",
				"|}",
			].join('\n');
			return parseWT(wt).then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "deletable-table-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "table");
				result[0].dsr.should.deep.equal([ 58, 91, 0, 0 ]);
			});
		});
		it('should identify deletable table tag for T161341 (3)', function() {
			var wt = [
				"{{1x|{{{!}}",
				"{{!}}a",
				"{{!}}-",
				"{{{!}}",
				"{{!}}b",
				"{{!}}c",
				"{{!}}}",
				"}}",
			].join('\n');
			return parseWT(wt).then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "deletable-table-tag");
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
				result[0].dsr.should.deep.equal([ 0, 56, null, null ]);
			});
		});
		it('should identify deletable table tag for T161341 (4)', function() {
			var wt = [
				"{{1x|{{{!}}",
				"{{!}}a",
				"{{!}}-",
				"}}",
				"{|",
				"|b",
				"|c",
				"|}",
			].join('\n');
			return parseWT(wt).then(function(result) {
				result.should.have.length(2);
				result[1].should.have.a.property("type", "deletable-table-tag");
				result[1].should.not.have.a.property("templateInfo");
				result[1].should.have.a.property("params");
				result[1].params.should.have.a.property("name", "table");
				result[1].dsr.should.deep.equal([ 29, 31, 0, 0 ]);
			});
		});
	});

	describe('PWRAP BUG WORKAROUND', function() {
		it('should identify rendering workarounds needed for doBlockLevels bug', function() {
			var wt = [
				"<div><span style='white-space:nowrap'>",
				"a",
				"</span>",
				"</div>",
			].join('\n');
			return parseWT(wt).then(function(result) {
				result.should.have.length(3);
				result[1].should.have.a.property("type", "pwrap-bug-workaround");
				result[1].should.not.have.a.property("templateInfo");
				result[1].should.have.a.property("params");
				result[1].params.should.have.a.property("root", "DIV");
				result[1].params.should.have.a.property("child", "SPAN");
				result[1].dsr.should.deep.equal([ 5, 48, 33, 0 ]);
			});
		});
		it('should not lint doBlockLevels bug rendering workarounds if newline break is present', function() {
			var wt = [
				"<div>",
				"<span style='white-space:nowrap'>",
				"a",
				"</span>",
				"</div>",
			].join('\n');
			return expectLinterCategoryToBeAbsent(wt, "pwrap-bug-workaround");
		});
		it('should not lint doBlockLevels bug rendering workarounds if nowrap CSS is not present', function() {
			var wt = [
				"<div><span>",
				"a",
				"</span>",
				"</div>",
			].join('\n');
			return expectLinterCategoryToBeAbsent(wt, "pwrap-bug-workaround");
		});
		it('should not lint doBlockLevels bug rendering workarounds where not required', function() {
			var wt = [
				"<div><small style='white-space:nowrap'>",
				"a",
				"</small>",
				"</div>",
			].join('\n');
			return expectLinterCategoryToBeAbsent(wt, "pwrap-bug-workaround");
		});
	});

	describe('TIDY WHITESPACE BUG', function() {
		var wt1 = [
			// Basic with inline CSS + text sibling
			"<span style='white-space:nowrap'>a </span>",
			"x",
			// Basic with inline CSS + span sibling
			"<span style='white-space:nowrap'>a </span>",
			"<span>x</span>",
			// Basic with class CSS + text sibling
			"<span class='nowrap'>a </span>",
			"x",
			// Basic with class CSS + span sibling
			"<span class='nowrap'>a </span>",
			"<span>x</span>",
			// Comments shouldn't trip it up
			"<span style='white-space:nowrap'>a<!--boo--> <!--boo--></span>",
			"<!--boo-->",
			"<span>x</span>",
		].join('');

		it('should detect problematic whitespace hoisting', function() {
			var tweakEnv = function(env) {
				env.conf.parsoid.linter.tidyWhitespaceBugMaxLength = 0;
			};
			return parseWT(wt1, { tweakEnv: tweakEnv }).then(function(result) {
				result.should.have.length(5);
				result.forEach(function(r) {
					r.should.have.a.property('type', 'tidy-whitespace-bug');
					r.params.should.have.a.property('node', 'SPAN');
				});
				result[0].params.should.have.a.property("sibling", "#text");
				result[1].params.should.have.a.property("sibling", "SPAN");
				result[2].params.should.have.a.property("sibling", "#text");
				result[3].params.should.have.a.property("sibling", "SPAN");
				result[4].params.should.have.a.property("sibling", "#comment");
				// skipping dsr tests
			});
		});

		it('should not detect problematic whitespace hoisting for short text runs', function() {
			// Nothing to trigger here
			var tweakEnv = function(env) {
				env.conf.parsoid.linter.tidyWhitespaceBugMaxLength = 100;
			};
			return expectEmptyResults(wt1, { tweakEnv: tweakEnv });
		});

		var wt2 = [
			"some unaffected text here ",
			"<span style='white-space:nowrap'>a </span>",
			"<span style='white-space:nowrap'>bb</span>",
			"<span class='nowrap'>cc</span>",
			"<span class='nowrap'>d </span>",
			"<span style='white-space:nowrap'>e </span>",
			"<span class='nowrap'>x</span>",
		].join('');

		it('should flag tidy whitespace bug on a run of affected content', function() {
			// The run length is 11 chars in the example above
			var tweakEnv = function(env) {
				env.conf.parsoid.linter.tidyWhitespaceBugMaxLength = 5;
			};
			return parseWT(wt2, { tweakEnv: tweakEnv }).then(function(result) {
				result.should.have.length(3);
				result.forEach(function(r) {
					r.should.have.a.property('type', 'tidy-whitespace-bug');
					r.params.should.have.a.property('node', 'SPAN');
				});
				result[0].params.should.have.a.property("sibling", "SPAN"); // 1st span
				result[0].dsr.should.deep.equal([ 26, 68, 33, 7 ]);
				result[1].params.should.have.a.property("sibling", "SPAN"); // 4th span
				result[1].dsr.should.deep.equal([ 140, 170, 21, 7 ]);
				result[2].params.should.have.a.property("sibling", "SPAN"); // 5th span
				result[2].dsr.should.deep.equal([ 170, 212, 33, 7 ]);
			});
		});

		it('should not flag tidy whitespace bug on a run of short affected content', function() {
			// The run length is 11 chars in the example above
			var tweakEnv = function(env) {
				env.conf.parsoid.linter.tidyWhitespaceBugMaxLength = 12;
			};
			return expectEmptyResults(wt2, { tweakEnv: tweakEnv });
		});

		it('should account for preceding text content', function() {
			// The run length is 11 chars in the example above
			var tweakEnv = function(env) {
				env.conf.parsoid.linter.tidyWhitespaceBugMaxLength = 12;
			};
			// Run length changes to 16 chars because of preceding text
			wt2 = wt2.replace(/some unaffected text here /, 'some unaffected text HERE-');
			return parseWT(wt2, { tweakEnv: tweakEnv }).then(function(result) {
				result.should.have.length(3);
				result.forEach(function(r) {
					r.should.have.a.property('type', 'tidy-whitespace-bug');
					r.params.should.have.a.property('node', 'SPAN');
				});
				result[0].params.should.have.a.property("sibling", "SPAN"); // 1st span
				result[0].dsr.should.deep.equal([ 26, 68, 33, 7 ]);
				result[1].params.should.have.a.property("sibling", "SPAN"); // 4th span
				result[1].dsr.should.deep.equal([ 140, 170, 21, 7 ]);
				result[2].params.should.have.a.property("sibling", "SPAN"); // 5th span
				result[2].dsr.should.deep.equal([ 170, 212, 33, 7 ]);
			});
		});

		it('should not flag tidy whitespace bug where it does not matter', function() {
			var wt = [
				// No CSS
				"<span>",
				"a ",
				"</span>",
				"<span>x</span>",
				// No trailing white-space
				"<span class='nowrap'>",
				"a",
				"</span>",
				"x",
				// White-space follows
				"<span class='nowrap'>",
				"a ",
				"</span>",
				" ",
				"<span>x</span>",
				// White-space follows
				"<span style='white-space:nowrap'>",
				"a ",
				"</span>",
				"<!--boo--> boo",
				"<span>x</span>",
				// Block tag
				"<div class='nowrap'>",
				"a ",
				"</div>",
				"<span>x</span>",
				// Block tag sibling
				"<span class='nowrap'>",
				"a ",
				"</span>",
				"<div>x</div>",
				// No next sibling
				"<span class='nowrap'>",
				"a ",
				"</span>",
			].join('');
			var tweakEnv = function(env) {
				env.conf.parsoid.linter.tidyWhitespaceBugMaxLength = 0;
			};
			return expectEmptyResults(wt, { tweakEnv: tweakEnv });
		});
	});
});
