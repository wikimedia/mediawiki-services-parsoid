#!/bin/bash

# Regenerate/update the set of test files in tests/tranform/
#
# $ tools/regen-transformTests.sh
#
# then `git add -u`, `git commit`, etc.

set -e
mkdir -p $(dirname $0)/../tests/transform

# Add article titles and revision IDs here (to ensure the tests are stable
# over time and don't change when the article is edited)

# It would be nice to use associative arrays here but MacOS doesn't bundle
# bash 4 (released in 2009) for license reasons, alas.  So just keep the
# indices in these two arrays in sync, please.

declare -a articles=(
    Skating
    Barack_Obama
)
declare -a oldids=(
    854722751
    862247016
)

for i in "${!articles[@]}"; do
    echo "Updating ${articles[$i]} (revision ${oldids[$i]})..."
    $(dirname $0)/../bin/parse.js --genTest QuoteTransformer --genTestOut $(dirname $0)/../tests/transform/"quote-${articles[$i]}.txt" --pageName "${articles[$i]}" --domain en.wikipedia.org --oldid ${oldids[$i]} < /dev/null > /dev/null

    $(dirname $0)/../bin/parse.js --genTest ParagraphWrapper --genTestOut $(dirname $0)/../tests/transform/"paragraph-${articles[$i]}.txt" --pageName "${articles[$i]}" --domain en.wikipedia.org --oldid ${oldids[$i]} < /dev/null > /dev/null

done
