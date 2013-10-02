/*
 * This file contains Parsoid-independent JS helper functions.
 * Over time, more functions can be migrated out of various other files here.
 */

var es6 = require('harmony-collections');

var JSUtils = {
	// This should probably be taken care of by the Set constructor
	// but doesn't seem to be implemented correctly anywhere.
	arrayToSet: function(a) {
		var s = new es6.Set();
		for (var i = 0, n = a.length; i < n; i++) {
			s.add(a[i]);
		}
		return s;
	},

	mapObject: function(h) {
		var m = new es6.Map();
		Object.keys(h).forEach(function(k) { m.set(k, h[k]); });
		return m;
	},

	// Deep-freeze an object
	// See https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/freeze
	deepFreeze: function (o) {
		if ( o === undefined ) {
			return;
		} else if ( ! (o instanceof Object) ) {
			//console.log( o );
			//console.trace();
			return;
		} else if ( Object.isFrozen(o) ) {
			return;
		}

		Object.freeze(o); // First freeze the object.
		for (var propKey in o) {
			var prop = o[propKey];
			if (!o.hasOwnProperty(propKey) || !(prop instanceof Object) || Object.isFrozen(prop)) {
				// If the object is on the prototype, not an object, or is already frozen,
				// skip it. Note that this might leave an unfrozen reference somewhere in the
				// object if there is an already frozen object containing an unfrozen object.
				continue;
			}

			this.deepFreeze(prop); // Recursively call deepFreeze.
		}
	}
};

if (typeof module === "object") {
	module.exports.JSUtils = JSUtils;
}
