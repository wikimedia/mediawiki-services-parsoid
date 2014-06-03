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
 * example, generic A elements are serialized to HTML A tags), but in general
 * support for this is mostly missing.
 *
 * Example issue:
 * <h1><p>foo</p></h1> will serialize to =\nfoo\n= whereas the
 *        correct serialized output would be: =<p>foo</p>=
 *
 * What to do about this?
 * * add a generic 'can this HTML node be serialized to wikitext in this
 *   context' detection method and use that to adaptively switch between
 *   wikitext and HTML serialization.
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
	this.options.rtTesting = this.env.conf.parsoid.rtTestMode;

	// Tag handlers
	this.tagHandlers = TagHandlers;

	// Used in multiple tag handlers, and hence added as top-level properties
	// - linkHandler is used by <a> and <link>
	// - figureHandler is used by <figure> and by <a>.linkHandler above
	this.linkHandler = LinkHandlersModule.linkHandler;
	this.figureHandler = LinkHandlersModule.figureHandler;

	// WT escaping handlers
	this.wteHandlers = new WTEModule.WikitextEscapeHandlers(this.env, this);

	// Separator handling
	this.handleSeparatorText = SeparatorsModule.handleSeparatorText;
	this.updateSeparatorConstraints = SeparatorsModule.updateSeparatorConstraints;
	this.emitSeparator = SeparatorsModule.emitSeparator;

	this.logType = this.options.logType || "trace/wts";
	this.trace = this.env.log.bind(this.env, this.logType);
}

var WSP = WikitextSerializer.prototype;

WSP.serializeHTML = function(opts, html) {
	opts.logType = this.logType;
	return (new WikitextSerializer(opts)).serializeDOM(DU.parseHTML(html).body);
};

WSP.getAttributeKey = function(node, key) {
	var tplAttrs = DU.getDataMw(node).attribs;
	if (tplAttrs) {
		// If this attribute's key is generated content,
		// serialize HTML back to generator wikitext.
		for (var i = 0; i < tplAttrs.length; i++) {
			if (tplAttrs[i][0].txt === key && tplAttrs[i][0].html) {
				return this.serializeHTML({ env: this.env, onSOL: false }, tplAttrs[i][0].html);
			}
		}
	}

	return key;
};

WSP.getAttributeValue = function(node, key, value) {
	var tplAttrs = DU.getDataMw(node).attribs;
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

	return value;
};

WSP.serializedAttrVal = function(node, name) {
	var v = this.getAttributeValue(node, name, null);
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
	var v = this.getAttributeValue(dataMWnode, key, null);
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
			v = this.getAttributeValue(node, kv.k, v);

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
				var m = fc.nodeValue.match(/^\n/);
				lostLine = m && m[0] || '';
			}

			if (!lostLine && DU.getDataParsoid( node ).strippedNL) {
				lostLine = '\n';
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

	srcParts.forEach(function(part) {
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

						var value, escapedValue,
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

						// TODO: Other formats?
						// Only consider the html parameter if the wikitext one
						// isn't present at all. If it's present but empty that's
						// still considered a valid parameter.
						if (tpl.params[k].wt !== undefined) {
							value = tpl.params[k].wt;
						} else {
							value = WSP.serializeHTML({
								env: state.env},
								tpl.params[k].html);
						}
						escapedValue = serializer.wteHandlers.escapeTplArgWT(state, value, opts);

						if (paramInfo.spc) {
							spc = paramInfo.spc;
						} //else {
							// TODO: match the space style of other/ parameters!
							//spc = ['', ' ', ' ', ''];
						//}

						if (escapedValue.serializeAsNamed) {
							// Escape as value only
							// Trim WS
							argBuf.push(spc[0] + k + spc[1] + "=" + spc[2] + escapedValue.v.trim() + spc[3]);
						} else {
							numericIndex++;
							// Escape as positional parameter
							// No WS trimming
							argBuf.push(escapedValue.v);
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
	// FIXME: with no dataAttribs, shadow info will mark it as new
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
				logType: this.logType,
				env: state.env,
				extName: extName
			});
			srcParts.push(wts.serializeDOM(DU.parseHTML(dataMW.body.html).body));
		} else if (dataMW.body.extsrc !== null && dataMW.body.extsrc !== undefined) {
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

	if (!node || !DU.isElt(node)) {
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
					dataMW = DU.getDataMw(node);
					if (dataMW.parts) {
						src = state.serializer._buildTemplateWT(node,
								state, dataMW.parts );
					} else if (dp.src) {
						self.env.log("error", "No data-mw for" + node.outerHTML );
						src = dp.src;
					} else {
						throw new Error("Can't serialize transclusion without parts or src!");
					}
				} else if (/(?:^|\s)mw:Param(?=$|\s)/.test(typeOf)) {
					src = dp.src;
				} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
					dataMW = DU.getDataMw(node);
					if (dataMW.name) {
						src = state.serializer._buildExtensionWT(state, node, dataMW);
					} else if (dp.src) {
						self.env.log("error", "No data-mw for" + node.outerHTML );
						src = dp.src;
					} else {
						throw new Error("Can't serialize extension without name or src!");
					}
				} else {
					throw new Error("Should never reach here");
				}

				// FIXME: Just adding this here temporarily till we go in and
				// clean this up and strip this out if we can verify that data-mw
				// is going to be present always when necessary and indicate that
				// a missing data-mw is either a parser bug or a client error.
				//
				// Fallback: should be exercised only in exceptional situations.
				if (src === undefined && state.env.page.src && WTSUtils.isValidDSR(dp.dsr) && !dp.fostered) {
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
	if ((dp.stx === 'html' && nodeName !== 'pre') ||
		(DU.isNewElt(node) && node.parentNode && node.nodeName !== 'BODY' &&
		DU.getDataParsoid( node.parentNode ).stx === 'html' &&
		((DU.isList(node.parentNode) && DU.isListItem(node)) ||
		 (node.parentNode.nodeName in {TABLE:1, TBODY:1, TH:1, TR:1} &&
		  node.nodeName in {TBODY:1, CAPTION:1, TH:1, TR:1, TD:1}))
		))
	{
		return {handle: self._htmlElementHandler.bind(self)};
	} else if (self.tagHandlers[nodeName]) {
		handler = self.tagHandlers[nodeName];
		if (!handler.handle || (nodeName === 'pre' && dp.stx === 'html')) {
			return {handle: self._htmlElementHandler.bind(self), sepnls: handler.sepnls};
		} else {
			return handler || null;
		}
	} else {
		// XXX: check against element whitelist and drop those not on it?
		return {handle: self._htmlElementHandler.bind(self)};
	}
};

/*
 * Get a regexp that let us test whether the text node
 * following a URL-link requires a nowiki before it.
 *
 * The two regexps comes from the PHP parser's EXT_LINK_URL_CLASS regexp
 */
var src1 = /^\[\]<>"\x00-\x20\x7F\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000/.source;
var src2 = ',.:;!?';
var autoURLNowikiTest1, autoURLNowikiTest2;

function getAutoURLNowikiTest(href) {
	if (/\(/.test(href)) {
		if (!autoURLNowikiTest1) {
			// Whitespace terminates url matching
			autoURLNowikiTest1 = new RegExp("^([" + src1 + src2 + "]|[" + src2 + "]+([^" + src2 + "\\s]))");
		}

		return autoURLNowikiTest1;
	} else {
		if (!autoURLNowikiTest2) {
			// Since the href doesnt have a '(' in it, a ')' char won't become
			// part of the url and doesn't need nowiki escaping.
			var src3 = src2 + ')';

			// Whitespace terminates url matching
			autoURLNowikiTest2 = new RegExp("^([" + src1 + src3 + "]|[" + src3 + "]+([^" + src3 + "\\s]))");
		}

		return autoURLNowikiTest2;
	}
}

/**
 * Check if textNode follows/precedes a link that requires
 * - <nowiki/> escaping to prevent unwanted link prefix/trail parsing
 * - OR <nowiki/> escaping to preserve a url link
 *
 * FIXME: This doesn't account for the fact that in the future,
 * trailing/leading newlines might get stripped out because of
 * separator constraints (Ex: <li> content that might get serialized
 * onto a single line).
 */
var getLinkPreservingNowikis = function(textNode, env) {
	function requiresLinkSuffixNowiki(aNode, text) {
		var href = aNode.getAttribute("href");
		var magicLinkMatch = env.conf.wiki.ExtResourceURLPatternMatcher.match(href);
		if (magicLinkMatch) {
			var linkType = magicLinkMatch[0];
			return ((linkType === "RFC" || linkType === "PMID") && text.match(/^\d/)) ||
				(linkType === "ISBN" && text.match(/^\w/));
		} else {
			return getAutoURLNowikiTest(href).test(text);
		}
		return false;
	}

	function requiresLinkPrefixNowiki(aNode, text) {
		var href = aNode.getAttribute("href");
		var magicLinkMatch = env.conf.wiki.ExtResourceURLPatternMatcher.match(href);
		if (magicLinkMatch) {
			// This will change once wt2html changes to match
			// magic-link keywords only on a word boundary.
			return false;
		} else {
			return text.match(/\w$/);
		}
		return false;
	}

	var node,
		wikiConfig = env.conf.wiki,
		escapes = {
			prefix: '',
			suffix: ''
		};

	// This is a quick test to handle common scenarios
	// when escaping is not needed.
	var text = textNode.nodeValue;
	if (!text.match(/^\s/)) {
		// Skip past deletion markers
		node = DU.previousNonDeletedSibling(textNode);
		if (node && node.nodeName === 'A'
			&& ((DU.usesURLLinkSyntax(node) && requiresLinkSuffixNowiki(node, text))
				|| (DU.usesWikiLinkSyntax(node) &&
					wikiConfig.linkTrailRegex &&
					wikiConfig.linkTrailRegex.test(text))
				)
			)
		{
			escapes.suffix = '<nowiki/>';
		}
	}

	// This is a quick test to handle common scenarios
	// when escaping is not needed.
	if (!text.match(/\s$/)) {
		// Skip past deletion markers
		node = DU.nextNonDeletedSibling(textNode);
		if (node && node.nodeName === 'A'
			&& ((DU.usesURLLinkSyntax(node) && requiresLinkPrefixNowiki(node, text))
				|| (DU.usesWikiLinkSyntax(node) &&
					wikiConfig.linkPrefixRegex &&
					wikiConfig.linkPrefixRegex.test(text))
				)
			)
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
		if (!state.inHTMLPre && (!DU.allChildrenAreText(node.parentNode) ||
			!DU.isBlockNode(node.parentNode) ||
			//node.parentNode.data.parsoid.stx !== 'html' ||
			doubleNewlineCount !== 1))
		{
			// Strip more than one consecutive newline
			res = res.replace(/\n([ \t]*\n)+/g, '\n');
		}
		// Strip trailing newlines from text content
		//if (node.nextSibling && DU.isElt(node.nextSibling)) {
		//	res = res.replace(/\n$/, ' ');
		//} else {
		//	res = res.replace(/\n$/, '');
		//}

		// Strip leading newlines.
		// They are already added to the separator source in handleSeparatorText.
		res = res.replace(/^[ \t]*\n+/, '');
	}

	// Always escape entities
	res = Util.escapeEntities(res);

	var escapes = getLinkPreservingNowikis(node, state.env);
	if (escapes.suffix) {
		cb(escapes.suffix, node);
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
	if (newSepMatch) {
		if (!state.sep.src) {
			state.sep.src = newSepMatch[0];
			state.sep.lastSourceSep = state.sep.src;

			// Since we are stashing away newlines for emitting
			// before the next element, we are in SOL state wrt
			// the content of that next element.
			//
			// FIXME: The only serious caveat is if all these newlines
			// will get stripped out in the context of any parent node
			// that suppress newlines (ex: <li> nodes that are forcibly
			// converted to non-html wikitext representation -- newlines
			// will get suppressed in those context). We currently don't
			// handle arbitrary HTML which cause these headaches. And,
			// in any case, we might decide to emit such HTML as native
			// HTML to avoid these problems. To be figured out later when
			// it is a real issue.
			state.onSOL = true;
		} else {
			/* jshint noempty: false */
			/* SSS FIXME: what are we doing with the stripped NLs?? */
		}
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

function traceNodeName(node) {
	switch (node.nodeType) {
	case node.ELEMENT_NODE:
	   return DU.isMarkerMeta(node, "mw:DiffMarker") ? "DIFF_MARK" : "NODE: " + node.nodeName;
	case node.TEXT_NODE:
	   return "TEXT: " + JSON.stringify(node.nodeValue);
	case node.COMMENT_NODE:
	   return "CMT : " + JSON.stringify(WTSUtils.commentWT(node.nodeValue));
	default:
	   return node.nodeName;
	}
}

/**
 * Internal worker. Recursively serialize a DOM subtree.
 */
WSP._serializeNode = function( node, state, cb ) {
	var prev, next, nextNode;

	// Default update
	state.prevNodeUnmodified = state.currNodeUnmodified;
	state.currNodeUnmodified = false;

	if (state.selserMode) {
		this.trace(function() { return traceNodeName(node); },
			"; prev-unmodified: ", state.prevNodeUnmodified,
			"; SOL: ", state.onSOL);
	} else {
		this.trace(function() { return traceNodeName(node); },
			"; SOL: ", state.onSOL);
	}

	// serialize this node
	switch( node.nodeType ) {
		case node.ELEMENT_NODE:
			// Ignore DiffMarker metas, but clear unmodified node state
			if (DU.isMarkerMeta(node, "mw:DiffMarker")) {
				state.sep.lastSourceNode = node;
				return node.nextSibling;
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
					this.trace("ORIG-src with DSR", function() {
							return '[' + dp.dsr[0] + ',' + dp.dsr[1] + '] = ' + JSON.stringify(out);
						});
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
						this.env.log("fatal", e);
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
	this.logType = selserMode ? "trace/selser" : "trace/wts";
	this.trace = this.env.log.bind(this.env, this.logType);

	var state = new SerializerState(this, this.options);
	try {
		// Minimize I/B tags
		minimizeWTQuoteTags(body);

		// Don't serialize the DOM if debugging is disabled
		this.env.log(this.logType, function() {
			return "--- DOM --- \n" + body.outerHTML + "\n-----------";
		});

		// If no chunkCB is provided, use an accumulator CB
		var out = '';
	    if (!chunkCB) {
			chunkCB = function(chunk) { out += chunk; };
		}

		// Init state
		state.selserMode = selserMode || false;
		state.sep.lastSourceNode = body;
		state.currLine.firstNode = body.firstChild;

		// Wrapper CB for every chunk that emits any required separators
		// before emitting the chunk itself.
		var chunkCBWrapper = function (chunk, node) {
			state.emitSepAndOutput(chunk, node, chunkCB, "OUT:");
			state.atStartOfOutput = false;
		};

		// Kick it off
		if (body.nodeName !== 'BODY') {
			// SSS FIXME: Do we need this fallback at all?
			this._serializeNode( body, state, chunkCBWrapper );
		} else {
			state.serializeChildren(body, chunkCBWrapper);
		}

		// Handle EOF
		chunkCBWrapper( '', body );

		if ( finalCB && typeof finalCB === 'function' ) {
			finalCB();
		}

		return out;
	} catch (e) {
		state.env.log("fatal", e);
		throw e;
	}
};

if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
