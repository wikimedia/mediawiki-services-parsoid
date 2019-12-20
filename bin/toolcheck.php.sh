#!/bin/bash

# Perform a basic crash test.
# This used to be the
# `parsoidsvc-{repository}-parse-tool-check-trusty`
# test on jenkins. (T141481)

BIN=$(dirname $0)

# If any of these commands fail, something is wrong!
set -ev

echo "Foo" | php $BIN/parse.php --wt2html
echo "Foo" | php $BIN/parse.php --wt2html --pageBundle
echo "Foo" | php $BIN/parse.php --wt2wt
echo "Foo" | php $BIN/parse.php --html2wt
echo "Foo" | php $BIN/parse.php --html2html

function tempfile () {
  mktemp "${TMPDIR:-/tmp/}$1.XXXXXX"
}

# Check --selser too!
TMPWT=$(tempfile wt)
TMPORIG=$(tempfile orig)
TMPEDIT=$(tempfile edit)
TMPPB=$(tempfile pb)

# inline data-parsoid
echo "<p>foo</p><p>boo</p>" | tee $TMPWT | php $BIN/parse.php | tee $TMPORIG |
    sed -e "s/foo/bar/g" > $TMPEDIT
php $BIN/parse.php --selser --oldtextfile $TMPWT --oldhtmlfile $TMPORIG < $TMPEDIT

# data-parsoid in separate files
php $BIN/parse.php --pboutfile $TMPPB < $TMPWT |
    tee $TMPORIG | sed -e "s/foo/bar/g" > $TMPEDIT
php $BIN/parse.php --pbinfile $TMPPB --selser \
    --oldtextfile $TMPWT --oldhtmlfile $TMPORIG < $TMPEDIT

# clean up
/bin/rm $TMPWT $TMPORIG $TMPEDIT $TMPPB
