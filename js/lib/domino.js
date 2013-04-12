"use strict";
var domino = require('domino');

/** If we need to hot-patch domino to fix upstream bugs, this is the place
 * to do it.   All Parsoid code depends on this module, not directly on
 * domino. */

// domino.Node = ... (there is nothing needed here as of domino 1.0.9)

module.exports = domino;
