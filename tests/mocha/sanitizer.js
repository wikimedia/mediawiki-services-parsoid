/* global describe, it */

'use strict';

require('../../core-upgrade.js');

var should = require('chai').should();

var Sanitizer = require('../../lib/wt2html/tt/Sanitizer').Sanitizer;
var defines = require('../../lib/wt2html/parser.defines.js');

var TagTk = defines.TagTk;

describe('Sanitizer', function() {
	it('should sanitize attributes according to php\'s getAttribsRegex', function() {
		var fakeEnv = {};
		var sanitizer = new Sanitizer(fakeEnv);
		var name = 'testelement';
		sanitizer.attrWhiteListCache[name] = new Set([
			'foo', 'עברית',
		]);
		var token = new TagTk(name);
		token.setAttribute('foo', 'bar');
		token.setAttribute('עברית', 'bar');
		token = sanitizer.sanitizeToken(token);
		token.getAttribute('foo').should.equal('bar');
		should.equal(token.getAttribute('עברית'), null);
	});
});
