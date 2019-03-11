'use strict';

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
