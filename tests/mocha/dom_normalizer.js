'use strict';

/* global describe, it */
/* eslint no-unused-expressions: off */

require('../../core-upgrade.js');
require('chai').should();

const { MockEnv } = require('../MockEnv');
const { DOMNormalizer } = require('../../lib/html2wt/DOMNormalizer.js');
const { ContentUtils } = require('../../lib/utils/ContentUtils.js');
const { DOMUtils } = require('../../lib/utils/DOMUtils.js');

const parseAndNormalize = function(html, opts) {
	const dummyEnv = new MockEnv({
		scrubWikitext: opts.scrubWikitext,
	}, null);

	const dummyState = {
		env: dummyEnv,
		selserMode: false,
		rtTestMode: false
	};

	const body = ContentUtils.ppToDOM(dummyEnv, html, { markNew: true });
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
			[
				'<h2><meta property="mw:PageProp/toc"/> ok</h2>',
				'<meta property="mw:PageProp/toc"/><h2>ok</h2>',
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
	{
		desc: "Formatting tags in links",
		stripDiffMarkers: true,
		scrubWikitext: true,
		tests: [
			// Reordered HTML serializable to simplified form
			[
				'<a rel="mw:WikiLink" href="./Football"><u><i><b>Football</b></i></u></a>',
				'<u><i><b><a rel="mw:WikiLink" href="./Football">Football</a></b></i></u>',
			],
			// Reordered HTML changes semantics
			[
				'<a rel="mw:WikiLink" href="./Football"><i color="brown">Football</i></a>',
				'<a rel="mw:WikiLink" href="./Football"><i color="brown">Football</i></a>',
			],
			// Reordered HTML NOT serializable to simplified form
			[
				'<a rel="mw:WikiLink" href="./Football"><u><i><b>Soccer</b></i></u></a>',
				'<a rel="mw:WikiLink" href="./Football"><u><i><b>Soccer</b></i></u></a>',
			],
		],
	},
	{
		desc: "Escapable prefixes in table cells",
		stripDiffMarkers: true,
		scrubWikitext: true,
		tests: [
			[
				'<table><tbody><tr><td>+</td><td>-</td></tr></tbody></table>',
				'<table><tbody><tr><td> +</td><td> -</td></tr></tbody></table>',
			],
		],
	},
	// More to come
];

const noDiffMarkerSpecsWithoutScrubWikitext = [
	{
		// No change in results compared to no-scrub
		desc: "Minimizable tags",
		scrubWikitext: false,
		tests: [
			[ "<i>X</i><i>Y</i>", "<i>XY</i>" ],
			[ "<i>X</i><b><i>Y</i></b>", "<i>X<b>Y</b></i>" ],
			[ "<i>A</i><b><i>X</i></b><b><i>Y</i></b><i>Z</i>", "<i>A<b>XY</b>Z</i>" ],
		],
	},
	{
		desc: "Headings",
		scrubWikitext: false,
		tests: [
			[
				'<h2>H2<link href="Category:A1" rel="mw:PageProp/Category"/></h2>',
				'<h2>H2<link href="Category:A1" rel="mw:PageProp/Category"/></h2>',
			],
		],
	},
	{
		desc: "Tables",
		scrubWikitext: false,
		tests: [
			[
				'<table><tbody><tr><td>+</td><td>-</td></tr></tbody></table>',
				'<table><tbody><tr><td>+</td><td>-</td></tr></tbody></table>',
			],
		],
	},
	{
		desc: "Links",
		scrubWikitext: false,
		tests: [
			[
				'<a data-parsoid="{}" href="FootBall">Foot</a><a href="FootBall">Ball</a>',
				// NOTE: we are stripping data-parsoid before comparing output in our testing.
				// Hence the difference in output.
				'<a href="FootBall">Foot</a><a href="FootBall">Ball</a>',
			],
			[
				'<a rel="mw:WikiLink" href="./Football"><u><i><b>Football</b></i></u></a>',
				'<a rel="mw:WikiLink" href="./Football"><u><i><b>Football</b></i></u></a>',
			],
			[
				'<a rel="mw:WikiLink" href="./Foo">Foo </a>bar',
				'<a rel="mw:WikiLink" href="./Foo">Foo </a>bar'
			],
		],
	},
];

describe('DOM Normalization (No Diff Markers, Scrub Wikitext): ', function() {
	noDiffMarkerSpecsWithScrubWikitext.forEach(function(s) {
		const desc = s.desc;
		it('should succeed for ' + JSON.stringify(desc), function() {
			s.tests.forEach(function(t) {
				return parseAndNormalize(t[0], s).should.equal(t[1]);
			});
		});
	});
});

describe('DOM Normalization (No Scrub Wikitext): ', function() {
	noDiffMarkerSpecsWithoutScrubWikitext.forEach(function(s) {
		const desc = s.desc;
		it('should succeed for ' + JSON.stringify(desc), function() {
			s.tests.forEach(function(t) {
				return parseAndNormalize(t[0], s).should.equal(t[1]);
			});
		});
	});
});
