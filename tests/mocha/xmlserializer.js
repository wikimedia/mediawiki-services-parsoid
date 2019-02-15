/* global describe, it */

'use strict';

var domino = require('domino');
var XMLSerializer = require('../../lib/wt2html/XMLSerializer.js');
require('chai').should();

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
		var ret = XMLSerializer.serialize(doc, options);
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
			'<p about="#mwt1" id="justhappenstobehere">b</p>' +
			'<p id="mwAg">c</p>' +
			'</body></html>';
		var doc = domino.createDocument(html);
		var options = {
			smartQuote: true,
			innerXML: false,
			captureOffsets: true,
		};
		var ret = XMLSerializer.serialize(doc, options);
		ret.should.have.property('offsets');
		ret.offsets.should.have.property('mwAQ');
		ret.offsets.should.have.property('mwAg');
		ret.offsets.should.not.have.property('justhappenstobehere');
		ret.offsets.mwAQ.html.should.eql([0, 104]);
		ret.offsets.mwAg.html.should.eql([104, 122]);
	});

	it('should handle expanded attrs properly while capturing offsets', function() {
		var html = '<html><head><title>hi</title><body>' +
			'<div style="color:red" about="#mwt2" typeof="mw:ExpandedAttrs" id="mwAQ" data-mw=\'{"attribs":[[{"txt":"style"},{"html":"&lt;span about=\\"#mwt1\\" typeof=\\"mw:Transclusion\\" data-parsoid=\\"{&amp;quot;pi&amp;quot;:[[{&amp;quot;k&amp;quot;:&amp;quot;1&amp;quot;}]],&amp;quot;dsr&amp;quot;:[12,30,null,null]}\\" data-mw=\\"{&amp;quot;parts&amp;quot;:[{&amp;quot;template&amp;quot;:{&amp;quot;target&amp;quot;:{&amp;quot;wt&amp;quot;:&amp;quot;echo&amp;quot;,&amp;quot;href&amp;quot;:&amp;quot;./Template:Echo&amp;quot;},&amp;quot;params&amp;quot;:{&amp;quot;1&amp;quot;:{&amp;quot;wt&amp;quot;:&amp;quot;color:red&amp;quot;}},&amp;quot;i&amp;quot;:0}}]}\\">color:red&lt;/span>"}]]}\'>boo</div>' +
			'<p id="mwAg">next!</p>' +
			'</body></html>';
		var doc = domino.createDocument(html);
		var options = {
			smartQuote: true,
			innerXML: false,
			captureOffsets: true,
		};
		var ret = XMLSerializer.serialize(doc, options);
		ret.should.have.property('offsets');
		ret.offsets.should.have.property('mwAQ');
		ret.offsets.mwAQ.html.should.eql([0, 684]);
		ret.offsets.should.have.property('mwAg');
		ret.offsets.mwAg.html.should.eql([684, 706]);
	});

	it('should handle extension content nested in templates while capturing offsets', function() {
		// Mostly scooped from, echo "{{Demografia/Apricale}}" | node tests/parse --prefix itwiki --dp
		var html = '<html><head><title>hi</title><body>' +
		'<p about="#mwt1" typeof="mw:Transclusion" id="mwAQ" data-mw=\'{"parts":[{"template":{"target":{"wt":"Demografia/Apricale","href":"./Template:Demografia/Apricale"},"params":{},"i":0}}]}\'><i>Abitanti censiti</i></p>' +
		'<map name="timeline" id="timeline" typeof="mw:Extension/timeline" data-mw=\'{"name":"timeline","attrs":{},"body":{"extsrc":"yadayadayada"}}\' about="#mwt1"></map>' +
		'</body></html>';
		var doc = domino.createDocument(html);
		var options = {
			smartQuote: true,
			innerXML: false,
			captureOffsets: true,
		};
		var ret = XMLSerializer.serialize(doc, options);
		ret.should.have.property('offsets');
		ret.offsets.should.have.property('mwAQ');
		ret.offsets.should.not.have.property('timeline');
		ret.offsets.mwAQ.html.should.eql([0, 372]);
	});

});
