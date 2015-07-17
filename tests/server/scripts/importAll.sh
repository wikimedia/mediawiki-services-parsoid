#!/bin/bash

#---- wikis ----
LANG="enwiki dewiki nlwiki frwiki itwiki ruwiki eswiki svwiki plwiki jawiki arwiki hewiki hiwiki kowiki zhwiki"
# link prefix languages
LANG=$LANG" ckbwiki cuwiki cvwiki hywiki iswiki kaawiki kawiki lbewiki lnwiki mznwiki pnbwiki ukwiki uzwiki"
#---- wikis ----
LANG=$LANG" enwiktionary frwiktionary"

for l in $LANG; do
        echo ${l}
        $(dirname $0)/../importJson.js -D testreduce_0715 -u testreduce --prefix ${l} ${l}.json
done
