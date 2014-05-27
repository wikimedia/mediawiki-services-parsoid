/*
 * This file contains Parsoid-independent JS helper functions.
 * Over time, more functions can be migrated out of various other files here.
 */
"use strict";

require('./core-upgrade');

var JSUtils = {

	// in ES7 it should be `new Map(Object.entries(obj))`
	mapObject: function(obj) {
		return new Map(Object.keys(obj).map(function(k) {
			return [k, obj[k]];
		}));
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
	},

	// Append an array to an accumulator using the most efficient method
	// available. Makes sure that accumulation is O(n).
	pushArray : function push (accum, arr) {
		if (accum.length < arr.length) {
			return accum.concat(arr);
		} else {
			// big accum & arr
			for (var i = 0, l = arr.length; i < l; i++) {
				accum.push(arr[i]);
			}
			return accum;
		}
	}


};

if (typeof module === "object") {
	module.exports.JSUtils = JSUtils;
}
