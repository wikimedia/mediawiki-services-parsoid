#!/bin/bash
# Wrapper for testing Gerrit master.

set -e

cd testing-repos/master
NODECMD="env -i ` ( nodejs --version > /dev/null 2>&1 && echo 'nodejs' ) || echo 'node' `"

git checkout -q master
git pull -q --rebase origin master 2>&1 > /dev/null
cd js
env -i npm install 2>&1 > /dev/null

cd tests
wget --quiet "https://gerrit.wikimedia.org/r/gitweb?p=mediawiki/core.git;a=blob_plain;hb=HEAD;f=tests/parser/parserTests.txt" -O parserTests.txt
$NODECMD parserTests.js --wt2wt --wt2html --html2wt --html2html --xml
