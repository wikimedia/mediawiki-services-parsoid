#!/bin/bash
# Wrapper for testing Gerrit changes. Will take some doing.

set -e

cd testing-repos
BASEPATH=`pwd`
NODECMD="env -i ` ( nodejs --version > /dev/null 2>&1 && echo 'nodejs' ) || echo 'node' `"
OURPATH=`mktemp -d --tmpdir=$BASEPATH`

git clone -q master $OURPATH
cd $OURPATH
git fetch -q https://gerrit.wikimedia.org/r/mediawiki/extensions/Parsoid $1
git checkout -q FETCH_HEAD
cd js
ln -s $BASEPATH/testing-repos/master/js/node_modules

cd tests
wget "https://gerrit.wikimedia.org/r/gitweb?p=mediawiki/core.git;a=blob_plain;hb=HEAD;f=tests/parser/parserTests.txt" -O parserTests.txt
$NODECMD parserTests.js --wt2wt --wt2html --html2wt --html2html --xml

rm -rf $OURPATH
