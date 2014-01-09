# Setting up Parsoid for development

Hopefully by now you've read the [setup guide](#!/guide/setup), which explains
how to get the Parsoid code, how to run our basic tools, and points here for
those who want to do more. The setup described therein is required for this
document also.

## Setup

Setup for developing Parsoid is, thankfully, brief.

### Getting test suite

We use MediaWiki's core parser test suite rather than writing our own. This
sets a very high bar for our success, but it also means that we can ensure
totally correct behavior if the tests are passing.

To fetch the test suite, go to the `tests/` directory and run this:

```
$ node fetch-parserTests.txt.js
```

This should pull the current parser tests to the tests directory. You may want
to run this command from time to time to make sure the tests are up to date.

### Getting a Gerrit account and setting it up in Parsoid's repository

If you want to submit patches to our project - and we highly suggest that you
do - you should definitely
[sign up for an account on Gerrit](https://wikitech.wikimedia.org/w/index.php?title=Special:UserLogin&returnto=Help%3AGetting+Started&type=signup)
and set it up on your local git repository.

Once you have an account, setting up a gerrit remote is pretty simple:

```
$ git remote add gerrit ssh://<YOUR-USERNAME>@gerrit.wikimedia.org:29418/mediawiki/services/parsoid
```

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

There are four major things you should test before you submit a change:

* tests/parserTests.js
* tests/parse.js
* tests/roundtrip-test.js
* api/server.js

### parserTests.js

To run the parser tests, go to the `tests/` directory, and run:

```
$ ./runtests.sh
```

This script is there to help remember the test modes and options we use, and
to assist in telling what tests change after a commit. If you want to know
about test changes in your commit, you should also run

```
$ ./runtests.sh -c
```

in this directory before you start working - it will commit the changes to a
git repository in `tests/results/` that will then be used to diff the test
results from the next test run.

If you prefer to run the parser tests on your own, something like

```
$ node parserTests --help
```

should tell you all you need to choose the right options.

### parse.js

This tool is described briefly in the [setup instructions](#!/guide/setup) as
a useful tool for testing functionality, or parsing bits of wikitext. We also
need to make sure it runs properly after your changes. Run something like

```
$ echo "''Non'''-trivial'' wikitext''' [[with links]] {{echo|and templates}} | node parse --wt2wt
```

from the `tests/` directory. That command should test a sufficient number
of the parser's - and serializer's - features that we can be confident in a
positive result.

### roundtrip-test.js

This script is something we use to test against actual wiki articles. You can
specify which wiki you want to use with the --wiki option, but it defaults to
English Wikipedia which should be sufficient. Running

```
$ node roundtrip-test.js "Barack Obama"
```

is a simple and stereotypical test case. If the script runs without issue,
then it should be fine.

### server.js

This is a more complicated one to test. You'll need to actually run the API
server - see the [setup instructions](#!/guide/setup) for how to do so - and
load a page in your browser to make sure the API still responds accurately to
responses. Loading
[French Wikipedia's page on Obama](http://localhost:8000/_rt/fr/Barack_Obama)
is a pretty good test, so if that page loads completely, and there are no
errors in the server's output, then you can probably call this test passed.

## Submitting changes

If you've followed the above instructions, you have git-review installed,
you've configured a gerrit remote, and your patch passed all of the tests,
then you can submit your change with

```
$ git add <files> # any files you changed
$ git commit # enter a commit summary
$ git review # send it for review
```

After you submit the patch, the Parsoid team will likely get around to
reviewing it within a day or two, depending on their schedules.
