'use strict';

/* global describe, it */
/* eslint no-unused-expressions: off */

require('../../core-upgrade.js');
require('chai').should();

const { DOMDiff } = require('../../lib/html2wt/DOMDiff.js');
const { DiffUtils } = require('../../lib/html2wt/DiffUtils.js');
const { DOMUtils } = require('../../lib/utils/DOMUtils.js');
const { TestUtils } = require('../../tests/TestUtils.js');

const parseAndDiff = function(a, b) {
	const oldDOM = TestUtils.mockEnvDoc(a).body;
	const newDOM = TestUtils.mockEnvDoc(b).body;

	const dummyEnv = {
		conf: { parsoid: {}, wiki: {} },
		page: { id: null },
		log: function() {},
	};

	(new DOMDiff(dummyEnv)).diff(oldDOM, newDOM);

	return { body: newDOM, env: dummyEnv };
};

describe('DOMDiff', function() {
	it('should find a diff when changing text in a node', function() {
		const { body } = parseAndDiff(
			'<p>a</p>\n<p>b</p>',
			'<p>A</p>\n<p>b</p>'
		);
		const meta = body.firstChild.firstChild;
		(DOMUtils.isDiffMarker(meta, 'deleted')).should.be.true;
	});
	it('should find a diff deleting a node', function() {
		const { body } = parseAndDiff(
			'<p>a</p>\n<p>b</p>',
			'<p>a</p>'
		);
		const meta = body.firstChild.nextSibling;
		DOMUtils.isDiffMarker(meta, 'deleted').should.be.true;
	});
	it('should find a diff when reordering nodes', function() {
		const { body } = parseAndDiff(
			'<p>a</p>\n<p>b</p>',
			'<p>b</p>\n<p>a</p>'
		);
		let meta = body.firstChild.firstChild;
		DOMUtils.isDiffMarker(meta, 'deleted').should.be.true;
		meta = body.firstChild.nextSibling.nextSibling.firstChild;
		DOMUtils.isDiffMarker(meta, 'deleted').should.be.true;
	});
	it('should find a diff when adding multiple nodes', function() {
		const { body } = parseAndDiff(
			'<p>a</p>\n<p>b</p>',
			'<p>p</p>\n<p>q</p>\n<p>a</p>\n<p>b</p>\n<p>r</p>\n<p>s</p>'
		);
		let meta = body.firstChild.firstChild;
		DOMUtils.isDiffMarker(meta, 'deleted').should.be.true;
		meta = body.firstChild.nextSibling.nextSibling.firstChild;
		DOMUtils.isDiffMarker(meta, 'deleted').should.be.true;
		meta = body.firstChild.nextSibling.nextSibling.nextSibling;
		DOMUtils.isDiffMarker(meta, 'inserted').should.be.true;
		meta = meta.nextSibling.nextSibling.nextSibling;
		DOMUtils.isDiffMarker(meta, 'inserted').should.be.true;
		meta = meta.nextSibling.nextSibling.nextSibling;
		DOMUtils.isDiffMarker(meta, 'inserted').should.be.true;
		meta = meta.nextSibling.nextSibling.nextSibling;
		DOMUtils.isDiffMarker(meta, 'inserted').should.be.true;
	});
	it('should find a diff when adding and deleting nodes', function() {
		const { body } = parseAndDiff(
			'<p>a</p>\n<p>b</p>\n<p>c</p>',
			'<p>p</p>\n<p>b</p>'
		);
		let meta = body.firstChild.firstChild;
		(DOMUtils.isDiffMarker(meta, 'deleted')).should.be.true;
		meta = body.firstChild.nextSibling.nextSibling.nextSibling;
		DOMUtils.isDiffMarker(meta, 'deleted').should.be.true;
	});
	it('should find a diff when changing an attribute', function() {
		const { body, env } = parseAndDiff(
			"<p class='a'>a</p>\n<p class='b'>b</p>",
			"<p class='aa'>a</p>\n<p class='b'>b</p>"
		);
		const { diff } = DiffUtils.getDiffMark(body.firstChild, env);
		diff.includes('modified-wrapper').should.be.true;
	});
});
