'use strict';

/* global describe, it */
/* eslint no-unused-expressions: off */

require('../../core-upgrade.js');
require('chai').should();

const { DOMNormalizer } = require('../../lib/html2wt/DOMNormalizer.js');
const { ContentUtils } = require('../../lib/utils/ContentUtils.js');
const { DOMUtils } = require('../../lib/utils/DOMUtils.js');
const { TestUtils } = require('../../tests/TestUtils.js');

const parseAndNormalize = function(html, opts) {
	const dummyEnv = {
		scrubWikitext: opts.scrubWikitext,
		conf: { parsoid: {}, wiki: {} },
		page: { id: null },
		log: function() {},
	};

	const dummyState = {
		env: dummyEnv,
		selserMode: false,
		rtTestMode: false
	};

	const body = TestUtils.ppToDOM(html).body;
	(new DOMNormalizer(dummyState)).normalize(body);

	if (opts.stripDiffMarkers) {
		// Strip diff markers for now
		DOMUtils.visitDOM(body, function(node) {
			if (DOMUtils.isDiffMarker(node)) {
				node.parentNode.removeChild(node);
			}
		});
	}

	return ContentUtils.ppToXML(body, { discardDataParsoid: true, innerXML: true });
};

const noDiffMarkerSpecsWithScrubWikitext = [
	{
		desc: "Tag Minimization",
		stripDiffMarkers: true,
		scrubWikitext: true,
		tests: [
			[ "<i>X</i><i>Y</i>", "<i>XY</i>" ],
			[ "<i>X</i><b><i>Y</i></b>", "<i>X<b>Y</b></i>" ],
			[ "<i>A</i><b><i>X</i></b><b><i>Y</i></b><i>Z</i>", "<i>A<b>XY</b>Z</i>" ],
			[
				// Second node is a newly inserted node
				'<a data-parsoid="{}" href="FootBall">Foot</a><a href="FootBall">Ball</a>',
				'<a href="FootBall">FootBall</a>'
			],
			[
				// Both nodes are old unedited nodes
				'<a data-parsoid="{}" href="FootBall">Foot</a><a data-parsoid="{}" href="FootBall">Ball</a>',
				'<a href="FootBall">Foot</a><a href="FootBall">Ball</a>',
			],
		],
	},
	{
		desc: "Headings (with scrubWikitext)",
		stripDiffMarkers: true,
		scrubWikitext: true,
		tests: [
			[
				'<h2>H2<link href="Category:A1" rel="mw:PageProp/Category"/></h2>',
				'<h2>H2</h2><link href="Category:A1" rel="mw:PageProp/Category"/>'
			],
		],
	},
	{
		desc: "Empty tag normalization",
		stripDiffMarkers: true,
		scrubWikitext: true,
		tests: [
			// These are stripped
			[ '<b></b>', '' ],
			[ '<i></i>', '' ],
			[ '<h2></h2>', '' ],
			[ '<a rel="mw:WikiLink" href="http://foo.org"></a>', '' ],
			// These should not be stripped
			[ '<p></p>', '<p></p>' ],
			[ '<div></div>', '<div></div>' ],
			[ '<a href="http://foo.org"></a>', '<a href="http://foo.org"></a>' ],
		],
	},
	{
		desc: "Trailing spaces in links",
		stripDiffMarkers: true,
		scrubWikitext: true,
		tests: [
			[
				'<a rel="mw:WikiLink" href="./Foo">Foo </a>',
				'<a rel="mw:WikiLink" href="./Foo">Foo</a>'
			],
			[
				'<a rel="mw:WikiLink" href="./Foo">Foo </a>bar',
				'<a rel="mw:WikiLink" href="./Foo">Foo</a> bar'
			],
			[
				'<a rel="mw:WikiLink" href="./Foo">Foo </a> bar',
				'<a rel="mw:WikiLink" href="./Foo">Foo</a> bar'
			],
		],
	},
	// More to come
];

const noDiffMarkerSpecsWithoutScrubWikitext = [
	{
		// No change in results compared no-scrub
		desc: "Minimizable tags",
		stripDiffMarkers: true,
		scrubWikitext: false,
		tests: [
			[ "<i>X</i><i>Y</i>", "<i>XY</i>" ],
			[ "<i>X</i><b><i>Y</i></b>", "<i>X<b>Y</b></i>" ],
			[ "<i>A</i><b><i>X</i></b><b><i>Y</i></b><i>Z</i>", "<i>A<b>XY</b>Z</i>" ],
		],
	},
	{
		desc: "Headings",
		stripDiffMarkers: true,
		scrubWikitext: false,
		tests: [
			[
				'<h2>H2<link href="Category:A1" rel="mw:PageProp/Category"/></h2>',
				'<h2>H2<link href="Category:A1" rel="mw:PageProp/Category"/></h2>',
			],
		],
	},
];

describe('DOM Normalization (No Diff Markers, Scrub Wikitext): ', function() {
	noDiffMarkerSpecsWithScrubWikitext.forEach(function(s) {
		var desc = s.desc;
		it('should succeed for ' + JSON.stringify(desc), function() {
			s.tests.forEach(function(t) {
				return parseAndNormalize(t[0], s).should.equal(t[1]);
			});
		});
	});
});

describe('DOM Normalization (No Diff Markers, No Scrub Wikitext): ', function() {
	noDiffMarkerSpecsWithoutScrubWikitext.forEach(function(s) {
		var desc = s.desc;
		it('should succeed for ' + JSON.stringify(desc), function() {
			s.tests.forEach(function(t) {
				return parseAndNormalize(t[0], s).should.equal(t[1]);
			});
		});
	});
});
