/**
 * General utilities for token transforms
 */

var Util = {
	/**
	 * Determine if a tag name is block-level or not
	 *
	 * @static
	 * @method
	 * @param {String} name: Lower-case tag name
	 * @returns {Boolean}: True if tag is block-level, false otherwise.
	 */
	isBlockTag: function ( name ) {
		switch ( name ) {
			case 'div':
			case 'table':
			case 'td':
			case 'tr':
			case 'tbody':
			case 'p':
			case 'ul':
			case 'ol':
			case 'li':
			case 'dl':
			case 'dt':
			case 'dd':
			//case 'img': // hmm!
			case 'pre':
			case 'center':
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
			case 'nav':
			case 'section':
			case 'header':
			case 'footer':
			case 'header':
			case 'figure':
			case 'figcaption':
			case 'fieldset':
			case 'details':
			case 'blockquote':
				return true;
			default:
				return false;
		}
	},

	// See http://www.whatwg.org/specs/web-apps/current-work/#void-elements
	voidElements: { area: 1, base: 1, br: 1, col: 1, command: 1, embed: 1, hr: 1, img: 1,
		input: 1, keygen: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 },

	/*
	 * Determine if the tag is an empty HTML tag
	 */
	isVoidElement: function ( name ) {
		return this.voidElements[name] || false;
	},

	/**
	 * Determine if a token is block-level or not
	 *
	 * @static
	 * @method
	 * @param {Object} token: The token to check
	 * @returns {Boolean}: True if token is block-level, false otherwise.
	 */
	isBlockToken: function ( token ) {
		if ( token.constructor === TagTk ||
				token.constructor === EndTagTk ||
				token.constructor === SelfclosingTagTk ) {
			return Util.isBlockTag( token.name.toLowerCase() );
		} else {
			return false;
		}
	},

	toStringTokens: function(tokens, indent) {
		if (!indent) indent = "";
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
			} else if ( token.constructor === String ) {
				out.push( token );
			} else if ( token.constructor === CommentTk || token.constructor === NlTk ) {
				// strip comments and newlines
			} else if ( strict ) {
				// If strict, return accumulated string on encountering first non-text token
				return [out.join(''), tokens.slice( i )];
			}
		}
		return out.join('');
	},

	// deep clones by default.
	clone: function(obj, deepClone) {
		if (deepClone === undefined) {
			deepClone = true;
		}
		return $.extend(deepClone, {}, obj);
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
			if (!res.switchToAsync) {
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
						[].push.apply(this.accum, toks);
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
		var l = tokens.length,
			i, token;
		// strip leading space
		for ( i = 0; i < l; i++ ) {
			token = tokens[i];
			if ( token.constructor === String ) {
				token = token.replace( /^\s+/, '' );
				tokens[i] = token;
				if ( token !== '' ) {
					break;
				}
			} else {
				break;
			}
		}
		// strip trailing space
		for ( i = l - 1; i >= 0; i-- ) {
			token = tokens[i];
			if ( token.constructor === String ) {
				token = token.replace( /\s+$/, '' );
				tokens[i] = token;
				if ( token !== '' ) {
					break;
				}
			} else {
				break;
			}
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
		if ( l.constructor === EOFTk || l.constructor === NlTk ||
				( l.constructor === String && l.match( /^\s+$/ ) ) ) {
			var origTokens = tokens;
			tokens = origTokens.slice();
			tokens.rank = origTokens.rank;
			while ( tokens.length &&
					((	l.constructor === EOFTk  || l.constructor === NlTk )  ||
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
		return s.replace( /%[0-9a-f][0-9a-f]/g, function( m ) {
			try {
				// JS library function
				return decodeURI( m );
			} catch ( e ) {
				return m;
			}
		} );
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
		host = host.replace( /%(?![0-9a-fA-F][0-9a-fA-F])|[#|]/g, function ( m ) {
			return encodeURIComponent( m );
		} );
		path = path.replace( /%(?![0-9a-fA-F][0-9a-fA-F])|[ \[\]#|]/g, function ( m ) {
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
		if ( sLen && text.substr( text.length - sLen, sLen ) === suffix )
		{
			return text.substr( 0, text.length - sLen );
		} else {
			return text;
		}
	},

	arrayToHash: function(a) {
		var h = {};
		for (var i = 0, n = a.length; i < n; i++) {
			h[a[i]] = 1;
		}
		return h;
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
	}
};

if (typeof module === "object") {
	module.exports.Util = Util;
}
