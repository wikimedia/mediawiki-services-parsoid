/** Testing the JavaScript API. */
/*global describe, it*/
"use strict";

var Parsoid = require('../../');
var Promise = require('../../lib/utils/promise.js');

describe('Parsoid JS API', function() {
	it('converts empty wikitext to HTML', function() {
		return Parsoid.parse('', { document: true }).then(function(res) {
			res.should.have.property('out');
			res.should.have.property('trailingNL');
			res.out.should.have.property('outerHTML');
			res.out.body.children.length.should.equal(0);
		});
	});
	it('converts simple wikitext to HTML', function() {
		return Parsoid.parse('hi there', { document: true }).then(function(res) {
			res.should.have.property('out');
			res.should.have.property('trailingNL');
			res.out.should.have.property('outerHTML');
		});
	});
});

describe('Examples from guides/jsapi', function() {
	it('converts empty wikitext to HTML', function() {
		return Parsoid.parse('', { pdoc: true}).then(function(pdoc) {
			pdoc.should.have.property('document');
			pdoc.document.should.have.property('outerHTML');
			pdoc.document.body.children.length.should.equal(0);
		});
	});
	it('converts simple wikitext to HTML', function() {
		return Parsoid.parse('I love wikitext!', { pdoc: true}).then(function(pdoc) {
			pdoc.should.have.property('document');
			pdoc.document.should.have.property('outerHTML');
		});
	});
	it('filters out templates', function() {
		var text = "I has a template! {{foo|bar|baz|eggs=spam}} See it?\n";
		var pdoc, templates, template;
		return Parsoid.parse(text, { pdoc: true }).then(function(_pdoc) {
			pdoc = _pdoc;
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal(text);
			templates = pdoc.filterTemplates();
			templates.length.should.equal(1);
			return templates[0].toWikitext();
		}).then(function(wt) {
			wt.should.equal('{{foo|bar|baz|eggs=spam}}');
			template = templates[0];
			template.name.should.equal('foo');
			template.name = 'notfoo';
			return template.toWikitext();
		}).then(function(wt) {
			wt.should.equal('{{notfoo|bar|baz|eggs=spam}}');
			template.params.length.should.equal(3);
			template.params[0].name.should.equal('1');
			template.params[1].name.should.equal('2');
			template.params[2].name.should.equal('eggs');
			return template.get(1).value.toWikitext();
		}).then(function(wt) {
			wt.should.equal('bar');
			return template.get('eggs').value.toWikitext();
		}).then(function(wt) {
			wt.should.equal('spam');
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
		var foo;
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var templates = pdoc.filterTemplates({ recursive: false });
			templates.length.should.equal(1);
			foo = templates[0];
			return foo.get(1).value.toWikitext();
		}).then(function(wt) {
			wt.should.equal('this {{includes a|template}}');
			var more = foo.get(1).value.filterTemplates();
			more.length.should.equal(1);
			return more[0].get(1).value.toWikitext();
		}).then(function(wt) {
			wt.should.equal('template');
		});
	});
	it('is easy to mutate templates', function() {
		var text = "{{cleanup}} '''Foo''' is a [[bar]]. {{uncategorized}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			pdoc.filterTemplates().forEach(function(template) {
				if (template.nameMatches('Cleanup') && !template.has('date')) {
					template.add('date', 'July 2012');
				}
				if (template.nameMatches('uncategorized')) {
					template.name = 'bar-stub';
				}
			});
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal("{{cleanup|date=July 2012}} '''Foo''' is a [[bar]]. {{bar-stub}}");
		});
	});
});

describe('Further examples of PDoc API', function() {
	it('is easy to mutate templates (2)', function() {
		// Works even on nested templates!
		var text = "{{1x|{{cleanup}} '''Foo''' is a [[bar]].}} {{uncategorized}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			pdoc.filterTemplates().forEach(function(template) {
				if (template.nameMatches('Cleanup') && !template.has('date')) {
					template.add('date', 'July 2012');
					// Works even when there are special characters
					template.add('test1', '{{foo}}&bar|bat<p>');
					template.add('test2', Parsoid.PNodeList.fromHTML(pdoc, "I'm so <b>bold</b>!"));
				}
			});
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal("{{1x|{{cleanup|date=July 2012|test1=<nowiki>{{foo}}</nowiki>&bar{{!}}bat<nowiki><p></nowiki>|test2=I'm so '''bold'''!}} '''Foo''' is a [[bar]].}} {{uncategorized}}");
		});
	});
	it('is safe to mutate template arguments', function() {
		var text = "{{1x|foo|bar}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var t = pdoc.filterTemplates()[0];
			t.remove(1);
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('{{1x||bar}}');
		});
	});
	it('is safe to mutate template arguments (2)', function() {
		var text = "{{1x|foo|bar}}";
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var t = pdoc.filterTemplates()[0];
			var param1 = t.get(1);
			var param2 = t.get(2);
			param2.value = param1.value;
			param1.value = '|';
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('{{1x|{{!}}|foo}}');
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
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('=<nowiki>=0=</nowiki>=\n== three ==\n=== three ===\n\n=== four ===\nbody\n');
		});
	});
	it('filters and mutates headings inside templates', function() {
		var text = "{{1x|1=\n= one =\n}}";
		var pdoc, headings;
		return Parsoid.parse(text, { pdoc: true }).then(function(_pdoc) {
			pdoc = _pdoc;
			headings = pdoc.filterHeadings();
			headings.length.should.equal(1);
			headings[0].level = 2;
			return headings[0].toWikitext();
		}).then(function(wt) {
			wt.should.equal('== one ==\n');
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('{{1x|1=\n== one ==\n}}');
			headings[0].title = 'two';
			return headings[0].toWikitext();
		}).then(function(wt) {
			wt.should.equal('== two ==\n');
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('{{1x|1=\n== two ==\n}}');
		});
	});
	it('filters and mutates external links', function() {
		var text = "[http://example.com {{1x|link content}}]";
		var pdoc, extlinks;
		return Parsoid.parse(text, { pdoc: true }).then(function(_pdoc) {
			pdoc = _pdoc;
			extlinks = pdoc.filterExtLinks();
			extlinks.length.should.equal(1);
			String(extlinks[0].url).should.equal('http://example.com');
			return extlinks[0].title.toWikitext();
		}).then(function(wt) {
			wt.should.equal('{{1x|link content}}');
			extlinks[0].title = ']';
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('[http://example.com <nowiki>]</nowiki>]\n');
		});
	});
	it('filters and mutates wiki links', function() {
		var text = "[[foo|1]] {{1x|[[bar|2]]}} [[{{1x|bat}}|3]]";
		var pdoc, extlinks;
		return Parsoid.parse(text, { pdoc: true }).then(function(_pdoc) {
			pdoc = _pdoc;
			extlinks = pdoc.filterWikiLinks();
			extlinks.length.should.equal(3);
			return Promise.all([
				extlinks[0].title,
				extlinks[0].text.toWikitext(),
				extlinks[1].title,
				extlinks[1].text.toWikitext(),
				extlinks[2].text.toWikitext(),
			]);
		}).then(function(all) {
			all[0].should.equal('Foo');
			all[1].should.equal('1');
			all[2].should.equal('Bar');
			all[3].should.equal('2');
			all[4].should.equal('3');
			extlinks[0].title = extlinks[0].text = 'foobar';
			extlinks[1].text = 'A';
			extlinks[2].text = 'B';
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('[[foobar]] {{1x|[[bar|A]]}} [[{{1x|bat}}|B]]\n');
		});
	});
	it('filters and mutates html entities', function() {
		var text = '&amp;{{1x|&quot;}}';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var entities = pdoc.filterHtmlEntities();
			entities.length.should.equal(2);
			entities[0].normalized.should.equal('&');
			entities[1].normalized.should.equal('"');
			entities[0].normalized = '<';
			entities[1].normalized = '>';
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('&#x3C;{{1x|&#x3E;}}\n');
		});
	});
	it('filters and mutates comments', function() {
		var text = '<!-- foo --> {{1x|<!--bar-->}}';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var comments = pdoc.filterComments();
			comments.length.should.equal(2);
			comments[0].contents.should.equal(' foo ');
			comments[1].contents.should.equal('bar');
			comments[0].contents = '<!-- ha! -->';
			comments[1].contents = '--';
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('<!--<!-- ha! --&gt;--> {{1x|<!------>}}');
		});
	});
	it('filters and mutates images', function() {
		var text = '[[File:SomeFile1.jpg]] [[File:SomeFile2.jpg|thumb|caption]]';
		var pdoc, media;
		return Parsoid.parse(text, { pdoc: true }).then(function(_pdoc) {
			pdoc = _pdoc;
			media = pdoc.filterMedia();
			media.length.should.equal(2);
			media[0].should.have.property('caption', null);
			return media[1].caption.toWikitext();
		}).then(function(wt) {
			wt.should.equal('caption');
			media[0].caption = '|';
			media[1].caption = null;
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('[[File:SomeFile1.jpg|<nowiki>|</nowiki>]] [[File:SomeFile2.jpg|thumb]]');
			media[0].caption = null;
			media[1].caption = '|';
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('[[File:SomeFile1.jpg]] [[File:SomeFile2.jpg|thumb|<nowiki>|</nowiki>]]');
		});
	});
	it('filters and mutates text', function() {
		var text = 'foo {{1x|bar}}';
		var pdoc, texts;
		return Parsoid.parse(text, { pdoc: true }).then(function(_pdoc) {
			pdoc = _pdoc;
			texts = pdoc.filterText({ recursive: false });
			texts.length.should.equal(1);
			texts = pdoc.filterText({ recursive: true });
			texts.length.should.equal(2);
			texts[0].value.should.equal('foo ');
			texts[1].value.should.equal('bar');
			texts[0].value = 'FOO ';
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('FOO {{1x|bar}}\n');
			texts[1].value = 'BAR';
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal('FOO {{1x|BAR}}\n');
		});
	});
	it.skip('filters and mutates text (2)', function() {
		var text = '{{{1x|{{!}}}}\n| foo\n|}';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			var texts = pdoc.filterText();
			texts.length.should.equal(1);
			// XXX this doesn't work yet, see note at end of
			// https://www.mediawiki.org/wiki/Specs/HTML/1.2.1#Transclusion_content
			// for details. ("Editing support for the interspersed wikitext...")
			texts[0].value.should.equal(' foo');
		});
	});
	it('allows mutation using wikitext', function() {
		var text = '== heading ==';
		var pdoc, headings;
		return Parsoid.parse(text, { pdoc: true }).then(function(_pdoc) {
			pdoc = _pdoc;
			headings = pdoc.filterHeadings();
			headings.length.should.equal(1);
			// Note that even if the wikitext is unbalanced, the result
			// will be balanced.  The bold face doesn't escape the heading!
			return Parsoid.PNodeList.fromWikitext(pdoc, "'''bold");
		}).then(function(pnl) {
			headings[0].title = pnl;
			return pdoc.toWikitext();
		}).then(function(wt) {
			wt.should.equal("== '''bold''' ==\n");
		});
	});
	it('allows iteration using length and get()', function() {
		var text = '== 1 ==\n[http://example.com 2]<!-- 3 -->&nbsp;{{1x|4}} 5 [[Foo|6]]';
		return Parsoid.parse(text, { pdoc: true }).then(function(pdoc) {
			pdoc.length.should.equal(3);
			pdoc.get(0).should.be.instanceof(Parsoid.PHeading);
			pdoc.get(1).should.be.instanceof(Parsoid.PText);
			pdoc.get(2).should.be.instanceof(Parsoid.PTag);
			pdoc.get(2).tagName.should.be.equal('p');
			var paragraph = pdoc.get(2).contents;
			paragraph.length.should.equal(6);
			paragraph.get(0).should.be.instanceof(Parsoid.PExtLink);
			paragraph.get(1).should.be.instanceof(Parsoid.PComment);
			paragraph.get(2).should.be.instanceof(Parsoid.PHtmlEntity);
			paragraph.get(3).should.be.instanceof(Parsoid.PTemplate);
			paragraph.get(4).should.be.instanceof(Parsoid.PText);
			paragraph.get(5).should.be.instanceof(Parsoid.PWikiLink);
			// Test indexOf with PNodes and Nodes
			for (var i = 0; i < paragraph.length; i++) {
				paragraph.indexOf(paragraph.get(i)).should.equal(i);
				paragraph.indexOf(paragraph.get(i).node).should.equal(i);
				pdoc.indexOf(paragraph.get(i), { recursive: true }).should.equal(2);
				pdoc.indexOf(paragraph.get(i).node, { recursive: true }).should.equal(2);
			}
			// Test indexOf with strings
			pdoc.indexOf(' 5 ').should.equal(-1);
			pdoc.indexOf(' 5 ', { recursive: true }).should.equal(2);
			paragraph.indexOf(' 5 ').should.equal(4);
			paragraph.indexOf('\u00A0').should.equal(2);
		});
	});
});
