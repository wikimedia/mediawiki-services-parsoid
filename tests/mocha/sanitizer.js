/* global describe, it */

'use strict';

require('../../core-upgrade.js');

var should = require('chai').should();

var Sanitizer = require('../../lib/wt2html/tt/Sanitizer').Sanitizer;
const { TagTk } = require('../../lib/tokens/TokenTypes.js');

describe('Sanitizer', function() {
	it('should sanitize attributes according to php\'s getAttribsRegex', function() {
		var fakeEnv = {};
		var fakeFrame = {};
		var name = 'testelement';
		Sanitizer.attributeWhitelistCache[name] = new Set([
			'foo', 'עברית', '६', '搭𨋢', 'ńgh',
		]);
		var token = new TagTk(name);
		token.setAttribute('foo', 'bar');
		token.setAttribute('bar', 'foo');
		token.setAttribute('עברית', 'bar');
		token.setAttribute('६', 'bar');
		token.setAttribute('搭𨋢', 'bar');
		token.setAttribute('ńgh', 'bar');
		token = Sanitizer.sanitizeToken(fakeEnv, fakeFrame, token);
		token.getAttribute('foo').should.equal('bar');
		should.equal(token.getAttribute('bar'), null);
		token.getAttribute('עברית').should.equal('bar');
		token.getAttribute('६').should.equal('bar');
		token.getAttribute('搭𨋢').should.equal('bar');
		should.equal(token.getAttribute('ńgh'), null);
	});
});
