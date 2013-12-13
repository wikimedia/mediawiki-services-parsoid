require('es6-shim');
if (!Array.prototype.last) {
	Object.defineProperty(Array.prototype, 'last', {
		value: function() { return this[this.length - 1]; }
	});
}
(function(global) {
	if (!global.setImmediate) {
		global.setImmediate = process.nextTick.bind(process);
	}
})(typeof global === 'object' && global ? global : this );
