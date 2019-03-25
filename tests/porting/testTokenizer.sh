#!/bin/bash

if [[ "$#" -lt 1 ]]; then
	echo "Usage: testTokenizer.sh <wt-file>"
	exit 1
fi

srcdir=$(dirname $0)

echo "Running JS tokenizer on $1 and dumping tokens to $1.js.tokens"
node "$srcdir/dump_tokens.js" "$1"
echo "Running PHP tokenizer on $1 and dumping tokens to $1.php.jsoffset.tokens and $1.php.byteoffset.tokens"
php "$srcdir/dump_tokens.php" "$1"
echo "Diffing $1.js.tokens with $1.php.jsoffset.tokens"
diff "$1.js.tokens" "$1.php.jsoffset.tokens"
