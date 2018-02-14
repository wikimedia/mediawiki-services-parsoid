#!/bin/bash
REPEAT=10
OUTPUT="$1.times"
# page name should have spaces replaced with underscores
PAGENAME=Barack_Obama

if [ ! -x /usr/bin/time ]; then
    echo "You need to install GNU time."
    echo "$ sudo apt-get install time"
    exit 1
fi

if [ ! -f $(dirname $0)/../nocks/en.wikipedia.org/"$PAGENAME.js" ]; then
    echo "Recording parse network traffic."
    $(dirname $0)/../bin/parse.js --wt2html --domain en.wikipedia.org \
        --pageName $PAGENAME --record < /dev/null > /dev/null
fi

# only re-run benchmark if output file doesn't exist.  otherwise, just
# recompute average
if [ ! -f "$OUTPUT" ]; then
  for f in $(seq 1 $REPEAT) extra1 extra2; do
    /usr/bin/time -f%U -o "$OUTPUT" -a \
    $(dirname $0)/../bin/parse.js --wt2html --domain en.wikipedia.org \
        --pageName $PAGENAME --replay < /dev/null > /dev/null
  done
fi

# now summarize
echo "scale=3;(" $(for f in $(sort -n "$OUTPUT" | head -n-1 | tail -$REPEAT) ; do echo -n $f + ; done) "0)/$REPEAT" | bc
