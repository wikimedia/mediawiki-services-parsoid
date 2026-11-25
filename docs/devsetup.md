# Setting up Parsoid for development

Hopefully by now you've read the [setup guide](setup.md), which explains
how to get the Parsoid code, how to run our basic tools, and points here for
those who want to do more. The setup described therein is required for this
document also.

## Setup

Setup for developing Parsoid is, thankfully, brief.

### Getting a Gerrit account and setting it up in Parsoid's repository

If you want to submit patches to our project - and we highly suggest that you
do - you should definitely
[sign up for an account on Gerrit](https://www.mediawiki.org/wiki/Gerrit/Getting_started)
and set it up on your local git repository.

You should also install the git-review tool, which makes it very
simple to submit code for review.
[The MediaWiki documentation wiki](https://www.mediawiki.org/wiki/Gerrit/git-review)
has a whole section on the subject.

Once you have an account and git-review, setting up a gerrit remote is
pretty simple. From the Parsoid base directory, run:

```sh
git review -s
```

## Making changes

In making changes to Parsoid, you should use
[our documentation](https://doc.wikimedia.org/Parsoid-PHP/master/) to
help guide you through the code. Where you aren't sure how to proceed, and if
you think you're lost, you can try joining our IRC channel,
`#mediawiki-parsoid` on `irc.libera.chat`, and asking for help there.

## Testing your changes

From the Parsoid base directory, run:

```sh
composer test
```

This will run parserTests.php, unit tests with PHPUnit, phan, and some code
style checkers as well. You can also run one of them, for example
`composer phpunit` or `composer phan`.

For more details on the different tests which are run, keep reading...

### parserTests.php

To run the parser tests, run:

```sh
php bin/parserTests.php
```

This is quite noisy!  You may wish to use the `--quiet` option, which
cuts down on the output from tests which are not failing.  There are
quite a number of options to the parser test suite, but they are
pretty well documented if you run:

```sh
php bin/parserTests.php --help
```

To get you oriented: there are five possible modes which a given test
can be run in, corresponding to the command-line options `--wt2html`,
`--html2wt`, `--wt2wt`, `--html2html`, and `--selser`.  If you don't
specify a mode on the command-line, it will run all of the tests
except for `--selser`.  If you are trying to track down a bug, it's
often helpful to concentrate on `--wt2html` or `--html2wt` first,
before enabling the other modes. You can also run one test file, or only
the tests whose names contain some text:

```sh
php bin/parserTests.php tests/parser/headings.txt
php bin/parserTests.php --filter 'Simple paragraph'
```

We inherited the parser test suite from the PHP parser, and still
regularly sync it with the copy in `mediawiki/core`.  Unfortunately,
that means that we inherited a large number of tests which are not
appropriate for Parsoid, and which therefore fail.  There are also
some real bugs which cause failing tests as well, of course!
In order to track regressions, we maintain a list of known failing tests
in a `*-standalone-knownFailures.json` file next to each test file in
`tests/parser/`.
[Known failures](tests/known-failures.md) explains them in more detail.
If you need to add or remove tests from the knownFailures, then this
command will help:

```sh
composer parserTests -- --updateKnownFailures
```

We also gladly accept patches that mark tests as PHP-only (usually
with the `!! html/php` tag) when they've been audited to be irrelevant
for Parsoid.

### parse.php

This tool is described briefly in the [setup instructions](setup.md) as
a useful tool for testing functionality, or parsing bits of wikitext. We also
need to make sure it runs properly after your changes. Run something like:

```sh
echo "''Non'''-trivial'' wikitext''' [[with links]] {{echo|and templates}}" | php bin/parse.php --wt2wt
```

That command should exercise a reasonable number of parser and
serializer features --- although not as many as the full `parserTests`
suite of course.

### Round-trip testing

A round-trip testing system converts a large set of real wiki pages from
wikitext to HTML and back, and reports pages where the output differs from the
original wikitext. It runs `bin/roundtrip-test.js` with Node.js on Wikimedia
infrastructure. See
[Parsoid/Round-trip testing](https://www.mediawiki.org/wiki/Parsoid/Round-trip_testing)
on mediawiki.org for how it works and how to start a test run.

### Testing with MediaWiki

Some tests need a MediaWiki installation. Set `MW_INSTALL_PATH` to your
MediaWiki directory to run phan with the MediaWiki classes:

```sh
MW_INSTALL_PATH=/path/to/mediawiki composer phan-integrated
```

To run the parser tests of MediaWiki with Parsoid, run this in your
MediaWiki directory:

```sh
php tests/parser/parserTests.php --parsoid
```

## Debugging

Try to reduce a bug to the shortest wikitext that shows it, and run it
through `bin/parse.php` with `--trace` and `--dump` to see what Parsoid
does. `--trace=help` and `--dump=help` list the values:

```sh
echo "* item" | php bin/parse.php --mock --trace pre,p-wrap
echo "* item" | php bin/parse.php --mock --dump dom:post-pwrap
```

If the bug needs the templates or extensions of your wiki, use
`--integrated` with `MW_INSTALL_PATH` set to your MediaWiki directory:

```sh
echo "{{#if:x|yes}}" | MW_INSTALL_PATH=/path/to/mediawiki php bin/parse.php --integrated
```

[Parsoid/Debugging](https://www.mediawiki.org/wiki/Parsoid/Debugging)
on mediawiki.org has many more tips.

## Submitting changes

If you've followed the above instructions, you have git-review installed,
you've configured a gerrit remote, and your patch passed all of the tests,
then you can submit your change with

```sh
git add <files> # any files you changed
git commit # enter a commit summary
git review # send it for review
```

After you submit the patch, the Parsoid team will likely get around to
reviewing it within a day or two, depending on their schedules.
You can also poke us on IRC (see above) to remind us to take a look.
