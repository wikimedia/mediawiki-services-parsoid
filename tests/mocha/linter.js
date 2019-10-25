/** Test cases for the linter */

'use strict';

/* global describe, it */

require('../../core-upgrade.js');
require('chai').should();

var ParsoidConfig = require('../../lib/config/ParsoidConfig.js').ParsoidConfig;
var Util = require('../../lib/utils/Util.js').Util;
var helpers = require('./test.helpers.js');

describe('Linter Tests', function() {
	// FIXME: MWParserEnvironment.getParserEnv and switchToConfig both require
	// mwApiMap to be setup. This forces us to load WMF config. Fixing this
	// will require some changes to ParsoidConfig and MWParserEnvironment.
	// Parsing the `[[file:...]]` tags below may also require running the
	// mock API to answer imageinfo queries.
	var parsoidConfig = new ParsoidConfig(null, {
		loadWMF: true,
		linting: true,
		defaultWiki: 'enwiki',
	});
	// Undo freezing so we can tweak it below
	parsoidConfig.linter = Util.clone(parsoidConfig.linter);
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

	var noLintsOfThisType = function(wt, type) {
		return parseWT(wt).then(function(result) {
			result.forEach(function(r) {
				r.should.not.have.a.property("type", type);
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
		it('should lint missing end tags for quotes correctly', function() {
			return parseWT("'''foo").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].dsr.should.deep.equal([ 0, 6, 3, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "b");
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
		it('should not flag tags where end tags are optional in the spec', function() {
			return expectEmptyResults('<ul><li>x<li>y</ul><table><tr><th>heading 1<tr><td>col 1<td>col 2</table>');
		});
	});

	describe('STRIPPED TAGS', function() {
		it('should lint stripped tags correctly', function() {
			return parseWT('foo</div>').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "stripped-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "div");
				result[0].dsr.should.deep.equal([ 3, 9, null, null ]);
			});
		});
		it('should lint stripped tags found in transclusions correctly', function() {
			return parseWT('{{1x|<div>foo</div></div>}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "stripped-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "div");
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
				result[0].dsr.should.deep.equal([ 24, 36, 4, 5 ]);
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
				result.should.have.length(1);
				result[0].should.have.a.property("type", "deletable-table-tag");
				result[0].should.not.have.a.property("templateInfo");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "table");
				result[0].dsr.should.deep.equal([ 29, 31, 0, 0 ]);
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
				result[1].params.should.have.a.property("root", "div");
				result[1].params.should.have.a.property("child", "span");
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
					r.params.should.have.a.property('node', 'span');
				});
				result[0].params.should.have.a.property("sibling", "#text");
				result[1].params.should.have.a.property("sibling", "span");
				result[2].params.should.have.a.property("sibling", "#text");
				result[3].params.should.have.a.property("sibling", "span");
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
					r.params.should.have.a.property('node', 'span');
				});
				result[0].params.should.have.a.property("sibling", "span"); // 1st span
				result[0].dsr.should.deep.equal([ 26, 68, 33, 7 ]);
				result[1].params.should.have.a.property("sibling", "span"); // 4th span
				result[1].dsr.should.deep.equal([ 140, 170, 21, 7 ]);
				result[2].params.should.have.a.property("sibling", "span"); // 5th span
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
					r.params.should.have.a.property('node', 'span');
				});
				result[0].params.should.have.a.property("sibling", "span"); // 1st span
				result[0].dsr.should.deep.equal([ 26, 68, 33, 7 ]);
				result[1].params.should.have.a.property("sibling", "span"); // 4th span
				result[1].dsr.should.deep.equal([ 140, 170, 21, 7 ]);
				result[2].params.should.have.a.property("sibling", "span"); // 5th span
				result[2].dsr.should.deep.equal([ 170, 212, 33, 7 ]);
			});
		});

		it('should not flag tidy whitespace bug where it does not matter', function() {
			var wt = [
				// No CSS
				"<span>a </span>",
				"<span>x</span>",
				// No trailing white-space
				"<span class='nowrap'>a</span>",
				"x",
				// White-space follows
				"<span class='nowrap'>a </span>",
				" ",
				"<span>x</span>",
				// White-space follows
				"<span style='white-space:nowrap'>a </span>",
				"<!--boo--> boo",
				"<span>x</span>",
				// Block tag
				"<div class='nowrap'>a </div>",
				"<span>x</span>",
				// Block tag sibling
				"<span class='nowrap'>a </span>",
				"<div>x</div>",
				// br sibling
				"<span class='nowrap'>a </span>",
				"<br/>",
				// No next sibling
				"<span class='nowrap'>a </span>",
			].join('');
			var tweakEnv = function(env) {
				env.conf.parsoid.linter.tidyWhitespaceBugMaxLength = 0;
			};
			return expectEmptyResults(wt, { tweakEnv: tweakEnv });
		});
	});

	describe('MULTIPLE COLON ESCAPE', function() {
		it('should lint links prefixed with multiple colons', function() {
			return parseWT('[[None]]\n[[:One]]\n[[::Two]]\n[[:::Three]]')
			.then(function(result) {
				result.should.have.length(2);
				result[0].dsr.should.deep.equal([ 18, 27 ]);
				result[0].should.have.a.property('params');
				result[0].params.should.have.a.property('href', '::Two');
				result[1].dsr.should.deep.equal([ 28, 40 ]);
				result[1].should.have.a.property('params');
				result[1].params.should.have.a.property('href', ':::Three');
			});
		});
		it('should lint links prefixed with multiple colons from templates', function() {
			return parseWT('{{1x|[[:One]]}}\n{{1x|[[::Two]]}}')
			.then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property('templateInfo');
				result[0].templateInfo.should.have.a.property('name', 'Template:1x');
				// TODO(arlolra): Frame doesn't have tsr info yet
				result[0].dsr.should.deep.equal([ 0, 0 ]);
				result[0].should.have.a.property('params');
				result[0].params.should.have.a.property('href', '::Two');
			});
		});
	});

	describe('HTML5 MISNESTED TAGS', function() {
		it('should not trigger html5 misnesting if there is no following content', function() {
			return parseWT('<del>foo\nbar').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "del");
			});
		});
		it('should trigger html5 misnesting correctly', function() {
			return parseWT('<del>foo\n\nbar').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "html5-misnesting");
				result[0].dsr.should.deep.equal([ 0, 8, 5, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "del");
			});
		});
		it('should trigger html5 misnesting for span (1)', function() {
			return parseWT('<span>foo\n\nbar').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "html5-misnesting");
				result[0].dsr.should.deep.equal([ 0, 9, 6, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "span");
			});
		});
		it('should trigger html5 misnesting for span (2)', function() {
			return parseWT('<span>foo\n\n<div>bar</div>').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "html5-misnesting");
				result[0].dsr.should.deep.equal([ 0, 9, 6, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "span");
			});
		});
		it('should trigger html5 misnesting for span (3)', function() {
			return parseWT('<span>foo\n\n{|\n|x\n|}\nboo').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "html5-misnesting");
				result[0].dsr.should.deep.equal([ 0, 9, 6, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "span");
			});
		});
		it('should not trigger html5 misnesting when there is no misnested content', function() {
			return parseWT('<span>foo\n\n</span>y').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misnested-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "span");
			});
		});
		it('should not trigger html5 misnesting when unclosed tag is inside a td/th/heading tags', function() {
			return parseWT('=<span id="1">x=\n{|\n!<span id="2">z\n|-\n|<span>id="3"\n|}').then(function(result) {
				result.should.have.length(3);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[1].should.have.a.property("type", "missing-end-tag");
				result[2].should.have.a.property("type", "missing-end-tag");
			});
		});
		it('should not trigger html5 misnesting when misnested content is outside an a-tag (without link-trails)', function() {
			return parseWT('[[Foo|<span>foo]]Bar</span>').then(function(result) {
				result.should.have.length(2);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "span");
				result[1].should.have.a.property("type", "stripped-tag");
			});
		});
		// Note that this is a false positive because of T177086 and fixing that will fix this.
		// We expect this to be an edge case.
		it('should trigger html5 misnesting when linktrails brings content inside an a-tag', function() {
			return parseWT('[[Foo|<span>foo]]bar</span>').then(function(result) {
				result.should.have.length(2);
				result[0].should.have.a.property("type", "html5-misnesting");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "span");
				result[1].should.have.a.property("type", "stripped-tag");
			});
		});
		it('should not trigger html5 misnesting for formatting tags', function() {
			return parseWT('<small>foo\n\nbar').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "small");
			});
		});
		it('should not trigger html5 misnesting for span if there is a nested span tag', function() {
			return parseWT('<span>foo<span>boo</span>\n\nbar</span>').then(function(result) {
				result.should.have.length(2);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[1].should.have.a.property("type", "stripped-tag");
			});
		});
		it('should trigger html5 misnesting for span if there is a nested non-span tag', function() {
			return parseWT('<span>foo<del>boo</del>\n\nbar</span>').then(function(result) {
				result.should.have.length(2);
				result[0].should.have.a.property("type", "html5-misnesting");
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "span");
				result[1].should.have.a.property("type", "stripped-tag");
			});
		});
		it('should trigger html5 misnesting for span if there is a nested unclosed span tag', function() {
			return parseWT('<span>foo<span>boo\n\nbar</span>').then(function(result) {
				result.should.have.length(3);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[1].should.have.a.property("type", "html5-misnesting");
				result[2].should.have.a.property("type", "stripped-tag");
			});
		});
	});
	describe('TIDY FONT BUG', function() {
		var wtLines = [
			"<font color='green'>[[Foo]]</font>",
			"<font color='green'>[[Category:Boo]][[Foo]]</font>",
			"<font color='green'>__NOTOC__[[Foo]]</font>",
			"<font color='green'><!--boo-->[[Foo]]</font>",
			"<font color='green'>[[Foo|bar]]</font>",
			"<font color='green'>[[Foo|''bar'']]</font>",
			"<font color='green'>[[Foo|''bar'' and boo]]</font>",
			"<font color='green'>[[Foo]]l</font>",
			"<font color='green'>{{1x|[[Foo]]}}</font>",
		];
		it('should flag Tidy font fixups accurately when color attribute is present', function() {
			return parseWT(wtLines.join('\n')).then(function(result) {
				var n = wtLines.length;
				result.should.have.length(2 * n);
				for (var i = 0; i < 2 * n; i += 2) {
					result[i].should.have.a.property("type", "obsolete-tag");
					result[i + 1].should.have.a.property("type", "tidy-font-bug");
				}
			});
		});
		it('should not flag Tidy font fixups when color attribute is absent', function() {
			return parseWT(wtLines.join('\n').replace(/ color='green'/g, '')).then(function(result) {
				var n = wtLines.length;
				result.should.have.length(n);
				for (var i = 0; i < n; i += 1) {
					result[i].should.have.a.property("type", "obsolete-tag");
				}
			});
		});
		var wtLines2 = [
			"<font color='green'></font>", // Regression test for T179757
			"<font color='green'>[[Foo]][[Bar]]</font>",
			"<font color='green'> [[Foo]]</font>",
			"<font color='green'>[[Foo]] </font>",
			"<font color='green'>[[Foo]]D</font>",
			"<font color='green'>''[[Foo|bar]]''</font>",
			"<font color='green'><span>[[Foo|bar]]</span></font>",
			"<font color='green'><div>[[Foo|bar]]</div></font>",
		];
		it('should not flag Tidy font fixups when Tidy does not do the fixups', function() {
			return parseWT(wtLines2.join('\n')).then(function(result) {
				var n = wtLines2.length;
				result.should.have.length(n);
				for (var i = 0; i < n; i += 1) {
					result[i].should.have.a.property("type", "obsolete-tag");
				}
			});
		});
	});

	describe('MULTIPLE UNCLOSED FORMATTING TAGS', function() {
		it('should detect multiple unclosed small tags', function() {
			return parseWT('<div><small>x</div><div><small>y</div>').then(function(result) {
				result.should.have.length(3);
				result[2].should.have.a.property("type", "multiple-unclosed-formatting-tags");
				result[2].params.should.have.a.property("name", "small");
			});
		});
		it('should detect multiple unclosed big tags', function() {
			return parseWT('<div><big>x</div><div><big>y</div>').then(function(result) {
				result.should.have.length(3);
				result[2].should.have.a.property("type", "multiple-unclosed-formatting-tags");
				result[2].params.should.have.a.property("name", "big");
			});
		});
		it('should detect multiple unclosed big tags', function() {
			return parseWT('<div><small><big><small><big>y</div>').then(function(result) {
				result.should.have.length(5);
				result[4].should.have.a.property("type", "multiple-unclosed-formatting-tags");
				result[4].params.should.have.a.property("name", "small");
			});
		});
		it('should ignore unclosed small tags in tables', function() {
			return noLintsOfThisType('{|\n|<small>a\n|<small>b\n|}', "multiple-unclosed-formatting-tags");
		});
		it('should ignore unclosed small tags in tables but detect those outside it', function() {
			return parseWT('<small>x\n{|\n|<small>a\n|<small>b\n|}\n<small>y').then(function(result) {
				result.should.have.length(5);
				result[4].should.have.a.property("type", "multiple-unclosed-formatting-tags");
				result[4].params.should.have.a.property("name", "small");
			});
		});
		it('should not flag undetected misnesting of formatting tags as multiple unclosed formatting tags', function() {
			return noLintsOfThisType('<br><small>{{1x|<div>\n*item 1\n</div>}}</small>', "multiple-unclosed-formatting-tags");
		});
		it("should detect Tidy's smart auto-fixup of paired unclosed formatting tags", function() {
			return parseWT('<b>foo<b>\n<code>foo <span>x</span> bar<code>').then(function(result) {
				result.should.have.length(6);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[1].should.have.a.property("type", "multiple-unclosed-formatting-tags");
				result[1].params.should.have.a.property("name", "b");
				result[3].should.have.a.property("type", "missing-end-tag");
				result[4].should.have.a.property("type", "multiple-unclosed-formatting-tags");
				result[4].params.should.have.a.property("name", "code");
			});
		});
		it("should not flag Tidy's smart auto-fixup of paired unclosed formatting tags where Tidy won't do it", function() {
			return noLintsOfThisType('<b>foo <b>\n<code>foo <span>x</span> <!--comment--><code>', "multiple-unclosed-formatting-tags");
		});
		it("should not flag Tidy's smart auto-fixup of paired unclosed tags for non-formatting tags", function() {
			return noLintsOfThisType('<span>foo<span>\n<div>foo <span>x</span> bar<div>', "multiple-unclosed-formatting-tags");
		});
	});
	describe('UNCLOSED WIKITEXT I/B tags in headings', function() {
		it('should detect unclosed wikitext i tags in headings', function() {
			return parseWT("==foo<span>''a</span>==\nx").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "unclosed-quotes-in-heading");
				result[0].params.should.have.a.property("name", "i");
				result[0].params.should.have.a.property("ancestorName", "h2");
			});
		});
		it('should detect unclosed wikitext b tags in headings', function() {
			return parseWT("==foo<span>'''a</span>==\nx").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "unclosed-quotes-in-heading");
				result[0].params.should.have.a.property("name", "b");
				result[0].params.should.have.a.property("ancestorName", "h2");
			});
		});
		it('should not detect unclosed HTML i/b tags in headings', function() {
			return parseWT("==foo<span><i>a</span>==\nx\n==foo<span><b>a</span>==\ny").then(function(result) {
				result.should.have.length(2);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[1].should.have.a.property("type", "missing-end-tag");
			});
		});
	});
	describe('MULTILINE HTML TABLES IN LISTS', function() {
		it('should detect multiline HTML tables in lists (li)', function() {
			return parseWT("* <table><tr><td>x</td></tr>\n</table>").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "multiline-html-table-in-list");
				result[0].params.should.have.a.property("name", "table");
				result[0].params.should.have.a.property("ancestorName", "li");
			});
		});
		it('should detect multiline HTML tables in lists (table in div)', function() {
			return parseWT("* <div><table><tr><td>x</td></tr>\n</table></div>").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "multiline-html-table-in-list");
				result[0].params.should.have.a.property("name", "table");
				result[0].params.should.have.a.property("ancestorName", "li");
			});
		});
		it('should detect multiline HTML tables in lists (dt)', function() {
			return parseWT("; <table><tr><td>x</td></tr>\n</table>").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "multiline-html-table-in-list");
				result[0].params.should.have.a.property("name", "table");
				result[0].params.should.have.a.property("ancestorName", "dt");
			});
		});
		it('should detect multiline HTML tables in lists (dd)', function() {
			return parseWT(": <table><tr><td>x</td></tr>\n</table>").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "multiline-html-table-in-list");
				result[0].params.should.have.a.property("name", "table");
				result[0].params.should.have.a.property("ancestorName", "dd");
			});
		});
		it('should not detect multiline HTML tables in HTML lists', function() {
			return expectEmptyResults("<ul><li><table>\n<tr><td>x</td></tr>\n</table>\n</li></ul>");
		});
		it('should not detect single-line HTML tables in lists', function() {
			return expectEmptyResults("* <div><table><tr><td>x</td></tr></table></div>");
		});
		it('should not detect multiline HTML tables in ref tags', function() {
			return expectEmptyResults("a <ref><table>\n<tr><td>b</td></tr>\n</table></ref> <references />");
		});
	});
	describe('LINT ISSUES IN <ref> TAGS', function() {
		it('should attribute linter issues to the ref tag', function() {
			return parseWT('a <ref><b>x</ref> <references/>').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].dsr.should.deep.equal([ 7, 11, 3, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "b");
			});
		});
		it('should attribute linter issues to the ref tag even if references is templated', function() {
			return parseWT('a <ref><b>x</ref> {{1x|<references/>}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].dsr.should.deep.equal([ 7, 11, 3, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "b");
			});
		});
		it('should attribute linter issues to the ref tag even when ref and references are both templated', function() {
			return parseWT('a <ref><b>x</ref> b <ref>{{1x|<b>x}}</ref> {{1x|c <ref><b>y</ref>}} {{1x|<references/>}}').then(function(result) {
				result.should.have.length(3);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].dsr.should.deep.equal([ 7, 11, 3, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "b");
				result[1].should.have.a.property("type", "missing-end-tag");
				result[1].dsr.should.deep.equal([ 25, 36, null, null]);
				result[1].should.have.a.property("params");
				result[1].params.should.have.a.property("name", "b");
				result[1].should.have.a.property("templateInfo");
				result[1].templateInfo.should.have.a.property("name", "Template:1x");
				result[2].should.have.a.property("type", "missing-end-tag");
				result[2].dsr.should.deep.equal([ 43, 67, null, null]);
				result[2].should.have.a.property("params");
				result[2].params.should.have.a.property("name", "b");
				result[2].should.have.a.property("templateInfo");
				result[2].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
		it('should attribute linter issues properly when ref tags are in non-templated references tag', function() {
			return parseWT("a <ref><s>x</ref> b <ref name='x' /> <references> <ref name='x'>{{1x|<b>boo}}</ref> </references>").then(function(result) {
				result.should.have.length(2);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].dsr.should.deep.equal([ 7, 11, 3, 0 ]);
				result[0].should.have.a.property("params");
				result[0].params.should.have.a.property("name", "s");
				result[1].should.have.a.property("type", "missing-end-tag");
				result[1].dsr.should.deep.equal([ 64, 77, null, null]);
				result[1].should.have.a.property("params");
				result[1].params.should.have.a.property("name", "b");
				result[1].should.have.a.property("templateInfo");
				result[1].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
		it('should not get into a cycle trying to lint ref in ref', function() {
			return parseWT("{{#tag:ref|<ref name='y' />|name='x'}}{{#tag:ref|<ref name='x' />|name='y'}}<ref name='x' />")
			.then(function() {
				return parseWT("{{#tag:ref|<ref name='x' />|name=x}}");
			});
		});
	});
	describe('DIV-SPAN-FLIP-TIDY-BUG', function() {
		it('should not trigger this lint when there are no style or class attributes', function() {
			return expectEmptyResults("<span><div>x</div></span>");
		});
		it('should trigger this lint when there is a style or class attribute (1)', function() {
			return parseWT("<span class='x'><div>x</div></span>").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misc-tidy-replacement-issues");
				result[0].params.should.have.a.property("subtype", "div-span-flip");
			});
		});
		it('should trigger this lint when there is a style or class attribute (2)', function() {
			return parseWT("<span style='x'><div>x</div></span>").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misc-tidy-replacement-issues");
				result[0].params.should.have.a.property("subtype", "div-span-flip");
			});
		});
		it('should trigger this lint when there is a style or class attribute (3)', function() {
			return parseWT("<span><div class='x'>x</div></span>").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misc-tidy-replacement-issues");
				result[0].params.should.have.a.property("subtype", "div-span-flip");
			});
		});
		it('should trigger this lint when there is a style or class attribute (4)', function() {
			return parseWT("<span><div style='x'>x</div></span>").then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "misc-tidy-replacement-issues");
				result[0].params.should.have.a.property("subtype", "div-span-flip");
			});
		});
	});
	describe('WIKILINK IN EXTERNAL LINK', function() {
		it('should lint wikilink in external link correctly', function() {
			return parseWT('[http://google.com This is [[Google]]\'s search page]').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "wikilink-in-extlink");
				result[0].dsr.should.deep.equal([0, 52, 19, 1]);
			});
		});
		it('should lint wikilink in external link correctly', function() {
			return parseWT('[http://stackexchange.com is the official website for [[Stack Exchange]]]').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "wikilink-in-extlink");
				result[0].dsr.should.deep.equal([ 0, 73, 26, 1 ]);
			});
		});
		it('should lint wikilink in external link correctly', function() {
			return parseWT('{{1x|foo <div> and [http://google.com [[Google]] bar] baz </div>}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "wikilink-in-extlink");
				result[0].dsr.should.deep.equal([ 0, 66, null, null ]);
				result[0].should.have.a.property("templateInfo");
				result[0].templateInfo.should.have.a.property("name", "Template:1x");
			});
		});
	});
});
