'use strict';

/* global describe, it */
/* eslint no-unused-expressions: off */

require('../../core-upgrade.js');
require('chai').should();

const { MockEnv } = require('../MockEnv');
const { DOMDiff } = require('../../lib/html2wt/DOMDiff.js');
const { DOMUtils } = require('../../lib/utils/DOMUtils.js');
const { DOMDataUtils } = require('../../lib/utils/DOMDataUtils.js');
const { ContentUtils } = require('../../lib/utils/ContentUtils.js');

const parseAndDiff = function(a, b) {
	const dummyEnv = new MockEnv({}, null);

	const oldDOM = ContentUtils.ppToDOM(dummyEnv, a, { markNew: true });
	const newDOM = ContentUtils.ppToDOM(dummyEnv, b, { markNew: true });

	(new DOMDiff(dummyEnv)).diff(oldDOM, newDOM);

	return { body: newDOM, env: dummyEnv };
};

// FIXME: The subtree-changed marker seems to be applied inconsistently.
// Check if that marker is still needed / used by serialization code and
// update code accordingly. If possible, simplify / reduce the different
// markers being used.
const tests = [
	{
		desc: 'changing text in a node',
		orig: '<p>a</p><p>b</p>',
		edit: '<p>A</p><p>b</p>',
		specs: [
			{ selector: 'body > p:first-child', markers: [ 'children-changed', 'subtree-changed'] },
			{ selector: 'body > p:first-child > meta:first-child', diff: 'deleted' },
		]
	},
	{
		desc: 'deleting a node',
		orig: '<p>a</p><p>b</p>',
		edit: '<p>a</p>',
		specs: [
			{ selector: 'body', markers: [ 'children-changed'] },
			{ selector: 'body > p + meta', diff: 'deleted' },
		]
	},
	{
		desc: 'reordering nodes',
		orig: '<p>a</p><p>b</p>',
		edit: '<p>b</p><p>a</p>',
		specs: [
			{ selector: 'body > p:nth-child(1)', markers: [ 'children-changed', 'subtree-changed'] },
			{ selector: 'body > p:nth-child(1) > meta', diff: 'deleted' },
			{ selector: 'body > p:nth-child(2)', markers: [ 'children-changed', 'subtree-changed'] },
			{ selector: 'body > p:nth-child(2) > meta', diff: 'deleted' },
		]
	},
	{
		desc: 'adding multiple nodes',
		orig: '<p>a</p>',
		edit: '<p>x</p><p>a</p><p>y</p>',
		specs: [
			{ selector: 'body', markers: [ 'children-changed'] },
			{ selector: 'body > p:nth-child(1)', markers: [ 'children-changed', 'subtree-changed'] },
			{ selector: 'body > p:nth-child(1) > meta', diff: 'deleted' },
			{ selector: 'body > p:nth-child(2)', markers: [ 'inserted'] },
			{ selector: 'body > p:nth-child(3)', markers: [ 'inserted'] },
		]
	},
	{
		desc: 'adding and deleting nodes',
		orig: '<p>a</p><p>b</p><p>c</p>',
		edit: '<p>x</p><p>b</p>',
		specs: [
			{ selector: 'body', markers: [ 'children-changed'] },
			{ selector: 'body > p:nth-child(1)', markers: [ 'children-changed', 'subtree-changed'] },
			{ selector: 'body > p:nth-child(1) > meta', diff: 'deleted' },
			{ selector: 'body > meta:nth-child(3)', diff: [ 'deleted'] },
		]
	},
	{
		desc: 'changing an attribute',
		orig: '<p class="a">a</p><p class="b">b</p>',
		edit: '<p class="X">a</p><p class="b">b</p>',
		specs: [
			{ selector: 'body', markers: [ 'children-changed'] },
			{ selector: 'body > p:nth-child(1)', markers: [ 'modified-wrapper'] },
		]
	},
	{
		desc: 'changing data-mw for a template',
		orig: '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"a"}},"i":0}}]}\'>a</p>',
		edit: '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"foo"}},"i":0}}]}\'>foo</p>',
		specs: [
			{ selector: 'body', markers: [ 'children-changed'] },
			{ selector: 'body > p:nth-child(1)', markers: [ 'modified-wrapper'] },
		]
	},
	// The additional subtrees added to the template's content should simply be ignored
	{
		desc: 'adding additional DOM trees to templated content',
		orig: '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"a"}},"i":0}}]}\'>a</p>',
		edit: '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"foo\\n\\nbar\\n\\nbaz"}},"i":0}}]}\'>foo</p>' +
			'<p about="#mwt1">bar</p><p about="#mwt1">baz</p>',
		specs: [
			{ selector: 'body', markers: [ 'children-changed'] },
			{ selector: 'body > p:nth-child(1)', markers: [ 'modified-wrapper'] },
		]
	},
];

describe('DOMDiff', function() {
	tests.forEach(function(t) {
		it(`should find diff correctly when ${t.desc}`, function() {
			const { body } = parseAndDiff(t.orig, t.edit);
			t.specs.forEach(function(spec) {
				let node;
				if (spec.selector === 'body') { // Hmm .. why is this?
					node = body;
				} else {
					const nodes = body.querySelectorAll(spec.selector);
					nodes.length.should.equal(1);
					node = nodes[0];
				}
				if (spec.diff) {
					DOMUtils.isDiffMarker(node, spec.diff).should.be.true;
				} else if (spec.markers) {
					// NOTE: Not using DiffUtils.getDiffMark because that
					// tests for page id and we may not be mocking that
					// precisely here. And, we need to revisit whether that
					// page id comparison is still needed / useful.
					const data = DOMDataUtils.getNodeData(node);
					const markers = data.parsoid_diff.diff;
					markers.length.should.equal(spec.markers.length);
					markers.forEach(function(m, j) {
						m.should.equal(spec.markers[j]);
					});
				}
			});
		});
	});
});
