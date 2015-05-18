/*global describe, it*/
'use strict';

var domino = require('domino');
var XMLSerializer = require('../../lib/XMLSerializer.js');

var xmlserializer = new XMLSerializer();

describe('XML Serializer', function() {
	it('should capture html offsets while serializing', function() {
		var html = '<html><head><title>hi</title><body>' +
				'<div id="123">ok<div id="234">nope</div></div>' +
				'\n\n<!--comment--><div id="345">end</div></body></html>';
		var doc = domino.createDocument(html);
		var options = {
			smartQuote: true,
			innerXML: false,
			captureOffsets: true,
		};
		var ret = xmlserializer.serializeToString(doc, options);
		ret.should.have.property('offsets');
		ret.offsets.should.have.property('123');
		ret.offsets['123'].html.should.eql([0, 62]);
		ret.offsets.should.not.have.property('234');
		ret.offsets.should.have.property('345');
		ret.offsets['345'].html.should.eql([62, 85]);
	});
	it('should handle templates properly while capturing offsets', function() {
		var html = '<html><head><title>hi</title><body>' +
			'<p about="#mwt1" typeof="mw:Transclusion" id="mwAQ">a</p>' +
			'<p about="#mwt1">b</p>' +
			'<p id="mwAg">c</p>' +
			'</body></html>';
		var doc = domino.createDocument(html);
		var options = {
			smartQuote: true,
			innerXML: false,
			captureOffsets: true,
		};
		var ret = xmlserializer.serializeToString(doc, options);
		ret.should.have.property('offsets');
		ret.offsets.should.have.property('mwAQ');
		ret.offsets.should.have.property('mwAg');
		ret.offsets.mwAQ.html.should.eql([0, 79]);
		ret.offsets.mwAg.html.should.eql([79, 97]);
	});
});
