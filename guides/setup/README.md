# Setting up Parsoid

Welcome to Parsoid! Parsoid is meant to be a simple, featureful parser for
wikitext that produces HTML DOMs which can then be turned back into wikitext,
even after modifications.

If you just want to turn wikitext into HTML, and don't need to round-trip back
into wikitext, you may be better off with another project, but Parsoid will
probably do what you want.

## Prerequisites

You'll need:

* [git](http://git-scm.com)
* [node.js](http://nodejs.org)
* [npm](http://npmjs.org) (Node.js Package Manager)

### A note about node.js

In a lot of places, you will see this document refer to a `node` executable.
On newer Debian systems, and maybe in other places, however, node.js is run by
a command `nodejs`. You should experiment with both and be conscious of which
one you need to use as you read this guide.

## Getting the code

To get the code, you'll need to clone our git repository. Run this command:

```
$ git checkout https://gerrit.wikimedia.org/r/p/mediawiki/services/parsoid
```

## Installing node.js dependencies

Now that you have the code, you can run npm to get all of the necessary dependencies. From the main directory of the Parsoid repository, run:

```
$ npm install
```

## Running the API

The API is the main reason you might want to run Parsoid, because VisualEditor
uses it to do a lot of backend work. To run the API in a terminal, go to the
`api/` directory in the Parsoid repository and run the following:

```
$ node server
```

There is also, in the `api/` directory, a nice runserver.sh script that will
perhaps be useful to someone running the API as a more permanent service. The
script was originally written for Wikimedia's internal purposes, but it could
be useful anywhere if it was tweaked a little bit.

Note that if you want to enable any options, or change any settings, you will
need to copy the example `localsettings.js` file from the `api/` directory
and use it to define any of your desired options.

## Running the basic parse tool

If you aren't looking to run an API service, or VisualEditor, or if you just
want to test Parsoid's capabilities, you can use our simple parse.js script.
This time, go to the `tests/` directory in the Parsoid repository and do
something like:

```
$ echo "some harmless [[wikitext]]" | node parse
```

This will run the echoed text through the wikitext parser and show you the
resulting HTML. You can also specify different options for different output -
`--wt2wt` will convert wikitext to HTML and then back to wikitext, `--html2wt`
will convert HTML to wikitext, and `--html2html` will convert HTML to wikitext
and then back to HTML. You can test the parser this way - please use this tool
when trying to report bugs.

## More setup and usage examples

If you want more, you might want to try our
[developer setup guide](#!/guide/devsetup) if you want to see how you can run
Parsoid's test suites, use the debug and trace flags, and perform round-trip
testing on real wiki articles.
