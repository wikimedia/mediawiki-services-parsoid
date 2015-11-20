Usage of the JavaScript API
===========================

This file describes usage of Parsoid as a standalone wikitext parsing
package, in the spirit of [`mwparserfromhell`].  This is not the typical
use case for Parsoid; it is more often used as a network service.
See [the HTTP API guide](#!/guide/apiuse) or [Parsoid service] on the wiki
for more details.

These examples will use the [`prfun`] library and [ES6 generators] in
order to fluently express asynchronous operations.  The library also
exports vanilla [`Promise`]s if you wish to maintain compatibility
with old versions of `node` at the cost of a little bit of readability.

Since many methods in the API return [`Promise`]s, we've also provided
a [`Promise`]-aware REPL, that will wait for a promise to be resolved
before printing its value.  This can be started from the
shell using:

	node -e 'require("parsoid").repl()'

Use `"./"` instead of `"parsoid"` if you are running this from a
checked-out repository.  Code examples below which contain lines
starting with `>` show sessions using this REPL.  (You may also
wish to look in `tests/mocha/jsapi.js` for examples using a more
traditional promise-chaining style.)

Use of Parsoid as a wikitext parser is straightforward (where `text` is
wikitext input):

	#/usr/bin/node --harmony-generators
	var Promise = require('prfun');
	var Parsoid = require('parsoid');
	
	var main = Promise.async(function*() {
	    var text = "I love wikitext!";
	    var pdoc = yield Parsoid.parse(text, { pdoc: true });
	    console.log(pdoc.document.outerHTML);
	});
	
	// start me up!
	main().done();

As you can see, there is a little bit of boilerplate needed to get the
asynchronous machinery started.  The body of the `main()` method can
be replaced with your code.

The `pdoc` variable above holds a [`PDoc`] object, which has
helpful methods to filter and manipulate the document.  If you want
to access the raw [Parsoid DOM], however, it is easily accessible
via the [`document`](#!/api/PDoc-property-document) property, as shown above,
and all normal DOM manipulation functions can be used on it (Parsoid uses
[`domino`] to implement these methods).  Be sure to call
[`update()`](#!/api/PNode-method-update) after any direct DOM manipulation.
[`PDoc`] is a subclass of [`PNodeList`], which provides a number of
useful access and mutation methods -- and if you use these you won't need
to manually call `update()`.  These provided methods can be quite useful.
For example:

	> var text = "I has a template! {{foo|bar|baz|eggs=spam}} See it?\n";
	> var pdoc = yield Parsoid.parse(text, { pdoc: true });
	> console.log(yield pdoc.toWikitext());
	I has a template! {{foo|bar|baz|eggs=spam}} See it?
	> var templates = pdoc.filterTemplates();
	> console.log(yield Promise.map(templates, Parsoid.toWikitext));
	[ '{{foo|bar|baz|eggs=spam}}' ]
	> var template = templates[0];
	> console.log(template.name);
	foo
	> template.name = 'notfoo';
	> console.log(yield template.toWikitext());
	{{notfoo|bar|baz|eggs=spam}}
	> console.log(template.params.map(function(p) { return p.name; }));
	[ '1', '2', 'eggs' ]
	> console.log(yield template.get(1).value.toWikitext());
	bar
	> console.log(yield template.get("eggs").value.toWikitext());
	spam

Getting nested templates is trivial:

	> var text = "{{foo|bar={{baz|{{spam}}}}}}";
	> var pdoc = yield Parsoid.parse(text, { pdoc: true });
	> console.log(yield Promise.map(pdoc.filterTemplates(), Parsoid.toWikitext));
	[ '{{foo|bar={{baz|{{spam}}}}}}',
	  '{{baz|{{spam}}}}',
	  '{{spam}}' ]

You can also pass `{ recursive: false }` to
[`filterTemplates()`](#!/api/PNodeList-method-filterTemplates) and explore
templates manually. This is possible because the
[`get`](#!/api/PTemplate-method-get) method on a
[`PTemplate`] object returns an object containing further [`PNodeList`]s:

	> var text = "{{foo|this {{includes a|template}}}}";
	> var pdoc = yield Parsoid.parse(text, { pdoc: true });
	> var templates = pdoc.filterTemplates({ recursive: false });
	> console.log(yield Promise.map(templates, Parsoid.toWikitext));
	[ '{{foo|this {{includes a|template}}}}' ]
	> var foo = templates[0];
	> console.log(yield foo.get(1).value.toWikitext());
	this {{includes a|template}}
	> var more = foo.get(1).value.filterTemplates();
	> console.log(yield Promise.map(more, Parsoid.toWikitext));
	[ '{{includes a|template}}' ]
	> console.log(yield more[0].get(1).value.toWikitext());
	template

Templates can be easily modified to add, remove, or alter params.
Templates also have a [`nameMatches()`](#!/api/PTemplate-method-nameMatches)
method for comparing template names, which takes care of capitalization and
white space:

	> var text = "{{cleanup}} '''Foo''' is a [[bar]]. {{uncategorized}}";
	> var pdoc = yield Parsoid.parse(text, { pdoc: true });
	> pdoc.filterTemplates().forEach(function(template) {
	...    if (template.nameMatches('Cleanup') && !template.has('date')) {
	...        template.add('date', 'July 2012');
	...    }
	...    if (template.nameMatches('uncategorized')) {
	...        template.name = 'bar-stub';
	...    }
	... });
	> console.log(yield pdoc.toWikitext());
	{{cleanup|date = July 2012}} '''Foo''' is a [[bar]]. {{bar-stub}}

At any time you can convert the `pdoc` into HTML conforming to the
[MediaWiki DOM spec] (by referencing the
[`document`](#!/api/PDoc-property-document) property) or into wikitext (by
invoking [`toWikitext()`](#!/api/PNodeList-method-toWikitext), which
returns a [`Promise`] for the wikitext string).  This allows you
to save the page using either standard API methods or the RESTBase API
(once [T101501](https://phabricator.wikimedia.org/T101501) is resolved).

For more tips, check out [PNodeList's full method list](#!/api/PNodeList)
and the list of [PNode](#!/api/PNode) subclasses.

[`mwparserfromhell`]: http://mwparserfromhell.readthedocs.org/en/latest/index.html
[Parsoid service]: https://www.mediawiki.org/wiki/Parsoid
[`prfun`]: https://github.com/cscott/prfun
[ES6 generators]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/function*
[`Promise`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise
[Parsoid DOM]: http://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec
[MediaWiki DOM spec]: http://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec
[`domino`]: https://www.npmjs.com/package/domino
[`PDoc`]: #!/api/PDoc
[`PNodeList`]: #!/api/PNodeList
[`PTemplate`]: #!/api/PTemplate
