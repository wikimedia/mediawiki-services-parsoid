'use strict';

/* global describe, it */

var expect = require("chai").expect;
var Util = require('../../../lib/utils/Util').Util;
var TagTk = require('../../../lib/tokens/TagTk').TagTk;
var KV = require('../../../lib/tokens/KV').KV;

(function() {
	var orig = new TagTk('a', [new KV('attr', 'a')], { da: { 'da_subattr': 'a' } });
	var clone = Util.clone(orig);

	orig.name = 'b';
	orig.setAttribute('attr', 'b');
	orig.dataAttribs.da.da_subattr = 'b';

	expect(orig.name).to.equal('b');
	expect(orig.getAttribute('attr')).to.equal('b');
	expect(orig.dataAttribs.da.da_subattr).to.equal('b');
	expect(clone.name).to.equal('a');
	expect(clone.getAttribute('attr')).to.equal('a');
	expect(clone.dataAttribs.da.da_subattr).to.equal('a');
})();

describe('decodeURI and decodeURIComponent tests', function() {
	var cases = {
		'Simple example': [ 'abc %66%6f%6f%c2%a0%62%61%72', "abc foo\u00a0bar" ],
		'Non-BMP example': [ '%66%6f%6f%f0%9f%92%a9%62%61%72', 'foo💩bar' ],
		'Reserved chars (lowercase hex)': [
			'%22%23%24%25%26%27%28%29%2a%2b%2c%2d%2e%2f%30%31%32%33%34%35%36%37%38%39%3a%3b%3c%3d%3e%3f%40',
			'"#$%&\'()*+,-./0123456789:;<=>?@',
			'"%23%24%%26\'()*%2b%2c-.%2f0123456789%3a%3b<%3d>%3f%40',
		],
		'Reserved chars (uppercase hex)': [
			'%22%23%24%25%26%27%28%29%2A%2B%2C%2D%2E%2F%30%31%32%33%34%35%36%37%38%39%3A%3B%3C%3D%3E%3F%40',
			'"#$%&\'()*+,-./0123456789:;<=>?@',
			'"%23%24%%26\'()*%2B%2C-.%2F0123456789%3A%3B<%3D>%3F%40',
		],
		'Reserved chars (literals aren\'t encoded)': [
			'"#$&\'()*+,-./0123456789:;<=>?@',
			'"#$&\'()*+,-./0123456789:;<=>?@',
		],
		'Invalid byte': [ '%66%6f%6f%aA%62%61%72', 'foo%aAbar' ],
		'Overlong sequence': [ '%66%6f%6f%c1%98%62%61%72', 'foo%c1%98bar' ],
		'Out of range sequence': [ '%66%6f%6f%f4%90%80%80%62%61%72', 'foo%f4%90%80%80bar' ],
		'Truncated sequence': [ '%66%6f%6f%f0%9f%92%c9%62%61%72', 'foo%f0%9f%92%c9bar' ],
		'Too many continuation bytes': [ '%66%6f%6f%c2%a0%a0%62%61%72', "foo\u00a0%a0bar" ],
		'Invalid percent-sequence': [ '%66%6f%6f%aG%%62%61%72', 'foo%aG%bar' ],
		'Truncated percent-sequence': [ '%66%6f%6', 'fo%6' ],
		'Truncated percent-sequence (2)': [ '%66%6f%', 'fo%' ],
	};

	Object.keys(cases).forEach(function(k) {
		var input = cases[k][0];
		var expect1 = cases[k][1];
		var expect2 = cases[k][2] || expect1;

		it('For decodeURIComponent, ' + k, function() {
			expect(Util.decodeURIComponent(input)).to.equal(expect1);
		});
		it('For decodeURI, ' + k, function() {
			expect(Util.decodeURI(input)).to.equal(expect2);
		});
	});
});
