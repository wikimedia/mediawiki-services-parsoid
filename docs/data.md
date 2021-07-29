# How Parsoid represents information in its output

Parsoid enriches the HTML representation of the wikitext it converts with
various mechanisms, depending on the end goal of the information.

Data can be represented:
* as named attributes of HTML tags (or even as tags themselves),
* as part of the `data-mw` attribute,
* as part of the `data-parsoid` attribute.

## HTML attributes

HTML attributes should be used for information that is required to __read__ the
page. "*Read*" should be interpreted broadly enough to encapsulate various
uses by client-side javascript, such as giving different styling to
template-generated content.

Examples of these attributes would be the `typeof` and the `about` attributes
used for template identification.

## `data-mw`

The `data-mw` stores data that is required to __edit__ content: elements that,
in particular, VisualEditor may need to enable the editing of the page. For
instance, the parameters of a template are stored in `data-mw` so that
VisualEditor lets users edit them.

The `data-mw` data is typically semantic information that can be useful for all
clients, including editing ones.

## `data-parsoid`

`data-parsoid` stores Parsoid-private data. It is primarily syntactic
information required for __clean round-trips__ between wikitext and HTML.
It may for instance contain information about template parameter names or
whitespace.

VisualEditor never sees `data-parsoid`; most clients do not see it either unless
they require it explicitly. Information there can be changed without notice.

The information stored in `data-parsoid` is documented on
https://www.mediawiki.org/wiki/Parsoid/Internals/data-parsoid.