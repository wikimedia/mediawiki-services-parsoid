"use strict";
require('./core-upgrade.js');

/**
 * @class ParserDefinesModule
 * @singleton
 */

var async = require('async'),
	Util, // Util module var for circular dependency avoidance
	requireUtil = function () {
		if (!Util) {
			Util = require('./mediawiki.Util.js').Util; // (circular dep)
		}
	}; // initialized later to avoid circular dependency

// To support isHTMLTag querying
String.prototype.isHTMLTag = function() {
	return false;
};

/**
 * @class
 *
 * Key-value pair.
 *
 * @constructor
 * @param {Mixed} k
 * @param {Mixed} v
 * @param {Array} srcOffsets The source offsets.
 */
function KV ( k, v, srcOffsets ) {
	this.k = k;
	this.v = v;
	if (srcOffsets) {
		this.srcOffsets = srcOffsets;
	}
}

/**
 * @class Token
 * @abstract
 *
 * Catch-all class for all token types.
 */

/**
 * @member Token
 *
 * Private helper for genericTokenMethods - store the orginal value of an attribute in a token's dataAttribs.
 *
 * @param {string} name
 * @param {Mixed} value
 * @param {Mixed} origValue
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

/*
 * Generic token attribute accessors
 *
 * TODO make this a real base class instead of some weird hackish object.
 */
var genericTokenMethods = {
	setShadowInfo: setShadowInfo,

	/**
	 * @member Token
	 *
	 * Generic set attribute method.
	 *
	 * @param {string} name
	 * @param {Mixed} value
	 */
	addAttribute: function ( name, value ) {
		this.attribs.push( new KV( name, value ) );
	},

	/**
	 * @member Token
	 *
	 * Generic set attribute method with support for change detection.
	 * Set a value and preserve the original wikitext that produced it.
	 *
	 * @param {string} name
	 * @param {Mixed} value
	 * @param {Mixed} origValue
	 */
	addNormalizedAttribute: function ( name, value, origValue ) {
		this.addAttribute( name, value );
		this.setShadowInfo( name, value, origValue );
	},

	/**
	 * @member Token
	 *
	 * Generic attribute accessor.
	 *
	 * @param {string} name
	 * @return {Mixed}
	 */
	getAttribute: function ( name ) {
		requireUtil();
		return Util.lookup( this.attribs, name );
	},

	/**
	 * @member Token
	 *
	 * Set an unshadowed attribute.
	 *
	 * @param {string} name
	 * @param {Mixed} value
	 */
	setAttribute: function ( name, value ) {
		requireUtil();
		// First look for the attribute and change the last match if found.
		for ( var i = this.attribs.length-1; i >= 0; i-- ) {
			var kv = this.attribs[i],
				k = kv.k;
			if ( k.constructor === String && k.toLowerCase() === name ) {
				kv.v = value;
				this.attribs[i] = kv;
				return;
			}
		}
		// Nothing found, just add the attribute
		this.addAttribute( name, value );
	},

	/**
	 * @member Token
	 *
	 * Attribute info accessor for the wikitext serializer. Performs change
	 * detection and uses unnormalized attribute values if set. Expects the
	 * context to be set to a token.
	 *
	 * @param {string} name
	 * @returns {Object} Information about the shadow info attached to this attribute.
	 * @returns {Mixed} return.value
	 * @returns {boolean} return.modified Whether the attribute was changed between parsing and now.
	 * @returns {boolean} return.fromsrc Whether we needed to get the source of the attribute to round-trip it.
	 */
	getAttributeShadowInfo: function ( name ) {
		requireUtil();
		var curVal = Util.lookup( this.attribs, name );

		// Not the case, continue regular round-trip information.
		if ( this.dataAttribs.a === undefined ) {
			return {
				value: curVal,
				// Mark as modified if a new element
				modified: Object.keys(this.dataAttribs).length === 0,
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
	 * @member Token
	 *
	 * Completely remove all attributes with this name.
	 *
	 * @param {string} name
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
	 * @member Token
	 *
	 * Set an attribute to a value, and shadow it if it was already set
	 *
	 * @param {string} name
	 * @param {Mixed} value
	 */
	setShadowedAttribute: function ( name, value ) {
		var out = [],
			found = false;
		for ( var i = this.attribs.length - 1; i >= 0; i-- ) {
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
	 * @member Token
	 *
	 * Add a space-separated property value
	 *
	 * @param {string} name
	 * @param {Mixed} value The value to add to the attribute.
	 */
	addSpaceSeparatedAttribute: function ( name, value ) {
		requireUtil();
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

	/**
	 * @member Token
	 *
	 * Determine whether the current token was an HTML tag in wikitext.
	 *
	 * @returns {boolean}
	 */
	isHTMLTag: function () {
		return this.dataAttribs.stx === 'html';
	},

	/**
	 * @member Token
	 *
	 * Clone a token.
	 *
	 * @param {boolean} cloneAttribs Whether to clone attributes too.
	 * @returns {Token}
	 */
	clone: function ( cloneAttribs ) {
		requireUtil();
		if (cloneAttribs === undefined) {
			cloneAttribs = true;
		}

		// create a new object with the same prototype as this, then copy
		// our own-properties into the new object.
		var myClone =
			Object.assign(Object.create(Object.getPrototypeOf(this)), this);
		if (cloneAttribs) {
			myClone.attribs = [];
			for (var i = 0, n = this.attribs.length; i < n; i++) {
				myClone.attribs.push(Util.clone(this.attribs[i]));
			}
			myClone.dataAttribs = Util.clone(this.dataAttribs);
		}
		return myClone;
	},

	/**
	 * @member Token
	 *
	 * Get the wikitext source of a token.
	 *
	 * @param {MWParserEnvironment} env
	 * @returns {string}
	 */
	getWTSource: function(env) {
		var tsr = this.dataAttribs.tsr;
		return tsr ? env.page.src.substring(tsr[0], tsr[1]) : null;
	}
};

/**
 * @class
 * @extends Token
 *
 * HTML tag token.
 *
 * @constructor
 * @param {string} name
 * @param {KV[]} attribs
 * @param {Object} dataAttribs Data-parsoid object.
 */
function TagTk( name, attribs, dataAttribs ) {
	this.name = name;
	this.attribs = attribs || [];
	this.dataAttribs = dataAttribs || {};
}

TagTk.prototype = {};

TagTk.prototype.constructor = TagTk;

/**
 * @method
 * @returns {string}
 */
TagTk.prototype.toJSON = function () {
	return Object.assign( { type: 'TagTk' }, this );
};

/**
 * @method
 * @returns {string}
 */
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

/**
 * @method
 * @param {boolean} compact Whether to return the full HTML, or just the tag name.
 * @returns {string}
 */
TagTk.prototype.toString = function(compact) {
	requireUtil();
	if (this.isHTMLTag()) {
		if (compact) {
			return "<HTML:" + this.name + ">";
		} else {
			var buf = '';
			for (var i = 0, n = this.attribs.length; i < n; i++) {
				var a = this.attribs[i];
				buf += (Util.toStringTokens(a.k).join('') + "=" + Util.toStringTokens(a.v).join(''));
			}
			return "<HTML:" + this.name + " " + buf + ">";
		}
	} else {
		var f = TagTk.prototype.tagToStringFns[this.name];
		return f ? f.bind(this)() : this.defaultToString();
	}
};

// add in generic token methods
Object.assign( TagTk.prototype, genericTokenMethods );

/**
 * @class
 * @extends Token
 *
 * HTML end tag token.
 *
 * @constructor
 * @param {string} name
 * @param {KV[]} attribs
 * @param {Object} dataAttribs
 */
function EndTagTk( name, attribs, dataAttribs ) {
	this.name = name;
	this.attribs = attribs || [];
	this.dataAttribs = dataAttribs || {};
}

EndTagTk.prototype = {};

EndTagTk.prototype.constructor = EndTagTk;

/**
 * @method
 * @returns {string}
 */
EndTagTk.prototype.toJSON = function () {
	return Object.assign( { type: 'EndTagTk' }, this );
};

/**
 * @method
 * @returns {string}
 */
EndTagTk.prototype.toString = function() {
	if (this.isHTMLTag()) {
		return "</HTML:" + this.name + ">";
	} else {
		return "</" + this.name + ">";
	}
};

// add in generic token methods
Object.assign( EndTagTk.prototype, genericTokenMethods );

/**
 * @class
 *
 * HTML tag token for a self-closing tag (like a br or hr).
 *
 * @extends Token
 * @constructor
 * @param {string} name
 * @param {KV[]} attribs
 * @param {Object} dataAttribs
 */
function SelfclosingTagTk( name, attribs, dataAttribs ) {
	this.name = name;
	this.attribs = attribs || [];
	this.dataAttribs = dataAttribs || {};
}

SelfclosingTagTk.prototype = {};

SelfclosingTagTk.prototype.constructor = SelfclosingTagTk;

/**
 * @method
 * @returns {string}
 */
SelfclosingTagTk.prototype.toJSON = function () {
	return Object.assign( { type: 'SelfclosingTagTk' }, this );
};

/**
 * @method multiTokenArgToString
 * @param {string} key
 * @param {Object} arg
 * @param {string} indent The string by which we should indent each new line.
 * @param {string} indentIncrement The string we should add to each level of indentation.
 * @returns {Object}
 * @returns {boolean} return.present Whether there is any non-empty string representation of these tokens.
 * @returns {string} return.str
 */
SelfclosingTagTk.prototype.multiTokenArgToString = function(key, arg, indent, indentIncrement) {
	requireUtil();
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
};

/**
 * @method attrsToSTring
 *
 * Get a string representation of the tag's attributes.
 *
 * @param {string} indent The string by which to indent every line.
 * @param {string} indentIncrement The string to add to every successive level of indentation.
 * @param {number} startAttrIndex Where to start converting attributes.
 * @returns {string}
 */
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


/**
 * @method
 * @param {boolean} compact Whether to return the full HTML, or just the tag name.
 * @param {string} indent The string by which to indent each line.
 * @returns {string}
 */
SelfclosingTagTk.prototype.defaultToString = function(compact, indent) {
	requireUtil();
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
		requireUtil();
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
		requireUtil();
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

/**
 * @method
 * @param {boolean} compact Whether to return the full HTML, or just the tag name.
 * @param {string} indent The string by which to indent each line.
 * @returns {string}
 */
SelfclosingTagTk.prototype.toString = function(compact, indent) {
	if (this.isHTMLTag()) {
		return "<HTML:" + this.name + " />";
	} else {
		var f = SelfclosingTagTk.prototype.tagToStringFns[this.name];
		return f ? f.bind(this)(compact, indent) : this.defaultToString(compact, indent);
	}
};

// add in generic token methods
Object.assign( SelfclosingTagTk.prototype, genericTokenMethods );

/**
 * @class
 *
 * Newline token.
 *
 * @extends Token
 * @constructor
 * @param {Array} The TSR of the newline(s).
 */
function NlTk( tsr ) {
	if (tsr) {
		this.dataAttribs = { tsr: tsr };
	}
}

NlTk.prototype = {
	constructor: NlTk,

	/**
	 * @method
	 *
	 * Convert the token to JSON.
	 *
	 * @returns {string} JSON string.
	 */
	toJSON: function () {
		return Object.assign( { type: 'NlTk' }, this );
	},

	/**
	 * @method
	 *
	 * Convert the token to a simple string.
	 *
	 * @returns {"\\n"}
	 */
	toString: function() {
		return "\\n";
	},

	/**
	 * @method
	 *
	 * Tell the caller that this isn't an HTML tag.
	 *
	 * @returns {boolean} Always false
	 */
	isHTMLTag: function() {
		return false;
	}
};

/**
 * @class
 * @extends Token
 * @constructor
 * @param {string} value
 * @param {Object} dataAttribs data-parsoid object.
 */
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
		return Object.assign( { type: 'COMMENT' }, this );
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
		return Object.assign( { type: 'EOFTk' }, this );
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
function Params ( params ) {
	for (var i = 0; i < params.length; i++) {
		this.push( params[i] );
	}
	this.argDict = null;
	this.namedArgsDict = null;
}

Params.prototype = [];

Params.prototype.constructor = Params;

Params.prototype.toString = function () {
	return this.slice(0).toString();
};

Params.prototype.dict = function () {
	requireUtil();
	if (this.argDict === null) {
		var res = {};
		for ( var i = 0, l = this.length; i < l; i++ ) {
			var kv = this[i],
				key = Util.tokensToString( kv.k ).trim();
			res[key] = kv.v;
		}
		this.argDict = res;
	}

	return this.argDict;
};

Params.prototype.named = function () {
	requireUtil();
	if (this.namedArgsDict === null) {
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
		this.namedArgsDict = { namedArgs: namedArgs, dict: out };
	}

	return this.namedArgsDict;
};

/**
 * Expand a slice of the parameters using the supplied get options.
 */
Params.prototype.getSlice = function ( options, start, end ) {
	requireUtil();
	var args = this.slice( start, end ),
		cb = options.cb;
	//console.warn( JSON.stringify( args ) );
	async.map(
			args,
			function( kv, cb2 ) {
				if ( kv.v.constructor === String ) {
					// nothing to do
					cb2( null, kv );
				} else if ( Array.isArray(kv.v) &&
					// remove String from Array
					kv.v.length === 1 && kv.v[0].constructor === String ) {
						cb2( null, new KV( kv.k, kv.v[0], kv.srcOffsets ) );
				} else {
					// Expand the value
					var o2 = Object.assign( {}, options );
					// Since cb2 can only be called once after we have all results,
					// and kv.v.get can generate a stream of async calls, we have
					// to accumulate the results of the async calls and call cb2 in the end.
					o2.cb = Util.buildAsyncOutputBufferCB(function (toks) {
						cb2(null, new KV(kv.k, Util.tokensToString(toks), kv.srcOffsets));
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

ParserValue.prototype.constructor = ParserValue;

ParserValue.prototype._defaultTransformOptions = {
	type: 'text/x-mediawiki/expanded'
};

ParserValue.prototype.toJSON = function() {
	return this.source;
};

ParserValue.prototype.get = function( options, cb ) {
	if ( ! options ) {
		options = Object.assign({}, this._defaultTransformOptions);
	} else if ( options.type === undefined ) {
		options.type = this._defaultTransformOptions.type;
	}

	// convenience cb override for async-style functions that pass a cb as the
	// last argument
	if ( cb === undefined ) {
		cb = options.cb;
	}

	var source = this.source;
	if ( source.constructor === String ) {
		if ( cb ) {
			cb ( source );
		} else {
			return source;
		}
	} else {
		if ( ! options.cb ) {
			console.trace();
			throw "Chunk.get: Need to expand asynchronously, but no cb provided! " +
				JSON.stringify( this, null, 2 );
		}
		options.cb = cb;
		options.wrapTemplates = options.wrapTemplates || this.wrapTemplates;
		this.frame.expand( source, options );
	}
};

if (typeof module === "object") {
	module.exports = {
		TagTk: TagTk,
		EndTagTk: EndTagTk,
		SelfclosingTagTk: SelfclosingTagTk,
		NlTk: NlTk,
		CommentTk: CommentTk,
		EOFTk: EOFTk,
		KV: KV,
		Params: Params,
		ParserValue: ParserValue
	};
}
