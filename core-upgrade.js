"use strict";
require('core-js/shim');
require('prfun/smash'); // This mutates the global Promise object.
if (!Array.prototype.last) {
	Object.defineProperty(Array.prototype, 'last', {
		value: function() { return this[this.length - 1]; },
	});
}
if (!global.setImmediate) {
	global.setImmediate = function(cb) {
		process.nextTick(cb);
	};
}
