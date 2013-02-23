#!/bin/sh
# Simple test runner with result archival in results git repository
# Usage:
#  ./runtests.sh -c    # wikitext -> HTML DOM tests and commit results
#  ./runtests.sh -r -c # round-trip tests; commit
#  ./runtests.sh       # wikitext -> HTML DOM; only show diff (no commit)
#  ./runtests.sh -r    # round-trip tests; only show diff (no commit)

# Helper function to echo a message to stderr
warn() {
	echo "$@" 1>&2
}
cd $(dirname $0) # allow running this script from other dirs

if [ ! -d results ];then
    git init results
    touch results/html.txt
    touch results/roundtrip.txt
    touch results/all.txt
    ( cd results;
      git add html.txt
      git add roundtrip.txt
      git add all.txt
      git commit -a -m 'init to empty test output' )
else
    ( cd results && git checkout -f )
fi

node=` ( nodejs --version > /dev/null 2>&1 && echo 'nodejs' ) || echo 'node' `

if [ "$1" = "--wt2wt" ];then
	OUTPUT="results/roundtrip.txt"
    time $node parserTests.js --cache --wt2wt \
        > $OUTPUT 2>&1
	TEST_EXIT_CODE=$?
elif [ "$1" = '--selser' ];then
	OUTPUT="results/selser.txt"
    time $node parserTests.js --selser --changesin selser.changes.json --cache --printwhitelist \
        > $OUTPUT 2>&1
	TEST_EXIT_CODE=$?
elif [ "$1" = '--wt2html' ];then
	OUTPUT="results/html.txt"
    time $node parserTests.js --wt2html --cache --printwhitelist \
        > $OUTPUT 2>&1
	TEST_EXIT_CODE=$?
else
	OUTPUT="results/all.txt"
    time $node parserTests.js --wt2html --wt2wt --html2html --selser --changesin selser.changes.json --cache --printwhitelist \
        > $OUTPUT 2>&1
	TEST_EXIT_CODE=$?
fi

# Handle any error that might have occured during the tests above
# such as a missing npm module.
if [ $TEST_EXIT_CODE -ne 0 ]; then
	warn "\nSome error occured. Dumping recorded output:"
	cat $OUTPUT 1>&2
	warn "\n... exiting '$0'"
	exit 1
fi;

cd results || exit 1
if [ "$1" != '-c' -a "$2" != '-c' ];then
    git diff | less -R
else
	git add $OUTPUT
    if [ "$1" = '--wt2wt' ];then
        git commit -m "`tail -8 roundtrip.txt`" || exit 1
    elif [ "$1" = '--selser' ];then
        git commit -m "`tail -8 selser.txt`" || exit 1
    elif [ "$1" = '--wt2html' ];then
        git commit -m "`tail -8 html.txt`" || exit 1
    else
        git commit -m "`tail -11 all.txt`" all.txt || exit 1
    fi
    git diff HEAD~1 | less -R || exit 1
fi
