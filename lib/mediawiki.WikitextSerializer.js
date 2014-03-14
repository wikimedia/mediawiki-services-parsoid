/* ----------------------------------------------------------------------
 * This serializer is designed to eventually
 * - accept arbitrary HTML and
 * - serialize that to wikitext in a way that round-trips back to the same
 *   HTML DOM as far as possible within the limitations of wikitext.
 *
 * Not much effort has been invested so far on supporting
 * non-Parsoid/VE-generated HTML. Some of this involves adaptively switching
 * between wikitext and HTML representations based on the values of attributes
 * and DOM context. A few special cases are already handled adaptively
 * (multi-paragraph list item contents are serialized as HTML tags for
 * example, generic a elements are serialized to HTML a tags), but in general
 * support for this is mostly missing.
 *
 * Example issue:
 * <h1><p>foo</p></h1> will serialize to =\nfoo\n= whereas the
 *        correct serialized output would be: =<p>foo</p>=
 *
 * What to do about this?
 * * add a generic 'can this HTML node be serialized to wikitext in this
 *   context' detection method and use that to adaptively switch between
 *   wikitext and HTML serialization
 * ---------------------------------------------------------------------- */

"use strict";

require('./core-upgrade.js');
var wtConsts = require('./mediawiki.wikitext.constants.js'),
	Consts = wtConsts.WikitextConstants,
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	WTSUtils = require('./wts.utils.js').WTSUtils,
	pd = require('./mediawiki.parser.defines.js'),
	minimizeWTQuoteTags = require('./wts.minimizeWTQuoteTags.js').minimizeWTQuoteTags,
	SerializerState = require('./wts.SerializerState.js').SerializerState,
	TagHandlers = require('./wts.TagHandlers.js').TagHandlers,
	LinkHandlersModule = require('./wts.LinkHandler.js'),
	SeparatorsModule = require('./wts.separators.js'),
	WTEModule = require('./wts.escapeWikitext.js');

function isHtmlBlockTag(name) {
	return name === 'body' || Util.isBlockTag(name);
}

function isTd(token) {
	return token && token.constructor === pd.TagTk && token.name === 'td';
}

function isListItem(token) {
	return token && token.constructor === pd.TagTk &&
		['li', 'dt', 'dd'].indexOf(token.name) !== -1;
}

function precedingSeparatorTxt(n) {
	// Given the CSS white-space property and specifically,
	// "pre" and "pre-line" values for this property, it seems that any
	// sane HTML editor would have to preserve IEW in HTML documents
	// to preserve rendering. One use-case where an editor might change
	// IEW drastically would be when the user explicitly requests it
	// (Ex: pretty-printing of raw source code).
	//
	// For now, we are going to exploit this.  This information is
	// only used to extrapolate DSR values and extract a separator
	// string from source, and is only used locally.  In addition,
	// the extracted text is verified for being a valid separator.
	//
	// So, at worst, this can create a local dirty diff around separators
	// and at best, it gets us a clean diff.

	var buf = '', orig = n;
	while (n) {
		if (DU.isIEW(n)) {
			buf += n.nodeValue;
		} else if (n.nodeType === n.COMMENT_NODE) {
			buf += "<!--";
			buf += n.nodeValue;
			buf += "-->";
		} else if (n !== orig) { // dont return if input node!
			return null;
		}

		n = n.previousSibling;
	}

	return buf;
}

/**
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 *
 * @class
 * @constructor
 * @param options {Object} List of options for serialization
 */
function WikitextSerializer( options ) {
	this.options = options || {};
	this.env = options.env;
	this.options.rtTesting = !this.env.conf.parsoid.editMode;

	// Tag handlers
	this.tagHandlers = TagHandlers;

	// Used in multiple tag handlers, and hence added as top-level properties
	// - linkHandler is used by <a> and <link>
	// - figureHandler is used by <figure> and by <a>.linkHandler above
	this.linkHandler = LinkHandlersModule.linkHandler;
	this.figureHandler = LinkHandlersModule.figureHandler;

	// WT escaping handlers
	this.wteHandlers = new WTEModule.WikitextEscapeHandlers(this.env);
	this.escapeWikiText = WTEModule.escapeWikiText;
	this.escapeTplArgWT = WTEModule.escapeTplArgWT;

	// Separator handling
	this.handleSeparatorText = SeparatorsModule.handleSeparatorText;
	this.updateSeparatorConstraints = SeparatorsModule.updateSeparatorConstraints;
	this.emitSeparator = SeparatorsModule.emitSeparator;

	// Set up debugging helpers
	this.debugging = this.env.conf.parsoid.traceFlags &&
		(this.env.conf.parsoid.traceFlags.indexOf("wts") !== -1);

	this.traceWTE = this.env.conf.parsoid.traceFlags &&
		(this.env.conf.parsoid.traceFlags.indexOf("wt-escape") !== -1);

	if ( this.env.conf.parsoid.debug || this.debugging ) {
		WikitextSerializer.prototype.debug_pp = function () {
			Util.debug_pp.apply(Util, arguments);
		};

		WikitextSerializer.prototype.debug = function ( ) {
			this.debug_pp.apply(this, ["WTS: ", ''].concat([].slice.apply(arguments)));
		};

		WikitextSerializer.prototype.trace = function () {
			console.error(JSON.stringify(["WTS:"].concat([].slice.apply(arguments))));
		};
	} else {
		WikitextSerializer.prototype.debug_pp = function ( ) {};
		WikitextSerializer.prototype.debug = function ( ) {};
		WikitextSerializer.prototype.trace = function () {};
	}
	this.wteHandlers.traceWTE = this.traceWTE;
}

var WSP = WikitextSerializer.prototype;

WSP.serializeHTML = function(opts, html) {
	return (new WikitextSerializer(opts)).serializeDOM(DU.parseHTML(html).body);
};

WSP.getAttributeKey = function(node, key) {
	var dataMW = node.getAttribute("data-mw");
	if (dataMW) {
		dataMW = JSON.parse(dataMW);
		var tplAttrs = dataMW.attribs;
		if (tplAttrs) {
			// If this attribute's key is generated content,
			// serialize HTML back to generator wikitext.
			for (var i = 0; i < tplAttrs.length; i++) {
				if (tplAttrs[i][0].txt === key && tplAttrs[i][0].html) {
					return this.serializeHTML({ env: this.env, onSOL: false }, tplAttrs[i][0].html);
				}
			}
		}
	}

	return key;
};

// SSS FIXME: data-mw html attribute is repeatedly fetched and parsed
// when multiple attrs are fetched on the same node
WSP.getAttrValFromDataMW = function(node, key, value) {
	var dataMW = node.getAttribute("data-mw");
	if (dataMW) {
		dataMW = JSON.parse(dataMW);
		var tplAttrs = dataMW.attribs;
		if (tplAttrs) {
			// If this attribute's value is generated content,
			// serialize HTML back to generator wikitext.
			for (var i = 0; i < tplAttrs.length; i++) {
				var a = tplAttrs[i];
				if (a[0] === key || a[0].txt === key && a[1].html !== null) {
					return this.serializeHTML({ env: this.env, onSOL: false }, a[1].html);
				}
			}
		}
	}

	return value;
};

WSP.serializedAttrVal = function(node, name) {
	var v = this.getAttrValFromDataMW(node, name, null);
	if (v) {
		return {
			value: v,
			modified: false,
			fromsrc: true,
			fromDataMW: true
		};
	} else {
		return DU.getAttributeShadowInfo(node, name);
	}
};

WSP.serializedImageAttrVal = function(dataMWnode, htmlAttrNode, key) {
	var v = this.getAttrValFromDataMW(dataMWnode, key, null);
	if (v) {
		return {
			value: v,
			modified: false,
			fromsrc: true,
			fromDataMW: true
		};
	} else {
		return DU.getAttributeShadowInfo(htmlAttrNode, key);
	}
};

WSP._serializeTableTag = function ( symbol, endSymbol, state, node, wrapperUnmodified ) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid( node ).dsr;
		return state.getOrigSrc(dsr[0], dsr[0]+dsr[2]);
	} else {
		var token = DU.mkTagTk(node);
		var sAttribs = this._serializeAttributes(state, node, token);
		if (sAttribs.length > 0) {
			// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the '' string
			// is a falsy value and we want to treat it as a truthy value.
			return symbol + ' ' + sAttribs + (endSymbol !== null ? endSymbol : ' |');
		} else {
			return symbol + (endSymbol || '');
		}
	}
};

WSP._serializeTableElement = function ( symbol, endSymbol, state, node ) {
	var token = DU.mkTagTk(node);

	var sAttribs = this._serializeAttributes(state, node, token);
	if (sAttribs.length > 0) {
		// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the '' string
		// is a falsy value and we want to treat it as a truthy value.
		return symbol + ' ' + sAttribs + (endSymbol !== null ? endSymbol : ' |');
	} else {
		return symbol + (endSymbol || '');
	}
};

WSP._serializeHTMLTag = function ( state, node, wrapperUnmodified ) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid( node ).dsr;
		return state.getOrigSrc(dsr[0], dsr[0]+dsr[2]);
	}

	var token = DU.mkTagTk(node);
	var da = token.dataAttribs;
	if ( token.name === 'pre' ) {
		// html-syntax pre is very similar to nowiki
		state.inHTMLPre = true;
	}

	if (da.autoInsertedStart) {
		return '';
	}

	var close = '';
	if ( (Util.isVoidElement( token.name ) && !da.noClose) || da.selfClose ) {
		close = ' /';
	}

	var sAttribs = this._serializeAttributes(state, node, token),
		tokenName = da.srcTagName || token.name;
	if (sAttribs.length > 0) {
		return '<' + tokenName + ' ' + sAttribs + close + '>';
	} else {
		return '<' + tokenName + close + '>';
	}
};

WSP._serializeHTMLEndTag = function ( state, node, wrapperUnmodified ) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid( node ).dsr;
		return state.getOrigSrc(dsr[1]-dsr[3], dsr[1]);
	}

	var token = DU.mkEndTagTk(node);
	if ( token.name === 'pre' ) {
		state.inHTMLPre = false;
	}
	if ( !token.dataAttribs.autoInsertedEnd &&
		 !Util.isVoidElement( token.name ) &&
		 !token.dataAttribs.selfClose  )
	{
		return '</' + (token.dataAttribs.srcTagName || token.name) + '>';
	} else {
		return '';
	}
};

WSP._serializeAttributes = function (state, node, token) {
	function hasExpandedAttrs(tokType) {
		return (/(?:^|\s)mw:ExpandedAttrs\/[^\s]+/).test(tokType);
	}

	var tokType = token.getAttribute("typeof"),
		attribs = token.attribs;

	var out = [],
		// Strip Parsoid generated values
		keysWithParsoidValues = {
			'about': /^#mwt\d+$/,
			'typeof': /(^|\s)mw:[^\s]+/g
		},
		ignoreKeys = {
			'data-mw': 1,
			// The following should be filtered out earlier,
			// but we ignore them here too just to make sure.
			'data-parsoid': 1,
			'data-ve-changed': 1,
			'data-parsoid-changed': 1,
			'data-parsoid-diff': 1,
			'data-parsoid-serialize': 1
		};

	var kv, k, vInfo, v, tplKV, tplK, tplV;
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		kv = attribs[i];
		k = kv.k;

		// Unconditionally ignore
		if (ignoreKeys[k]) {
			continue;
		}

		// Strip Parsoid-values
		//
		// FIXME: Given that we are currently escaping about/typeof keys
		// that show up in wikitext, we could unconditionally strip these
		// away right now.
		if (keysWithParsoidValues[k] && kv.v.match(keysWithParsoidValues[k])) {
			v = kv.v.replace(keysWithParsoidValues[k], '');
			if (v) {
				out.push(k + '=' + '"' + v + '"');
			}
			continue;
		}

		if (k.length > 0) {
			vInfo = token.getAttributeShadowInfo(k);
			v = vInfo.value;

			// Deal with k/v's that were template-generated
			k = this.getAttributeKey(node, k);

			// Pass in kv.k, not k since k can potentially
			// be original wikitext source for 'k' rather than
			// the string value of the key.
			v = this.getAttrValFromDataMW(node, kv.k, v);

			// Remove encapsulation from protected attributes
			// in pegTokenizer.pegjs.txt:generic_newline_attribute
			k = k.replace( /^data-x-/i, '' );

			if (v.length > 0) {
				if (!vInfo.fromsrc) {
					// Escape HTML entities
					v = Util.escapeEntities(v);
				}
				out.push(k + '=' + '"' + v.replace( /"/g, '&quot;' ) + '"');
			} else if (k.match(/[{<]/)) {
				// Templated, <*include*>, or <ext-tag> generated
				out.push(k);
			} else {
				out.push(k + '=""');
			}
		} else if ( kv.v.length ) {
			// not very likely..
			out.push( kv.v );
		}
	}

	// SSS FIXME: It can be reasonably argued that we can permanently delete
	// dangerous and unacceptable attributes in the interest of safety/security
	// and the resultant dirty diffs should be acceptable.  But, this is
	// something to do in the future once we have passed the initial tests
	// of parsoid acceptance.
	//
	// 'a' data attribs -- look for attributes that were removed
	// as part of sanitization and add them back
	var dataAttribs = token.dataAttribs;
	if (dataAttribs.a && dataAttribs.sa) {
		var aKeys = Object.keys(dataAttribs.a);
		for (i = 0, l = aKeys.length; i < l; i++) {
			k = aKeys[i];
			// Attrib not present -- sanitized away!
			if (!Util.lookupKV(attribs, k)) {
				v = dataAttribs.sa[k];
				if (v) {
					out.push(k + '=' + '"' + v.replace( /"/g, '&quot;' ) + '"');
				} else {
					// at least preserve the key
					out.push(k);
				}
			}
		}
	}

	// XXX: round-trip optional whitespace / line breaks etc
	return out.join(' ');
};

WSP._handleLIHackIfApplicable = function (node, cb) {
	var liHackSrc = DU.getDataParsoid( node ).liHackSrc,
	    prev = DU.previousNonSepSibling(node);

	// If we are dealing with an LI hack, then we must ensure that
	// we are dealing with either
	//
	//   1. A node with no previous sibling inside of a list.
	//
	//   2. A node whose previous sibling is a list element.
	if (liHackSrc !== undefined &&
	    ((prev === null && DU.isList(node.parentNode)) ||        // Case 1
	     (prev !== null && DU.isListItem(prev)))) {              // Case 2
		cb(liHackSrc, node);
	}
};

WSP._htmlElementHandler = function (node, state, cb, wrapperUnmodified) {
	// Wikitext supports the following list syntax:
	//
	//    * <li class="a"> hello world
	//
	// The "LI Hack" gives support for this syntax, and we need to
	// specially reconstruct the above from a single <li> tag.
	this._handleLIHackIfApplicable(node, cb);

	WTSUtils.emitStartTag(this._serializeHTMLTag(state, node, wrapperUnmodified),
			node, state, cb);
	if (node.childNodes.length) {
		var inPHPBlock = state.inPHPBlock;
		if (Util.tagOpensBlockScope(node.nodeName.toLowerCase())) {
			state.inPHPBlock = true;
		}

		if (node.nodeName === 'PRE') {
			// Handle html-pres specially
			// 1. If the node has a leading newline, add one like it (logic copied from VE)
			// 2. If not, and it has a data-parsoid strippedNL flag, add it back.
			// This patched DOM will serialize html-pres correctly.

			var lostLine = '', fc = node.firstChild;
			if (fc && DU.isText(fc)) {
				var m = fc.nodeValue.match(/^\r\n|\r|\n/);
				lostLine = m && m[0] || '';
			}

			var shadowedNL = DU.getDataParsoid( node ).strippedNL;
			if (!lostLine && shadowedNL) {
				lostLine = shadowedNL;
			}

			cb(lostLine, node);
		}

		state.serializeChildren(node, cb);
		state.inPHPBlock = inPHPBlock;
	}
	WTSUtils.emitEndTag(this._serializeHTMLEndTag(state, node, wrapperUnmodified),
			node, state, cb);
};

WSP._buildTemplateWT = function(node, state, srcParts) {
	function countPositionalArgs(tpl, paramInfos) {
		var res = 0;
		paramInfos.forEach(function(paramInfo) {
			var k = paramInfo.k;
			if (tpl.params[k] !== undefined && !paramInfo.named) {
				res++;
			}
		});
		return res;
	}

	var buf = '',
		serializer = this,
		dp = DU.getDataParsoid( node );

	// Workaround for VE bug https://bugzilla.wikimedia.org/show_bug.cgi?id=51150
	if (srcParts.length === 1 && srcParts[0].template &&
			srcParts[0].template.i === undefined) {
		srcParts[0].template.i = 0;
	}

	srcParts.map(function(part) {
		var tpl = part.template;
		if (tpl) { // transclusion: tpl or parser function
			var isTpl = typeof(tpl.target.href) === 'string';
			buf += "{{";

			// tpl target
			buf += tpl.target.wt;

			// tpl args
			var argBuf = [],
				keys = Object.keys(tpl.params),
				// per-parameter info for pre-existing parameters
				paramInfos = dp.pi && tpl.i !== undefined ?
								dp.pi[tpl.i] || [] : [],
				// extract the original keys in order
				origKeys = paramInfos.map( function (paramInfo) {
					return paramInfo.k;
				}),
				n = keys.length;
			if (n > 0) {
				var numericIndex = 1,
					numPositionalArgs = countPositionalArgs(tpl, paramInfos),
					pushArg = function (k, paramInfo) {
						if (!paramInfo) {
							paramInfo = {};
						}

						var v = tpl.params[k].wt,
							// Default to ' = ' spacing. Anything that matches
							// this does not remember spc explicitly.
							spc = ['', ' ', ' ', ''],
							opts = {
								serializeAsNamed: false,
								isTemplate: isTpl,
								numPositionalArgs: numPositionalArgs,
								argIndex: numericIndex
							};

						if (paramInfo.named || k !== numericIndex.toString()) {
							opts.serializeAsNamed = true;
						}

						if (paramInfo.spc) {
							spc = paramInfo.spc;
						} //else {
							// TODO: match the space style of other/ parameters!
							//spc = ['', ' ', ' ', ''];
						//}
						var res = serializer.escapeTplArgWT(state, v, opts);
						if (res.serializeAsNamed) {
							// Escape as value only
							// Trim WS
							argBuf.push(spc[0] + k + spc[1] + "=" + spc[2] + res.v.trim() + spc[3]);
						} else {
							numericIndex++;
							// Escape as positional parameter
							// No WS trimming
							argBuf.push(res.v);
						}
					};

				// first serialize out old parameters in order
				paramInfos.forEach(function(paramInfo) {
					var k = paramInfo.k;
					if (tpl.params[k] !== undefined) {
						pushArg(k, paramInfo);
					}
				});
				// then push out remaining (new) parameters
				keys.forEach(function(k) {
					// Don't allow whitespace in keys

					var strippedK = k.trim();
					if (origKeys.indexOf(strippedK) === -1) {
						if (strippedK !== k) {
							// copy over
							tpl.params[strippedK] = tpl.params[k];
						}
						pushArg(strippedK);
					}
				});

				// Now append the parameters joined by pipes
				buf += "|";
				buf += argBuf.join("|");
			}
			buf += "}}";
		} else {
			// plain wt
			buf += part;
		}
	});
	return buf;
};

WSP._buildExtensionWT = function(state, node, dataMW) {
	var extName = dataMW.name,
		srcParts = ["<", extName];

	// Serialize extension attributes in normalized form as:
	// key='value'
	var attrs = dataMW.attrs || {},
		extTok = new pd.TagTk(extName, Object.keys(attrs).map(function(k) {
			return new pd.KV(k, attrs[k]);
		})),
		about = node.getAttribute('about'),
		type = node.getAttribute('typeof'),
		attrStr;

	if (about) {
		extTok.addAttribute('about', about);
	}
	if (type) {
		extTok.addAttribute('typeof', type);
	}
	attrStr = this._serializeAttributes(state, node, extTok);

	if (attrStr) {
		srcParts.push(' ');
		srcParts.push(attrStr);
	}

	// Serialize body
	if (!dataMW.body) {
		srcParts.push(" />");
	} else {
		srcParts.push(">");
		if (typeof dataMW.body.html === 'string') {
			var wts = new WikitextSerializer({
				env: state.env,
				extName: extName
			});
			srcParts.push(wts.serializeDOM(DU.parseHTML(dataMW.body.html).body));
		} else if (dataMW.body.extsrc) {
			srcParts.push(dataMW.body.extsrc);
		} else {
			this.env.log("error", "extension src unavailable for: " + node.outerHTML );
		}
		srcParts = srcParts.concat(["</", extName, ">"]);
	}

	return srcParts.join('');
};

/**
 * Get a DOM-based handler for an element node
 */
WSP._getDOMHandler = function(node, state, cb) {
	var self = this;

	if (!node || node.nodeType !== node.ELEMENT_NODE) {
		return {};
	}

	var dp = DU.getDataParsoid( node ),
		nodeName = node.nodeName.toLowerCase(),
		handler,
		typeOf = node.getAttribute( 'typeof' ) || '';

	// XXX: Convert into separate handlers?
	if (/(?:^|\s)mw:(?:Transclusion(?=$|\s)|Param(?=$|\s)|Extension\/[^\s]+)/.test(typeOf)) {
		return {
			handle: function () {
				var src, dataMW;
				if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
					dataMW = JSON.parse(node.getAttribute("data-mw"));
					if (dataMW) {
						src = state.serializer._buildTemplateWT(node,
								state, dataMW.parts || [{ template: dataMW }]);
					} else {
						self.env.log("error", "No data-mw for" + node.outerHTML );
						src = dp.src;
					}
				} else if (/(?:^|\s)mw:Param(?=$|\s)/.test(typeOf)) {
					src = dp.src;
				} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
					dataMW = JSON.parse(node.getAttribute("data-mw"));
					src = !dataMW ? dp.src : state.serializer._buildExtensionWT(state, node, dataMW);
				} else {
					self.env.log("error", "Should not have come here!");
				}

				// FIXME: Just adding this here temporarily till we go in and
				// clean this up and strip this out if we can verify that data-mw
				// is going to be present always when necessary and indicate that
				// a missing data-mw is either a parser bug or a client error.
				//
				// Fallback: should be exercised only in exceptional situations.
				if (src === undefined && state.env.page.src && WTSUtils.isValidDSR(dp.dsr)) {
					src = state.getOrigSrc(dp.dsr[0], dp.dsr[1]);
				}
				if (src !== undefined) {
					self.emitWikitext(src, state, cb, node);
					return DU.skipOverEncapsulatedContent(node);
				} else {
					var errors = ["No handler for: " + node.outerHTML];
					errors.push("Serializing as HTML.");
					self.env.log("error", errors.join("\n"));
					return self._htmlElementHandler(node, state, cb);
				}
			},
			sepnls: {
				// XXX: This is questionable, as the template can expand
				// to newlines too. Which default should we pick for new
				// content? We don't really want to make separator
				// newlines in HTML significant for the semantics of the
				// template content.
				before: function (node, otherNode) {
					if (DU.isNewElt(node)
							&& /(?:^|\s)mw:Extension\/references(?:\s|$)/
								.test(node.getAttribute('typeof'))
							// Only apply to plain references tags
							&& ! /(?:^|\s)mw:Transclusion(?:\s|$)/
								.test(node.getAttribute('typeof')))
					{
						// Serialize new references tags on a new line
						return {min:1, max:2};
					} else {
						return {min:0, max:2};
					}
				}
			}
		};
	}

	if ( dp.src !== undefined ) {
		//console.log(node.parentNode.outerHTML);
		if (/(^|\s)mw:Placeholder(\/\w*)?$/.test(typeOf) ||
				(typeOf === "mw:Nowiki" && node.textContent === dp.src )) {
			// implement generic src round-tripping:
			// return src, and drop the generated content
			return {
				handle: function() {
					// FIXME: Should this also check for tabs and plain space chars
					// interspersed with newlines?
					if (dp.src.match(/^\n+$/)) {
						state.sep.src = (state.sep.src || '') + dp.src;
					} else {
						self.emitWikitext(dp.src, state, cb, node);
					}
				}
			};
		} else if (typeOf === "mw:Entity") {
			var contentSrc = node.childNodes.length === 1 && node.textContent ||
								node.innerHTML;
			return  {
				handle: function () {
					if ( contentSrc === dp.srcContent ) {
						self.emitWikitext(dp.src, state, cb, node);
					} else {
						//console.log(contentSrc, dp.srcContent);
						self.emitWikitext(contentSrc, state, cb, node);
					}
				}
			};
		}
	}

	// If parent node is a list or table tag in html-syntax, then serialize
	// new elements in html-syntax rather than wiki-syntax.
	if (dp.stx === 'html' ||
		(DU.isNewElt(node) && node.parentNode &&
		DU.getDataParsoid( node.parentNode ).stx === 'html' &&
		((DU.isList(node.parentNode) && DU.isListItem(node)) ||
		 (node.parentNode.nodeName in {TABLE:1, TBODY:1, TH:1, TR:1} &&
		  node.nodeName in {TBODY:1, CAPTION:1, TH:1, TR:1, TD:1}))
		))
	{
		return {handle: self._htmlElementHandler.bind(self)};
	} else if (self.tagHandlers[nodeName]) {
		handler = self.tagHandlers[nodeName];
		if (!handler.handle) {
			return {handle: self._htmlElementHandler.bind(self), sepnls: handler.sepnls};
		} else {
			return handler || null;
		}
	} else {
		// XXX: check against element whitelist and drop those not on it?
		return {handle: self._htmlElementHandler.bind(self)};
	}
};

/**
 * Check if textNode follows/precedes a link that requires
 * <nowiki/> escaping to prevent unwanted link prefix/trail parsing.
 */
var getLinkPrefixTailEscapes = function(textNode, env) {
	var node,
		escapes = {
			prefix: '',
			tail: ''
		};

	if (env.conf.wiki.linkTrailRegex &&
		!textNode.nodeValue.match(/^\s/) &&
		env.conf.wiki.linkTrailRegex.test(textNode.nodeValue))
	{
		// Skip past deletion markers
		node = DU.previousNonDeletedSibling(textNode);
		if (node && DU.isElt(node) && node.nodeName === 'A' &&
			/mw:WikiLink/.test(node.getAttribute("rel")))
		{
			escapes.tail = '<nowiki/>';
		}
	}

	if (env.conf.wiki.linkPrefixRegex &&
		!textNode.nodeValue.match(/\s$/) &&
		env.conf.wiki.linkPrefixRegex.test(textNode.nodeValue))
	{
		// Skip past deletion markers
		node = DU.nextNonDeletedSibling(textNode);
		if (node && DU.isElt(node) && node.nodeName === 'A' &&
			/mw:WikiLink/.test(node.getAttribute("rel")))
		{
			escapes.prefix = '<nowiki/>';
		}
	}

	return escapes;
};

/**
 * Serialize the content of a text node
 */
WSP._serializeTextNode = function(node, state, cb) {
	// write out a potential separator?
	var res = node.nodeValue,
		doubleNewlineMatch = res.match(/\n([ \t]*\n)+/g),
		doubleNewlineCount = doubleNewlineMatch && doubleNewlineMatch.length || 0;

	// Deal with trailing separator-like text (at least 1 newline and other whitespace)
	var newSepMatch = res.match(/\n\s*$/);
	res = res.replace(/\n\s*$/, '');

	if (!state.inIndentPre) {
		// Don't strip two newlines for wikitext like this:
		// <div>foo
		//
		// bar</div>
		// The PHP parser won't create paragraphs on lines that also contain
		// block-level tags.
		if (node.parentNode.childNodes.length !== 1 ||
				!DU.isBlockNode(node.parentNode) ||
				//node.parentNode.data.parsoid.stx !== 'html' ||
				doubleNewlineCount !== 1)
		{
			// Strip more than one consecutive newline
			res = res.replace(/\n([ \t]*\n)+/g, '\n');
		}
		// Strip trailing newlines from text content
		//if (node.nextSibling && node.nextSibling.nodeType === node.ELEMENT_NODE) {
		//	res = res.replace(/\n$/, ' ');
		//} else {
		//	res = res.replace(/\n$/, '');
		//}

		// Strip leading newlines. They are already added to the separator source
		// in handleSeparatorText.
		res = res.replace(/^[ \t]*\n/, '');
	}

	// Always escape entities
	res = Util.escapeEntities(res);

	var escapes = getLinkPrefixTailEscapes(node, state.env);
	if (escapes.tail) {
		cb(escapes.tail, node);
	}

	// If not in nowiki and pre context, escape wikitext
	// XXX refactor: Handle this with escape handlers instead!
	state.escapeText = !state.inNoWiki && !state.inHTMLPre;
	cb(res, node);
	state.escapeText = false;

	if (escapes.prefix) {
		cb(escapes.prefix, node);
	}

	//console.log('text', JSON.stringify(res));

	// Move trailing newlines into the next separator
	if (newSepMatch && !state.sep.src) {
		state.sep.src = newSepMatch[0];
		state.sep.lastSourceSep = state.sep.src;
	}
};

/**
 * Emit non-separator wikitext that does not need to be escaped
 */
WSP.emitWikitext = function(text, state, cb, node) {
	// Strip leading newlines. They are already added to the separator source
	// in handleSeparatorText.
	var res = text.replace(/^\n/, '');
	// Deal with trailing newlines
	var newSepMatch = res.match(/\n\s*$/);
	res = res.replace(/\n\s*$/, '');
	cb(res, node);
	state.sep.lastSourceNode = node;
	// Move trailing newlines into the next separator
	if (newSepMatch && !state.sep.src) {
		state.sep.src = newSepMatch[0];
		state.sep.lastSourceSep = state.sep.src;
	}
};

WSP._getDOMAttribs = function( attribs ) {
	// convert to list of key-value pairs
	var out = [],
		ignoreAttribs = {
			'data-parsoid': 1,
			'data-ve-changed': 1,
			'data-parsoid-changed': 1,
			'data-parsoid-diff': 1,
			'data-parsoid-serialize': 1
		};
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		var attrib = attribs.item(i);
		if ( !ignoreAttribs[attrib.name] ) {
			out.push( { k: attrib.name, v: attrib.value } );
		}
	}
	return out;
};

/**
 * Internal worker. Recursively serialize a DOM subtree.
 */
WSP._serializeNode = function( node, state, cb) {
	cb = cb || state.chunkCB;
	var prev, next, nextNode;

	// serialize this node
	switch( node.nodeType ) {
		case node.ELEMENT_NODE:
			// Ignore DiffMarker metas, but clear unmodified node state
			if (DU.isMarkerMeta(node, "mw:DiffMarker")) {
				state.prevNodeUnmodified = state.currNodeUnmodified;
				state.currNodeUnmodified = false;
				state.sep.lastSourceNode = node;
				return node;
			}

			if (state.selserMode) {
				this.trace("NODE: ", node.nodeName,
					"; prev-flag: ", state.prevNodeUnmodified,
					"; curr-flag: ", state.currNodeUnmodified);
			}

			var dp = DU.getDataParsoid( node );
			dp.dsr = dp.dsr || [];

			// Update separator constraints
			var domHandler = this._getDOMHandler(node, state, cb);
			prev = DU.previousNonSepSibling(node) || node.parentNode;
			if (prev) {
				this.updateSeparatorConstraints(state,
						prev,  this._getDOMHandler(prev, state, cb),
						node,  domHandler);
			}

			var handled = false, wrapperUnmodified = false;

			// WTS should not be in a subtree with a modification flag that applies
			// to every node of a subtree (rather than an indication that some node
			// in the subtree is modified).
			if (state.selserMode
				&& !state.inModifiedContent
				&& dp && WTSUtils.isValidDSR(dp.dsr)
				&& (dp.dsr[1] > dp.dsr[0] || dp.fostered || dp.misnested))
			{
				// To serialize from source, we need 3 things of the node:
				// -- it should not have a diff marker
				// -- it should have valid, usable DSR
				// -- it should have a non-zero length DSR
				//    (this is used to prevent selser on synthetic content,
				//     like the category link for '#REDIRECT [[Category:Foo]]')
				//
				// SSS FIXME: Additionally, we can guard against buggy DSR with
				// some sanity checks. We can test that non-sep src content
				// leading wikitext markup corresponds to the node type.
				//
				//  Ex: If node.nodeName is 'UL', then src[0] should be '*'
				//
				//  TO BE DONE
				//
				if (!DU.hasCurrentDiffMark(node, this.env)) {
					state.currNodeUnmodified = true;
					handled = true;

					// If this HTML node will disappear in wikitext because of zero width,
					// then the separator constraints will carry over to the node's children.
					//
					// Since we dont recurse into 'node' in selser mode, we update the
					// separator constraintInfo to apply to 'node' and its first child.
					//
					// We could clear constraintInfo altogether which would be correct (but
					// could normalize separators and introduce dirty diffs unnecessarily).
					if (Consts.ZeroWidthWikitextTags.has(node.nodeName) &&
						node.childNodes.length > 0 &&
						state.sep.constraints.constraintInfo.sepType === 'sibling')
					{
						state.sep.constraints.constraintInfo.onSOL = state.onSOL;
						state.sep.constraints.constraintInfo.sepType = 'parent-child';
						state.sep.constraints.constraintInfo.nodeA = node;
						state.sep.constraints.constraintInfo.nodeB = node.firstChild;
					}

					var out = state.getOrigSrc(dp.dsr[0], dp.dsr[1]);

					// console.warn("USED ORIG");
					this.trace("ORIG-src with DSR[", dp.dsr[0], dp.dsr[1], "]", out);
					cb(out, node);

					// Skip over encapsulated content since it has already been serialized
					var typeOf = node.getAttribute( 'typeof' ) || '';
					if (/(?:^|\s)mw:(?:Transclusion(?=$|\s)|Param(?=$|\s)|Extension\/[^\s]+)/.test(typeOf)) {
						nextNode = DU.skipOverEncapsulatedContent(node);
					}
				} else if (DU.onlySubtreeChanged(node, this.env) &&
					WTSUtils.hasValidTagWidths(dp.dsr) &&
					// In general, we want to avoid nodes with auto-inserted start/end tags
					// since dsr for them might not be entirely trustworthy. But, since wikitext
					// does not have closing tags for tr/td/th in the first place, dsr for them
					// can be trusted.
					//
					// SSS FIXME: I think this is only for b/i tags for which we do dsr fixups.
					// It maybe okay to use this for other tags.
					((!dp.autoInsertedStart && !dp.autoInsertedEnd) || (node.nodeName in {TR:1,TH:1,TD:1})))
				{
					wrapperUnmodified = true;
				}
			}

			if ( !handled ) {
				state.prevNodeUnmodified = state.currNodeUnmodified;
				state.currNodeUnmodified = false;
				// console.warn("USED NEW");
				if ( domHandler && domHandler.handle ) {
					// DOM-based serialization
					try {
						if (state.selserMode && DU.hasInsertedOrModifiedDiffMark(node, this.env)) {
							state.inModifiedContent = true;
							nextNode = domHandler.handle(node, state, cb, wrapperUnmodified);
							state.inModifiedContent = false;
						} else {
							nextNode = domHandler.handle(node, state, cb, wrapperUnmodified);
						}
					} catch(e) {
						this.env.log("error", e);
						this.env.log("error", node.nodeName, domHandler);
					}
					// The handler is responsible for serializing its children
				} else {
					// Used to be token-based serialization
					this.env.log("error", 'No dom handler found for', node.outerHTML);
				}
			}

			// Update end separator constraints
			next = DU.nextNonSepSibling(node) || node.parentNode;
			if (next) {
				this.updateSeparatorConstraints(state,
						node, domHandler,
						next, this._getDOMHandler(next, state, cb));
			}

			break;
		case node.TEXT_NODE:
			state.prevNodeUnmodified = state.currNodeUnmodified;
			state.currNodeUnmodified = false;

			this.trace("TEXT: ", node.nodeValue);

			if (!this.handleSeparatorText(node, state)) {
				// Text is not just whitespace
				prev = DU.previousNonSepSibling(node) || node.parentNode;
				if (prev) {
					this.updateSeparatorConstraints(state,
							prev, this._getDOMHandler(prev, state, cb),
							node, {});
				}
				// regular serialization
				this._serializeTextNode(node, state, cb );
				next = DU.nextNonSepSibling(node) || node.parentNode;
				if (next) {
					//console.log(next.outerHTML);
					this.updateSeparatorConstraints(state,
							node, {},
							next, this._getDOMHandler(next, state, cb));
				}
			}
			break;
		case node.COMMENT_NODE:
			state.prevNodeUnmodified = state.currNodeUnmodified;
			state.currNodeUnmodified = false;

			this.trace("COMMENT: ", "<!--" + node.nodeValue + "-->");

			// delay the newline creation until after the comment
			if (!this.handleSeparatorText(node, state)) {
				cb(WTSUtils.commentWT(node.nodeValue), node);
			}
			break;
		default:
			this.env.log("error", "Unhandled node type:", node.outerHTML);
			break;
	}

	// If handlers didn't provide a valid next node,
	// default to next sibling
	if (nextNode === undefined) {
		nextNode = node.nextSibling;
	}

	return nextNode;
};

/**
 * Serialize an HTML DOM document.
 */
WSP.serializeDOM = function( body, chunkCB, finalCB, selserMode ) {
	if (this.debugging) {
		if (selserMode) {
			console.warn("-----------------selser-mode-----------------");
		} else {
			console.warn("-----------------WTS-mode-----------------");
		}
	}

	var state = new SerializerState(this, this.options);
	try {
		state.selserMode = selserMode || false;

		// Normalize the DOM (coalesces adjacent text body)
		// FIXME: Disabled as this strips empty comments (<!---->).
		//body.normalize();

		// Minimize I/B tags
		minimizeWTQuoteTags(body);

		// Don't serialize the DOM if debugging is disabled
		if (this.debugging) {
			this.trace(" DOM ==> \n", body.outerHTML);
		}

		var chunkCBWrapper = function (cb, chunk, node) {
			state.emitSepAndOutput(chunk, node, cb);

			if (state.serializer.debugging) {
				console.log("OUT:", JSON.stringify(chunk), node && node.nodeName || 'noNode');
			}

			state.atStartOfOutput = false;
		};

		var out = '';
	    if ( ! chunkCB ) {
			state.chunkCB = function(chunk, node) {
				var cb = function ( chunk ) {
					out += chunk;
				};
				chunkCBWrapper(cb, chunk, node);
			};
		} else {
			state.chunkCB = function(chunk, node) {
				chunkCBWrapper(chunkCB, chunk, node);
			};
		}

		state.sep.lastSourceNode = body;
		state.currLine.firstNode = body.firstChild;
		if (body.nodeName !== 'BODY') {
			// FIXME: Do we need this fallback at all?
			this._serializeNode( body, state );
		} else {
			state.serializeChildren(body, state.chunkCB);
		}

		// Handle EOF
		//this.emitSeparator(state, state.chunkCB, body);
		state.chunkCB( '', body );

		if ( finalCB && typeof finalCB === 'function' ) {
			finalCB();
		}

		return chunkCB ? '' : out;
	} catch (e) {
		state.env.log("fatal", e);
		throw e;
	}
};

if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
