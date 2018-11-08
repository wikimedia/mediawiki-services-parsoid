#!/bin/bash

# Exit immediately if any of these tests fail
set -e

# 1. Run all the manual tests
for t in QuoteTransformer ListHandler ParagraphWrapper PreHandler ; do
    echo "Unit test: $t"
    $(dirname $0)/../bin/transformTests.js --manual --transformer $t --inputFile $(dirname $0)/../tests/transformTests.txt
done

# 2. Run the automatically-generated tests
#    (Use tools/regen-transformTests.sh to update these.)
for article in Skating Barack_Obama; do
    echo "Article $article: QuoteTransformer"
    $(dirname $0)/../bin/transformTests.js --transformer QuoteTransformer --inputFile tests/transform/quote-$article.txt
    echo "Article $article: ParagraphWrapper"
    $(dirname $0)/../bin/transformTests.js --transformer ParagraphWrapper --inputFile tests/transform/paragraph-$article.txt
done
