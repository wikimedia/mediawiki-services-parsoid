'use strict';

/**
 * @class
 * @constructor
 * @param {TokenTransformManager} manager
 *   The manager for this stage of the parse.
 * @param {Object} options
 *   Any options for the expander.
 */
var TokenHandler = module.exports = function(manager, options) {
	this.manager = manager;
	this.env = manager.env;
	this.options = options;
	this.init();
};

TokenHandler.prototype.init = function() {
	console.assert(false, '`init` unimplemented!');
};

TokenHandler.prototype.resetState = function(opts) {
	this.atTopLevel = opts && opts.toplevel;
};
