'use strict';

/* global describe, it */

require('../../core-upgrade.js');
require('chai').should();

const { MockEnv } = require('../MockEnv');
const { DOMDataUtils } = require('../../lib/utils/DOMDataUtils.js');
const { ContentUtils } = require('../../lib/utils/ContentUtils.js');
const { PWrap } = require('../../lib/wt2html/pp/processors/PWrap.js');

const env = new MockEnv({}, null);
const PWrapper = new PWrap();
const re = new RegExp(` ${DOMDataUtils.DataObjectAttrName()}="\\d+"`, 'g');
var verifyPWrap = function(html, expectedOutput) {
	const body = ContentUtils.ppToDOM(env, html);
	PWrapper.run(body, env);
	body.innerHTML.replace(re, '').should.equal(expectedOutput);
};

var noPWrapperTests = [
	{ html: '', output: '' },
	{ html: ' ', output: ' ' },
	{ html: ' <!--c--> ', output: ' <!--c--> ' },
	{ html: '<div>a</div>', output: '<div>a</div>' },
	{ html: '<div>a</div> <div>b</div>', output: '<div>a</div> <div>b</div>' },
	{ html: '<i><div>a</div></i>', output: '<i><div>a</div></i>' },
	// <span> is not a spittable tag
	{ html: '<span>x<div>a</div>y</span>', output: '<span>x<div>a</div>y</span>' },
];

var simplePWrapperTests = [
	{ html: 'a', output: '<p>a</p>' },
	// <span> is not a splittable tag, but gets p-wrapped in simple wrapping scenarios
	{ html: '<span>a</span>', output: '<p><span>a</span></p>' },
	{ html: 'x <div>a</div> <div>b</div> y', output: '<p>x </p><div>a</div> <div>b</div><p> y</p>' },
	{ html: 'x<!--c--> <div>a</div> <div>b</div> <!--c-->y', output: '<p>x<!--c--> </p><div>a</div> <div>b</div> <!--c--><p>y</p>' },
];

var complexPWrapperTests = [
	{ html: '<i>x<div>a</div>y</i>', output: '<p><i>x</i></p><i><div>a</div></i><p><i>y</i></p>' },
	{ html: 'a<small>b</small><i>c<div>d</div>e</i>f', output: '<p>a<small>b</small><i>c</i></p><i><div>d</div></i><p><i>e</i>f</p>' },
	{ html: 'a<small>b<i>c<div>d</div></i>e</small>', output: '<p>a<small>b<i>c</i></small></p><small><i><div>d</div></i></small><p><small>e</small></p>' },
	{ html: 'x<small><div>y</div></small>', output: '<p>x</p><small><div>y</div></small>' },
	{ html: 'a<small><i><div>d</div></i>e</small>', output: '<p>a</p><small><i><div>d</div></i></small><p><small>e</small></p>' },
	{ html: '<i>a<div>b</div>c<b>d<div>e</div>f</b>g</i>', output: '<p><i>a</i></p><i><div>b</div></i><p><i>c<b>d</b></i></p><i><b><div>e</div></b></i><p><i><b>f</b>g</i></p>' },
	{ html: '<i><b><font><div>x</div></font></b><div>y</div><b><font><div>z</div></font></b></i>', output: '<i><b><font><div>x</div></font></b><div>y</div><b><font><div>z</div></font></b></i>' },
];

[
	{ tests: noPWrapperTests, heading: 'No P-wrappers' },
	{ tests: simplePWrapperTests, heading: 'Simple P-wrapping' },
	{ tests: complexPWrapperTests, heading: 'P-wrapping with subtree-splitting' },
].forEach(function(a) {

	describe(a.heading, function() {
		a.tests.forEach(function(test) {
			it('should be valid for ' + JSON.stringify(test.html), function() {
				return verifyPWrap(test.html, test.output);
			});
		});
	});

	describe('Blockquotes: ' + a.heading, function() {
		a.tests.forEach(function(test) {
			var html = '<blockquote>' + test.html + '</blockquote>';
			it('should be valid for ' + JSON.stringify(html), function() {
				return verifyPWrap(html, '<blockquote>' + test.output + '</blockquote>');
			});
		});
	});
});
