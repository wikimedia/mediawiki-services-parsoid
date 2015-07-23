#!/bin/bash

#---- for wikis ---
LANG="en de nl fr it ru es sv pl ja ar he hi ko zh"
# link prefix languages
LANG=$LANG" ckb cu cv hy is kaa ka lbe ln mzn pnb uk uz"

for l in $LANG ; do
    wget http://dumps.wikimedia.org/${l}wiki/latest/${l}wiki-latest-all-titles-in-ns0.gz
done

#---- for wiktionaries ---
LANG="en fr"
for l in $LANG ; do
    wget http://dumps.wikimedia.org/${l}wiktionary/latest/${l}wiktionary-latest-all-titles-in-ns0.gz
done
