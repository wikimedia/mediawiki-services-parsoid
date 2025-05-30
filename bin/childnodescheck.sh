#!/bin/bash

# Ensure that no more uses of $node -> childNodes creep into our repository...
# we should be using DOMUtils::childNodes( $node )

BIN=$(dirname $0)
# put this string together in a somewhat awkward way so that it doesn't
# trigger a match itself.
grepPhrase="childNodes"
badWords='$node->'"$grepPhrase"
grepPhrase="[-]>$grepPhrase"

# If any of these commands fail, something is wrong!
set -ev

FILES=$(git grep -l '[-]>')

# Ensure exactly two matches are present:
#  One in DOMUtils and one in Ext/DOMUtils in the documentation comment
#  for DOMUtils::childNodes()
x=`git grep "$grepPhrase" $FILES | wc -l`
if [ ! $x -eq 2 ]
then
    echo "Uses of $badWords found! :("
    git grep -P "$grepPhrase" $FILES
    exit -1
fi
echo "No new uses of $badWords found! :)"
