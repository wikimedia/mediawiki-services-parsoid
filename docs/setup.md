# Setting up Parsoid

Welcome to Parsoid! Parsoid is meant to be a simple, featureful parser for
wikitext that produces HTML DOMs which can then be turned back into wikitext,
even after modifications.

## Prerequisites

You'll need:

* [git](https://git-scm.com)
* PHP 8.3 or later, with the `dom`, `mbstring`, `xml` and `curl` extensions
* [Composer](https://getcomposer.org)

## Getting the code

To get the code, you'll need to clone our git repository. Run this command:

```sh
git clone https://gerrit.wikimedia.org/r/mediawiki/services/parsoid
```

## Installing dependencies

Run Composer to get all of the necessary
dependencies. From the main directory of the Parsoid repository, run:

```sh
composer install
```

## Running the basic parse tool

If you want to test Parsoid's capabilities, you can use the
`parse.php` script. From the base directory in the Parsoid repository,
run something like:

```sh
echo "some harmless [[wikitext]]" | php bin/parse.php --mock
```

This will run the echoed text through the wikitext parser and show you the
resulting HTML. You can also specify different options for different output -
`--wt2wt` will convert wikitext to HTML and then back to wikitext, `--html2wt`
will convert HTML to wikitext, and `--html2html` will convert HTML to wikitext
and then back to HTML.  By default the HTML output will contain a lot
of internal Parsoid data (`data-parsoid` attributes, for example).
You may wish to use the command-line option `--normalize=parsoid` to
clean things up a bit and make it easier to tell what's going on.

```sh
echo "<p>Hello <b>world</b></p>" | php bin/parse.php --mock --html2wt
```

The `--mock` option uses a built-in test configuration and works offline.
Without `--mock`, the script gets its configuration and templates from a wiki
over the network, by default English Wikipedia. Use `--domain` to choose a
different wiki:

```sh
echo "{{echo|Hello}}" | php bin/parse.php --domain www.mediawiki.org
```

You can test the parser this way --- please use this tool
when trying to report bugs. `php bin/parse.php --help` lists all the options.

## More setup and usage examples

If you want more, you might want to try our
[developer setup guide](devsetup.md) if you want to see how you can run
Parsoid's test suites and use the debug and trace flags.
[Parsoid on mediawiki.org](https://www.mediawiki.org/wiki/Parsoid)
has more information about the project.
