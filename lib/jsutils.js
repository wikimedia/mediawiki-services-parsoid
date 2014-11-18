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
	},

	// Helper function to ease migration to Promise-based control flow
	// (aka, "after years of wandering, arrive in the Promise land").
	// This function allows retrofitting an existing callback-based
	// method to return an equivalent Promise, allowing enlightened
	// new code to omit the callback parameter and treat it as if
	// it had an API which simply returned a Promise for the result.
	//
	// Sample use:
	//   // callback is node-style: callback(err, value)
	//   function legacyApi(param1, param2, callback) {
	//     callback = JSUtils.mkPromised(callback); // THIS LINE IS NEW
	//     ... some implementation here...
	//     return callback.promise; // THIS LINE IS NEW
	//   }
	//   // old-style caller, still works:
	//   legacyApi(x, y, function(err, value) { ... });
	//   // new-style caller, such hotness:
	//   return legacyApi(x, y).then(function(value) { ... });
	//
	// The optional `names` parameter to `mkPromised` is the same
	// as the optional second argument to `Promise.promisify` in
	// https://github/cscott/prfun
	// It allows the use of `mkPromised` for legacy functions which
	// promise multiple results to their callbacks, eg:
	//   callback(err, body, response);  // from npm "request" module
	// For this callback signature, you have two options:
	// 1. Pass `true` as the names parameter:
	//      function legacyRequest(options, callback) {
	//        callback = JSUtils.mkPromised(callback, true);
	//        ... existing implementation...
	//        return callback.promise;
	//      }
	//    This resolves the promise with the array `[body, response]`, so
	//    a Promise-using caller looks like:
	//      return legacyRequest(options).then(function(r) {
	//        var body = r[0], response = r[1];
	//        ...
	//      }
	//    If you are using `prfun` then `Promise#spread` is convenient:
	//      return legacyRequest(options).spread(function(body, response) {
	//        ...
	//      });
	// 2. Alternatively (and probably preferably), provide an array of strings
	//    as the `names` parameter:
	//      function legacyRequest(options, callback) {
	//        callback = JSUtils.mkPromised(callback, ['body','response']);
	//        ... existing implementation...
	//        return callback.promise;
	//      }
	//    The resolved value will be an object with those fields:
	//      return legacyRequest(options).then(function(r) {
	//        var body = r.body, response = r.response;
	//        ...
	//      }
	// Note that in both cases the legacy callback behavior is unchanged:
	//   legacyRequest(options, function(err, body, response) { ... });
	//
	mkPromised: function( callback, names ) {
		var res, rej;
		var p = new Promise(function( _res, _rej ) { res=_res; rej=_rej; });
		var f = function( e, v ) {
			if ( e ) {
				rej( e );
			} else if ( names === true ) {
				res( Array.prototype.slice.call( arguments, 1 ) );
			} else if ( names ) {
				var value = {};
				for ( var index in names ) {
					value[names[index]] = arguments[(+index) + 1];
				}
				res( value );
			} else {
				res( v );
			}
			return callback && callback.apply( this, arguments );
		};
		f.promise = p;
		return f;
	}

};

if (typeof module === "object") {
	module.exports.JSUtils = JSUtils;
}
