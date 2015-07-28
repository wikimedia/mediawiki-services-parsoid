/** Test cases for the linter */
'use strict';
require('../../lib/core-upgrade.js');
/*global describe, it, Promise*/

var should = require("chai").should();

var MWParserEnvironment = require('../../lib/mediawiki.parser.environment.js').MWParserEnvironment;
var Util = require('../../lib/mediawiki.Util.js').Util;
var ParsoidConfig = require('../../lib/mediawiki.ParsoidConfig').ParsoidConfig;

describe('Linter Tests', function() {
	var parsoidConfig = new ParsoidConfig(null, { defaultWiki: 'enwiki', linting: true });

	var parseWT = function(wt) {
		return MWParserEnvironment.getParserEnv(parsoidConfig, null, {
			prefix: 'enwiki',
			pageName: 'Main_Page',
		}).then(function(env) {
			env.setPageSrcInfo(wt);

			var pipeline = env.pipelineFactory;
			return Promise.promisify(pipeline.parse, false, pipeline)(
				env, wt, null
			).then(function(doc) {
				return env.linter.buffer;
			}, function(err) {
				env.log("error", err);
				throw err;
			});
		});
	};

	describe('#Issues', function() {
		it('should not lint any issues', function() {
			return parseWT('foo').then(function(result) {
				return result.should.be.empty;
			});
		});
		it('should lint missing end tags correctly', function() {
			return parseWT('<div>foo').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 8, 5, 0 ]);
				result[0].should.have.a.property("src", "<div>foo");
			});
		});
		it('should lint missing end tags found in transclusions correctly', function() {
			return parseWT('{{echo|<div>foo<p>bar</div>}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "missing-end-tag");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 29, null, null ]);
				result[0].should.have.a.property("src", "{{echo|<div>foo<p>bar</div>}}");
			});
		});
		it('should lint stripped tags correctly', function() {
			return parseWT('foo</div>').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "stripped-tag");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 3, 9, null, null ]);
				result[0].should.have.a.property("src", "</div>");
			});
		});
		it('should lint stripped tags found in transclusions correctly', function() {
			return parseWT('{{echo|<div>foo</div></div>}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "stripped-tag");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 29, null, null ]);
				result[0].should.have.a.property("src", "{{echo|<div>foo</div></div>}}");
			});
		});
		it('should lint obsolete tags correctly', function() {
			return parseWT('<big>foo</big>bar').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "obsolete-tag");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 14, 5, 6 ]);
				result[0].should.have.a.property("src", "<big>foo</big>");
			});
		});
		it('should lint obsolete tags found in transclusions correctly', function() {
			return parseWT('{{echo|<div><big>foo</big></div>}}foo').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "obsolete-tag");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 34, null, null ]);
				result[0].should.have.a.property("src", "{{echo|<div><big>foo</big></div>}}");
			});
		});
		it('should lint fostered content correctly', function() {
			return parseWT('{|\nfoo\n|-\n| bar\n|}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "fostered");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 18, 2, 2 ]);
				result[0].should.have.a.property("src", "foo");
			});
		});
		it('should lint ignored table attributes Correctly', function() {
			return parseWT('{|\n|- foo\n|bar\n|}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "ignored-table-attr");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 3, 14, 6, 0 ]);
				result[0].should.have.a.property("src", "|- foo\n|bar");
			});
		});
		it('should lint ignored table attributes found in transclusions correctly', function() {
			return parseWT('{{echo|\n{{{!}}\n{{!}}- foo\n{{!}} bar\n{{!}}}\n}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "ignored-table-attr");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 45, null, null]);
				result[0].should.have.a.property("src", "{{echo|\n{{{!}}\n{{!}}- foo\n{{!}} bar\n{{!}}}\n}}");
			});
		});
		it('should not lint whitespaces as ignored table attributes', function() {
			return parseWT('{|\n|- \n| 1 ||style="text-align:left;"| p \n|}').then(function(result) {
				result.should.have.length(0);
			});
		});
		it('should lint as ignored table attributes', function() {
			return parseWT('{|\n|- <!--bad attr-->attr\n|bar\n|}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "ignored-table-attr");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 3, 30, 22, 0 ]);
				result[0].should.have.a.property("src", "|- <!--bad attr-->attr\n|bar");
			});
		});
		it('should lint Bogus image options correctly', function() {
			return parseWT('[[file:a.jpg|foo|bar]]').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "bogus-image-options");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 22, null, null ]);
				result[0].should.have.a.property("src", "[[file:a.jpg|foo|bar]]");
			});
		});
		it('should lint Bogus image options found in transclusions correctly', function() {
			return parseWT('{{echo|[[file:a.jpg|foo|bar]]}}').then(function(result) {
				result.should.have.length(1);
				result[0].should.have.a.property("type", "bogus-image-options");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 0, 31, null, null ]);
				result[0].should.have.a.property("src", "{{echo|[[file:a.jpg|foo|bar]]}}");
			});
		});
	});
});
