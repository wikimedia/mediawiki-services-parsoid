'use strict';

/* global describe, it */
require('../../core-upgrade.js');
const assert = require('chai').assert;

const { DOMDataUtils } = require('../../lib/utils/DOMDataUtils');
const { ContentUtils } = require('../../lib/utils/ContentUtils');
const { MockEnv } = require('../MockEnv');
const {
	ConstrainedText,
	AutoURLLinkText,
	ExtLinkText,
	LanguageVariantText,
	MagicLinkText,
	WikiLinkText
} = require('../../lib/html2wt/ConstrainedText');

/** Unit tests for ConstrainedText */

describe('ConstrainedText', () => {
	const tests = [
		{
			name: 'WikiLinkText: Simple',
			linkTrailRegex: /^([a-z]+)/, // enwiki
			html: '<a rel="mw:WikiLink" href="./Foo" title="Foo" data-parsoid=\'{"stx":"simple","a":{"href":"./Foo"},"sa":{"href":"Foo"}}\'>Foo</a>',
			types: [ WikiLinkText ],
			text: '[[Foo]]',
			escapes: [
				{
					output: '[[Foo]]',
				},
				{
					left: 'bar ',
					right: ' bat',
					output: 'bar [[Foo]] bat',
				},
				{
					left: '[',
					right: ']',
					output: '[<nowiki/>[[Foo]]]',
				},
				{
					// not a link trail
					right: "'s",
					output: '[[Foo]]\'s',
				},
				{
					// a link trail
					right: 's',
					output: '[[Foo]]<nowiki/>s',
				},
			],
		},
		{
			name: 'WikiLinkText: iswiki linkprefix/linktrail',
			linkPrefixRegex: /[áÁðÐéÉíÍóÓúÚýÝþÞæÆöÖA-Za-z–-]+$/,
			linkTrailRegex: /^([áðéíóúýþæöa-z-–]+)/,
			html: '<a rel="mw:WikiLink" href="./Foo" title="Foo" data-parsoid=\'{"stx":"simple","a":{"href":"./Foo"},"sa":{"href":"Foo"}}\'>Foo</a>',
			types: [ WikiLinkText ],
			text: '[[Foo]]',
			escapes: [
				{
					left: 'bar ',
					right: ' bat',
					output: 'bar [[Foo]] bat',
				},
				{
					left: '-',
					right: '-',
					output: '-<nowiki/>[[Foo]]<nowiki/>-',
				},
			],
		},
		{
			name: 'WikiLinkText: iswiki greedy linktrails',
			linkPrefixRegex: /[áÁðÐéÉíÍóÓúÚýÝþÞæÆöÖA-Za-z–-]+$/,
			linkTrailRegex: /^([áðéíóúýþæöa-z-–]+)/,
			html: '<p data-parsoid=\'{"dsr":[0,11,0,0]}\'><a rel="mw:WikiLink" href="./A" title="A" data-parsoid=\'{"stx":"simple","a":{"href":"./A"},"sa":{"href":"a"},"dsr":[0,6,2,3],"tail":"-"}\'>a-</a><a rel="mw:WikiLink" href="./B" title="B" data-parsoid=\'{"stx":"simple","a":{"href":"./B"},"sa":{"href":"b"},"dsr":[6,11,2,2]}\'>b</a></p>',
			types: [
				ConstrainedText,
				WikiLinkText,
				ConstrainedText,
				WikiLinkText,
			],
			text: '[[a]]-[[b]]',
			escapes: [{
				// this would be '[[a]]-<nowiki/>[[b]] if the "greedy"
				// functionality wasn't present; see commit
				// 88605a4a7a37a61da76238db6d3fff756e8514f1
				output: '[[a]]-[[b]]'
			}],
		},
		{
			name: 'ExtLinkText',
			html: '<a rel="mw:ExtLink" href="https://example.com" class="external autonumber" data-parsoid=\'{"targetOff":20,"contentOffsets":[20,20],"dsr":[0,21,20,1]}\'></a>',
			types: [
				ExtLinkText,
			],
			text: '[https://example.com]',
			escapes: [
				{
					// ExtLinkText isn't very interesting
					output: '[https://example.com]',
				},
				{
					left: '[',
					right: ']',
					// FIXME This output is wrong! See: T220018
					output: '[[https://example.com]]',
				},
			],
		},
		{
			name: 'AutoURLLinkText: no paren',
			html: '<a rel="mw:ExtLink" href="http://example.com" class="external free" data-parsoid=\'{"stx":"url","dsr":[0,18,0,0]}\'>http://example.com</a>',
			types: [
				AutoURLLinkText,
			],
			text: 'https://example.com',
			escapes: [
				{
					output: 'https://example.com',
				},
				{
					// Non-word characters are find in the prefix
					left: '(',
					output: '(https://example.com',
				},
				{
					// Word characters need an escape
					left: 'foo',
					right: 'bar',
					output: 'foo<nowiki/>https://example.com<nowiki/>bar',
				},
				{
					// Close paren is fine in the trailing context so long
					// as the URL doesn't have a paren.
					left: '(',
					right: ')',
					output: '(https://example.com)',
				},
				{
					// Ampersand isn't allowed in the trailing context...
					right: '&',
					output: 'https://example.com<nowiki/>&',
				},
				{
					// ...but an entity will terminate the autourl
					right: '&lt;',
					output: 'https://example.com&lt;',
				},
				{
					// Single quote isn't allowed...
					right: "'",
					output: 'https://example.com<nowiki/>\'',
				},
				{
					// ...but double-quote (aka bold or italics) is fine
					left: "''",
					right: "''",
					output: "''https://example.com''",
				},
				{
					// Punctuation is okay.
					right: ".",
					output: "https://example.com.",
				},
				{
					left: '[',
					right: ' foo]',
					// FIXME This output is wrong! See: T220018
					output: '[https://example.com foo]',
				},
			],
		},
		{
			name: 'AutoURLLinkText: w/ paren',
			html: '<a rel="mw:ExtLink" href="http://example.com/foo(bar" class="external free" data-parsoid=\'{"stx":"url","dsr":[0,26,0,0]}\'>http://example.com/foo(bar</a></p>',
			types: [
				AutoURLLinkText,
			],
			text: 'https://example.com/foo(bar',
			escapes: [
				{
					output: 'https://example.com/foo(bar',
				},
				{
					// Close paren is escaped in the trailing context since
					// the URL has a paren.
					left: '(',
					right: ')',
					output: '(https://example.com/foo(bar<nowiki/>)',
				},
			],
		},
		{
			name: 'AutoURLLinkText: w/ ampersand',
			html: '<a rel="mw:ExtLink" href="http://example.com?foo&amp;lt" class="external free" data-parsoid=\'{"stx":"url","dsr":[0,25,0,0]}\'>http://example.com?foo&amp;lt</a>',
			types: [
				AutoURLLinkText,
			],
			text: 'https://example.com?foo&lt',
			escapes: [
				{
					output: 'https://example.com?foo&lt',
				},
				{
					right: '.',
					output: 'https://example.com?foo&lt.',
				},
				{
					// Careful of right contexts which could complete an
					// entity
					right: ';',
					output: 'https://example.com?foo&lt<nowiki/>;',
				},
			],
		},
		{
			name: 'MagicLinkText',
			html: '<a href="./Special:BookSources/1234567890" rel="mw:WikiLink" data-parsoid=\'{"stx":"magiclink","dsr":[0,15,2,2]}\'>ISBN 1234567890</a>',
			types: [
				MagicLinkText,
			],
			text: 'ISBN 1234567890',
			escapes: [
				{
					output: 'ISBN 1234567890'
				},
				{
					left: 'I',
					right: '1',
					output: 'I<nowiki/>ISBN 1234567890<nowiki/>1'
				},
			],
		},
		{
			name: 'LanguageVariantText',
			html: '<span typeof="mw:LanguageVariant" data-mw-variant=\'{"disabled":{"t":"raw"}}\' data-parsoid=\'{"fl":[],"src":"-{raw}-","dsr":[0,7,null,2]}\'></span>',
			types: [
				LanguageVariantText,
			],
			text: '-{raw}-',
			escapes: [
				{
					output: '-{raw}-',
				},
				{
					// single | at SOL causes issues with table markup
					left: '|',
					output: '|<nowiki/>-{raw}-',
				},
				{
					left: '||',
					output: '||-{raw}-',
				}
			],
		},
	];
	for (const t of tests) {
		it(t.name, () => {
			// Set up environment and test data
			const env = new MockEnv({}, null);
			if (t.linkPrefixRegex) {
				env.conf.wiki.linkPrefixRegex = t.linkPrefixRegex;
			}
			if (t.linkTrailRegex) {
				env.conf.wiki.linkTrailRegex = t.linkTrailRegex;
			}
			const body = ContentUtils.ppToDOM(env, t.html);
			const node = body.firstChild;
			const dataParsoid = DOMDataUtils.getDataParsoid(node);

			// Test ConstrainedText.fromSelSer
			const ct = ConstrainedText.fromSelSer(t.text, node, dataParsoid, env);
			assert.isArray(ct);
			assert.deepEqual(
				ct.map(x => x.constructor.name),
				t.types.map(x => x.name)
			);

			// Test ConstrainedText.escapeLine
			for (const e of t.escapes) {
				const nct = ct.slice(0);
				if (e.left !== undefined) {
					nct.unshift(ConstrainedText.cast(e.left));
				}
				if (e.right !== undefined) {
					nct.push(ConstrainedText.cast(e.right));
				}
				const r = ConstrainedText.escapeLine(nct);
				assert.strictEqual(r, e.output);
			}
		});
	}
});
