# Setting up Parsoid for development

Hopefully by now you've read the [setup guide](#!/guide/setup), which explains
how to get the Parsoid code, how to run our basic tools, and points here for
those who want to do more. The setup described therein is required for this
document also.

## Setup

Setup for developing Parsoid is, thankfully, brief.

### Getting a Gerrit account and setting it up in Parsoid's repository

If you want to submit patches to our project - and we highly suggest that you
do - you should definitely
[sign up for an account on Gerrit](https://wikitech.wikimedia.org/w/index.php?title=Special:UserLogin&returnto=Help%3AGetting+Started&type=signup)
and set it up on your local git repository.

Once you have an account, setting up a gerrit remote is pretty simple:

	$ git remote add gerrit ssh://<YOUR-USERNAME>@gerrit.wikimedia.org:29418/mediawiki/services/parsoid

Be sure to replace the `<YOUR-USERNAME>` bit with your username on Gerrit -
you can use your
[user settings page](https://gerrit.wikimedia.org/r/#/settings/)
to figure out exactly what that is.

After that, you should also install the git-review tool, which makes it very
simple to submit code for review.
[The MediaWiki documentation wiki](http://www.mediawiki.org/wiki/Gerrit/Tutorial#Installing_git-review)
has a whole section on the subject.

## Making changes

In making changes to Parsoid, you should use [our documentation](#!/api) to
help guide you through the code. Where you aren't sure how to proceed, and if
you think you're lost, you can try joining our IRC channel,
`#mediawiki-parsoid` on `irc.freenode.net`, and asking for help there.

## Testing your changes

From the Parsoid base directory, run:

	$ npm test

This will run parserTests.js, unit tests with mocha, and some code style
checkers as well.

	$ npm run roundtrip

This will run roundtrip-test.js on two representative pages.

	$ npm start

This will launch Parsoid's HTTP API, which should be used to verify
appropriate responses in the browser.

For more details on the different tests which are run, keep reading...

### parserTests.js

To run the parser tests, run:

	$ node bin/parserTests

This is quite noisy!  You may wish to use the `--quiet` option, which
cuts down on the output from tests which are not failing.  There are
quite a number of options to the parser test suite, but they are
pretty well documented if you run:

	$ node bin/parserTests --help

To get you oriented: there are five possible modes which a given test
can be run in, corresponding to the command-line options `--wt2html`,
`--html2wt`, `--wt2wt`, `--html2html`, and `--selser`.  If you don't
specify a mode on the command-line, it will run all of the tests
except for `--selser`.  If you are trying to track down a bug, it's
often helpful to concentrate on `--wt2html` or `--html2wt` first,
before enabling the other modes.

We inherited the parser test suite from the PHP parser, and still
regularly sync it with the copy in `mediawiki/core`.  Unfortunately,
that means that we inherited a large number of tests which are not
appropriate for Parsoid, and which therefore fail.  There are also
some real bugs which cause failing tests as well, of course!
In order to track regressions, we maintain a blacklist of
currently-failing tests in `tests/parserTests-blacklist.json`.
If you need to add or remove tests from the blacklist, then this
command will help:

	$ node bin/parserTests --rewrite-blacklist

We also gladly accept patches that mark tests as PHP-only (usually
with the `!! html/php` tag) when they've been audited to be irrelevant
for Parsoid.

### parse.js

This tool is described briefly in the [setup instructions](#!/guide/setup) as
a useful tool for testing functionality, or parsing bits of wikitext. We also
need to make sure it runs properly after your changes. Run something like:

	$ echo "''Non'''-trivial'' wikitext''' [[with links]] {{echo|and templates}} | node bin/parse --wt2wt

That command should exercise a reasonable number of parser and
serializer features --- although not as many as the full `parserTests`
suite of course.

### roundtrip-test.js

This script is something we use to test against actual wiki articles. You can
specify which wiki you want to use with the --wiki option, but it defaults to
English Wikipedia which should be sufficient. Running

	$ node bin/roundtrip-test.js "Barack Obama"

is a simple and typical test case. If the script runs without issue,
then it should be fine.

### npm start

This is a more complicated one to test. You'll need to actually run the API
server - see the [setup instructions](#!/guide/setup) for how to do so - and
load a page in your browser to make sure the API still responds accurately to
responses. Loading
[French Wikipedia's page on Obama](http://localhost:8000/_rt/frwiki/Barack_Obama)
is a pretty good test, so if that page loads completely, and there are no
semantic differences in the server's output, then you can probably
call this test passed.

## Submitting changes

If you've followed the above instructions, you have git-review installed,
you've configured a gerrit remote, and your patch passed all of the tests,
then you can submit your change with

	$ git add <files> # any files you changed
	$ git commit # enter a commit summary
	$ git review # send it for review

After you submit the patch, the Parsoid team will likely get around to
reviewing it within a day or two, depending on their schedules.
You can also poke us on IRC (see above) to remind us to take a look.
