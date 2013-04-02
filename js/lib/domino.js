"use strict";
var domino = require('domino');
// double-check that domino is up-to-date
var pjson = require('domino/package.json');
if (/1.0.[0-8]/.test(pjson.version)) {
    throw new Error("Your domino library is out-of-date.  Please update it.");
}

/** If we need to hot-patch domino to fix upstream bugs, this is the place
 * to do it.   All Parsoid code depends on this module, not directly on
 * domino. */

// domino.Node = ... (there is nothing needed here as of domino 1.0.9)

module.exports = domino;
