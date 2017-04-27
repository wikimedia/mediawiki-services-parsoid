/** Testing the JavaScript API. */
/* global describe, it */

"use strict";

var Parsoid = require('../../');

describe('Parsoid JS API', function() {
	it('converts empty wikitext to HTML', function() {
		return Parsoid.parse('', { document: true }).then(function(res) {
			res.should.have.property('out');
			res.should.have.property('trailingNL');
			res.out.should.have.property('outerHTML');
			res.out.body.children.length.should.equal(0);
		});
	});
	it('converts simple wikitext to HTML', function() {
		return Parsoid.parse('hi there', { document: true }).then(function(res) {
			res.should.have.property('out');
			res.should.have.property('trailingNL');
			res.out.should.have.property('outerHTML');
		});
	});
});
