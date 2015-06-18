/* A map of test titles and their manually verified output. If the parser
 * output matches the expected output listed here, the test can be marked as
 * passing in parserTests.js. */

// CSA note: This whitelist dates back to when parsoid was an experiment,
// and there wasn't "php"/"parsoid" support in upstream's parserTests.  Now
// that Parsoid is mainstream, I'm trying to deprecate this file and move
// the tweaked tests upstream to mediawiki/core (splitting tests into 'php'
// and 'parsoid' versions where necessary).  This helps document the
// differences between the PHP and Parsoid parsers in one place (albeit
// one gigantic hard-to-read file, but still).
// So please don't add new entries here, except for experimental stuff
// which we're not sure we want to document/upstream.
// Known-broken-but-we'll-fix-it stuff goes in parserTests-blacklist.js

var testWhiteList = {};

// These tests fail because the PHP parser has seemingly-random rules regarding dd/dt.
// We are egotistical and assume we got it right, because we are more consistent.
// Also, the nesting is repeated in funny ways, and we recognize the shared nesting and
// keep the still-open tags around until the nesting is complete. PHP doesn't.
testWhiteList["Definition Lists: Mixed Lists: Test 11"] = "<ul><li><ol><li><ul><li><ol><li><dl><dt><ul><li><dl><dt><dl><dt>foo<span typeof=\"mw:Placeholder\" data-parsoid=\"{&quot;src&quot;:&quot; &quot;}\">&nbsp;</span></dt><dd data-parsoid=\"{&quot;tsr&quot;:[13,14],&quot;stx&quot;:&quot;row&quot;}\">bar\n</dd></dl></dt></dl></li></ul></dt><dt data-parsoid=\"{&quot;tsr&quot;:[17,21]}\">boo<span typeof=\"mw:Placeholder\" data-parsoid=\"{&quot;src&quot;:&quot; &quot;}\">&nbsp;</span></dt><dd data-parsoid=\"{&quot;tsr&quot;:[27,28],&quot;stx&quot;:&quot;row&quot;}\">baz</dd></dl></li></ol></li></ul></li></ol></li></ul>";

// Italic/link nesting is changed in this test, but the rendered result is the
// same. Currently the result is actually an improvement over the MediaWiki
// output.
testWhiteList["Bug 2702: Mismatched <i>, <b> and <a> tags are invalid"] = "<p><i><a href=\"http://example.com\">text<i></i></a></i><a href=\"http://example.com\"><b>text</b></a><b></b><i>Something <a href=\"http://example.com\">in italic<i></i></a></i><i>Something <a href=\"http://example.com\">mixed<b><i>, even bold</i></b></a>'</i><b><i>Now <a href=\"http://example.com\">both<b><i></i></b></a></i></b></p>";

// empty table tags / with only a caption are legal in HTML5.
testWhiteList["A table with no data."] = "<table></table>";
testWhiteList["A table with nothing but a caption"] = "<table><caption> caption</caption></table>";

// We preserve the trailing whitespace in a table cell, while the PHP parser
// strips it. It renders the same, and round-trips with the space.
// testWhiteList["Table rowspan"] = "<table border=\"1\" data-parsoid=\"{&quot;tsr&quot;:[0,11],&quot;bsp&quot;:[0,121]}\">\n<tbody><tr><td data-parsoid=\"{&quot;tsr&quot;:[12,13]}\"> Cell 1, row 1 \n</td><td rowspan=\"2\" data-parsoid=\"{&quot;tsr&quot;:[29,40]}\"> Cell 2, row 1 (and 2) \n</td><td data-parsoid=\"{&quot;tsr&quot;:[64,65]}\"> Cell 3, row 1 \n</td></tr><tr data-parsoid=\"{&quot;tsr&quot;:[81,84]}\">\n<td data-parsoid=\"{&quot;tsr&quot;:[85,86]}\"> Cell 1, row 2 \n</td><td data-parsoid=\"{&quot;tsr&quot;:[102,103]}\"> Cell 3, row 2 \n</td></tr></tbody></table>";

// The PHP parser strips the hash fragment for non-existent pages, but Parsoid does not.
// TODO: implement link target detection in a DOM postprocessor or on the client
// side.
testWhiteList["Broken link with fragment"] = "<p><a rel=\"mw:WikiLink\" href=\"Zigzagzogzagzig#zug\" title=\"Zigzagzogzagzig\" data-parsoid=\"{&quot;tsr&quot;:[0,23],&quot;src&quot;:&quot;[[Zigzagzogzagzig#zug]]&quot;,&quot;bsp&quot;:[0,23],&quot;stx&quot;:&quot;simple&quot;}\">Zigzagzogzagzig#zug</a></p>";
testWhiteList["Nonexistent special page link with fragment"] = "<p><a rel=\"mw:WikiLink\" href=\"Special:ThisNameWillHopefullyNeverBeUsed#anchor\" title=\"Special:ThisNameWillHopefullyNeverBeUsed\" data-parsoid=\"{&quot;tsr&quot;:[0,51],&quot;src&quot;:&quot;[[Special:ThisNameWillHopefullyNeverBeUsed#anchor]]&quot;,&quot;bsp&quot;:[0,51],&quot;stx&quot;:&quot;simple&quot;}\">Special:ThisNameWillHopefullyNeverBeUsed#anchor</a></p>";

testWhiteList["Fuzz testing: Parser22"] = "<p><a href=\"http://===r:::https://b\">http://===r:::https://b</a></p><table></table>";

/**
 * Small whitespace differences that we now start to care about for
 * round-tripping
 */

// Very minor whitespace difference at end of cell (MediaWiki inserts a
// newline before the close tag even if there was no trailing space in the cell)
// testWhiteList["Table rowspan"] = "<table border=\"1\"><tbody><tr><td> Cell 1, row 1 </td><td rowspan=\"2\"> Cell 2, row 1 (and 2) </td><td> Cell 3, row 1 </td></tr><tr><td> Cell 1, row 2 </td><td> Cell 3, row 2 </td></tr></tbody></table>";

// Inter-element whitespace only
// testWhiteList["Indented table markup mixed with indented pre content (proposed in bug 6200)"] = "   \n\n<table><tbody><tr><td><pre>\nText that should be rendered preformatted\n</pre></td></tr></tbody></table>";


/* Misc sanitizer / HTML5 differences */

// Sanitizer

if (typeof module === "object") {
	module.exports.testWhiteList = testWhiteList;
}
