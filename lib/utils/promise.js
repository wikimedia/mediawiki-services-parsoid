/**
 * This module selects Parsoid's default promise implementation.
 * @module
 */

'use strict';

module.exports = require('prfun/wrap')(require('babybird'));
