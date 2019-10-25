/** Test cases for cleanup of DOM such as removal of extraneous data parsoid items */

'use strict';

require('../../core-upgrade.js');
/* global describe, it */

require("chai").should();

var DOMDataUtils = require('../../lib/utils/DOMDataUtils.js').DOMDataUtils;
var ParsoidConfig = require('../../lib/config/ParsoidConfig.js').ParsoidConfig;
var DOMTraverser = require('../../lib/utils/DOMTraverser.js').DOMTraverser;
var helpers = require('./test.helpers.js');

describe('Cleanup DOM pass', function() {
	// FIXME: MWParserEnvironment.getParserEnv and switchToConfig both require
	// mwApiMap to be setup. This forces us to load WMF config. Fixing this
	// will require some changes to ParsoidConfig and MWParserEnvironment.
	// There are also specific dependencies on enwiki contents
	// (subpage support and the {Lowercase title}} template)
	// which ought to be factored out and mocked, longer-term.
	var parsoidConfig = new ParsoidConfig(null, {
		loadWMF: true,
		defaultWiki: 'enwiki',
	});
	var parse = function(src, options) {
		return helpers.parse(parsoidConfig, src, options).then(function(ret) {
			return ret.doc;
		});
	};

	// mocha test searching for autoInsertedEnd flags using DOM traversal helper functions
	it('should confirm removal of autoInsertedEnd flag for wikitext table tags without closing tag syntax using DOM traversal', function() {
		var origWt = [
			"{|",
			"|a",
			"|}",
		].join('\n');
		return parse(origWt).then(function(doc) {
			DOMDataUtils.visitAndLoadDataAttribs(doc.body);
			var table = doc.body.firstChild;
			var domVisitor = new DOMTraverser();
			var autoInsValidation = function(node) {
				var autoInsEnd = DOMDataUtils.getDataParsoid(node).autoInsertedEnd;
				(typeof autoInsEnd).should.equal('undefined');
				return true;
			};
			domVisitor.addHandler('tr', autoInsValidation);
			domVisitor.addHandler('td', autoInsValidation);
			domVisitor.traverse(table);
		});
	});

	// comprehensive mocha test searching for autoInsertedEnd flags in all possible WT tags with no closing tags
	// "PRE", "LI", "DT", "DD", "HR", "TR", "TD", "TH", "CAPTION"
	it('should confirm removal of autoInsertedEnd flag for all wikitext tags without closing tags', function() {
		var origWt = [
			";Definition list",
			":First definition",
			":Second definition",
			"{|",
			"|+ caption",
			"|-",
			"! heading 1!! heading 2",
			"|-",
			"|a||b",
			"|}",
			" preformatted text using leading whitespace as a pre wikitext symbol equivalent",
			"{|",
			"|c",
			"|}",
			"# Item 1",
			"# Item 2",
		].join('\n');
		return parse(origWt).then(function(doc) {
			DOMDataUtils.visitAndLoadDataAttribs(doc.body);
			var fragment = doc.body.firstChild;
			var domVisitor = new DOMTraverser();
			var autoInsValidation = function(node) {
				var autoInsEnd = DOMDataUtils.getDataParsoid(node).autoInsertedEnd;
				(typeof autoInsEnd).should.equal('undefined');
				return true;
			};
			domVisitor.addHandler('pre', autoInsValidation);
			domVisitor.addHandler('li', autoInsValidation);
			domVisitor.addHandler('dt', autoInsValidation);
			domVisitor.addHandler('dd', autoInsValidation);
			domVisitor.addHandler('hr', autoInsValidation);
			domVisitor.addHandler('tr', autoInsValidation);
			domVisitor.addHandler('td', autoInsValidation);
			domVisitor.addHandler('th', autoInsValidation);
			domVisitor.addHandler('caption', autoInsValidation);
			domVisitor.traverse(fragment);
		});
	});

	// comprehensive mocha test searching for autoInsertedEnd flags in all possible HTML wikitext tags with no closing tags
	// "PRE", "LI", "DT", "DD", "HR", "TR", "TD", "TH", "CAPTION"
	it('should confirm presence of autoInsertedEnd flag for all HTML wikitext tags that can appear without closing tags', function() {
		var origWt = [
			"<dl>",
			"<dt>Definition list",
			"<dd>First definition",
			"<dd>Second definition",
			"</dl>",
			"<table>",
			"<caption>caption",
			"<tr>",
			"<th>heading 1",
			"<th>heading 2",
			"<tr>",
			"<td>a",
			"<td>b",
			"</table>",
			"<pre>preformatted text using leading whitespace as a pre wikitext symbol equivalent",
			"<ol>",
			"<li>Item 1",
			"<li>Item 2",
			"</ol>",
		].join('\n');
		return parse(origWt).then(function(doc) {
			DOMDataUtils.visitAndLoadDataAttribs(doc.body);
			var fragment = doc.body.firstChild;
			var domVisitor = new DOMTraverser();
			var autoInsValidation = function(node) {
				var autoInsEnd = DOMDataUtils.getDataParsoid(node).autoInsertedEnd;
				(typeof autoInsEnd).should.not.equal('undefined');
				return true;
			};
			domVisitor.addHandler('pre', autoInsValidation);
			domVisitor.addHandler('li', autoInsValidation);
			domVisitor.addHandler('dt', autoInsValidation);
			domVisitor.addHandler('dd', autoInsValidation);
			domVisitor.addHandler('hr', autoInsValidation);
			domVisitor.addHandler('tr', autoInsValidation);
			domVisitor.addHandler('td', autoInsValidation);
			domVisitor.addHandler('th', autoInsValidation);
			domVisitor.addHandler('caption', autoInsValidation);
			domVisitor.traverse(fragment);
		});
	});
});
