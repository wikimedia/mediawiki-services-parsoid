/*
 * This file contains Parsoid-independent JS helper functions.
 * Over time, more functions can be migrated out of various other files here.
 */
"use strict";

require('./core-upgrade');

var JSUtils = {
	// This should probably be taken care of by the Set constructor
	// but doesn't seem to be implemented correctly anywhere.
	arrayToSet: function(a) {
		var s = new Set();
		for (var i = 0, n = a.length; i < n; i++) {
			s.add(a[i]);
		}
		return s;
	},

	mapObject: function(h) {
		var m = new Map();
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
	},

	// Convert a counter to a Base64 encoded string.
	// Padding is stripped. \,+ are replaced with _,- respectively.
	// Warning: Max integer is 2^31 - 1 for bitwise operations.
	counterToBase64: function ( n ) {
		/* jshint bitwise: false */
		var arr = [];
		do {
			arr.unshift( n & 0xff );
			n >>= 8;
		} while ( n > 0 );
		return ( new Buffer( arr ) )
			.toString( "base64" )
			.replace( /=/g, "" )
			.replace( /\//g, "_" )
			.replace( /\+/g, "-" );
	}

};

if (typeof module === "object") {
	module.exports.JSUtils = JSUtils;
}
