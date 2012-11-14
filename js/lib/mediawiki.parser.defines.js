"use strict";

/**
 * Constructors for different token types. Plain text is represented as simple
 * strings or String objects (if attributes are needed).
 */

var async = require('async'),
	Util = require('./mediawiki.Util.js').Util,
	$ = require( 'jquery' );

// To support isHTMLTag querying
String.prototype.isHTMLTag = function() {
	return false;
};

/* -------------------- KV -------------------- */
// A key-value pair
function KV ( k, v ) {
	this.k = k;
	this.v = v;
}

/* -------------------- TagTk -------------------- */
function TagTk( name, attribs, dataAttribs ) {
	this.name = name;
	this.attribs = attribs || [];
	this.dataAttribs = dataAttribs || {};
}

/**
 * Private helper for genericTokenMethods
 */
var setShadowInfo = function ( name, value, origValue ) {
	// Don't shadow if value is the same or the orig is null
	if ( value !== origValue && origValue !== null ) {
		if ( ! this.dataAttribs.a ) {
			this.dataAttribs.a = {};
		}
		this.dataAttribs.a[name] = value;
		if ( origValue !== undefined ) {
			if ( ! this.dataAttribs.sa ) {
				this.dataAttribs.sa = {};
			}
			this.dataAttribs.sa[name] = origValue;
		}
	}
};

/**
 * Generic token attribute accessors
 */
var genericTokenMethods = {
	setShadowInfo: setShadowInfo,

	/**
	 * Generic set attribute method. Expects the context to be set to a token.
	 */
	addAttribute: function ( name, value ) {
		this.attribs.push( new KV( name, value ) );
	},

	/**
	 * Generic set attribute method with support for change detection. Expects the
	 * context to be set to a token.
	 */
	addNormalizedAttribute: function ( name, value, origValue ) {
		this.addAttribute( name, value );
		this.setShadowInfo( name, value, origValue );
	},

	/**
	 * Generic attribute accessor. Expects the context to be set to a token.
	 */
	getAttribute: function ( name ) {
		return Util.lookup( this.attribs, name );
	},

	/**
	 * Set an unshadowed attribute.
	 */
	setAttribute: function ( name, value ) {
		// First look for the attribute and change the last match if found.
		for ( var i = this.attribs.length-1; i >= 0; i-- ) {
			var k = this.attribs[i].k;
			if ( k.constructor === String && k.toLowerCase() === name ) {
				this.attribs[i] = new KV( k, value );
				return;
			}
		}
		// Nothing found, just add the attribute
		this.addAttribute( name, value );
	},

	/**
	 * Attribute info accessor for the wikitext serializer. Performs change
	 * detection and uses unnormalized attribute values if set. Expects the
	 * context to be set to a token.
	 */
	getAttributeShadowInfo: function ( name ) {
		var curVal = Util.lookup( this.attribs, name );
		if ( this.dataAttribs.a === undefined ) {
			return {
				value: curVal,
				modified: false,
				fromsrc: false
			};
		} else if ( this.dataAttribs.a[name] !== curVal ||
				this.dataAttribs.sa[name] === undefined ) {
			return {
				value: curVal,
				modified: true,
				fromsrc: false
			};
		} else {
			return {
				value: this.dataAttribs.sa[name],
				modified: false,
				fromsrc: true
			};
		}
	},

	/**
	 * Completely remove all attributes with this name.
	 */
	removeAttribute: function ( name ) {
		var out = [],
			attribs = this.attribs;
		for ( var i = 0, l = attribs.length; i < l; i++ ) {
			var kv = attribs[i];
			if ( kv.k.toLowerCase() !== name ) {
				out.push( kv );
			}
		}
		this.attribs = out;
	},

	/**
	 * Set an attribute to a value, and shadow it if it was already set
	 */
	setShadowedAttribute: function ( name, value ) {
		var out = [],
			found = false;
		for ( var i = this.attribs.length; i >= 0; i-- ) {
			var kv = this.attribs[i];
			if ( kv.k.toLowerCase() !== name ) {
				out.push( kv );
			} else if ( ! found ) {
				if ( ! this.dataAttribs.a ||
						this.dataAttribs.a[name] === undefined )
				{
					this.setShadowInfo( name, value, kv.v );
				}

				kv.v = value;
				found = true;
			}
			// else strip it..
		}
		out.reverse();
		if ( ! found ) {
			out.push( new KV( name, value ) );
		}
		this.attribs = out;
	},

	/**
	 * Add a space-separated property value
	 */
	addSpaceSeparatedAttribute: function ( name, value ) {
		var curVal = Util.lookupKV( this.attribs, name ),
			vals;
		if ( curVal !== null ) {
			vals = curVal.v.split(/\s+/);
			for ( var i = 0, l = vals.length; i < l; i++ ) {
				if ( vals[i] === value ) {
					// value is already included, nothing to do.
					return;
				}
			}
			// Value was not yet included in the existing attribute, just add
			// it separated with a space
			this.setAttribute( curVal.k, curVal.v + ' ' + value );
		} else {
			// the attribute did not exist at all, just add it
			this.addAttribute( name, value );
		}
	},

	isHTMLTag: function() {
		return this.dataAttribs.stx === 'html';
	},

	clone: function(cloneAttribs) {
		if (cloneAttribs === undefined) {
			cloneAttribs = true;
		}

		var myClone = $.extend({}, this);
		if (cloneAttribs) {
			myClone.attribs = [];
			for (var i = 0, n = this.attribs.length; i < n; i++) {
				myClone.attribs.push(Util.clone(this.attribs[i]));
			}
			myClone.dataAttribs = Util.clone(this.dataAttribs);
		}
		return myClone;
	},

	getWTSource: function(env) {
		var tsr = this.dataAttribs.tsr;
		return tsr ? env.text.substring(tsr[0], tsr[1]) : null;
	}
};

TagTk.prototype = {};

TagTk.prototype.constructor = TagTk;

TagTk.prototype.toJSON = function () {
	return $.extend( { type: 'TagTk' }, this );
};

TagTk.prototype.defaultToString = function(t) {
	return "<" + this.name + ">";
};

var tagToStringFns = {
	"listItem": function() {
		return "<li:" + this.bullets.join('') + ">";
	},
	"mw-quote": function() {
		return "<mw-quote:" + this.value + ">";
	},
	"urllink": function() {
		return "<urllink:" + this.attribs[0].v + ">";
	},
	"behavior-switch": function() {
		return "<behavior-switch:" + this.attribs[0].v + ">";
	}
};

// Hide tagToStringFns when serializing tokens to JSON
Object.defineProperty( TagTk.prototype, 'tagToStringFns',
		{
			enumerable: false,
			value: tagToStringFns
		} );

TagTk.prototype.toString = function(compact) {
	if (this.isHTMLTag()) {
		if (compact) {
			return "<HTML:" + this.name + ">";
		} else {
			var buf = [];
			for (var i = 0, n = this.attribs.length; i < n; i++) {
				var a = this.attribs[i];
				buf.push(Util.toStringTokens(a.k).join('') + "=" + Util.toStringTokens(a.v).join(''));
			}
			return "<HTML:" + this.name + " " + buf.join(' ') + ">";
		}
	} else {
		var f = TagTk.prototype.tagToStringFns[this.name];
		return f ? f.bind(this)() : this.defaultToString();
	}
};

// add in generic token methods
$.extend( TagTk.prototype, genericTokenMethods );

/* -------------------- EndTagTk -------------------- */
function EndTagTk( name, attribs, dataAttribs ) {
	this.name = name;
	this.attribs = attribs || [];
	this.dataAttribs = dataAttribs || {};
}

EndTagTk.prototype = {};

EndTagTk.prototype.constructor = EndTagTk;

EndTagTk.prototype.toJSON = function () {
	return $.extend( { type: 'EndTagTk' }, this );
};

EndTagTk.prototype.toString = function() {
	if (this.isHTMLTag()) {
		return "</HTML:" + this.name + ">";
	} else {
		return "</" + this.name + ">";
	}
};
// add in generic token methods
$.extend( EndTagTk.prototype, genericTokenMethods );

/* -------------------- SelfclosingTagTk -------------------- */
function SelfclosingTagTk( name, attribs, dataAttribs ) {
	this.name = name;
	this.attribs = attribs || [];
	this.dataAttribs = dataAttribs || {};
}

SelfclosingTagTk.prototype = {};

SelfclosingTagTk.prototype.constructor = SelfclosingTagTk;

SelfclosingTagTk.prototype.toJSON = function () {
	return $.extend( { type: 'SelfclosingTagTk' }, this );
};

SelfclosingTagTk.prototype.multiTokenArgToString = function(key, arg, indent, indentIncrement) {
	var newIndent = indent + indentIncrement;
	var present = true;
	var toks    = Util.toStringTokens(arg, newIndent);
	var str     = toks.join("\n" + newIndent);

	if (toks.length > 1 || str[0] === '<') {
		str = [key, ":{\n", newIndent, str, "\n", indent, "}"].join('');
	} else {
		present = (str !== '');
	}

	return {present: present, str: str};
},

SelfclosingTagTk.prototype.attrsToString = function(indent, indentIncrement, startAttrIndex) {
	var buf = [];
	for (var i = startAttrIndex, n = this.attribs.length; i < n; i++) {
		var a = this.attribs[i];
		var kVal = this.multiTokenArgToString("k", a.k, indent, indentIncrement);
		var vVal = this.multiTokenArgToString("v", a.v, indent, indentIncrement);

		if (kVal.present && vVal.present) {
			buf.push([kVal.str, "=", vVal.str].join(''));
		} else {
			if (kVal.present) {
				buf.push(kVal.str);
			}
			if (vVal.present) {
				buf.push(vVal.str);
			}
		}
	}

	return buf.join("\n" + indent + "|");
};

SelfclosingTagTk.prototype.defaultToString = function(compact, indent) {
	if (compact) {
		var buf = "<" + this.name + ">:";
		var attr0 = this.attribs[0];
		return attr0 ? buf + Util.toStringTokens(attr0.k, "\n") : buf;
	} else {
		if (!indent) {
			indent = "";
		}
		var origIndent = indent;
		var indentIncrement = "  ";
		indent = indent + indentIncrement;
		return ["<", this.name, ">(\n", indent, this.attrsToString(indent, indentIncrement, 0), "\n", origIndent, ")"].join('');
	}
};

tagToStringFns = {
	"extlink": function(compact, indent) {
		var indentIncrement = "  ";
		var href = Util.toStringTokens(Util.lookup(this.attribs, 'href'), indent + indentIncrement);
		if (compact) {
			return ["<extlink:", href, ">"].join('');
		} else {
			if (!indent) {
				indent = "";
			}
			var origIndent = indent;
			indent = indent + indentIncrement;
			var content = Util.lookup(this.attribs, 'mw:content');
			content = this.multiTokenArgToString("v", content, indent, indentIncrement).str;
			return ["<extlink>(\n", indent,
					"href=", href, "\n", indent,
					"content=", content, "\n", origIndent,
					")"].join('');
		}
	},

	"wikilink": function(compact, indent) {
		if (!indent) {
			indent = "";
		}
		var indentIncrement = "  ";
		var href = Util.toStringTokens(Util.lookup(this.attribs, 'href'), indent + indentIncrement);
		if (compact) {
			return ["<wikilink:", href, ">"].join('');
		} else {
			if (!indent) {
				indent = "";
			}
			var origIndent = indent;
			indent = indent + indentIncrement;
			var tail = Util.lookup(this.attribs, 'tail');
			var content = this.attrsToString(indent, indentIncrement, 2);
			return ["<wikilink>(\n", indent,
					"href=", href, "\n", indent,
					"tail=", tail, "\n", indent,
					"content=", content, "\n", origIndent,
					")"].join('');
		}
	}
};

// Hide tagToStringFns when serializing tokens to JSON
Object.defineProperty( SelfclosingTagTk.prototype, 'tagToStringFns',
		{
			enumerable: false,
			value: tagToStringFns
		} );

SelfclosingTagTk.prototype.toString = function(compact, indent) {
	if (this.isHTMLTag()) {
		return "<HTML:" + this.name + " />";
	} else {
		var f = SelfclosingTagTk.prototype.tagToStringFns[this.name];
		return f ? f.bind(this)(compact, indent) : this.defaultToString(compact, indent);
	}
};
// add in generic token methods
$.extend( SelfclosingTagTk.prototype, genericTokenMethods );

/* -------------------- NlTk -------------------- */
function NlTk( ) { }

NlTk.prototype = {
	constructor: NlTk,

	toJSON: function () {
		return $.extend( { type: 'NlTk' }, this );
	},

	toString: function() {
		return "\\n";
	},

	isHTMLTag: function() {
		return false;
	}
};

/* -------------------- CommentTk -------------------- */
function CommentTk( value, dataAttribs ) {
	this.value = value;
	// won't survive in the DOM, but still useful for token serialization
	if ( dataAttribs !== undefined ) {
		this.dataAttribs = dataAttribs;
	}
}

CommentTk.prototype = {
	constructor: CommentTk,

	toJSON: function () {
		return $.extend( { type: 'COMMENT' }, this );
	},

	toString: function() {
		return "<!--" + this.value + "-->";
	},

	isHTMLTag: function() {
		return false;
	}
};

/* -------------------- EOFTk -------------------- */
function EOFTk( ) { }
EOFTk.prototype = {
	constructor: EOFTk,

	toJSON: function () {
		return $.extend( { type: 'EOFTk' }, this );
	},

	toString: function() {
		return "";
	},

	isHTMLTag: function() {
		return false;
	}
};




/* -------------------- Params -------------------- */
/**
 * A parameter object wrapper, essentially an array of key/value pairs with a
 * few extra methods.
 *
 * It might make sense to wrap array results of array methods such as slice
 * into a params object too, so that users are not surprised by losing the
 * custom methods. Alternatively, the object could be made more abstract with
 * a separate .array method that just returns the plain array.
 */
function Params ( env, params ) {
	this.env = env;
	for (var i = 0; i < params.length; i++) {
		this.push( params[i] );
	}
}

Params.prototype = [];

Params.prototype.constructor = Params;

Params.prototype.toString = function () {
	return this.slice(0).toString();
};

Params.prototype.dict = function () {
	var res = {};
	for ( var i = 0, l = this.length; i < l; i++ ) {
		var kv = this[i],
			key = Util.tokensToString( kv.k ).trim();
		res[key] = kv.v;
	}
	return res;
};

Params.prototype.named = function () {
	var n = 1,
		out = {},
		namedArgs = {};

	for ( var i = 0, l = this.length; i < l; i++ ) {
		// FIXME: Also check for whitespace-only named args!
		var k = this[i].k;
		var v = this[i].v;
		if ( k.constructor === String ) {
			k = k.trim();
		}
		if ( ! k.length ) {
			out[n.toString()] = v;
			n++;
		} else if ( k.constructor === String ) {
			namedArgs[k] = true;
			out[k] = v;
		} else {
			k = Util.tokensToString( k ).trim();
			namedArgs[k] = true;
			out[k] = v;
		}
	}
	return { namedArgs: namedArgs, dict: out };
};

/**
 * Expand a slice of the parameters using the supplied get options.
 */
Params.prototype.getSlice = function ( options, start, end ) {
	var args = this.slice( start, end ),
		cb = options.cb;
	//console.warn( JSON.stringify( args ) );
	async.map(
			args,
			function( kv, cb2 ) {
				if ( kv.v.constructor === String ) {
					// nothing to do
					cb2( null, kv );
				} else if ( kv.v.constructor === Array &&
					// remove String from Array
					kv.v.length === 1 && kv.v[0].constructor === String ) {
						cb2( null, new KV( kv.k, kv.v[0] ) );
				} else {
					// Expand the value
					var o2 = $.extend( {}, options );
					// Since cb2 can only be called once after we have all results,
					// and kv.v.get can generate a stream of async calls, we have
					// to accumulate the results of the async calls and call cb2 in the end.
					o2.cb = Util.buildAsyncOutputBufferCB(function (toks) {
						cb2(null, new KV(kv.k, Util.tokensToString(toks)));
					});
					kv.v.get( o2 );
				}
			},
			function( err, res ) {
				if ( err ) {
					console.trace();
					throw JSON.stringify( err );
				}
				//console.warn( 'getSlice res: ' + JSON.stringify( res ) );
				cb( res );
			});
};

/* -------------------- ParserValue -------------------- */
/**
 * A chunk. Wraps a source chunk of tokens with a reference to a frame for
 * lazy and shared transformations. Do not use directly- use
 * frame.newParserValue instead!
 */
function ParserValue ( source, options ) {
	if ( source.constructor === ParserValue ) {
		Object.defineProperty( this, 'source',
				{ value: source.source, enumerable: false } );
	} else {
		Object.defineProperty( this, 'source',
				{ value: source, enumerable: false } );
	}
	Object.defineProperty( this, 'frame',
			{ value: options.frame, enumerable: false } );
	Object.defineProperty( this, 'wrapTemplates',
			{ value: options.wrapTemplates, enumerable: false } );
}

ParserValue.prototype = {};

ParserValue.prototype._defaultTransformOptions = {
	type: 'text/x-mediawiki/expanded'
};

ParserValue.prototype.toJSON = function() {
	return this.source;
};

ParserValue.prototype.get = function( options, cb ) {
	if ( ! options ) {
		options = $.extend({}, this._defaultTransformOptions);
	} else if ( options.type === undefined ) {
		options.type = this._defaultTransformOptions.type;
	}

	// convenience cb override for async-style functions that pass a cb as the
	// last argument
	if ( cb === undefined ) {
		cb = options.cb;
	}

	var maybeCached;
	var source = this.source;
	if ( source.constructor === String ) {
		maybeCached = source;
	} else {
		// try the cache
		maybeCached = source.cache && source.cache.get( this.frame, options );
	}
	if ( maybeCached !== undefined ) {
		if ( cb ) {
			cb ( maybeCached );
		} else {
			return maybeCached;
		}
	} else {
		if ( ! options.cb ) {
			console.trace();
			throw "Chunk.get: Need to expand asynchronously, but no cb provided! " +
				JSON.stringify( this, null, 2 );
		}
		options.cb = cb;
		options.wrapTemplates = this.wrapTemplates;
		this.frame.expand( source, options );
	}
};

ParserValue.prototype.length = function () {
	return this.source.length;
};


// TODO: don't use globals!
if (typeof module === "object") {
	module.exports = {};
	global.TagTk = TagTk;
	global.EndTagTk = EndTagTk;
	global.SelfclosingTagTk = SelfclosingTagTk;
	global.NlTk = NlTk;
	global.CommentTk = CommentTk;
	global.EOFTk = EOFTk;
	global.KV = KV;
	global.Params = Params;
	global.ParserValue = ParserValue;
}
