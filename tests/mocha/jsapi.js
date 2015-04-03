/** Testing the JavaScript API. */
/*global describe, it, before*/
"use strict";

var Parsoid = require( '../../' );

describe('Parsoid JS API', function() {
    it("converts simple wikitext to HTML", function() {
        return Parsoid.parse('hi there', { document: true }).then(function(res) {
            res.should.have.property('out');
            res.should.have.property('trailingNL');
            res.out.should.have.property('outerHTML');
        });
    });
});
