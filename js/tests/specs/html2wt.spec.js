var should  = require('should'),
	parsoid = require('../parsoid').Parsoid;

// Helpers
function dom(snippet) {
	parsoid.html5.parse( '<html><body>' + snippet + '</body></html>');
	return parsoid.html5.tree.document.childNodes[0].childNodes[1];
}

function wikitext(dom) {
	var out = [];
    parsoid.serializer.serializeDOM(dom, function(c) {
		out.push(c);
	});
	return out.join('');
}

function char_sequence(c, n) {
	var buf = [];
	for (var i = 0; i < n; i++) {
		buf.push(c);
	}
	return buf.join('');
}

// Heading specs
describe("Headings", function() {
	// Regular non-empty specs
	it("should be serialized properly when non-empty", function() {
		// wikitext(dom("<h1>foo</h1>")).should.equal("=foo=");
		// Repeat pattern from h1 .. h6
		for (var i = 1; i <= 6; i++) {
			var str  = char_sequence("=", i);
			var tag  = "h" + i;
			var html = "<" + tag + ">foo</" + tag + ">";
			var res  = str + "foo" + str;
			wikitext(dom(html)).should.equal(res);
		}
	});

	// Empty heading specs
	it("should be serialized properly when empty", function() {
		// wikitext(dom("<h1></h1>")).should.equal("=<nowiki></nowiki>=");
		// Repeat pattern from h1 .. h6
		for (var i = 1; i <= 6; i++) {
			var str  = char_sequence("=", i);
			var tag  = "h" + i;
			var html = "<" + tag + "></" + tag + ">";
			var res  = str + "<nowiki></nowiki>" + str;
			wikitext(dom(html)).should.equal(res);
		}
	});

	// Escape specs
	it("should escape wikitext properly", function() {
		wikitext(dom("=foo=")).should.equal("<nowiki>=</nowiki>foo<nowiki>=</nowiki>");

		// wikitext(dom("<h1>=foo=</h1>")).should.equal("=<nowiki>=</nowiki>foo<nowiki>=</nowiki>=");
		// Repeat pattern from h1 .. h5
		for (var i = 1; i <= 5; i++) {
			var str  = char_sequence("=", i);
			var tag  = "h" + i;
			var html = "<" + tag + ">=foo=</" + tag + ">";
			var res  = str + "<nowiki>=</nowiki>foo<nowiki>=</nowiki>" + str;
			wikitext(dom(html)).should.equal(res);
		}
	});

	it ("should escape wikitext after the closing tag if on the same line", function() {
		wikitext(dom("<h1>foo</h1>*bar")).should.equal("=foo=\n<nowiki>*</nowiki>bar");
		wikitext(dom("<h1>foo</h1>=bar")).should.equal("=foo=\n=bar");
		wikitext(dom("<h1>foo</h1>=bar=")).should.equal("=foo=\n<nowiki>=</nowiki>bar<nowiki>=</nowiki>");
	});
});

// List specs
describe("Lists", function() {
	// Escape specs
	it("should escape wikitext properly", function() {
		var liChars = ["*", "#", ":", ";"];
		for (var i = 0; i < liChars.length; i++) {
			var c    = liChars[i];
			var html = "<ul><li>" + c + "foo</li></ul>";
			var res  = "*<nowiki>" + c + "</nowiki>foo";
			wikitext(dom(html)).should.equal(res);
		}

		for (var i = 0; i < liChars.length; i++) {
			var c    = liChars[i];
			var html = "<ol><li>" + c + "foo</li></ol>";
			var res  = "#<nowiki>" + c + "</nowiki>foo";
			wikitext(dom(html)).should.equal(res);
		}
	});
});

// HR specs
describe("<hr>", function() {
	it ("should escape wikitext after the closing tag if on the same line", function() {
		wikitext(dom("<hr/>----")).should.equal("----\n<nowiki>----</nowiki>");
		wikitext(dom("<hr/>=foo=")).should.equal("----\n<nowiki>=</nowiki>foo<nowiki>=</nowiki>");
		wikitext(dom("<hr/>*foo")).should.equal("----\n<nowiki>*</nowiki>foo");
	});
});
