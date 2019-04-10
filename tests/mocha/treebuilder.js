'use strict';

/* global describe, it */

require('../../core-upgrade.js');
require('chai').should();

const { EventEmitter } = require('events');

const { MockEnv } = require('../MockEnv');
const { HTML5TreeBuilder } = require('../../lib/wt2html/HTML5TreeBuilder.js');
const { TagTk, EndTagTk } = require('../../lib/tokens/TokenTypes.js');

const buildFromTokens = function(tokens) {
	const env = new MockEnv({}, null);
	const tb = new HTML5TreeBuilder(env);
	let doc;
	tb.addListener('document', function(_doc) {
		doc = _doc;
	});
	const ev = new EventEmitter();
	tb.addListenersOn(ev);
	ev.emit('chunk', tokens);
	ev.emit('end');
	return doc;
};

describe('HTML5TreeBuilder', function() {
	it('should build a document', function() {
		const doc = buildFromTokens([
			new TagTk('p'),
			'Testing 123',
			new EndTagTk('p'),
		]);
		doc.body.innerHTML.should.equal('<p data-object-id="0"><meta typeof="mw:StartTag" data-stag="p:1" data-object-id="1">Testing 123</p><meta data-object-id="3" typeof="mw:EndTag" data-etag="p">');
	});
});
