/*
 * This file contains general utilities for token transforms
 */
/* jshint nonstandard:true */ // define 'unescape'

"use strict";

var domino = require( './domino' ),
	async = require('async'),
	$ = require( './fakejquery' ),
	jsDiff = require( 'diff' ),
	entities = require( 'entities' ),
	TemplateRequest = require( './mediawiki.ApiRequest.js' ).TemplateRequest;

/** WORKAROUND HACK to entities package, using domino. */
// see https://github.com/fb55/node-entities/issues/8
if ( /^0.2.[01]$/.test( require( 'entities/package.json' ).version ) ) {
	entities.decodeHTML5 = function(data) {
		return data.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g, function(e) {
			return domino.createDocument('x'+e).body.textContent.substr(1);
		});
	};
}

// This is a circular dependency.  Don't use anything from defines at module
// evaluation time.  (For example, we can't define the usual local variable
// shortcuts here.)
var pd = require('./mediawiki.parser.defines.js');

/**
 * @class
 * @singleton
 */
var Util = {

	/**
	 * @method
	 *
	 * Set debugging flags on an object, based on an options object.
	 *
	 * @param {Object} obj The object to modify.
	 * @param {Object} opts The options object to use for setting the debug flags.
	 * @returns {Object} The modified object.
	 */
	setDebuggingFlags: function(obj, opts) {
		obj.debug = Util.booleanOption( opts.debug );
		obj.trace = (opts.trace === true);
		obj.traceFlags = opts.trace && opts.trace !== true ? opts.trace.split(",") : null;
		obj.dumpFlags = opts.dump ? opts.dump.split(",") : null;

		return obj;
	},

	/**
	 * @method
	 *
	 * Parse a boolean option returned by the optimist package.
	 * The strings 'false' and 'no' are also treated as false values.
	 * This allows --debug=no and --debug=false to mean the same as
	 * --no-debug.
	 *
	 * @param {Boolean} a boolean, or a string naming a boolean value.
	 */
	booleanOption: function ( val ) {
		if ( !val ) { return false; }
		if ( (typeof val) === 'string' &&
			 /^(no|false)$/i.test(val)) {
			return false;
		}
		return true;
	},

	/**
	 * @method
	 *
	 * Set the color flags, based on an options object.
	 *
	 * @param {Options} options The options object to use for setting
	 *        the mode of the 'color' package.
	 */
	setColorFlags: function(options) {
		var colors = require('colors');
		if( options.color === 'auto' ) {
			if (!process.stdout.isTTY) {
				colors.mode = 'none';
			}
		} else if( !Util.booleanOption( options.color ) ) {
			colors.mode = 'none';
		}
	},

	/**
	 * @method
	 *
	 * Update only those properties that are undefined or null
	 * $.extend updates properties that are falsy (which means false gets updated as well)
	 *
	 * @param {Object} tgt The object to modify.
	 * @param {Object} subject The object to extend tgt with. Add more arguments to the function call to chain more extensions.
	 * @returns {Object} The modified object.
	 */
	extendProps: function() {
		function internalExtend(target, obj) {
			var allKeys = [].concat(Object.keys(target),Object.keys(obj));
			for (var i = 0, numKeys = allKeys.length; i < numKeys; i++) {
				var k = allKeys[i];
				if (target[k] === undefined || target[k] === null) {
					target[k] = obj[k];
				}
			}
			return target;
		}

		var n = arguments.length;
		var tgt = arguments[0];
		for (var i = 1; i < n; i++) {
			internalExtend(tgt, arguments[i]);
		}
		return tgt;
	},

	/**
	 * Determine if a tag name is block-level or not
	 *
	 * @method
	 * @param {string} name: Lower-case tag name
	 * @returns {boolean}
	 */
	isBlockTag: function ( name ) {
		switch ( name ) {
			case 'div':
			case 'p':
			// tables
			case 'table':
			case 'tbody':
			case 'thead':
			case 'tfoot':
			case 'caption':
			case 'th':
			case 'tr':
			case 'td':
			// lists
			case 'ul':
			case 'ol':
			case 'li':
			case 'dl':
			case 'dt':
			case 'dd':
			// HTML5 heading content
			case 'h1':
			case 'h2':
			case 'h3':
			case 'h4':
			case 'h5':
			case 'h6':
			case 'hgroup':
			// HTML5 sectioning content
			case 'article':
			case 'aside':
			case 'body':
			case 'nav':
			case 'section':
			case 'footer':
			case 'header':
			case 'figure':
			case 'figcaption':
			case 'fieldset':
			case 'details':
			case 'blockquote':
			// other
			case 'hr':
			case 'button':
			case 'canvas':
			case 'center':
			case 'col':
			case 'colgroup':
			case 'embed':
			case 'map':
			case 'object':
			case 'pre':
			case 'progress':
			case 'video':
				return true;
			default:
				return false;
		}
	},

	// In the PHP parser, these block tags open block-tag scope
	// See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	tagOpensBlockScope: function(name) {
		switch ( name ) {
			case 'p':
			case 'table':
			case 'tr':
			case 'ul':
			case 'ol':
			case 'li':
			case 'dl':
			case 'h1':
			case 'h2':
			case 'h3':
			case 'h4':
			case 'h5':
			case 'h6':
			case 'blockquote':
			case 'pre':
				return true;
			default:
				return false;
		}
	},

	// In the PHP parser, these block tags close block-tag scope
	// See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	tagClosesBlockScope: function(name) {
		return name === 'td' || name === 'th';
	},

	// We are currently treating <source> as an extension tag since this is widely
	// used on wikipedias.  So, we dont want to treat this as a HTML tag => it cannot
	// be a void element
	//
	// See http://www.whatwg.org/specs/web-apps/current-work/#void-elements
	voidElements: { area: 1, base: 1, br: 1, col: 1, command: 1, embed: 1, hr: 1, img: 1,
		input: 1, keygen: 1, link: 1, meta: 1, param: 1, /* source: 1, */ track: 1, wbr: 1 },

	/*
	 * Determine if the tag is an empty HTML tag
	 */
	isVoidElement: function ( name ) {
		return this.voidElements[name] || false;
	},

	/**
	 * Determine if a token is block-level or not
	 *
	 * @method
	 * @param {Token} token
	 * @returns {boolean}
	 */
	isBlockToken: function ( token ) {
		if ( token.constructor === pd.TagTk ||
		     token.constructor === pd.EndTagTk ||
		     token.constructor === pd.SelfclosingTagTk ) {
			return Util.isBlockTag( token.name );
		} else {
			return false;
		}
	},

	isTemplateToken: function(token) {
		return token && token.constructor === pd.SelfclosingTagTk && token.name === 'template';
	},

	isTableTag: function(token) {
		var tc = token.constructor;
		return (tc === pd.TagTk || tc === pd.EndTagTk) &&
			['table','tbody','caption','th','tr','td'].indexOf(token.name) !== -1;
	},

	isSolTransparent: function(token) {
		var tc = token.constructor;
		if (tc === String) {
			if (token.match(/[^\s]/)) {
				return false;
			}
		} else if (tc !== pd.CommentTk &&
		           (tc !== pd.SelfclosingTagTk || token.name !== 'meta')) {
			return false;
		}

		// BUG 47854: Treat all mw:Ext/* tokens as non-SOL.
		if (token.name === 'meta' && /\bmw:Extension\//.test(token.getAttribute('typeof'))) {
			return false;
		} else {
			return true;
		}
	},

	/*
	 * Transform "\n" and "\r\n" in the input string to NlTk tokens
	 */
	newlinesToNlTks: function(str, tsr0) {
		var toks = str.split(/\n|\r\n/),
			ret = [],
			tsr = tsr0;

		// Add one NlTk between each pair, hence toks.length-1
		for (var i = 0, n = toks.length-1; i < n; i++) {
			ret.push(toks[i]);
			var nlTk = new pd.NlTk();
			if (tsr !== undefined) {
				tsr += toks[i].length;
				nlTk.dataAttribs = { tsr: [tsr, tsr+1] };
			}
			ret.push(nlTk);
		}
		ret.push(toks[i]);

		return ret;
	},

	shiftTokenTSR: function(tokens, offset, clearIfUnknownOffset) {
		// Bail early if we can
		if (offset === 0) {
			return;
		}

		// offset should either be a valid number or null
		if (offset === undefined) {
			if (clearIfUnknownOffset) {
				offset = null;
			} else {
				return;
			}
		}

		// update/clear tsr
		for (var i = 0, n = tokens.length; i < n; i++) {
			var t = tokens[i];
			switch (t.constructor) {
				case pd.TagTk:
				case pd.SelfclosingTagTk:
				case pd.NlTk:
				case pd.CommentTk:
				case pd.EndTagTk:
					var da = tokens[i].dataAttribs;
					var tsr = da.tsr;
					if (tsr) {
						if (offset !== null) {
							da.tsr = [tsr[0] + offset, tsr[1] + offset];
						} else {
							da.tsr = null;
						}
					}

					// SSS FIXME: offset will always be available in
					// chunky-tokenizer mode in which case we wont have
					// buggy offsets below.  The null scenario is only
					// for when the token-stream-patcher attempts to
					// reparse a string -- it is likely to only patch up
					// small string fragments and the complicated use cases
					// below should not materialize.

					// target offset
					if (offset && da.targetOff) {
						da.targetOff += offset;
					}

					//  Process attributes
					if (t.attribs) {
						for (var j = 0, m = t.attribs.length; j < m; j++) {
							var a = t.attribs[j];
							if (a.k.constructor === Array) {
								this.shiftTokenTSR(a.k, offset, clearIfUnknownOffset);
							}
							if (a.v.constructor === Array) {
								this.shiftTokenTSR(a.v, offset, clearIfUnknownOffset);
							}

							// src offsets used to set mw:TemplateParams
							if (offset === null) {
								a.srcOffsets = null;
							} else if (a.srcOffsets) {
								for (var k = 0; k < a.srcOffsets.length; k++) {
									a.srcOffsets[k] += offset;
								}
							}
						}
					}
					break;

				default:
					break;
			}
		}
	},

	toStringTokens: function(tokens, indent) {
		if (!indent) {
			indent = "";
		}

		if (tokens.constructor !== Array) {
			return [tokens.toString(false, indent)];
		} else if (tokens.length === 0) {
			return [null];
		} else {
			var buf = [];
			for (var i = 0, n = tokens.length; i < n; i++) {
				buf.push(tokens[i].toString(false, indent));
			}
			return buf;
		}
	},

	tokensToString: function ( tokens, strict ) {
		var out = [];
		// XXX: quick hack, track down non-array sources later!
		if ( ! $.isArray( tokens ) ) {
			tokens = [ tokens ];
		}
		for ( var i = 0, l = tokens.length; i < l; i++ ) {
			var token = tokens[i];
			if ( token === undefined ) {
				console.warn( 'Util.tokensToString, invalid token: ' +
								token, ' tokens:', tokens);
				console.trace();
			} else if ( token.constructor === String ) {
				out.push( token );
			} else if ( token.constructor === pd.CommentTk ||
			            token.constructor === pd.NlTk ) {
				// strip comments and newlines
				/* jshint noempty: false */
			} else if ( strict ) {
				// If strict, return accumulated string on encountering first non-text token
				return [out.join(''), tokens.slice( i )];
			}
		}
		return out.join('');
	},

	flattenAndAppendToks: function(array, prefix, t) {
		if (t.constructor === pd.ParserValue) {
			// The check above will explode for undefined or null, but that is
			// fine. Fail early and loudly!
			throw new TypeError("Got ParserValue in flattenAndAppendToks!");
		} else if (t.constructor === Array || t.constructor === String) {
			if (t.length > 0) {
				if (prefix) {
					array.push(prefix);
				}
				array = array.concat(t);
			}
		} else {
			if (prefix) {
				array.push(prefix);
			}
			array.push(t);
		}

		return array;
	},

	/**
	 * Expand all ParserValue values in the passed-in KV pairs, and call the
	 * supplied callback with the new KV pairs.
	 */
	expandParserValueValues: function(kvs, cb, wrapTemplates) {
		var v,
		reassembleKV = function( kv, cb2, v )  {
			var newKV = Util.clone(kv);
			newKV.v = v;
			cb2(null, newKV);
		};


		async.map(
				kvs,
				function ( kv, cb1 ) {
					v = kv.v;
					if ( v.constructor === pd.ParserValue ) {
						v.get({
							type: 'tokens/x-mediawiki/expanded',
							cb: reassembleKV.bind(null, kv, cb1),
							wrapTemplates: wrapTemplates
						});
					} else {
						cb1 ( null, kv );
					}
				},
				function ( err, expandedAttrs ) {
					if ( err ) {
						throw( err );
					}
					cb(expandedAttrs);
				}
		);
	},

	/**
	 * Determine whether two objects are identical, recursively.
	 */
	deepEquals: function ( a, b ) {
		var i;
		if ( a === b ) {
			// If only it were that simple.
			return true;
		}

		if ( a === undefined || b === undefined ||
				a === null || b === null ) {
			return false;
		}

		if ( a.constructor !== b.constructor ) {
			return false;
		}

		if ( a instanceof Object ) {
			for ( i in a ) {
				if ( !this.deepEquals( a[i], b[i] ) ) {
					return false;
				}
			}
			for ( i in b ) {
				if ( a[i] === undefined ) {
					return false;
				}
			}
			return true;
		}

		return false;
	},

	// deep clones by default.
	clone: function(obj, deepClone) {
		if (deepClone === undefined) {
			deepClone = true;
		}
		if ( obj ) {
			if ( obj.constructor === Array ) {
				if ( deepClone ) {
					return $.extend(true, {}, {o: obj}).o;
				} else {
					return obj.slice();
				}
			} else if ( obj instanceof Object ) {
				return $.extend(deepClone, {}, obj);
			} else {
				return obj;
			}
		} else {
			return obj;
		}
	},

	// Deep-freeze an object
	// See
	// https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Object/freeze
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

	// 'cb' can only be called once after "everything" is done.
	// But, we need something that can be used in async context where it is
	// called repeatedly till we are done.
	//
	// Primarily needed in the context of async.map calls that requires a 1-shot callback.
	//
	// Use with caution!  If the async stream that we are accumulating into the buffer
	// is a firehose of tokens, the buffer will become huge.
	buildAsyncOutputBufferCB: function(cb) {
		function AsyncOutputBufferCB(cb) {
			this.accum = [];
			this.targetCB = cb;
		}

		AsyncOutputBufferCB.prototype.processAsyncOutput = function(res) {
			// * Ignore switch-to-async mode calls since
			//   we are actually collapsing async calls.
			// * Accumulate async call results in an array
			//   till we get the signal that we are all done
			// * Once we are done, pass everything to the target cb.
			if (res.async !== true) {
				// There are 3 kinds of callbacks:
				// 1. cb({tokens: .. })
				// 2. cb({}) ==> toks can be undefined
				// 3. cb(foo) -- which means in some cases foo can
				//    be one of the two cases above, or it can also be a simple string.
				//
				// Version 1. is the general case.
				// Versions 2. and 3. are optimized scenarios to eliminate
				// additional processing of tokens.
				//
				// In the C++ version, this is handled more cleanly.
				var toks = res.tokens;
				if (!toks && res.constructor === String) {
					toks = res;
				}

				if (toks) {
					if (toks.constructor === Array) {
						for ( var i = 0, l = toks.length; i < l; i++ ) {
							this.accum.push(toks[i]);
						}
						//this.accum = this.accum.concat(toks);
					} else {
						this.accum.push(toks);
					}
				}

				if (!res.async) {
					// we are done!
					this.targetCB(this.accum);
				}
			}
		};

		var r = new AsyncOutputBufferCB(cb);
		return r.processAsyncOutput.bind(r);
	},

	lookupKV: function ( kvs, key ) {
		if ( ! kvs ) {
			return null;
		}
		var kv;
		for ( var i = 0, l = kvs.length; i < l; i++ ) {
			kv = kvs[i];
			if ( kv.k.constructor === String && kv.k.trim() === key ) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	},

	lookup: function ( kvs, key ) {
		var kv = this.lookupKV(kvs, key);
		return kv === null ? null : kv.v;
	},

	lookupValue: function ( kvs, key ) {
		if ( ! kvs ) {
			return null;
		}
		var kv;
		for ( var i = 0, l = kvs.length; i < l; i++ ) {
			kv = kvs[i];
			if ( kv.v === key ) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	},

	/**
	 * Convert an array of key-value pairs into a hash of keys to values. For
	 * duplicate keys, the last entry wins.
	 */
	KVtoHash: function ( kvs ) {
		if ( ! kvs ) {
			console.warn( "Invalid kvs!: " + JSON.stringify( kvs, null, 2 ) );
			return {};
		}
		var res = {};
		for ( var i = 0, l = kvs.length; i < l; i++ ) {
			var kv = kvs[i],
				key = this.tokensToString( kv.k ).trim();
			//if( res[key] === undefined ) {
			res[key.toLowerCase()] = this.tokenTrim( kv.v );
			//}
		}
		//console.warn( 'KVtoHash: ' + JSON.stringify( res ));
		return res;
	},

	/**
	 * Trim space and newlines from leading and trailing text tokens.
	 */
	tokenTrim: function ( tokens ) {
		if (tokens.constructor !== Array) {
			return tokens;
		}

		// Since the tokens array might be frozen,
		// we have to create a new array -- but, create it
		// only if needed
		//
		// FIXME: If tokens is not frozen, we can avoid
		// all this circus with leadingToks and trailingToks
		// but we will need a new function altogether -- so,
		// something worth considering if this is a perf. problem.

		var i, n = tokens.length, token;

		// strip leading space
		var leadingToks = [];
		for ( i = 0; i < n; i++ ) {
			token = tokens[i];
			if (token.constructor === pd.NlTk) {
				leadingToks.push('');
			} else if ( token.constructor === String ) {
				leadingToks.push(token.replace( /^\s+/, '' ));
				if ( token !== '' ) {
					break;
				}
			} else {
				break;
			}
		}

		i = leadingToks.length;
		if (i > 0) {
			tokens = leadingToks.concat(tokens.slice(i));
		}

		// strip trailing space
		var trailingToks = [];
		for ( i = n - 1; i >= 0; i-- ) {
			token = tokens[i];
			if (token.constructor === pd.NlTk) {
				trailingToks.push(''); // replace newline with empty
			} else if ( token.constructor === String ) {
				trailingToks.push(token.replace( /\s+$/, '' ));
				if ( token !== '' ) {
					break;
				}
			} else {
				break;
			}
		}

		var j = trailingToks.length;
		if (j > 0) {
			tokens = tokens.slice(0, n - j).concat(trailingToks.reverse());
		}

		return tokens;
	},

	// Strip 'end' tokens and trailing newlines
	stripEOFTkfromTokens: function ( tokens ) {
		// this.dp( 'stripping end or whitespace tokens' );
		if ( tokens.constructor !== Array ) {
			tokens = [ tokens ];
		}
		if ( ! tokens.length ) {
			return tokens;
		}
		// Strip 'end' tokens and trailing newlines
		var l = tokens[tokens.length - 1];
		if ( l &&
		     ( l.constructor === pd.EOFTk ||
		       l.constructor === pd.NlTk ||
				( l.constructor === String && l.match( /^\s+$/ ) ) ) ) {
			var origTokens = tokens;
			tokens = origTokens.slice();
			tokens.rank = origTokens.rank;
			while ( tokens.length &&
			        (( l.constructor === pd.EOFTk  ||
			           l.constructor === pd.NlTk )  ||
			         ( l.constructor === String && l.match( /^\s+$/ ) ) ) )
			{
				// this.dp( 'stripping end or whitespace tokens' );
				tokens.pop();
				l = tokens[tokens.length - 1];
			}
		}
		return tokens;
	},

	/**
	 * Perform a shallow clone of a chunk of tokens
	 */
	cloneTokens: function ( chunk ) {
		var out = [],
			token, tmpToken;
		for ( var i = 0, l = chunk.length; i < l; i++ ) {
			token = chunk[i];
			if ( token.constructor === String ) {
				out.push( token );
			} else {
				tmpToken = token.clone(false); // dont clone attribs
				tmpToken.rank = 0;
				out.push(tmpToken);
			}
		}
		return out;
	},

	// Does this need separate UI/content inputs?
	formatNum: function( num ) {
		return num + '';
	},

	decodeURI: function ( s ) {
		return s.replace( /(%[0-9a-fA-F][0-9a-fA-F])+/g, function( m ) {
			try {
				// JS library function
				return decodeURIComponent( m );
			} catch ( e ) {
				return m;
			}
		} );
	},

	sanitizeTitleURI: function ( title ) {
		var bits = title.split('#'),
			anchor = null;
		if ( bits.length > 1 ) {
			anchor = bits[bits.length - 1];
			title = title.substring(0, title.length - anchor.length - 1);
		}
		title = title.replace( /[%? \[\]#|]/g, function ( m ) {
			return encodeURIComponent( m );
		} );
		if ( anchor !== null ) {
			title += '#' + anchor;
		}
		return title;
	},

	sanitizeURI: function ( s ) {
		var host = s.match(/^[a-zA-Z]+:\/\/[^\/]+(?:\/|$)/),
			path = s,
			anchor = null;
		//console.warn( 'host: ' + host );
		if ( host ) {
			path = s.substr( host[0].length );
			host = host[0];
		} else {
			host = '';
		}
		var bits = path.split('#');
		if ( bits.length > 1 ) {
			anchor = bits[bits.length - 1];
			path = path.substr(0, path.length - anchor.length - 1);
		}
		host = host.replace( /[%#|]/g, function ( m ) {
			return encodeURIComponent( m );
		} );
		path = path.replace( /[% \[\]#|]/g, function ( m ) {
			return encodeURIComponent( m );
		} );
		s = host + path;
		if ( anchor !== null ) {
			s += '#' + anchor;
		}
		return s;
	},

	/**
	 * Strip a string suffix if it matches
	 */
	stripSuffix: function ( text, suffix ) {
		var sLen = suffix.length;
		if ( sLen && text.substr( -sLen ) === suffix )
		{
			return text.substr( 0, text.length - sLen );
		} else {
			return text;
		}
	},

    // SSS FIXME: This code is copied from the WTS.
    // Given the ongoing refactoring, I figured it is good to have a copy here
    // and de-duplicate code once the refactoring is complete and see if this
    // code survives there.
    charSequence: function(prefix, c, numChars) {
        if (numChars && numChars > 0) {
            var buf = [prefix];
            for (var i = 0; i < numChars; i++) {
                buf.push(c);
            }
            return buf.join('');
        } else {
            return prefix;
        }
    },

	arrayToHash: function(a) {
		var h = {};
		for (var i = 0, n = a.length; i < n; i++) {
			h[a[i]] = true;
		}
		return h;
	},

	extractExtBody: function(extName, extTagSrc) {
		var re = "<" + extName + "[^>]*/?>([\\s\\S]*)";
		return extTagSrc.replace(new RegExp(re, "mi"), function() {
			return arguments[1].replace(new RegExp("</" + extName + ">", "mi"), "");
		});
	},

	// Returns the utf8 encoding of the code point
	codepointToUtf8: function(cp) {
		return unescape(encodeURIComponent(cp));
	},

	// Returns true if a given Unicode codepoint is a valid character in XML.
	validateCodepoint: function(cp) {
		return (cp ===    0x09) ||
			(cp ===   0x0a) ||
			(cp ===   0x0d) ||
			(cp >=    0x20 && cp <=   0xd7ff) ||
			(cp >=  0xe000 && cp <=   0xfffd) ||
			(cp >= 0x10000 && cp <= 0x10ffff);
	},

	debug_pp: function() {
		var out = [arguments[0]];
		for ( var i = 2; i < arguments.length; i++) {
			var a = arguments[i];
			if (a === null) {
				out.push('null');
			} else if (a === undefined) {
				out.push('undefined');
			} else if (a.constructor === Boolean) {
				out.push(a ? '1' : '0');
			} else if (a.constructor !== String || a.match(/\n|^\s*$/)) {
				out.push(JSON.stringify(a));
			} else {
				out.push(a);
			}
		}
		console.error(out.join(arguments[1]));
	}
};

/**
 * Utility function for stripping useless paragraphs from the beginning of a list item,
 * because they get appended by VisualEditor sometimes.
 */
// FIXME: Dead function?  SelectiveSerializer doesn't seem to use this
Util.stripFirstParagraph = function ( node ) {
	var thisnode, hasAttrs, dataParsoid, attrs, exemptAttrs = 0;
	for ( var i = 0; i < node.childNodes.length; i++ ) {
		thisnode = node.childNodes[i];
		exemptAttrs += Util.getJSONAttribute( thisnode, 'data-ve-changed' ) ? 1 : 0;
		exemptAttrs += Util.getJSONAttribute( thisnode, 'data-parsoid-changed' ) ? 1 : 0;
		dataParsoid = Util.getJSONAttribute( thisnode, 'data-parsoid' );
		exemptAttrs += dataParsoid ? 1 : 0;
		attrs = thisnode.attributes;
		hasAttrs = ( attrs && attrs.length && attrs.length - exemptAttrs ) > 0;
		if ( ( node.tagName || '' ).toLowerCase() === 'li' && i < 1 && !hasAttrs &&
				( !dataParsoid || !dataParsoid.stx || dataParsoid.stx !== 'html' ) &&
				( thisnode.tagName || '' ).toLowerCase() === 'p' ) {
			for ( var j = 0; j < thisnode.childNodes.length; j++ ) {
				node.insertBefore( thisnode.childNodes[j].cloneNode(), thisnode );
			}
			node.removeChild( thisnode );
			i--;
		} else {
			Util.stripFirstParagraph( thisnode );
		}
	}
};

// FIXME: There is also a DOMUtils.getJSONAttribute. Consolidate
Util.getJSONAttribute = function ( node, attr, fallback ) {
    fallback = fallback || null;
    var atext;
    if ( node && node.getAttribute && typeof node.getAttribute === 'function' ) {
        atext = node.getAttribute( attr );
        if ( atext ) {
            return JSON.parse( atext );
        } else {
            return fallback;
        }
    } else {
        return fallback;
    }
};

// Separate closure for normalize functions that
// use a singleton html parser
( function ( Util ) {


/**
 * Normalize a bit of source by stripping out unnecessary newlines.
 *
 * @method
 * @param {string} source
 * @returns {string}
 */
var normalizeNewlines = function ( source ) {
	return source
				// strip comments first
				.replace(/<!--(?:[^\-]|-(?!->))*-->/gm, '')

				// preserve a space for non-inter-tag-whitespace
				// non-tag content followed by non-tag content
				.replace(/([^<> \r\n]|<\/span>)[\r\n ]+([^ \r\n<]|<span typeof="mw:)/g, '$1 $2')

				// and eat all remaining newlines
				.replace(/[\r\n]/g, '');
};

/**
 * @method normalizeOut
 *
 * Specialized normalization of the wiki parser output, mostly to ignore a few
 * known-ok differences.  If parsoidOnly is true-ish, then we allow more
 * markup through (like property and typeof attributes), for better
 * checking of parsoid-only test cases.
 *
 * @param {string} out
 * @param {bool} parsoidOnly
 * @returns {string}
 */
var normalizeOut = function ( out, parsoidOnly ) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	// NOTE that we use a slightly restricted regexp for "attribute"
	//  which works for the output of DOM serialization.  For example,
	//  we know that attribute values will be surrounded with double quotes,
	//  not unquoted or quoted with single quotes.  The serialization
	//  algorithm is given by:
	//  http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#serializing-html-fragments
	if (!/[^<]*(<\w+(\s+[^\0-\cZ\s"'>\/=]+(="[^"]*")?)*\/?>[^<]*)*/.test(out)) {
		throw new Error("normalizeOut input is not in standard serialized form");
	}
	out = normalizeNewlines( out );
	if ( !parsoidOnly ) {
		// ignore troublesome attributes
		out = out.
			// remove <span typeof="....">....</span>
			replace(/<span(?:[^>]*) typeof="mw:(?:Placeholder|Nowiki|Transclusion|Entity)"(?: [^\0-\cZ\s\"\'>\/=]+(?:="[^"]*")?)*>((?:[^<]+|(?!<\/span).)*)<\/span>/g, '$1').
			replace(/ (data-mw|data-parsoid|typeof|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content|title|class)="[^\"]*"/g, '');
	} else {
		out = out.
			// remove <span typeof="mw:Placeholder">....</span>
			replace(/<span(?: [^>]+)* typeof="mw:Placeholder"(?: [^\0-\cZ\s\"\'>\/=]+(?:="[^"]*")?)*>((?:[^<]+|(?!<\/span).)*)<\/span>/g, '$1').
			// unnecessary attributes, we don't need to check these
			// style is in there because we should only check classes.
			replace(/ (data-mw|data-parsoid|prefix|about|rev|datatype|inlist|vocab|content|style)="[^\"]*"/g, '').
			replace(/<\/?(?:meta|link)(?: [^\0-\cZ\s"'>\/=]+(?:="[^"]*")?)*\/?>/g, '');
	}
	return out.
		// replace mwt ids
		replace(/ id="mwt\d+"/, '').
		//.replace(/<!--.*?-->\n?/gm, '')
		replace(/<span[^>]+about="[^"]*"[^>]*>/g, '').
		replace(/<span><\/span>/g, '').
		replace(/(href=")(?:\.?\.\/)+/g, '$1').
		// replace unnecessary URL escaping
		replace(/ href="[^"]*"/g, decodeURIComponent).
		// strip thumbnail size prefixes
		replace(/(src="[^"]*?)\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^\/]+)\/[0-9]+px-[^"\/]+(?=")/g, '$1$2').
		replace(/(<(table|tbody|tr|th|td|\/th|\/td)[^<>]*>)\s+/g, '$1');
};

/**
 * @method normalizeHTML
 *
 * Normalize the expected parser output by parsing it using a HTML5 parser and
 * re-serializing it to HTML. Ideally, the parser would normalize inter-tag
 * whitespace for us. For now, we fake that by simply stripping all newlines.
 *
 * @param source {string}
 * @return {string}
 */
var normalizeHTML = function ( source ) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	source = normalizeNewlines( source );
	try {
		var doc = this.parseHTML( source );
		return doc.body
			.innerHTML
			// a few things we ignore for now..
			//.replace(/\/wiki\/Main_Page/g, 'Main Page')
			// do not expect a toc for now
			.replace(/<table[^>]+?id="toc"[^>]*>.+?<\/table>/mg, '')
			// do not expect section editing for now
			.replace(/<span[^>]+class="mw-headline"[^>]*>(.*?)<\/span> *(<span class="mw-editsection">\[.*?<\/span>)?/g, '$1')
			// remove empty span tags
			.replace(/<span><\/span>/g, '')
			// general class and titles, typically on links
			.replace(/ (title|class|rel|about|typeof)="[^"]*"/g, '')
			// strip red link markup, we do not check if a page exists yet
			.replace(/\/index.php\?title=([^']+?)&amp;action=edit&amp;redlink=1/g, '/wiki/$1')
			// the expected html has some extra space in tags, strip it
			.replace(/<a +href/g, '<a href')
			.replace(/href="\/wiki\//g, 'href="')
			.replace(/" +>/g, '">')
			// parsoid always add a page name to lonely fragments
			.replace(/href="#/g, 'href="Main Page#')
			// replace unnecessary URL escaping
			.replace(/ href="[^"]*"/g, decodeURIComponent)
			// strip empty spans
			.replace(/<span><\/span>/g, '')
			.replace(/(<(table|tbody|tr|th|td|\/th|\/td)[^<>]*>)\s+/g, '$1');
	} catch(e) {
		console.log("normalizeHTML failed on" +
		            source + " with the following error: " + e);
		console.trace();
		return source;
	}
},

/**
 * @method formatHTML
 *
 * Insert newlines before some block-level start tags.
 *
 * @param {string} source
 * @returns {string}
 */
formatHTML = function ( source ) {
	return source.replace(
		/(?!^)<((div|dd|dt|li|p|table|tr|td|tbody|dl|ol|ul|h1|h2|h3|h4|h5|h6)[^>]*)>/g, '\n<$1>');
},

/**
 * @method parseHTML
 *
 * Parse HTML, return the tree.
 *
 * @param {string} html
 * @returns {Node}
 */
parseHTML = function ( html ) {
	if(! html.match(/^<(?:!doctype|html|body)/i)) {
		// Make sure that we parse fragments in the body. Otherwise comments,
		// link and meta tags end up outside the html element or in the head
		// element.
		html = '<body>' + html;
	}
	return domino.createDocument(html);
},

/**
 * @method compressHTML
 *
 * Compress an HTML string by applying some smart quoting
 *
 * @param {string} html
 * @returns {string}
 */
compressHTML = function(html) {
	// now compress our output (and make it more readable) by using
	// "smart quoting" of attribute values -- using single-quotes
	// where the contents have a lot of double quotes.
	// since the output of outerHTML is specified strictly, we know
	// this regexp is safe. See:
	// http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html
	// http://www.whatwg.org/specs/web-apps/current-work/multipage/syntax.html
	var smart_quote = function(match, name, equals, value) {
		if (!equals) { return match; }
		var decoded = entities.decodeHTML5(value);
		// try re-encoding with single-quotes escaped
		var encoded = decoded.replace(/[&'\u00A0]/g, function(c) {
			switch(c) {
			case '&': return '&amp;';
			case "'": return '&#39;';
			case '\u00A0': return '&nbsp;';
			}
		});
		if (encoded.length >= value.length) { return match; /* no change */ }
		return ' '+name+"='"+encoded+"'";
	};
	var process_attr_list = function(match, tag, attrs) {
		attrs = attrs.replace(/ ([^\0-\cZ\s"'>\/=]+)(="([^"]*)")?/g,
		                      smart_quote);
		return tag + attrs + '>';
	};
	return html.replace(/(<\w+)((?: [^\0-\cZ\s"'>\/=]+(?:="[^"]*")?)+)>/g,
	                    process_attr_list);
},

/**
 * @method serializeNode
 *
 * Serialize a HTML document.
 * The output is identical to standard DOM serialization, as given by
 * http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#serializing-html-fragments
 * except that we may quote attributes with single quotes, *only* where that would
 * result in more compact output than the standard double-quoted serialization.
 * Single-quoted attribute values have &amp; &#39 and &nbsp; escaped.
 *
 * @param {Node} doc
 * @returns {string}
 */
serializeNode = function (doc) {
	// use domino's outerHTML, as specified by
	// http://domparsing.spec.whatwg.org/#outerhtml
	var html = doc.outerHTML;
	// technically, dom doesn't define outerHTML on a Document; that's
	// just a convenience API defined by domino.  We can handle a
	// more-standard DOM implementation, too.
	if (doc.nodeName==='#document' && !html) {
		html = doc.documentElement.outerHTML;
	}
	// ensure there's a doctype for documents
	if (html &&
	    (doc.nodeName === '#document' || /^html$/i.test(doc.nodeName)) &&
	    ! /^\s*<!doctype/i.test(html)) {
		html = '<!DOCTYPE html>\n' + html;
	}
	if (!html) {
		// fall back to definition of outerHTML, for comments, etc:
		// "return the result of running the HTML fragment
		// serialization algorithm on a fictional node whose only child is
		// the context object"
		var fictional = doc.ownerDocument.createElement('p');
		fictional.appendChild(doc.cloneNode());
		html = fictional.innerHTML;
	}
	return compressHTML(html);
},

/**
 * @method encodeXml
 *
 * Little helper function for encoding XML entities
 *
 * @param {string} string
 * @returns {string}
 */
encodeXml = function ( string ) {
	return entities.encodeXML(string);
};

// FIXME gwicke: define this directly
Util.encodeXml = encodeXml;
Util.parseHTML = parseHTML;
Util.compressHTML = compressHTML;
Util.serializeNode = serializeNode;
Util.normalizeHTML = normalizeHTML;
Util.normalizeOut = normalizeOut;
Util.formatHTML = formatHTML;

}( Util ) );

( function ( Util ) {

var convertDiffToOffsetPairs = function ( diff ) {
	var currentPair, pairs = [], srcOff = 0, outOff = 0;
	diff.map( function ( change ) {
		var pushPair = function ( pair, start ) {
			if ( !pair.added ) {
				pair.added = {start: start, end: start };
			} else if ( !pair.removed ) {
				pair.removed = {start: start, end: start };
			}

			pairs.push( [pair.added, pair.removed] );
			currentPair = {};
		};

		if ( !currentPair ) {
			currentPair = {};
		}

		if ( change.added ) {
			if ( currentPair.added ) {
				pushPair( currentPair, outOff );
			}

			currentPair.added = { start: outOff };
			outOff += change.value.length;
			currentPair.added.end = outOff;

			if ( currentPair.removed ) {
				pushPair( currentPair );
			}
		} else if ( change.removed ) {
			if ( currentPair.removed ) {
				pushPair( currentPair, srcOff );
			}

			currentPair.removed = { start: srcOff };
			srcOff += change.value.length;
			currentPair.removed.end = srcOff;

			if ( currentPair.added ) {
				pushPair( currentPair );
			}
		} else {
			if ( currentPair.added || currentPair.removed ) {
				pushPair( currentPair, currentPair.added ? srcOff : outOff );
			}

			srcOff += change.value.length;
			outOff += change.value.length;
		}
	} );

	return pairs;
};
Util.convertDiffToOffsetPairs = convertDiffToOffsetPairs;

}( Util ) );

// Variant of diff with some extra context
Util.contextDiff = function(a, b, color, onlyReportChanges, useLines) {
	var diff = jsDiff.diffLines( a, b ),
		offsetPairs = this.convertDiffToOffsetPairs( diff ),
		results = [];
	offsetPairs.map(function(pair) {
		var context = 5,
			asource = a.substring(pair[0].start - context, pair[0].end + context),
			bsource = b.substring(pair[1].start - context, pair[1].end + context);
		results.push('++++++\n' + JSON.stringify(asource));
		results.push('------\n' + JSON.stringify(bsource));
		//results.push('======\n' + Util.diff(a, b, color, onlyReportChanges, useLines));
	});
	if ( !onlyReportChanges || diff.length > 0 ) {
		return results.join('\n');
	} else {
		return '';
	}
};

var diff = function ( a, b, color, onlyReportChanges, useLines ) {
	var thediff, patch, diffs = 0;
	if ( color ) {
		thediff = jsDiff[useLines ? 'diffLines' : 'diffWords']( a, b ).map( function ( change ) {
			if ( useLines && change.value[-1] !== '\n' ) {
				change.value += '\n';
			}
			if ( change.added ) {
				diffs++;
				return change.value.split( '\n' ).map( function ( line ) {
					return line.green + '';//add '' to workaround color bug
				} ).join( '\n' );
			} else if ( change.removed ) {
				diffs++;
				return change.value.split( '\n' ).map( function ( line ) {
					return line.red + '';//add '' to workaround color bug
				} ).join( '\n' );
			} else {
				return change.value;
			}
		}).join('');
		if ( !onlyReportChanges || diffs > 0 ) {
			return thediff;
		} else {
			return '';
		}
	} else {
		patch = jsDiff.createPatch('wikitext.txt', a, b, 'before', 'after');

		// Strip the header from the patch, we know how diffs work..
		patch = patch.replace(/^[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/, '');

		// Don't care about not having a newline.
		patch = patch.replace( /^\\ No newline at end of file\n/, '' );

		return patch;
	}
};
Util.diff = diff;

// XXX gwicke: move to a Parser object?
Util.getParserPipeline = function ( env, type ) {
	var ParserPipelineFactory = require( './mediawiki.parser.js' ).ParserPipelineFactory;
	return ( new ParserPipelineFactory( env ) ).makePipeline( type );
},

// XXX gwicke: move to a Parser object?
Util.parse = function ( env, cb, err, src, expansions ) {
	if ( err !== null ) {
		cb( null, err );
	} else {
		// If we got some expansions passed in, prime the caches with it.
		if (expansions) {
			env.transclusionCache = expansions.transclusions;
			env.extensionCache = expansions.extensions;
			env.imageCache = expansions.images;
		}

		// Now go ahead with the actual parsing
		var parser = Util.getParserPipeline( env, 'text/x-mediawiki/full' );
		parser.on( 'document', cb.bind( null, env, null ) );
		try {
			parser.processToplevelDoc( src );
		} catch ( e ) {
			env.errCB(e);
			cb( null, e );
		}
	}
};


Util.getPageSrc = function ( env, title, oldid, cb ) {
	title = env.resolveTitle( title, '' );
	var pageRequest = new TemplateRequest( env, title, oldid );
	pageRequest.once( 'src', function(err, page) {
		cb(err, page && page.revision ? page.revision['*'] : null);
	});
};

/**
 * @property linkTrailRegex
 *
 * This regex was generated by running through *all unicode characters* and
 * testing them against *all regexes* for linktrails in a default MW install.
 * We had to treat it a little bit, here's what we changed:
 *
 * 1. A-Z, though allowed in Walloon, is disallowed.
 * 2. '"', though allowed in Chuvash, is disallowed.
 * 3. '-', though allowed in Icelandic (possibly due to a bug), is disallowed.
 * 4. '1', though allowed in Lak (possibly due to a bug), is disallowed.
 */
Util.linkTrailRegex = new RegExp(
	'^[^\0-`{÷ĀĈ-ČĎĐĒĔĖĚĜĝĠ-ĪĬ-įĲĴ-ĹĻ-ĽĿŀŅņŉŊŌŎŏŒŔŖ-ŘŜŝŠŤŦŨŪ-ŬŮŲ-ŴŶŸ' +
	'ſ-ǤǦǨǪ-Ǯǰ-ȗȜ-ȞȠ-ɘɚ-ʑʓ-ʸʽ-̂̄-΅·΋΍΢Ϗ-ЯѐѝѠѢѤѦѨѪѬѮѰѲѴѶѸѺ-ѾҀ-҃҅-ҐҒҔҕҘҚҜ-ҠҤ-ҪҬҭҰҲ' +
	'Ҵ-ҶҸҹҼ-ҿӁ-ӗӚ-ӜӞӠ-ӢӤӦӪ-ӲӴӶ-ՠֈ-׏׫-ؠً-ٳٵ-ٽٿ-څڇ-ڗڙ-ڨڪ-ڬڮڰ-ڽڿ-ۅۈ-ۊۍ-۔ۖ-਀਄਋-਎਑਒' +
	'਩਱਴਷਺਻਽੃-੆੉੊੎-੘੝੟-੯ੴ-჏ჱ-ẼẾ-​\u200d-‒—-‗‚‛”--\ufffd\ufffd]+$' );

/**
 * @method isLinkTrail
 *
 * Check whether some text is a valid link trail.
 *
 * @param {string} text
 * @returns {boolean}
 */
Util.isLinkTrail = function ( text ) {
	if ( text && text.match && text.match( this.linkTrailRegex ) ) {
		return true;
	} else {
		return false;
	}
};

/**
 * @method stripPipeTrickChars
 *
 * Strip pipe trick chars off a link target
 *
 * Example: 'Foo (bar)' -> 'Foo'
 *
 * Used by the LinkHandler and the WikitextSerializer.
 *
 * @param {string} target
 * @returns {string}
 */
Util.stripPipeTrickChars = function ( target ) {
	var res;
	// TODO: get this from somewhere else, hard-coding is fun but ultimately bad
	// Valid title characters
	var tc = '[%!\"$&\'\\(\\)*,\\-.\\/0-9:;=?@A-Z\\\\^_`a-z~\\x80-\\xFF+]';
	// Valid namespace characters
	var nc = '[ _0-9A-Za-z\x80-\xff-]';

	// [[ns:page (context)|]] -> page
	var p1 = new RegExp( '(:?' + nc + '+:|:|)(' + tc + '+?)( ?\\(' + tc + '+\\))' );
	// [[ns:page（context）|]] -> page (different form of parenthesis)
	var p2 = new RegExp( '(:?' + nc + '+:|:|)(' + tc + '+?)( ?（' + tc + '+）)' );
	// page, context -> page
	var p3 = new RegExp( '(, |，)' + tc + '+' );

	res = target.replace( p1, '$2' );
	res = res.replace( p2, '$2' );
	return res.replace( p3, '' );
};

/**
 * @method decodeEntity
 *
 * Decode HTML5 entities in text.
 *
 * @param {string} text
 * @returns {string}
 */
Util.decodeEntities = function ( text ) {
    return entities.decodeHTML5(text);
};


/**
 * @method escapeEntities
 *
 * Entity-escape anything that would decode to a valid HTML entity
 *
 * @param {string} text
 * @returns {string}
 */
Util.escapeEntities = function ( text ) {
	// [CSA] replace with entities.encode( text, 2 )?
	// but that would encode *all* ampersands, where we apparently just want
	// to encode ampersands that precede valid entities.
	return text.replace(/&[#0-9a-zA-Z]+;/g, function(match) {
		var decodedChar = Util.decodeEntities(match);
		if ( decodedChar !== match ) {
			// Escape the and
			return '&amp;' + match.substr(1);
		} else {
			// Not an entity, just return the string
			return match;
		}
	});
};

// From http://www.w3.org/TR/html5-diff/#obsolete-elements
// SSS FIXME: basefont is missing here, but looks like the PHP parser
// does not support it anyway and treats it as plain text.  So, skipping
// this one in Parsoid as well.
var html_old_names = Util.arrayToHash([
	"strike", "big", "center", "font", "tt"
]);

// The list of HTML5 tags, mainly used for the identification of *non*-html
// tags. Non-html tags terminate otherwise tag-eating productions (see list
// below) in order to support potential extension tags.
var html5_tag_names = Util.arrayToHash([
	"a", "abbr", "address", "area", "article",
	"aside", "audio", "b", "base", "bdi", "bdo", "blockquote",
	"body", "br", "button", "canvas", "caption", "cite", "code",
	"col", "colgroup", "command", "data", "datalist", "dd", "del",
	"details", "dfn", "div", "dl", "dt", "em", "embed", "fieldset",
	"figcaption", "figure", "footer", "form",
	"h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup",
	"hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "keygen",
	"label", "legend", "li", "link", "map", "mark", "menu", "meta",
	"meter", "nav", "noscript", "object", "ol", "optgroup", "option",
	"output", "p", "param", "pre", "progress", "q", "rp", "rt",
	"ruby", "s", "samp", "script", "section", "select", "small",
	// "source", Support the deprecated <source> alias for syntaxhighlight
	"span", "strong", "style", "sub", "summary", "sup",
	"table", "tbody", "td", "textarea", "tfoot", "th", "thead", "time",
	"title", "tr", "track", "u", "ul", "var", "video", "wbr"
]);

Util.isHTMLElementName = function (name) {
	name = name.toLowerCase();
	return html5_tag_names[name] === true ||
		html_old_names[name] === true;
};

if (typeof module === "object") {
	module.exports.Util = Util;
}
