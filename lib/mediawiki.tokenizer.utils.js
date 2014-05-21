/**
 * Utilities used in the tokenizer.
 */

"use strict";

var defines = require('./mediawiki.parser.defines.js');

var KV = defines.KV,
	TagTk = defines.TagTk,
	SelfclosingTagTk = defines.SelfclosingTagTk,
	EndTagTk = defines.EndTagTk;


var tu = {

	flattenIfArray: function(e) {
		function internal_flatten(e, res) {
			// Don't bother flattening if we dont have an array
			if ( !Array.isArray(e) ) {
				return e;
			}

			for (var i = 0; i < e.length; i++) {
				var v = e[i];
				if ( Array.isArray(v) ) {
					// Change in assumption from a shallow array to a nested array.
					if (res === null) { res = e.slice(0, i); }
					internal_flatten(v, res);
				} else if ( v !== null && v !== undefined ) {
					if (res !== null) {
						res.push(v);
					}
				} else {
					throw new Error("falsy " + e);
				}
			}

			if ( res ) {
				e = res;
			}
			return e;
		}
		return internal_flatten(e, null);
	},

	flatten_string: function ( c ) {
		var out = tu.flatten_stringlist( c );
		if ( out.length === 1 && out[0].constructor === String ) {
			return out[0];
		} else {
			return out;
		}
	},

	flatten_stringlist: function ( c ) {
		var out = [],
			text = '';
		// c will always be an array
		c = tu.flattenIfArray(c);
		for (var i = 0, l = c.length; i < l; i++) {
			var ci = c[i];
			if (ci.constructor === String) {
				if (ci !== '') {
					text += ci;
				}
			} else {
				if (text !== '') {
					out.push( text );
					text = '';
				}
				out.push(ci);
			}
		}
		if (text !== '' ) {
			out.push( text );
		}
		return out;
	},

	// Simple string formatting using '%s'
	sprintf: function ( format ) {
		var args = Array.prototype.slice.call(arguments, 1);
		return format.replace(/%s/g, function () {
			return args.length ? args.shift() : '';
		});
	},

	/**
	* Get an attribute value and source, given a start and end position.	Returned object will have a 'value' property
	* holding the value (first argument) and a 'valueSrc' property holding the raw value source
	*/
	get_attribute_value_and_source: function ( input, attrVal, attrValPosStart, attrValPosEnd ) {
		return {
			value: attrVal,
			valueSrc: input.substring(attrValPosStart, attrValPosEnd)
		};
	},

	buildTableTokens: function (tagName, wtChar, attrInfo, tsr, endPos, content) {
		var a, dp = {tsr: tsr};

		if (!attrInfo) {
			a = [];
		} else {
			a = attrInfo[0];
			if ( a.length === 0 ) {
				dp.startTagSrc = wtChar + attrInfo[1].join('');
			}
			if ((a.length === 0 && attrInfo[2]) || attrInfo[2] !== "|") {
				// Variation from default
				// 1. Separator present with an empty attribute block
				// 2. Not "|"
				dp.attrSepSrc = attrInfo[2];
			}
		}

		var tokens = [new TagTk( tagName, a, dp )].concat( content );

		// We rely on our tree builder to close the table cell (td/th) as needed.
		// We cannot close the cell here because cell content can come from
		// multiple parsing contexts and we cannot close the tag in the same
		// parsing context in which the td was opened:
		//   Ex: {{echo|{{!}}foo}}{{echo|bar}} has to output <td>foobar</td>
		//
		// But, add a marker meta-tag to capture tsr info.
		// SSS FIXME: Unsure if this is actually helpful, but adding it in just in case.
		// Can test later and strip it out if it doesn't make any diff to rting.
		tokens.push(
			new SelfclosingTagTk('meta', [
				new KV('typeof', 'mw:TSRMarker'),
				new KV('data-tag', tagName)
			], {
				tsr: [endPos, endPos]
			})
		);

		return tokens;
	},

	buildXMLTag: function (name, lcName, attribs, endTag, selfClose, tsr) {
		var tok, da = { tsr: tsr, stx: 'html' };

		if (name !== lcName) {
			da.srcTagName = name;
		}

		if ( endTag !== null) {
			tok = new EndTagTk( lcName, attribs, da );
		} else if ( selfClose !== null) {
			da.selfClose = true;
			tok = new SelfclosingTagTk( lcName, attribs, da );
		} else {
			tok = new TagTk( lcName, attribs, da	);
		}

		return tok;
	}

};


/*
 * Flags for specific parse environments (inside tables, links etc). Flags
 * trigger syntactic stops in the inline_breaks production, which
 * terminates inline and attribute matches. Flags merely reduce the number
 * of productions needed: The grammar is still context-free as the
 * productions can just be unrolled for all combinations of environments
 * at the cost of a much larger grammar.
 */

function SyntaxStops () {
	this.counters = {};
	this.stacks = {};
	this.key = '';
	this._counterKey = '';
	this._stackKey = '';
}

SyntaxStops.prototype.inc = function(flag) {
	if (this.counters[flag] !== undefined) {
		this.counters[flag]++;
	} else {
		this.counters[flag] = 1;
	}
	this._updateCounterKey();
	return true;
};

SyntaxStops.prototype.dec = function(flag) {
	if ( this.counters[flag] !== undefined ) {
		this.counters[flag]--;
	}
	this._updateCounterKey();
	return false;
};

SyntaxStops.prototype.onCount = function ( name ) {
	return this.counters[name];
};

/**
 * A stack for nested, but not cumulative syntactic stops.
 * Example: '=' is allowed in values of template arguments, even if those
 * are nested in attribute names.
 */
SyntaxStops.prototype.push = function ( name, value ) {
	if( this.stacks[name] === undefined ) {
		this.stacks[name] = [value];
	} else {
		this.stacks[name].push( value );
	}
	this._updateStackKey();
	return true;
};

SyntaxStops.prototype.pop = function ( name ) {
	if( this.stacks[name] !== undefined ) {
		this.stacks[name].pop();
	} else {
		throw "SyntaxStops.pop: unknown stop for " + name;
	}
	this._updateStackKey();
	return false;
};

SyntaxStops.prototype.onStack = function ( name ) {
	var stack = this.stacks[name];
	if ( stack === undefined || stack.length === 0 ) {
		return false;
	} else {
		return stack[stack.length - 1];
	}
};

SyntaxStops.prototype._updateKey = function ( ) {
	this._updateCounterKey();
	this._updateStackKey();
};

SyntaxStops.prototype._updateCounterKey = function ( ) {
	var counters = '';
	for ( var k in this.counters ) {
		if ( this.counters[k] > 0 ) {
			counters += 'c' + k;
		}
	}
	this._counterKey = counters;
	this.key = this._counterKey + this._stackKey;
};

SyntaxStops.prototype._updateStackKey = function ( ) {
	var stackStops = '';
	for ( var k in this.stacks ) {
		if ( this.onStack( k )  ) {
			stackStops += 's' + k;
		}
	}
	this._stackKey = stackStops;
	this.key = this._counterKey + this._stackKey;
};


if (typeof module === "object") {
	tu.SyntaxStops = SyntaxStops;
	module.exports = tu;
}
