/*
 * This file contains Parsoid-independent JS helper functions.
 * Over time, more functions can be migrated out of various other files here.
 */

var JSUtils = {
	// Return a hash mapping all of the given elements of `a` to `true`.
	// The result hash is created with `Object.create(null)`, so it doesn't
	// inherit extra properties (like `hasOwnProperty`) from `Object`.
	arrayToHash: function(a) {
		var h = Object.create(null); // No inherited methods
		for (var i = 0, n = a.length; i < n; i++) {
			h[a[i]] = true;
		}
		return h;
	},

	// Return a hash with the same own properties as `h`.
	// The result hash is created with `Object.create(null)`, so it doesn't
	// inherit extra properties (like `hasOwnProperty`) from `Object`, nor
	// will it include any inherited properties from `h`.
	safeHash: function(h) {
		var r = Object.create(null);
		Object.keys(h).forEach(function(k) { r[k] = h[k]; });
		return r;
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
