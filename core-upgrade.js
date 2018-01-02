'use strict';

// Register prfun's Promises with node-pn
var Promise = require('./lib/utils/promise.js');
require('pn/_promise')(Promise); // This only needs to be done once.

// Comments below annotate the highest lts version of node for which the
// polyfills are necessary.  Remove when that version is no longer supported.

// v4
require('core-js/fn/array/includes');

// v6
require('core-js/fn/object/entries');
require('core-js/fn/string/pad-start');
