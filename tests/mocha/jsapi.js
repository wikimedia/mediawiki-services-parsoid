/** Testing the JavaScript API. */
/*global describe, it, before*/
"use strict";

var Parsoid = require('../../');

describe('Parsoid JS API', function() {
	it('converts simple wikitext to HTML', function() {
		return Parsoid.parse('hi there', { document: true }).then(function(res) {
			res.should.have.property('out');
			res.should.have.property('trailingNL');
			res.out.should.have.property('outerHTML');
		});
	});
});

describe('Examples from guides/jsapi', function() {
	it('converts simple wikitext to HTML', function() {
		return Parsoid.parse('I love wikitext!', { pdoc: true}).then(function(pdoc) {
			pdoc.should.have.property('document');
			pdoc.document.should.have.property('outerHTML');
		});
	});
	it('filters out templates', function() {
		var text = "I has a template! {{foo|bar|baz|eggs=spam}} See it?\n";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			String(pdoc).should.equal(text);
			var templates = pdoc.filterTemplates();
			templates.length.should.equal(1);
			String(templates[0]).should.equal('{{foo|bar|baz|eggs=spam}}');
			var template = templates[0];
			template.name.should.equal('foo');
			template.name = 'notfoo';
			String(template).should.equal('{{notfoo|bar|baz|eggs=spam}}');
			template.params.length.should.equal(3);
			template.params[0].should.equal('1');
			template.params[1].should.equal('2');
			template.params[2].should.equal('eggs');
			String(template.get(1).value).should.equal('bar');
			String(template.get('eggs').value).should.equal('spam');
		});
	});
	it('filters templates, recursively', function() {
		var text = "{{foo|{{bar}}={{baz|{{spam}}}}}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var templates = pdoc.filterTemplates();
			// XXX note that {{bar}} as template name doesn't get handled;
			//     that's bug T106852
			templates.length.should.equal(3);
		});
	});
	it('filters templates, non-recursively', function() {
		var text = "{{foo|this {{includes a|template}}}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var templates = pdoc.filterTemplates({ recursive: false });
			templates.length.should.equal(1);
			var foo = templates[0];
			String(foo.get(1).value).should.equal('this {{includes a|template}}');
			var more = foo.get(1).value.filterTemplates();
			more.length.should.equal(1);
			String(more[0].get(1).value).should.equal('template');
		});
	});
	it('is easy to mutate templates', function() {
		var text = "{{cleanup}} '''Foo''' is a [[bar]]. {{uncategorized}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			pdoc.filterTemplates().forEach(function(template) {
				if (template.matches('Cleanup') && !template.has('date')) {
					template.add('date', 'July 2012');
				}
				if (template.matches('uncategorized')) {
					template.name = 'bar-stub';
				}
			});
			String(pdoc).should.equal("{{cleanup|date = July 2012}} '''Foo''' is a [[bar]]. {{bar-stub}}");
		});
	});
});

describe('Further examples of PDoc API', function() {
	it('is easy to mutate templates (2)', function() {
		// Works even on nested templates!
		var text = "{{echo|{{cleanup}} '''Foo''' is a [[bar]].}} {{uncategorized}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			pdoc.filterTemplates().forEach(function(template) {
				if (template.matches('Cleanup') && !template.has('date')) {
					template.add('date', 'July 2012');
					// Works even when there are special characters
					template.add('test1', '{{foo}}&bar|bat<p>');
					template.add('test2', Parsoid.PNodeList.fromHTML(pdoc, "I'm so <b>bold</b>!"));
				}
			});
			String(pdoc).should.equal("{{echo|{{cleanup|date = July 2012|test1 = <nowiki>{{foo}}</nowiki>&bar{{!}}bat<nowiki><p></nowiki>|test2 = I'm so '''bold'''!}} '''Foo''' is a [[bar]].}} {{uncategorized}}");
		});
	});
	it('is safe to mutate template arguments', function() {
		var text = "{{echo|foo|bar}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var t = pdoc.filterTemplates()[0];
			t.remove(1);
			String(pdoc).should.equal('{{echo||bar}}');
		});
	});
	it('filters and mutates headings', function() {
		var text = "= one =\n== two ==\n=== three ===\n==== four ====\nbody";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var headings = pdoc.filterHeadings();
			headings.length.should.equal(4);
			headings[0].level.should.equal(1);
			headings[1].level.should.equal(2);
			headings[2].level.should.equal(3);
			headings[3].level.should.equal(4);
			headings[0].title.toHtml().should.equal(' one ');
			headings[1].title.toHtml().should.equal(' two ');
			headings[2].title.toHtml().should.equal(' three ');
			headings[3].title.toHtml().should.equal(' four ');
			headings[0].title = '=0=';
			headings[1].title = headings[2].title;
			headings[3].level = 3;
			String(pdoc).should.equal('=<nowiki>=0=</nowiki>=\n== three ==\n=== three ===\n\n=== four ===\nbody\n');
		});
	});
	it('filters and mutates headings inside templates', function() {
		var text = "{{echo|1=\n= one =\n}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var headings = pdoc.filterHeadings();
			headings.length.should.equal(1);
			headings[0].level = 2;
			String(headings[0]).should.equal('== one ==\n');
			String(pdoc).should.equal('{{echo|1=\n== one ==\n}}');
			headings[0].title = 'two';
			String(headings[0]).should.equal('== two ==\n');
			String(pdoc).should.equal('{{echo|1=\n== two ==\n}}');
		});
	});
	it('filters and mutates external links', function() {
		var text = "[http://example.com {{echo|link content}}]";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var extlinks = pdoc.filterExtLinks();
			extlinks.length.should.equal(1);
			String(extlinks[0].url).should.equal('http://example.com');
			String(extlinks[0].title).should.equal('{{echo|link content}}');
			extlinks[0].title = ']';
			String(pdoc).should.equal('[http://example.com <nowiki>]</nowiki>]\n');
		});
	});
	it('filters and mutates wiki links', function() {
		var text = "[[foo|1]] {{echo|[[bar|2]]}} [[{{echo|bat}}|3]]";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var extlinks = pdoc.filterWikiLinks();
			extlinks.length.should.equal(3);
			String(extlinks[0].title).should.equal('Foo');
			String(extlinks[0].text).should.equal('1');
			String(extlinks[1].title).should.equal('Bar');
			String(extlinks[1].text).should.equal('2');
			String(extlinks[2].text).should.equal('3');
			extlinks[0].title = extlinks[0].text = 'foobar';
			extlinks[1].text = 'A';
			extlinks[2].text = 'B';
			String(pdoc).should.equal('[[foobar]] {{echo|[[bar|A]]}} [[{{echo|bat}}|B]]\n');
		});
	});
	it('filters and mutates html entities', function() {
		var text = '&amp;{{echo|&quot;}}';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var entities = pdoc.filterHtmlEntities();
			entities.length.should.equal(2);
			entities[0].normalized.should.equal('&');
			entities[1].normalized.should.equal('"');
			entities[0].normalized = '<';
			entities[1].normalized = '>';
			String(pdoc).should.equal('&#x3C;{{echo|&#x3E;}}\n');
		});
	});
	it('filters and mutates comments', function() {
		var text = '<!-- foo --> {{echo|<!--bar-->}}';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var comments = pdoc.filterComments();
			comments.length.should.equal(2);
			comments[0].contents.should.equal(' foo ');
			comments[1].contents.should.equal('bar');
			comments[0].contents = '<!-- ha! -->';
			comments[1].contents = '--';
			String(pdoc).should.equal('<!--<!-- ha! --&gt;--> {{echo|<!------>}}');
		});
	});
	it('filters and mutates text', function() {
		var text = 'foo {{echo|bar}}';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var texts = pdoc.filterText({ recursive: false });
			texts.length.should.equal(1);
			texts = pdoc.filterText({ recursive: true });
			texts.length.should.equal(2);
			texts[0].value.should.equal('foo ');
			texts[1].value.should.equal('bar');
			texts[0].value = 'FOO ';
			String(pdoc).should.equal('FOO {{echo|bar}}\n');
			texts[1].value = 'BAR';
			String(pdoc).should.equal('FOO {{echo|BAR}}\n');
		});
	});
	it.skip('filters and mutates text (2)', function() {
		var text = '{{{echo|{{!}}}}\n| foo\n|}';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var texts = pdoc.filterText();
			texts.length.should.equal(1);
			// XXX this doesn't work yet, see note at end of
			// https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec#Transclusion_content
			// for details.
			texts[0].value.should.equal(' foo');
		});
	});
	it('allows mutation using wikitext', function() {
		var text = '== heading ==';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var headings = pdoc.filterHeadings();
			headings.length.should.equal(1);
			// Note that even if the wikitext is unbalanced, the result
			// will be balanced.  The bold face doesn't escape the heading!
			return Parsoid.PNodeList.fromWikitext(pdoc, "'''bold").then(function(pnl) {
				headings[0].title = pnl;
				String(pdoc).should.equal("== '''bold''' ==\n");
			});
		});
	});
});
