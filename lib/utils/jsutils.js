/**
 * This file contains Parsoid-independent JS helper functions.
 * Over time, more functions can be migrated out of various other files here.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var Promise = require('./promise.js');

var rejectMutation = function() {
	throw new TypeError("Mutation attempted on read-only collection.");
};

var lastItem = function(array) {
	console.assert(Array.isArray(array));
	return array[array.length - 1];
};

/** @namespace */
var JSUtils = {

	/**
	 * Return the last item in an array.
	 * @method
	 * @param {Array} array
	 * @return {any} The last item in `array`
	 */
	lastItem: lastItem,

	/**
	 * Return a {@link Map} with the same initial keys and values as the
	 * given {@link Object}.
	 * @param {Object} obj
	 * @return {Map}
	 */
	mapObject: function(obj) {
		return new Map(Object.entries(obj));
	},

	/**
	 * Return a two-way Map that maps each element to its index
	 * (and vice-versa).
	 * @param {Array} arr
	 * @return {Map}
	 */
	arrayMap: function(arr) {
		var m = new Map(arr.map(function(e, i) { return [e, i]; }));
		m.item = function(i) { return arr[i]; };
		return m;
	},

	/**
	 * ES6 maps/sets are still writable even when frozen, because they
	 * store data inside the object linked from an internal slot.
	 * This freezes a map by disabling the mutation methods, although
	 * it's not bulletproof: you could use `Map.prototype.set.call(m, ...)`
	 * to still mutate the backing store.
	 */
	freezeMap: function(it, freezeEntries) {
		// Allow `it` to be an iterable, as well as a map.
		if (!(it instanceof Map)) { it = new Map(it); }
		it.set = it.clear = it.delete = rejectMutation;
		Object.freeze(it);
		if (freezeEntries) {
			it.forEach(function(v, k) {
				JSUtils.deepFreeze(v);
				JSUtils.deepFreeze(k);
			});
		}
		return it;
	},

	/**
	 * This makes a set read-only.
	 * @see {@link .freezeMap}
	 */
	freezeSet: function(it, freezeEntries) {
		// Allow `it` to be an iterable, as well as a set.
		if (!(it instanceof Set)) { it = new Set(it); }
		it.add = it.clear = it.delete = rejectMutation;
		Object.freeze(it);
		if (freezeEntries) {
			it.forEach(function(v) {
				JSUtils.deepFreeze(v);
			});
		}
		return it;
	},

	/**
	 * Deep-freeze an object.
	 * {@link Map}s and {@link Set}s are handled with {@link .freezeMap} and
	 * {@link .freezeSet}.
	 * @see https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/freeze
	 * @param {any} o
	 * @return {any} Frozen object
	 */
	deepFreeze: function(o) {
		if (!(o instanceof Object)) {
			return o;
		} else if (Object.isFrozen(o)) {
			// Note that this might leave an unfrozen reference somewhere in
			// the object if there is an already frozen object containing an
			// unfrozen object.
			return o;
		} else if (o instanceof Map) {
			return JSUtils.freezeMap(o, true);
		} else if (o instanceof Set) {
			return JSUtils.freezeSet(o, true);
		}

		Object.freeze(o);
		for (var propKey in o) {
			var desc = Object.getOwnPropertyDescriptor(o, propKey);
			if ((!desc) || desc.get || desc.set) {
				// If the object is on the prototype or is a getter, skip it.
				continue;
			}
			// Recursively call deepFreeze.
			JSUtils.deepFreeze(desc.value);
		}
		return o;
	},

	/**
	 * Deep freeze an object, except for the specified fields.
	 * @param {Object} o
	 * @param {Object} ignoreFields
	 * @return {Object} Frozen object.
	 */
	deepFreezeButIgnore: function(o, ignoreFields) {
		for (var prop in o) {
			var desc = Object.getOwnPropertyDescriptor(o, prop);
			if (ignoreFields[prop] === true || (!desc) || desc.get || desc.set) {
				// Ignore getters, primitives, and explicitly ignored fields.
				return;
			}
			o[prop] = JSUtils.deepFreeze(desc.value);
		}
		Object.freeze(o);
	},

	/**
	 * Sort keys in an object, recursively, for better reproducibility.
	 * (This is especially useful before serializing as JSON.)
	 */
	sortObject: function(obj) {
		var sortObject = JSUtils.sortObject;
		var sortValue = function(v) {
			if (v instanceof Object) {
				return Array.isArray(v) ? v.map(sortValue) : sortObject(v);
			}
			return v;
		};
		return Object.keys(obj).sort().reduce(function(sorted, k) {
			sorted[k] = sortValue(obj[k]);
			return sorted;
		}, {});
	},

	/**
	 * Convert a counter to a Base64 encoded string.
	 * Padding is stripped. \,+ are replaced with _,- respectively.
	 * Warning: Max integer is 2^31 - 1 for bitwise operations.
	 */
	counterToBase64: function(n) {
		/* eslint-disable no-bitwise */
		var arr = [];
		do {
			arr.unshift(n & 0xff);
			n >>= 8;
		} while (n > 0);
		return (Buffer.from(arr))
			.toString("base64")
			.replace(/=/g, "")
			.replace(/\//g, "_")
			.replace(/\+/g, "-");
		/* eslint-enable no-bitwise */
	},

	/**
	 * Escape special regexp characters in a string.
	 * @param {string} s
	 * @return {string} A regular expression string that matches the
	 *  literal characters in s.
	 */
	escapeRegExp: function(s) {
		return s.replace(/[\^\\$*+?.()|{}\[\]\/]/g, '\\$&');
	},

	/**
	 * Escape special regexp characters in a string, returning a
	 * case-insensitive regular expression.  This is usually denoted
	 * by something like `(?i:....)` in most programming languages,
	 * but JavaScript doesn't support embedded regexp flags.
	 *
	 * @param {string} s
	 * @return {string} A regular expression string that matches the
	 *  literal characters in s.
	 */
	escapeRegExpIgnoreCase: function(s) {
		// Using Array.from() here ensures we split on unicode codepoints,
		// which may be longer than a single JavaScript character.
		return Array.from(s).map((c) => {
			if (/[\^\\$*+?.()|{}\[\]\/]/.test(c)) { return '\\' + c; }
			const uc = c.toUpperCase();
			const lc = c.toLowerCase();
			if (c === lc && c === uc) { return c; }
			if (uc.length === 1 && lc.length === 1) { return `[${uc}${lc}]`; }
			return `(?:${uc}|${lc})`;
		}).join('');
	},

	/**
	 * Join pieces of regular expressions together.  This helps avoid
	 * having to switch between string and regexp quoting rules, and
	 * can also give you a poor-man's version of the "x" flag, ie:
	 * ```
	 *  var re = rejoin( "(",
	 *      /foo|bar/, "|",
	 *      someRegExpFromAVariable
	 *      ")", { flags: "i" } );
	 * ```
	 * Note that this is basically string concatenation, except that
	 * regular expressions are converted to strings using their `.source`
	 * property, and then the final resulting string is converted to a
	 * regular expression.
	 *
	 * If the final argument is a regular expression, its flags will be
	 * used for the result.  Alternatively, you can make the final argument
	 * an object, with a `flags` property (as shown in the example above).
	 * @return {RegExp}
	 */
	rejoin: function() {
		var regexps = Array.from(arguments);
		var last = lastItem(regexps);
		var flags;
		if (typeof (last) === 'object') {
			if (last instanceof RegExp) {
				flags = /\/([gimy]*)$/.exec(last.toString())[1];
			} else {
				flags = regexps.pop().flags;
			}
		}
		return new RegExp(regexps.reduce(function(acc, r) {
			return acc + (r instanceof RegExp ? r.source : r);
		}, ''), flags === undefined ? '' : flags);
	},

	/**
	 * Append an array to an accumulator using the most efficient method
	 * available. Makes sure that accumulation is O(n).
	 */
	pushArray: function push(accum, arr) {
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

	/**
	 * Helper function to ease migration to Promise-based control flow
	 * (aka, "after years of wandering, arrive in the Promise land").
	 * This function allows retrofitting an existing callback-based
	 * method to return an equivalent Promise, allowing enlightened
	 * new code to omit the callback parameter and treat it as if
	 * it had an API which simply returned a Promise for the result.
	 *
	 * Sample use:
	 * ```
	 *   // callback is node-style: callback(err, value)
	 *   function legacyApi(param1, param2, callback) {
	 *     callback = JSUtils.mkPromised(callback); // THIS LINE IS NEW
	 *     ... some implementation here...
	 *     return callback.promise; // THIS LINE IS NEW
	 *   }
	 *   // old-style caller, still works:
	 *   legacyApi(x, y, function(err, value) { ... });
	 *   // new-style caller, such hotness:
	 *   return legacyApi(x, y).then(function(value) { ... });
	 * ```
	 * The optional `names` parameter to `mkPromised` is the same
	 * as the optional second argument to `Promise.promisify` in
	 * {@link https://github/cscott/prfun}.
	 * It allows the use of `mkPromised` for legacy functions which
	 * promise multiple results to their callbacks, eg:
	 * ```
	 *   callback(err, body, response);  // from npm "request" module
	 * ```
	 * For this callback signature, you have two options:
	 * 1. Pass `true` as the names parameter:
	 *    ```
	 *      function legacyRequest(options, callback) {
	 *        callback = JSUtils.mkPromised(callback, true);
	 *        ... existing implementation...
	 *        return callback.promise;
	 *      }
	 *    ```
	 *    This resolves the promise with the array `[body, response]`, so
	 *    a Promise-using caller looks like:
	 *    ```
	 *      return legacyRequest(options).then(function(r) {
	 *        var body = r[0], response = r[1];
	 *        ...
	 *      }
	 *    ```
	 *    If you are using `prfun` then `Promise#spread` is convenient:
	 *    ```
	 *      return legacyRequest(options).spread(function(body, response) {
	 *        ...
	 *      });
	 *    ```
	 * 2. Alternatively (and probably preferably), provide an array of strings
	 *    as the `names` parameter:
	 *    ```
	 *      function legacyRequest(options, callback) {
	 *        callback = JSUtils.mkPromised(callback, ['body','response']);
	 *        ... existing implementation...
	 *        return callback.promise;
	 *      }
	 *    ```
	 *    The resolved value will be an object with those fields:
	 *    ```
	 *      return legacyRequest(options).then(function(r) {
	 *        var body = r.body, response = r.response;
	 *        ...
	 *      }
	 *    ```
	 * Note that in both cases the legacy callback behavior is unchanged:
	 * ```
	 *   legacyRequest(options, function(err, body, response) { ... });
	 * ```
	 * @param {Function|undefined} callback
	 * @param {true|Array<string>} [names]
	 * @return {Function}
	 * @return {Promise} [return.promise] A promise that will be fulfilled
	 *  when the returned callback function is invoked.
	 */
	mkPromised: function(callback, names) {
		var res, rej;
		var p = new Promise(function(_res, _rej) { res = _res; rej = _rej; });
		var f = function(e, v) {
			if (e) {
				rej(e);
			} else if (names === true) {
				res(Array.prototype.slice.call(arguments, 1));
			} else if (names) {
				var value = {};
				for (var index in names) {
					value[names[index]] = arguments[(+index) + 1];
				}
				res(value);
			} else {
				res(v);
			}
			return callback && callback.apply(this, arguments);
		};
		f.promise = p;
		return f;
	},

	/**
	 * Determine whether two objects are identical, recursively.
	 * @param {any} a
	 * @param {any} b
	 * @return {boolean}
	 */
	deepEquals: function(a, b) {
		var i;
		if (a === b) {
			// If only it were that simple.
			return true;
		}

		if (a === undefined || b === undefined ||
				a === null || b === null) {
			return false;
		}

		if (a.constructor !== b.constructor) {
			return false;
		}

		if (a instanceof Object) {
			for (i in a) {
				if (!this.deepEquals(a[i], b[i])) {
					return false;
				}
			}
			for (i in b) {
				if (a[i] === undefined) {
					return false;
				}
			}
			return true;
		}

		return false;
	},

	/**
	 * Return accurate system time
	 * @return {number}
	 */
	startTime: function() {
		var startHrTime = process.hrtime();
		var milliseconds = (startHrTime[0] * 1e9 + startHrTime[1]) / 1000000;	// convert seconds and nanoseconds to a scalar milliseconds value
		return milliseconds;
	},

	/**
	 * Return millisecond accurate system time differential
	 * @param {number} previousTime
	 * @return {number}
	 */
	elapsedTime: function(previousTime) {
		var endHrTime = process.hrtime();
		var milliseconds = (endHrTime[0] * 1e9 + endHrTime[1]) / 1000000;	// convert seconds and nanoseconds to a scalar milliseconds value
		return milliseconds - previousTime;
	},

};

if (typeof module === "object") {
	module.exports.JSUtils = JSUtils;
}
