/** Testing the JavaScript API. */
/* global describe, it */

"use strict";

var Parsoid = require('../../');
var DU = require('../../lib/utils/DOMUtils.js').DOMUtils;

describe('Parsoid JS API', function() {
	it('converts empty wikitext to HTML', function() {
		return Parsoid.parse({
			input: '',
			mode: 'wt2html',
			parsoidOptions: {
				loadWMF: true,
				wrapSections: false,
			},
			envOptions: {
				domain: 'en.wikipedia.org',
			},
		})
		.then(function(out) {
			var doc = DU.parseHTML(out.html);
			doc.should.have.property('outerHTML');
			doc.body.children.length.should.equal(0);
		});
	});
	it('converts simple wikitext to HTML', function() {
		return Parsoid.parse({
			input: 'hi there',
			mode: 'wt2html',
			parsoidOptions: {
				loadWMF: true,
			},
			envOptions: {
				domain: 'en.wikipedia.org',
			},
		})
		.then(function(out) {
			var doc = DU.parseHTML(out.html);
			doc.should.have.property('outerHTML');
		});
	});
});
