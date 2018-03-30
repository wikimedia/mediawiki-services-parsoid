This directory contains finite-state transducers implementing (reversible)
variant conversion between languages.  Given a transducer X->Y and a
putative inverse transducer Y->X, we also generate bracketing transducers
which can split an input string into "safe" reversible segments (where
X->Y->X is the identity) and "unsafe" segments where the conversion
loses information.  We can then preserve extra metadata to allow
lossless conversion even for "unsafe" segments.

The primary files in this directory are named `<language code>.foma` and
are the input to the FOMA finite-state transducer toolset; see
https://fomafst.github.io/ .  There are test cases and examples in
`<language code>-examples.foma`.  Other files ending in `.foma` bundle
up helper tranducers for reuse across languages.

Running foma on the primary `<language code>.foma` files will generate
`.att`-format transducer graphs.  The tool in
`$PARSOID/tools/build-langconv-fst.js` can then be used to compile/compress
these into JSON data structures, which can then be executed by
`lib/language/FST.js`.
