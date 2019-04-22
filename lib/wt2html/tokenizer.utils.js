/**
 * Utilities used in the tokenizer.
 * @module wt2html/tokenizer_utils
 */

'use strict';

const { DOMDataUtils } = require('../utils/DOMDataUtils.js');
const { KV, TagTk, EndTagTk, SelfclosingTagTk, CommentTk } = require('../tokens/TokenTypes.js');

var tu = module.exports = {

	flattenIfArray: function(a) {
		function internalFlatten(e, res) {
			// Don't bother flattening if we dont have an array
			if (!Array.isArray(e)) {
				return e;
			}

			for (var i = 0; i < e.length; i++) {
				var v = e[i];
				if (Array.isArray(v)) {
					// Change in assumption from a shallow array to a nested array.
					if (res === null) { res = e.slice(0, i); }
					internalFlatten(v, res);
				} else if (v !== null && v !== undefined) {
					if (res !== null) {
						res.push(v);
					}
				} else {
					throw new Error("falsy " + e);
				}
			}

			if (res) {
				e = res;
			}
			return e;
		}
		return internalFlatten(a, null);
	},

	flattenString: function(c) {
		var out = tu.flattenStringlist(c);
		if (out.length === 1 && out[0].constructor === String) {
			return out[0];
		} else {
			return out;
		}
	},

	flattenStringlist: function(c) {
		var out = [];
		var text = '';
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
					out.push(text);
					text = '';
				}
				out.push(ci);
			}
		}
		if (text !== '') {
			out.push(text);
		}
		return out;
	},

	/** Simple string formatting using `%s`. */
	sprintf: function(format) {
		var args = Array.prototype.slice.call(arguments, 1);
		return format.replace(/%s/g, function() {
			return args.length ? args.shift() : '';
		});
	},

	getAttrVal: function(value, start, end) {
		return { value: value, srcOffsets: [start, end] };
	},

	buildTableTokens: function(tagName, wtChar, attrInfo, tsr, endPos, content, addEndTag) {
		var a;
		var dp = { tsr: tsr };

		if (!attrInfo) {
			a = [];
			if (tagName === 'td' || tagName === 'th') {
				// Add a flag that indicates that the tokenizer didn't
				// encounter a "|...|" attribute box. This is useful when
				// deciding which <td>/<th> cells need attribute fixups.
				dp.tmp = { noAttrs: true };
			}
		} else {
			a = attrInfo[0];
			if (a.length === 0) {
				dp.startTagSrc = wtChar + attrInfo[1];
			}
			if ((a.length === 0 && attrInfo[2]) || attrInfo[2] !== "|") {
				// Variation from default
				// 1. Separator present with an empty attribute block
				// 2. Not "|"
				dp.attrSepSrc = attrInfo[2];
			}
		}

		var dataAttribs = { tsr: [endPos, endPos] };
		var endTag;
		if (addEndTag) {
			endTag = new EndTagTk(tagName, [], dataAttribs);
		} else {
			// We rely on our tree builder to close the table cell (td/th) as needed.
			// We cannot close the cell here because cell content can come from
			// multiple parsing contexts and we cannot close the tag in the same
			// parsing context in which the td was opened:
			//   Ex: {{echo|{{!}}foo}}{{echo|bar}} has to output <td>foobar</td>
			//
			// But, add a marker meta-tag to capture tsr info.
			// SSS FIXME: Unsure if this is actually helpful, but adding it in just in case.
			// Can test later and strip it out if it doesn't make any diff to rting.
			endTag = new SelfclosingTagTk('meta', [
				new KV('typeof', 'mw:TSRMarker'),
				new KV('data-etag', tagName),
			], dataAttribs);
		}

		return [new TagTk(tagName, a, dp)].concat(content, endTag);
	},

	buildXMLTag: function(name, lcName, attribs, endTag, selfClose, tsr) {
		var tok;
		var da = { tsr: tsr, stx: 'html' };

		if (name !== lcName) {
			da.srcTagName = name;
		}

		if (endTag !== null) {
			tok = new EndTagTk(lcName, attribs, da);
		} else if (selfClose) {
			da.selfClose = true;
			tok = new SelfclosingTagTk(lcName, attribs, da);
		} else {
			tok = new TagTk(lcName, attribs, da);
		}

		return tok;
	},

	/**
	 * Inline breaks, flag-enabled rule which detects end positions for
	 * active higher-level rules in inline and other nested rules.
	 * Those inner rules are then exited, so that the outer rule can
	 * handle the end marker.
	 */
	inlineBreaks: function(input, pos, stops) {
		var c = input[pos];

		switch (c) {
			case '=':
				if (stops.arrow && input[pos + 1] === ">") {
					return true;
				}
				return stops.equal ||
					(stops.h &&
						(pos === input.length - 1
						// possibly more equals followed by spaces or comments
						|| /^=*(?:[ \t]|<\!--(?:(?!-->)[^])*-->)*(?:[\r\n]|$)/
							.test(input.substr(pos + 1)))
					);
			case '|':
				return (stops.templateArg &&
						!stops.extTag) ||
					stops.tableCellArg ||
					stops.linkdesc ||
					(stops.table && (
						pos < input.length - 1 &&
						/[}|]/.test(input[pos + 1])));
			case '!':
				return stops.th &&
					!stops.templatedepth &&
					input[pos + 1] === "!";
			case '{':
				// {{!}} pipe templates..
				// FIXME: Presumably these should mix with and match | above.
				return (
					(stops.tableCellArg &&
						input.substr(pos, 5) === '{{!}}') ||
					(stops.table &&
						input.substr(pos, 10) === '{{!}}{{!}}')
				);
			case '}':
				var c2 = input[pos + 1];
				var preproc = stops.preproc;
				return (c2 === '}' && preproc === '}}') ||
					(c2 === "-" && preproc === '}-');
			case ':':
				return stops.colon &&
					!stops.extlink &&
					!stops.templatedepth &&
					!stops.linkdesc &&
					!(stops.preproc === '}-');
			case ";":
				return stops.semicolon;
			case '\r':
				return stops.table &&
					/\r\n?\s*[!|]/.test(input.substr(pos));
			case '\n':
				// The code below is just a manual / efficient
				// version of this check.
				//
				// stops.table && /^\n\s*[!|]/.test(input.substr(pos));
				//
				// It eliminates a substr on the string and eliminates
				// a potential perf problem since "\n" and the inline_breaks
				// test is common during tokenization.
				if (!stops.table) {
					return false;
				}

				// Allow leading whitespace in tables

				// Since we switched on 'c' which is input[pos],
				// we know that input[pos] is "\n".
				// So, the /^\n/ part of the regexp is already satisfied.
				// Look for /\s*[!|]/ below.
				var n = input.length;
				for (var i = pos + 1; i < n; i++) {
					var d = input[i];
					if (/[!|]/.test(d)) {
						return true;
					} else if (!(/\s/.test(d))) {
						return false;
					}
				}
				return false;
			case '[':
				// This is a special case in php's doTableStuff, added in
				// response to T2553.  If it encounters a `[[`, it bails on
				// parsing attributes and interprets it all as content.
				return stops.tableCellArg &&
					input.substr(pos, 2) === '[[';
			case '-':
				// Same as above: a special case in doTableStuff, added
				// as part of T153140
				return stops.tableCellArg &&
					input.substr(pos, 2) === '-{';
			case ']':
				if (stops.extlink) { return true; }
				return stops.preproc === ']]' &&
					input[pos + 1] === ']';
			default:
				throw new Error('Unhandled case!');
		}
	},

	/** Pop off the end comments, if any. */
	popComments: function(attrs) {
		var buf = [];
		for (var i = attrs.length - 1; i > -1; i--) {
			var kv = attrs[i];
			if (typeof kv.k === "string" && !kv.v && /^\s*$/.test(kv.k)) {
				// permit whitespace
				buf.unshift(kv.k);
			} else if (Array.isArray(kv.k) && !kv.v) {
				// all should be comments
				if (kv.k.some(function(k) {
					return !(k instanceof CommentTk);
				})) { break; }
				buf.unshift.apply(buf, kv.k);
			} else {
				break;
			}
		}
		// ensure we found a comment
		while (buf.length && !(buf[0] instanceof CommentTk)) {
			buf.shift();
		}
		if (buf.length) {
			attrs.splice(-buf.length, buf.length);
			return { buf: buf, commentStartPos: buf[0].dataAttribs.tsr[0] };
		} else {
			return null;
		}
	},

	tsrOffsets: function(startOffset, endOffset, flag) {
		switch (flag) {
			case 'start':
				return [startOffset, startOffset];
			case 'end':
				return [endOffset, endOffset];
			default:
				return [startOffset, endOffset];
		}
	},

	expandTsrK: function(tsr) {
		console.assert(tsr.length === 2, tsr);
		// This is used to expand tsr into format expected for attribute
		// source offsets (where the tsr corresponds to the key)
		return [tsr[0], tsr[1], tsr[1], tsr[1]];
	},

	expandTsrV: function(tsr) {
		console.assert(tsr.length === 2, tsr);
		// This is used to expand tsr into format expected for attribute
		// source offsets (where the tsr corresponds to the value)
		return [tsr[0], tsr[0], tsr[0], tsr[1]];
	},


	enforceWt2HtmlResourceLimits: function(env, token) {
		if (token && (token.constructor === TagTk || token.constructor === SelfclosingTagTk)) {
			switch (token.name) {
				case 'listItem':
					env.bumpWt2HtmlResourceUse('listItem');
					break;
				case 'template':
					env.bumpWt2HtmlResourceUse('transclusion');
					break;
				case 'td':
				case 'th':
					env.bumpWt2HtmlResourceUse('tableCell');
					break;
			}
		}
	},

	protectAttrsRegExp: new RegExp(`^(about|data-mw.*|data-parsoid.*|data-x.*|${DOMDataUtils.DataObjectAttrName()}|property|rel|typeof)$`, 'i'),
	protectAttrs: function(name) {
		return name.replace(this.protectAttrsRegExp, 'data-x-$1');
	},

	isIncludeTag: function(name) {
		return name === 'includeonly' || name === 'noinclude' || name === 'onlyinclude';
	},

};
