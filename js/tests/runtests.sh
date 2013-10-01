#!/bin/sh
# Simple test runner with result archival in results git repository
# Usage:
#  ./runtests.sh -c    # run all tests and commit results
#  ./runtests.sh -c -q # run all tests and commit results, no diff
#  ./runtests.sh       # run all tests, only show diff (no commit)
#  ./xuntests.sh --quick

# Helper function to echo a message to stderr
warn() {
	echo "$@" 1>&2
}
cd $(dirname $0) # allow running this script from other dirs

OPTS="--cache --color --no-blacklist --exit-zero"
if [ ! -d results ];then
    git init results
    touch results/html.txt
    touch results/roundtrip.txt
    touch results/all.txt
    touch results/quick.txt
    ( cd results;
      git add html.txt
      git add roundtrip.txt
      git add all.txt
      git add quick.txt
      git commit -a -m 'init to empty test output' )
else
    ( cd results && git checkout -f )
fi

if [ -n "$NODE" ]; then
	node="$NODE"
else
	node=` ( nodejs --version > /dev/null 2>&1 && echo 'nodejs' ) || echo 'node' `
fi

if [ "$1" = "--wt2wt" ];then
	OUTPUT="results/roundtrip.txt"
    time $node parserTests.js $OPTS --wt2wt \
        > $OUTPUT 2>&1
	TEST_EXIT_CODE=$?
elif [ "$1" = '--selser' ];then
	OUTPUT="results/selser.txt"
    time $node parserTests.js $OPTS --selser --printwhitelist \
        > $OUTPUT 2>&1
	TEST_EXIT_CODE=$?
elif [ "$1" = '--wt2html' ];then
	OUTPUT="results/html.txt"
    time $node parserTests.js $OPTS --wt2html --printwhitelist \
        > $OUTPUT 2>&1
	TEST_EXIT_CODE=$?
elif [ "$1" = '--quick' ];then
	OUTPUT="results/quick.txt"
    time $node parserTests.js $OPTS --wt2html --wt2wt --html2html --printwhitelist \
        > $OUTPUT 2>&1
	TEST_EXIT_CODE=$?
else
	OUTPUT="results/all.txt"
    time $node parserTests.js $OPTS --wt2html --wt2wt --html2html --selser --printwhitelist \
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
    git diff --patience | less -R
else
	git add $(basename $OUTPUT)
    if [ "$1" = '--wt2wt' ];then
        git commit -m "`tail -8 roundtrip.txt`" roundtrip.txt || exit 1
    elif [ "$1" = '--selser' ];then
        git commit -m "`tail -8 selser.txt`" selser.txt || exit 1
    elif [ "$1" = '--wt2html' ];then
        git commit -m "`tail -8 html.txt`" html.txt || exit 1
    elif [ "$1" = '--quick' ];then
        git commit -m "`tail -8 quick.txt`" quick.txt || exit 1
    else
        git commit -m "`tail -11 all.txt`" all.txt || exit 1
    fi
    if [ "$2" != '-q' -a "$3" != '-q' ];then
        git diff --patience HEAD~1 | less -R || exit 1
    fi
fi
