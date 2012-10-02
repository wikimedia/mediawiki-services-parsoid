#!/bin/bash
# Wrapper for testing Gerrit changes. Will take some doing.

set -e
set -u

BASEPATH=`pwd`
NODECMD=` ( nodejs --version > /dev/null 2>&1 && echo 'nodejs' ) || echo 'node' `

cd testing-repos
mkdir -p $1
git clone -q master $1
cd $1
git fetch -q https://gerrit.wikimedia.org/r/mediawiki/extensions/Parsoid $1
git checkout -q FETCH_HEAD
cd js
ln -s $BASEPATH/testing-repos/master/js/node_modules

# Maybe don't need to run these. Maybe do.
OLDNWI=$NODE_WORKER_ID
NODE_WORKER_ID=""
cd tests
$NODECMD fetch-parserTests.txt.js 2>&1 > /dev/null
$NODECMD parserTests.js --wt2wt --wt2html --html2wt --html2html --xml
NODE_WORKER_ID=$OLDNWI

rm -rf $BASEPATH/testing-repos/$1
