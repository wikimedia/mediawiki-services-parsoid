/**
 * This file contains general utilities for:
 * (a) querying token properties and token types
 * (b) manipulating tokens, individually and as collections.
 *
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var Consts = require('../config/WikitextConstants.js').WikitextConstants;
var JSUtils = require('./jsutils.js').JSUtils;
const { KV, TagTk, EndTagTk, SelfclosingTagTk, NlTk, EOFTk, CommentTk } = require('../tokens/TokenTypes.js');

var lastItem = JSUtils.lastItem;

var TokenQueryUtils = {
	/**
	 * Determine if a tag is block-level or not.
	 *
	 * `<video>` is removed from block tags, since it can be phrasing content.
	 * This is necessary for it to render inline.
	 */
	isBlockTag: function(name) {
		name = name.toUpperCase();
		return name !== 'VIDEO' && Consts.HTML.HTML4BlockTags.has(name);
	},

	/**
	 * In the PHP parser, these block tags open block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php).
	 */
	tagOpensBlockScope: function(name) {
		return Consts.BlockScopeOpenTags.has(name.toUpperCase());
	},

	/**
	 * In the PHP parser, these block tags close block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php).
	 */
	tagClosesBlockScope: function(name) {
		return Consts.BlockScopeCloseTags.has(name.toUpperCase());
	},

	isTemplateToken: function(token) {
		return token && token.constructor === SelfclosingTagTk && token.name === 'template';
	},

	/**
	 * Determine whether the current token was an HTML tag in wikitext.
	 *
	 * @return {boolean}
	 */
	isHTMLTag: function(token) {
		switch (token.constructor) {
			case String:
			case NlTk:
			case CommentTk:
			case EOFTk:
				return false;
			case TagTk:
			case EndTagTk:
			case SelfclosingTagTk:
				return token.dataAttribs.stx === 'html';
			default:
				console.assert(false, 'Unhandled token type');
		}
	},

	isDOMFragmentType: function(typeOf) {
		return /(?:^|\s)mw:DOMFragment(\/sealed\/\w+)?(?=$|\s)/.test(typeOf);
	},

	isTableTag: function(token) {
		var tc = token.constructor;
		return (tc === TagTk || tc === EndTagTk) &&
			Consts.HTML.TableTags.has(token.name.toUpperCase());
	},

	/** @property {RegExp} */
	solTransparentLinkRegexp: /(?:^|\s)mw:PageProp\/(?:Category|redirect|Language)(?=$|\s)/,

	isSolTransparentLinkTag: function(token) {
		var tc = token.constructor;
		return (tc === SelfclosingTagTk || tc === TagTk || tc === EndTagTk) &&
			token.name === 'link' &&
			this.solTransparentLinkRegexp.test(token.getAttribute('rel') || '');
	},

	isBehaviorSwitch: function(env, token) {
		return token.constructor === SelfclosingTagTk && (
			// Before BehaviorSwitchHandler (ie. PreHandler, etc.)
			token.name === 'behavior-switch' ||
			// After BehaviorSwitchHandler
			// (ie. ListHandler, ParagraphWrapper, etc.)
			(token.name === 'meta' &&
				token.hasAttribute('property') &&
				env.conf.wiki.bswPagePropRegexp.test(token.getAttribute('property')))
		);
	},

	/**
	 * This should come close to matching
	 * {@link DOMUtils.emitsSolTransparentSingleLineWT}
	 */
	isSolTransparent: function(env, token) {
		var tc = token.constructor;
		if (tc === String) {
			return token.match(/^[ \t]*$/);
		} else if (this.isSolTransparentLinkTag(token)) {
			return true;
		} else if (tc === CommentTk) {
			return true;
		} else if (this.isBehaviorSwitch(env, token)) {
			return true;
		} else if (tc !== SelfclosingTagTk || token.name !== 'meta') {
			return false;
		} else {  // only metas left
			return token.dataAttribs.stx !== 'html';
		}
	},

	isEmptyLineMetaToken: function(token) {
		return token.constructor === SelfclosingTagTk &&
			token.name === "meta" &&
			token.getAttribute("typeof") === "mw:EmptyLine";
	},

	isEntitySpanToken: function(token) {
		return token.constructor === TagTk && token.name === 'span' &&
			token.getAttribute('typeof') === 'mw:Entity';
	},
};

var OtherTokenUtils = {
	/**
	 * Transform `"\n"` and `"\r\n"` in the input string to {@link NlTk} tokens.
	 */
	newlinesToNlTks: function(str) {
		var toks = str.split(/\n|\r\n/);
		var ret = [];
		var i = 0;
		// Add one NlTk between each pair, hence toks.length-1
		for (var n = toks.length - 1; i < n; i++) {
			ret.push(toks[i]);
			ret.push(new NlTk());
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
			switch (t && t.constructor) {
				case TagTk:
				case SelfclosingTagTk:
				case NlTk:
				case CommentTk:
				case EndTagTk:
					var da = tokens[i].dataAttribs;
					var tsr = da.tsr;
					if (tsr) {
						if (offset !== null) {
							da.tsr = [tsr[0] + offset, tsr[1] + offset];
						} else {
							da.tsr = null;
						}
					}

					if (offset && da.extTagOffsets) {
						da.extTagOffsets[0] += offset;
						da.extTagOffsets[1] += offset;
					}

					// SSS FIXME: offset will always be available in
					// chunky-tokenizer mode in which case we wont have
					// buggy offsets below.  The null scenario is only
					// for when the token-stream-patcher attempts to
					// reparse a string -- it is likely to only patch up
					// small string fragments and the complicated use cases
					// below should not materialize.
					// CSA: token-stream-patcher shouldn't have problems
					// now that Frame.srcText is always accurate?

					// content offsets for ext-links
					if (offset && da.extLinkContentOffsets) {
						da.extLinkContentOffsets[0] += offset;
						da.extLinkContentOffsets[1] += offset;
					}

					//  Process attributes
					if (t.attribs) {
						for (var j = 0, m = t.attribs.length; j < m; j++) {
							var a = t.attribs[j];
							if (Array.isArray(a.k)) {
								this.shiftTokenTSR(a.k, offset, clearIfUnknownOffset);
							}
							if (Array.isArray(a.v)) {
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

	/**
	 * Strip include tags, and the contents of includeonly tags as well.
	 */
	stripIncludeTokens: function(tokens) {
		var toks = [];
		var includeOnly = false;
		for (var i = 0; i < tokens.length; i++) {
			var tok = tokens[i];
			switch (tok.constructor) {
				case TagTk:
				case EndTagTk:
				case SelfclosingTagTk:
					if (['noinclude', 'onlyinclude'].includes(tok.name)) {
						continue;
					} else if (tok.name === 'includeonly') {
						includeOnly = (tok.constructor === TagTk);
						continue;
					}
				// Fall through
				default:
					if (!includeOnly) {
						toks.push(tok);
					}
			}
		}
		return toks;
	},

	tokensToString: function(tokens, strict, opts) {
		if (tokens.constructor === String) {
			return tokens;
		}
		if (!Array.isArray(tokens)) {
			tokens = [ tokens ];
		}

		var out = '';
		if (!opts) {
			opts = {};
		}
		for (var i = 0, l = tokens.length; i < l; i++) {
			var token = tokens[i];
			if (token === null) {
				console.assert(false, 'No nulls expected.');
			} else if (token.constructor === KV) {
				// Since this function is occasionally called on KV->v,
				// whose signature recursively includes KV[], a mismatch with
				// this function, we assert that those values are only
				// included in safe places that don't intend to stringify
				// their tokens.
				console.assert(false, 'No KVs expected.');
			} else if (token.constructor === String) {
				out += token;
			} else if (Array.isArray(token)) {
				out += this.tokensToString(token, strict, opts);
			} else if (token.constructor === CommentTk ||
					(!opts.retainNLs && token.constructor === NlTk)) {
				// strip comments and newlines
			} else if (opts.stripEmptyLineMeta && this.isEmptyLineMetaToken(token)) {
				// If requested, strip empty line meta tokens too.
			} else if (opts.includeEntities && this.isEntitySpanToken(token)) {
				out += token.dataAttribs.src;
				i += 2;  // Skip child and end tag.
			} else if (strict) {
				// If strict, return accumulated string on encountering first non-text token
				return [out, tokens.slice(i)];
			} else if (opts.unpackDOMFragments &&
					[TagTk, SelfclosingTagTk].indexOf(token.constructor) !== -1 &&
					this.isDOMFragmentType(token.getAttribute('typeof') || '')) {
				// Handle dom fragments
				const nodes = opts.env.fragmentMap.get(token.dataAttribs.html);
				out += nodes.reduce(function(prev, next) {
					// FIXME: The correct thing to do would be to return
					// `next.outerHTML` for the current scenarios where
					// `unpackDOMFragments` is used (expanded attribute
					// values and reparses thereof) but we'd need to remove
					// the span wrapping and typeof annotation of extension
					// content and nowikis.  Since we're primarily expecting
					// to find <translate> and <nowiki> here, this will do.
					return prev + next.textContent;
				}, '');
				if (token.constructor === TagTk) {
					i += 1;  // Skip the EndTagTK
					console.assert(i >= l || tokens[i].constructor === EndTagTk);
				}
			}
		}
		return out;
	},

	flattenAndAppendToks: function(array, prefix, t) {
		if (Array.isArray(t) || t.constructor === String) {
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
	 * Convert an array of key-value pairs into a hash of keys to values. For
	 * duplicate keys, the last entry wins.
	 */
	kvToHash: function(kvs, convertValuesToString, useSrc) {
		if (!kvs) {
			console.warn("Invalid kvs!: " + JSON.stringify(kvs, null, 2));
			return Object.create(null);
		}
		var res = Object.create(null);
		for (var i = 0, l = kvs.length; i < l; i++) {
			var kv = kvs[i];
			var key = this.tokensToString(kv.k).trim();
			// SSS FIXME: Temporary fix to handle extensions which use
			// entities in attribute values. We need more robust handling
			// of non-string template attribute values in general.
			var val = (useSrc && kv.vsrc !== undefined) ? kv.vsrc :
				convertValuesToString ? this.tokensToString(kv.v) : kv.v;
			res[key.toLowerCase()] = this.tokenTrim(val);
		}
		return res;
	},

	/**
	 * Trim space and newlines from leading and trailing text tokens.
	 */
	tokenTrim: function(tokens) {
		if (!Array.isArray(tokens)) {
			if (tokens.constructor === String) {
				return tokens.trim();
			}
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

		var i, token;
		var n = tokens.length;

		// strip leading space
		var leadingToks = [];
		for (i = 0; i < n; i++) {
			token = tokens[i];
			if (token.constructor === NlTk) {
				leadingToks.push('');
			} else if (token.constructor === String) {
				leadingToks.push(token.replace(/^\s+/, ''));
				if (token !== '') {
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
		for (i = n - 1; i >= 0; i--) {
			token = tokens[i];
			if (token.constructor === NlTk) {
				trailingToks.push(''); // replace newline with empty
			} else if (token.constructor === String) {
				trailingToks.push(token.replace(/\s+$/, ''));
				if (token !== '') {
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

	/**
	 * Strip EOFTk token from token chunk.
	 */
	stripEOFTkfromTokens: function(tokens) {
		// this.dp( 'stripping end or whitespace tokens' );
		if (!Array.isArray(tokens)) {
			tokens = [ tokens ];
		}
		if (!tokens.length) {
			return tokens;
		}
		// Strip 'end' token
		if (tokens.length && lastItem(tokens).constructor === EOFTk) {
			var rank = tokens.rank;
			tokens = tokens.slice(0, -1);
			tokens.rank = rank;
		}

		return tokens;
	},

	kvsFromArray(a) {
		return a.map((e) => {
			let v = e.v;
			if (e.k === 'options' && Array.isArray(v) && v.every(o => o.k !== undefined && o.v !== undefined)) {
				v = this.kvsFromArray(v);
			}
			return new KV(e.k, v, e.srcOffsets || null, e.ksrc, e.vsrc);
		});
	},

	/**
	 * Get a token from a JSON string
	 *
	 * @param {Object} jsTk
	 * @return {Token}
	 */
	getToken(jsTk) {
		if (!jsTk || !jsTk.type) {
			return jsTk;
		}

		switch (jsTk.type) {
			case "SelfclosingTagTk":
				return new SelfclosingTagTk(jsTk.name, this.kvsFromArray(jsTk.attribs), jsTk.dataAttribs);
			case "TagTk":
				return new TagTk(jsTk.name, this.kvsFromArray(jsTk.attribs), jsTk.dataAttribs);
			case "EndTagTk":
				return new EndTagTk(jsTk.name, this.kvsFromArray(jsTk.attribs), jsTk.dataAttribs);
			case "NlTk":
				return new NlTk(null, jsTk.dataAttribs);
			case "EOFTk":
				return new EOFTk();
			case "CommentTk":
				return new CommentTk(jsTk.value, jsTk.dataAttribs);
			default:
				// Looks like data-parsoid can have a 'type' property in some cases
				// We can change that usage and then throw an exception here.
				return jsTk;
		}
	}
};

var TokenUtils = Object.assign({}, TokenQueryUtils, OtherTokenUtils);

if (typeof module === "object") {
	module.exports.TokenUtils = TokenUtils;
}
