#!/bin/bash

# Run the parse.js script on a string.
# Usage: parse [--wt2wt|--wt2html] "Text with whatever characters"

NODE=` ( nodejs --version > /dev/null 2>&1 && echo 'nodejs' ) || echo 'node' `

if [ "$2" == "" ]; then
   OPT="--wt2html"
   TEXT=$1
else
   OPT=$1
   TEXT=$2
fi

$NODE parse.js $OPT <<< $TEXT
