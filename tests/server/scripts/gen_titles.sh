#!/bin/bash

#---- wikis ----
LANG="enwiki dewiki nlwiki frwiki itwiki ruwiki eswiki svwiki plwiki jawiki arwiki hewiki hiwiki kowiki zhwiki"
HOWMANY=(30 10 10 10 10 10 10 8 8 8 7 7 7 7 5)
# link prefix languages
LANG=$LANG" ckbwiki cuwiki cvwiki hywiki iswiki kaawiki kawiki lbewiki lnwiki mznwiki pnbwiki ukwiki uzwiki"
HOWMANY=("${HOWMANY[@]}" 1 1 1 1 1 1 1 1 1 1 1 1 1)

#---- wiktionaries ----
LANG=$LANG" enwiktionary frwiktionary"
HOWMANY=("${HOWMANY[@]}" 1 1)

i=0
FRACTION=700;
for l in $LANG ; do
	n=${HOWMANY[$i]}
	suffix=".random_titles.txt"
	echo $l, $n
	zcat ${l}-latest-all-titles-in-ns0.gz | sort -R | head -$[$n*FRACTION] > ${l}${suffix}
	head -2 ${l}${suffix}
	cat ${l}${suffix} ${l}.rc_titles.txt | sort | uniq | head -$[$n*1000+100] | tail -$[$n*1000] > ${l}.all_titles.txt
	$(dirname $0)/jsonify.js ${l}.all_titles.txt > ${l}.json
	i=`expr $i + 1`
done
