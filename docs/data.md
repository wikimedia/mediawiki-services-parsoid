# How Parsoid represents information in its output

Parsoid enriches the HTML representation of the wikitext it converts with
various mechanisms, depending on the end goal of the information.

Data can be represented:
* as named attributes of HTML tags (or even as tags themselves),
* as part of the `data-mw` attribute,
* as part of the `data-parsoid` attribute.
* as part of other "rich attributes" (`data-mw-i18n`, `data-mw-variant`, etc)

## Structured data / Rich attributes

The DOM model of HTML is not orthogonal. Elements can contain elements
which can contain elements, in a pleasant tree structure, but
attributes of elements are limited to plain strings. You cannot nest
further structure inside an attribute, and you cannot store multiple
values within an attribute (outside of string-separated tokens in a
few cases).

Parsoid extends the HTML model with rich attributes which can store
structured data.  The data contained in an attribute can include
embedded DocumentFragments, or it can be a structured value (a JSON
"Object" data type, to be specific).

The type of each attribute in the DOM is given by an implicit schema
which gives a type based on attribute name.  All `data-mw` attributes
share the same type, as do all `data-parsoid` attributes, etc.
Extensions can define their own rich attribute types, and so access
to the extension registry (via Parsoid's SiteConfig object) is needed
to create a new Document.

In addition to their external "JSON object" representation, Parsoid
also defines codecs specific to each attribute which convert the JSON
object into an instance of a native PHP class, which provides type
safety and allows methods to be defined on the classes, etc. Client
applications other than Parsoid can interact with the rich data either
directly as a JSON object, or can define their own codecs to map these
to native objects.

## Page bundle versus inline representation of attributes

There are multiple representations possible of rich attribute content.
For developer purposes and testing, it is most convenient to use an
"inline attribute" form, where object-valued attributes are stored as
their string serialization, and embedded document fragments inside
those object values are recursively converted to inline attribute form
as well.  The primary disadvantage of this format is the addition of
multiple levels of escape: the JSON strings must be HTML-escaped for
inclusion into the attribute, and then any HTML embedded in the JSON
needs to be JSON-escaped for inclusion in the JSON object, etc.
Readability and encoding efficiency of quotation marks especially
suffer greatly.

A "page bundle" representation stores the JSON object values
separately in a "page bundle", linked to the DOM element by an ID
attribute which is added to every element which does not already
contain one. The value of the page bundle is encoded directly as a
JSON value and can either be transmitted separately or (eg) encoded as
the CDATA contents of a <script> tag in the document <head>.  This
improves readability and encoding efficiency of JSON-valued
attributes, although HTML embedded in the JSON value is still
JSON-escaped.

The "template bank" representation further stores HTML embedded in
JSON values as references to <template> nodes in the document <head>,
fully solving the encoding issue, but at the cost of separating the
attribute value among three different locations in the HTML source.

In current production, the "template bank" representation is not used
and the "page bundle" is only used for `data-parsoid` attributes.

## The use of specific attributes

Standard HTML attributes should be used for information that is
required to __read__ the page. "*Read*" should be interpreted broadly
enough to encapsulate various uses by client-side javascript, such as
giving different styling to template-generated content.

Examples of these attributes would be the `typeof` and the `about`
attributes used for template identification.

## `data-mw`

The `data-mw` stores data that is required to __edit__ content: elements that,
in particular, VisualEditor may need to enable the editing of the page. For
instance, the parameters of a template are stored in `data-mw` so that
VisualEditor lets users edit them.

In theory, `data-mw` could be stripped from pages for ordinary reads,
and then loaded on-demand for editing. In practice, the `data-mw` data
includes semantic information that can be useful for all clients,
including user gadgets and client side features as well as editing.

## `data-parsoid`

`data-parsoid` stores Parsoid-private data. It is primarily syntactic
information required for __clean round-trips__ between wikitext and HTML.
It may for instance contain information about template parameter names or
whitespace.

VisualEditor never sees `data-parsoid`; most clients do not see it
either unless they require it explicitly. Information there can be
changed without notice.

The information stored in `data-parsoid` is documented on
https://www.mediawiki.org/wiki/Parsoid/Internals/data-parsoid.

## `data-mw-variant`

`data-mw-variant` stores information about LanguageConverter markup;
it is used to convert a text between multiple script variants. In
theory, this can be done entirely client-side using the rules and
other information encoded in `data-mw-variant`; however in practice,
this is a server-side postprocessing step.

## `data-mw-i18n`

Parsoid tries to provide a canonical form which does not contain
any user-specific rendering.  Various UX messages are intended to
be localized into the current user's preferred language, however.
These are encoded as `data-mw-i18n` attributes, which are then
transformed during postprocessing into message strings in the
appropriate user language.
