'use strict';

/* global describe, it */

require('../../core-upgrade.js');
require("chai").should();
var DOMUtils = require('../../lib/utils/DOMUtils.js').DOMUtils;
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
	return helpers.parse(parsoidConfig, src, options);
};

var serialize = (doc, pb, opts) => helpers.serialize(parsoidConfig, doc, pb, opts);

// These are regression specs for when we fix bugs that cannot be easily
// verified with the parser tests framework
describe('Regression Specs', function() {

	// Wikilinks use ./ prefixed urls. For reasons of consistency,
	// we should use a similar format for internal cite urls.
	// This spec ensures that we don't inadvertently break that requirement.
	it('should use ./ prefixed urls for cite links', function() {
		return parse('a [[Foo]] <ref>b</ref>').then(function(ret) {
			const { doc: result } = ret;
			result.body.querySelector(".mw-ref a").getAttribute('href')
				.should.equal('./Main_Page#cite_note-1');
			result.body.querySelector("#cite_note-1 a").getAttribute('href')
				.should.equal('./Main_Page#cite_ref-1');
		});
	});

	it('should prevent regression of T153107', function() {
		var wt = '[[Foo|bar]]';
		return parse(wt).then(function(ret) {
			const { doc: result, env } = ret;

			var origDOM = result.body;
			// This is mimicking a copy/paste in an editor
			var editedHTML = origDOM.innerHTML + origDOM.innerHTML.replace(/bar/, 'Foo');

			// Without selser, we should see [[Foo|Foo]], since we only normalize
			// for modified / new content, which requires selser for detection

			const doc = env.createDocument(editedHTML);
			return serialize(doc, null, {}).then(function(editedWT) {
				editedWT.should.equal(wt + "\n\n[[Foo|Foo]]");
				// With selser, we should see [[Foo]]
				var options = {
					useSelser: true,
					pageSrc: wt,
					origDOM: origDOM,
				};

				const doc2 = env.createDocument(editedHTML);
				return serialize(doc2, null, options).then(function(editedWT) {
					editedWT.should.equal(wt + "\n\n[[Foo]]");
				});
			});
		});
	});

	it('should ensure edited lists, headings, table cells preserve original whitespace in some scenarios', function() {
		var wt = [
			"* item",
			"* <!--cmt--> item",
			"* <div>item</div>",
			"* [[Link|item]]",
			"== heading ==",
			"== <!--cmt--> heading ==",
			"== <div>heading</div> ==",
			"== [[Link|heading]] ==",
			"{|",
			"| cell",
			"| <!--cmt--> cell",
			"| <div>cell</div>",
			"| [[Link|cell]]",
			"|  unedited c1  || cell ||  unedited c3  || cell",
			"|  unedited c1  || cell ||  unedited c3  ||   unedited c4",
			"|}"
		].join('\n');
		return parse(wt).then(function(ret) {
			const { doc: result, env } = ret;

			var origDOM = result.body;
			var editedHTML = origDOM.innerHTML.replace(/item/g, 'edited item').replace(/heading/g, 'edited heading').replace(/cell/g, 'edited cell');

			// Without selser, we should see normalized wikitext

			const doc = env.createDocument(editedHTML);
			return serialize(doc, null, {}).then(function(editedWT) {
				editedWT.should.equal([
					"*edited item",
					"*<!--cmt-->edited item",
					"*<div>edited item</div>",
					"*[[Link|edited item]]",
					"",
					"==edited heading==",
					"==<!--cmt-->edited heading==",
					"==<div>edited heading</div>==",
					"==[[Link|edited heading]]==",
					"{|",
					"|edited cell",
					"|<!--cmt-->edited cell",
					"|<div>edited cell</div>",
					"|[[Link|edited cell]]",
					"|unedited c1||edited cell||unedited c3||edited cell",
					"|unedited c1||edited cell||unedited c3||unedited c4",
					"|}"
				].join('\n'));
				// With selser, we should have whitespace heuristics applied
				var options = {
					useSelser: true,
					pageSrc: wt,
					origDOM: origDOM,
				};

				const doc2 = env.createDocument(editedHTML);
				return serialize(doc2, null, options).then(function(editedWT) {
					editedWT.should.equal([
						"* edited item",
						"* <!--cmt-->edited item",
						"* <div>edited item</div>",
						"* [[Link|edited item]]",
						"== edited heading ==",
						"== <!--cmt-->edited heading ==",
						"== <div>edited heading</div> ==",
						"== [[Link|edited heading]] ==",
						"{|",
						"| edited cell",
						"| <!--cmt-->edited cell",
						"| <div>edited cell</div>",
						"| [[Link|edited cell]]",
						"|  unedited c1  || edited cell || unedited c3 || edited cell",
						"|  unedited c1  || edited cell || unedited c3 ||   unedited c4",
						"|}"
					].join('\n'));
				});
			});
		});
	});

	it('should not apply whitespace heuristics for HTML versions older than 1.7.0', function() {
		var wt = [
			"* item",
			"* <!--cmt--> item",
			"* <div>item</div>",
			"* [[Link|item]]",
			"== heading ==",
			"== <!--cmt--> heading ==",
			"== <div>heading</div> ==",
			"== [[Link|heading]] ==",
			"{|",
			"| cell",
			"| <!--cmt--> cell",
			"| <div>cell</div>",
			"| [[Link|cell]]",
			"|}"
		].join('\n');
		return parse(wt).then(function(ret) {
			const { doc, env } = ret;

			var origHeader = doc.head.innerHTML;
			var origBody = doc.body.innerHTML;
			var editedHTML = origBody.replace(/item/g, 'edited item').replace(/heading/g, 'edited heading').replace(/cell/g, 'edited cell');
			doc.body.innerHTML = editedHTML;

			const origDoc = env.createDocument(origBody);
			var options = {
				useSelser: true,
				pageSrc: wt,
				origDOM: origDoc.body,
			};
			// Whitespace heuristics are enabled
			return serialize(doc, null, options).then(function(editedWT) {
				editedWT.should.equal([
					"* edited item",
					"* <!--cmt-->edited item",
					"* <div>edited item</div>",
					"* [[Link|edited item]]",
					"== edited heading ==",
					"== <!--cmt-->edited heading ==",
					"== <div>edited heading</div> ==",
					"== [[Link|edited heading]] ==",
					"{|",
					"| edited cell",
					"| <!--cmt-->edited cell",
					"| <div>edited cell</div>",
					"| [[Link|edited cell]]",
					"|}"
				].join('\n'));

				// Pretend we are in 1.6.1 version to disable whitespace heuristics
				doc.body.innerHTML = editedHTML;
				doc.head.innerHTML = origHeader.replace(/2\.\d+\.\d+/, '1.6.1');
				options.origDOM = env.createDocument(origBody).body;

				// Whitespace heuristics are disabled, but selser's
				// buildSep heuristics will do the magic for non-text
				// and non-comment nodes.
				return serialize(doc, null, options).then(function(editedWT) {
					editedWT.should.equal([
						"*edited item",
						"*<!--cmt-->edited item",
						"* <div>edited item</div>",
						"* [[Link|edited item]]",
						"==edited heading==",
						"==<!--cmt-->edited heading==",
						"== <div>edited heading</div> ==",
						"== [[Link|edited heading]] ==",
						"{|",
						"|edited cell",
						"|<!--cmt-->edited cell",
						"| <div>edited cell</div>",
						"| [[Link|edited cell]]",
						"|}"
					].join('\n'));
				});
			});
		});
	});

	it('should not wrap templatestyles style tags in p-wrappers', function() {
		var wt = "<templatestyles src='Template:Quote/styles.css'/><div>foo</div>";
		return parse(wt).then(function(ret) {
			return ret.doc.body.firstChild.nodeName.should.equal("STYLE");
		});
	});

	// For https://phabricator.wikimedia.org/T208901
	it('should not split p-wrappers around templatestyles', function() {
		var wt = 'abc {{1x|<templatestyles src="Template:Quote/styles.css" /> def}} ghi [[File:Foo.jpg|thumb|250px]]';
		return parse(wt).then(function(ret) {
			const body = ret.doc.body;
			body.firstChild.nodeName.should.equal("P");
			DOMUtils.nextNonSepSibling(body.firstChild).nodeName.should.equal("FIGURE");
		});
	});

	it('should deduplicate templatestyles style tags', function() {
		var wt = [
			'<templatestyles src="Template:Quote/styles.css" /><span>a</span>',
			'<templatestyles src="Template:Quote/styles.css" /><span>b</span>'
		].join('\n');
		return parse(wt).then(function(ret) {
			const { doc } = ret;
			var firstStyle = doc.body.firstChild.firstChild; // the first child is a p-wrap
			firstStyle.nodeName.should.equal("STYLE");
			var secondStyle = firstStyle.nextSibling.nextSibling.nextSibling;
			secondStyle.nodeName.should.equal("LINK");
			secondStyle.getAttribute('rel').should.equal('mw-deduplicated-inline-style');
			secondStyle.getAttribute('href').should.equal('mw-data:' + firstStyle.getAttribute('data-mw-deduplicate'));
			['about','typeof','data-mw','data-parsoid'].forEach(function(k) {
				secondStyle.hasAttribute(k).should.equal(true);
			});
			return serialize(doc, null, { useSelser: false }).then(function(rtWT) {
				rtWT.should.equal(wt);
			});
		});
	});
});
