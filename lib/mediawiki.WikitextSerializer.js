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

'use strict';
require('./core-upgrade.js');

var util = require('util');
var wtConsts = require('./mediawiki.wikitext.constants.js');
var Util = require('./mediawiki.Util.js').Util;
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var WTSUtils = require('./wts.utils.js').WTSUtils;
var pd = require('./mediawiki.parser.defines.js');
var ConstrainedText = require('./wts.ConstrainedText.js').ConstrainedText;
var Normalizer = require('./wts.normalizeDOM.js').Normalizer;
var SerializerState = require('./wts.SerializerState.js').SerializerState;
var TagHandlers = require('./wts.TagHandlers.js').TagHandlers;
var LinkHandlersModule = require('./wts.LinkHandler.js');
var SeparatorsModule = require('./wts.separators.js');
var WTEModule = require('./wts.escapeWikitext.js');

var Consts = wtConsts.WikitextConstants;


/**
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 *
 * @class
 * @constructor
 * @param {Object} options List of options for serialization
 * @param {MWParserEnvironment} options.env
 * @param {boolean} [options.rtTestMode]
 * @param {string} [options.logType="trace/wts"]
 */
function WikitextSerializer(options) {
	this.options = options;
	this.env = options.env;

	// Set rtTestMode if not already set.
	if (this.options.rtTestMode === undefined) {
		this.options.rtTestMode = this.env.conf.parsoid.rtTestMode;
	}

	// WT escaping handlers
	this.wteHandlers = new WTEModule.WikitextEscapeHandlers(this.env, this);

	this.logType = this.options.logType || "trace/wts";
	this.trace = this.env.log.bind(this.env, this.logType);
}

var WSP = WikitextSerializer.prototype;

// Tag handlers
WSP.tagHandlers = TagHandlers;

// Used in multiple tag handlers, and hence added as top-level properties
// - linkHandler is used by <a> and <link>
// - figureHandler is used by <figure> and by <a>.linkHandler above
WSP.linkHandler = LinkHandlersModule.linkHandler;
WSP.figureHandler = LinkHandlersModule.figureHandler;

// Separator handling
WSP.handleSeparatorText = SeparatorsModule.handleSeparatorText;
WSP.updateSeparatorConstraints = SeparatorsModule.updateSeparatorConstraints;
WSP.buildAndEmitSep = SeparatorsModule.buildAndEmitSep;

// Methods

WSP.serializeHTML = function(opts, html) {
	opts.logType = this.logType;
	var body = DU.parseHTML(html).body;
	return (new WikitextSerializer(opts)).serializeDOMSync(body);
};

WSP.getAttributeKey = function(node, key) {
	var tplAttrs = DU.getDataMw(node).attribs;
	if (tplAttrs) {
		// If this attribute's key is generated content,
		// serialize HTML back to generator wikitext.
		for (var i = 0; i < tplAttrs.length; i++) {
			var a = tplAttrs[i];
			if (a[0].txt === key && a[0].html) {
				return this.serializeHTML({ env: this.env, onSOL: false }, a[0].html);
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
			// !== null is required. html:"" will serialize to "" and will
			// be returned here. This is used to suppress the =".." string
			// in the attribute in scenarios where the template generates
			// a "k=v" string. Ex: <div {{echo|1=style='color:red'}}>foo</div>
			if (a[0] === key || a[0].txt === key && a[1].html !== null) {
				return this.serializeHTML({ env: this.env, onSOL: false, inAttribute: true }, a[1].html);
			}
		}
	}
	return value;
};

WSP.serializedAttrVal = function(node, name) {
	return this.serializedImageAttrVal(node, node, name);
};

WSP.serializedImageAttrVal = function(dataMWnode, htmlAttrNode, key) {
	var v = this.getAttributeValue(dataMWnode, key, null);
	if (v) {
		return {
			value: v,
			modified: false,
			fromsrc: true,
			fromDataMW: true,
		};
	} else {
		return DU.getAttributeShadowInfo(htmlAttrNode, key);
	}
};

WSP._serializeHTMLTag = function(state, node, wrapperUnmodified) {
	// 'inHTMLPre' flag has to be updated always,
	// even when we are selsering in the wrapperUnmodified case.
	var token = DU.mkTagTk(node);
	if (token.name === 'pre') {
		// html-syntax pre is very similar to nowiki
		state.inHTMLPre = true;
	}

	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid(node).dsr;
		return state.getOrigSrc(dsr[0], dsr[0] + dsr[2]);
	}

	var da = token.dataAttribs;
	if (da.autoInsertedStart) {
		return '';
	}

	var close = '';
	if ((Util.isVoidElement(token.name) && !da.noClose) || da.selfClose) {
		close = ' /';
	}

	var sAttribs = this._serializeAttributes(state, node, token);
	if (sAttribs.length > 0) {
		sAttribs = ' ' + sAttribs;
	}

	var tokenName = da.srcTagName || token.name;
	var ret = util.format('<%s%s%s>', tokenName, sAttribs, close);

	if (tokenName.toLowerCase() === 'nowiki') {
		ret = DU.escapeNowikiTags(ret);
	}

	return ret;
};

WSP._serializeHTMLEndTag = function(state, node, wrapperUnmodified) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid(node).dsr;
		return state.getOrigSrc(dsr[1] - dsr[3], dsr[1]);
	}

	var token = DU.mkEndTagTk(node);
	if (token.name === 'pre') {
		state.inHTMLPre = false;
	}

	var tokenName = token.dataAttribs.srcTagName || token.name;
	var ret = '';

	if (!token.dataAttribs.autoInsertedEnd &&
			!Util.isVoidElement(token.name) &&
			!token.dataAttribs.selfClose) {
		ret = util.format('</%s>', tokenName);
	}

	if (tokenName.toLowerCase() === 'nowiki') {
		ret = DU.escapeNowikiTags(ret);
	}

	return ret;
};

var IGNORED_ATTRIBUTES = new Set([
	'data-parsoid',
	'data-ve-changed',
	'data-parsoid-changed',
	'data-parsoid-diff',
	'data-parsoid-serialize',
]);

var PARSOID_ATTRIBUTES = new Map([
	[ 'about', /^#mwt\d+$/ ],
	[ 'typeof', /(^|\s)mw:[^\s]+/g ],
]);

WSP._serializeAttributes = function(state, node, token) {
	var tokType = token.getAttribute("typeof");
	var attribs = token.attribs;
	var out = [];
	var vInfo, v, kv, k, tplKV, tplK, tplV;
	for (var i = 0, l = attribs.length; i < l; i++) {
		kv = attribs[i];
		k = kv.k;

		// Unconditionally ignore
		// (all of the IGNORED_ATTRIBUTES should be filtered out earlier,
		// but ignore them here too just to make sure.)
		if (IGNORED_ATTRIBUTES.has(k) || k === 'data-mw') {
			continue;
		}

		// Ignore parsoid-like ids. They may have been left behind
		// by clients and shouldn't be serialized. This can also happen
		// in v2 API when there is no matching data-parsoid entry found
		// for this id.
		if (k === "id" && /^mw[\w-]{2,}$/.test(kv.v)) {
			if (!node.getAttribute("data-parsoid")) {
				state.env.log("warning/html2wt",
					"Parsoid id found on element without a matching data-parsoid " +
					"entry: ID=" + kv.v + "; ELT=" + node.outerHTML);
			} else {
				vInfo = token.getAttributeShadowInfo(k);
				if (!vInfo.modified && vInfo.fromsrc) {
					out.push(k + '=' + '"' + vInfo.value.replace(/"/g, '&quot;') + '"');
				}
			}
			continue;
		}

		// Strip other Parsoid-generated values
		//
		// FIXME: Given that we are currently escaping about/typeof keys
		// that show up in wikitext, we could unconditionally strip these
		// away right now.
		var parsoidValueRegExp = PARSOID_ATTRIBUTES.get(k);
		if (parsoidValueRegExp && kv.v.match(parsoidValueRegExp)) {
			v = kv.v.replace(parsoidValueRegExp, '');
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
			k = k.replace(/^data-x-/i, '');

			if (v.length > 0) {
				if (!vInfo.fromsrc) {
					// Escape HTML entities
					v = Util.escapeEntities(v);
				}
				out.push(k + '=' + '"' + v.replace(/"/g, '&quot;') + '"');
			} else if (k.match(/[{<]/)) {
				// Templated, <*include*>, or <ext-tag> generated
				out.push(k);
			} else {
				out.push(k + '=""');
			}
		} else if (kv.v.length) {
			// not very likely..
			out.push(kv.v);
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
					out.push(k + '=' + '"' + v.replace(/"/g, '&quot;') + '"');
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

WSP._handleLIHackIfApplicable = function(node, cb) {
	var liHackSrc = DU.getDataParsoid(node).liHackSrc;
	var prev = DU.previousNonSepSibling(node);

	// If we are dealing with an LI hack, then we must ensure that
	// we are dealing with either
	//
	//   1. A node with no previous sibling inside of a list.
	//
	//   2. A node whose previous sibling is a list element.
	if (liHackSrc !== undefined &&
			((prev === null && DU.isList(node.parentNode)) ||       // Case 1
			(prev !== null && DU.isListItem(prev)))) {              // Case 2
		cb(liHackSrc, node);
	}
};

WSP._htmlElementHandler = function(node, state, cb, wrapperUnmodified) {
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

			var lostLine = '';
			var fc = node.firstChild;
			if (fc && DU.isText(fc)) {
				var m = fc.nodeValue.match(/^\n/);
				lostLine = m && m[0] || '';
			}

			if (!lostLine && DU.getDataParsoid(node).strippedNL) {
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

	var buf = '';
	var serializer = this;
	var dp = DU.getDataParsoid(node);

	srcParts.forEach(function(part) {
		var tpl = part.template;
		if (tpl) { // transclusion: tpl or parser function
			var isTpl = typeof (tpl.target.href) === 'string';
			buf += "{{";

			// tpl target
			buf += tpl.target.wt;

			// tpl args
			var argBuf = [];
			var keys = Object.keys(tpl.params);
			// per-parameter info for pre-existing parameters
			var paramInfos = dp.pi && tpl.i !== undefined ?
					dp.pi[tpl.i] || [] : [];
			// extract the original keys in order
			var origKeys = paramInfos.map(function(paramInfo) {
				return paramInfo.k;
			});
			var n = keys.length;
			if (n > 0) {
				var argIndex = 1;
				var numericIndex = 1;
				var numPositionalArgs = countPositionalArgs(tpl, paramInfos);
				var pushArg = function(k, paramInfo) {
					if (!paramInfo) {
						paramInfo = {};
					}

					var value;
					var escapedValue;
					var paramName;
					// Default to ' = ' spacing. Anything that matches
					// this does not remember spc explicitly.
					var spc = ['', ' ', ' ', ''];
					var opts = {
						serializeAsNamed: false,
						isTemplate: isTpl,
						argPositionalIndex: numericIndex,
						numPositionalArgs: numPositionalArgs,
						argIndex: argIndex++,
						numArgs: n,
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
						value = serializer.serializeHTML(
							{ env: state.env },
							tpl.params[k].html
						);
					}

					if (typeof value !== "string") {
						state.env.log("error/html2wt/spec",
							"For param: ", k,
							", wt property should be a string but got: ",
							value);
						// This is a temporary fix. Once T90463 is fixed,
						// we should log the error above, and maybe return
						// an error to VE. In any case, we shouldn't be
						// crashing. See T90479.
						value = Util.tokensToString(value);
					}

					escapedValue = serializer.wteHandlers.escapeTplArgWT(state, value, opts);

					if (paramInfo.spc) {
						spc = paramInfo.spc;
					} else if (opts.serializeAsNamed && k === "") {
						// No spacing for blank parameters ({{foo|=bar}})
						spc = ['', '', '', ''];
					} // else {
					// TODO: match the space style of other/ parameters!
					// spc = ['', ' ', ' ', ''];
					// }

					// The name is usually equal to the parameter key, but
					// if there's a key.wt attribute, use that.
					if (tpl.params[k].key && tpl.params[k].key.wt !== undefined) {
						paramName = tpl.params[k].key.wt;
						// And make it appear even if there wasn't
						// data-parsoid information.
						escapedValue.serializeAsNamed = true;
					} else {
						paramName = k;
					}

					if (escapedValue.serializeAsNamed) {
						// Escape as value only
						// Trim WS
						argBuf.push(spc[0] + paramName + spc[1] + "=" +
							spc[2] + escapedValue.v.trim() + spc[3]);
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
	var extName = dataMW.name;
	var srcParts = ["<", extName];

	// Serialize extension attributes in normalized form as:
	// key='value'
	// FIXME: with no dataAttribs, shadow info will mark it as new
	var attrs = dataMW.attrs || {};
	var extTok = new pd.TagTk(extName, Object.keys(attrs).map(function(k) {
		return new pd.KV(k, attrs[k]);
	}));
	var about = node.getAttribute('about');
	var type = node.getAttribute('typeof');

	if (about) {
		extTok.addAttribute('about', about);
	}
	if (type) {
		extTok.addAttribute('typeof', type);
	}
	var attrStr = this._serializeAttributes(state, node, extTok);

	if (attrStr) {
		srcParts.push(' ');
		srcParts.push(attrStr);
	}

	// Serialize body
	if (!dataMW.body) {
		srcParts.push(" />");
	} else {
		srcParts.push(">");
		if (typeof dataMW.body.html === 'string' ||
				typeof dataMW.body.id === 'string') {
			var htmlText;
			// First look for the extension's content in data-mw.body.html
			if (dataMW.body.html) {
				htmlText = dataMW.body.html;
			} else {
				// If the body isn't contained in data-mw.body.html, look if
				// there's an element pointed to by body.id.
				var bodyElt = node.ownerDocument.getElementById(dataMW.body.id);
				if (!bodyElt && state.env.page.editedDoc) {
					// Try to get to it from the main page.
					// This can happen when the <ref> is inside another extension,
					// most commonly inside a <references>.
					bodyElt = state.env.page.editedDoc.getElementById(dataMW.body.id);
				}
				if (bodyElt) {
					htmlText = bodyElt.innerHTML;
				} else {
					// Some extra debugging for VisualEditor
					var extraDebug = '';
					var firstA = node.querySelector('a[href]');
					if (firstA && /^#/.test(firstA.getAttribute('href'))) {
						var href = firstA.getAttribute('href');
						var ref = node.ownerDocument.querySelector(href);
						if (ref) {
							extraDebug += ' [own doc: ' + ref.outerHTML + ']';
						}
						ref = state.env.page.editedDoc.querySelector(href);
						if (ref) {
							extraDebug += ' [main doc: ' + ref.outerHTML + ']';
						}
						if (!extraDebug) {
							extraDebug = ' [reference ' + href + ' not found]';
						}
					}

					// Log an error and drop the extension call
					state.env.log("error/" + extName,
						"extension src id " + dataMW.body.id + " points to non-existent element for:",
						node.outerHTML, ". Dropping the extension. More debug info: ", extraDebug);
					return '';
				}
			}
			if (htmlText) {
				srcParts.push(this.serializeHTML({
					env: state.env,
					extName: extName,
				}, htmlText));
			}
		} else if (dataMW.body.extsrc !== null && dataMW.body.extsrc !== undefined) {
			srcParts.push(dataMW.body.extsrc);
		} else {
			this.env.log("error", "extension src unavailable for: " + node.outerHTML);
		}
		srcParts = srcParts.concat(["</", extName, ">"]);
	}

	return srcParts.join('');
};

/**
 * Get a DOM-based handler for an element node
 */
WSP._getDOMHandler = function(node, state, cb) {
	if (!node || !DU.isElt(node)) {
		return {};
	}

	var self = this;
	var dp = DU.getDataParsoid(node);
	var nodeName = node.nodeName.toLowerCase();
	var handler;
	var typeOf = node.getAttribute('typeof') || '';

	// XXX: Convert into separate handlers?
	if (DU.isFirstEncapsulationWrapperNode(node)) {
		return {
			handle: function() {
				var src, dataMW;
				if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
					dataMW = DU.getDataMw(node);
					if (dataMW.parts) {
						src = state.serializer._buildTemplateWT(node, state, dataMW.parts);
					} else if (dp.src) {
						self.env.log("error", "data-mw missing in: " + node.outerHTML);
						src = dp.src;
					} else {
						throw new Error("Cannot serialize transclusion without data-mw.parts or data-parsoid.src.");
					}
				} else if (/(?:^|\s)mw:Param(?=$|\s)/.test(typeOf)) {
					if (dp.src) {
						src = dp.src;
					} else {
						throw new Error("No source for params.");
					}
				} else if (/(?:^|\s)mw:Extension\/LabeledSectionTransclusion/.test(typeOf)) {
					// FIXME: Special case for <section> until LST is implemented
					// natively in Parsoid
					if (dp.src) {
						src = dp.src;
					} else if (typeOf.match('begin')) {
						src = '<section begin="' + node.getAttribute('content') + '" />';
					} else if (typeOf.match('end')) {
						src = '<section end="' + node.getAttribute('content') + '" />';
					} else {
						self.env.log("error", "LST <section> without content in: " + node.outerHTML);
						src = '<section />';
					}
				} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
					dataMW = DU.getDataMw(node);
					if (dataMW.name) {
						src = state.serializer._buildExtensionWT(state, node, dataMW);
					} else if (dp.src) {
						self.env.log("error", "data-mw missing in: " + node.outerHTML);
						src = dp.src;
					} else {
						// If there was no typeOf name, and no dp.src, try getting
						// the name out of the mw:Extension type. This will
						// generate an empty extension tag, but it's better than
						// just an error.
						var extGivenName = typeOf.replace(/(?:^|\s)mw:Extension\/([^\s]+)/, "$1");
						if (extGivenName) {
							self.env.log("error", "no data-mw name for extension in: ", node.outerHTML);
							dataMW.name = extGivenName;
							src = state.serializer._buildExtensionWT(state, node, dataMW);
						} else {
							throw new Error("Cannot serialize extension without data-mw.name or data-parsoid.src.");
						}
					}
				} else {
					throw new Error("Should never reach here");
				}

				state.singleLineContext.disable();
				self.emitWikitext(src, state, cb, node);
				state.singleLineContext.pop();
				return DU.skipOverEncapsulatedContent(node);
			},
			sepnls: {
				// XXX: This is questionable, as the template can expand
				// to newlines too. Which default should we pick for new
				// content? We don't really want to make separator
				// newlines in HTML significant for the semantics of the
				// template content.
				before: function(node, otherNode) {
					if (DU.isNewElt(node)
							&& /(?:^|\s)mw:Extension\/references(?:\s|$)/
								.test(node.getAttribute('typeof'))
							// Only apply to plain references tags
							&& !/(?:^|\s)mw:Transclusion(?:\s|$)/
								.test(node.getAttribute('typeof'))) {
						// Serialize new references tags on a new line
						return { min: 1, max: 2 };
					} else {
						return { min: 0, max: 2 };
					}
				},
			},
		};
	}

	if (dp.src !== undefined) {
		if (/(^|\s)mw:Placeholder(\/\w*)?$/.test(typeOf) ||
				(typeOf === "mw:Nowiki" && node.textContent === dp.src)) {
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
				},
			};
		} else if (typeOf === "mw:Entity" && node.childNodes.length === 1) {
			var contentSrc = node.textContent || node.innerHTML;
			return {
				handle: function() {
					if (contentSrc === dp.srcContent) {
						self.emitWikitext(dp.src, state, cb, node);
					} else {
						self.emitWikitext(contentSrc, state, cb, node);
					}
				},
			};
		}
	}

	// Handle html pres
	if (nodeName === 'pre' && dp.stx === 'html') {
		return {
			handle: self._htmlElementHandler.bind(self),
			sepnls: self.tagHandlers[nodeName].sepnls,
		};
	// If parent node is a list or table tag in html-syntax, then serialize
	// new elements in html-syntax rather than wiki-syntax.
	// Anchor elements should never serialize as html, regardless of what
	// data-parsoid has to say about the matter.
	} else if (nodeName !== "a" && (dp.stx === 'html' ||
		(DU.isNewElt(node) && !DU.atTheTop(node) &&
		!DU.isDocumentFragment(node.parentNode) &&
		DU.getDataParsoid(node.parentNode).stx === 'html' &&
		((DU.isList(node.parentNode) && DU.isListItem(node)) ||
			(Consts.ParentTableTags.has(node.parentNode.nodeName) &&
			Consts.ChildTableTags.has(node.nodeName)))
	))) {
		return { handle: self._htmlElementHandler.bind(self) };
	} else if (self.tagHandlers[nodeName]) {
		handler = self.tagHandlers[nodeName];
		if (!handler.handle) {
			return {
				handle: self._htmlElementHandler.bind(self),
				sepnls: handler.sepnls,
			};
		} else {
			return handler || null;
		}
	} else {
		// XXX: check against element whitelist and drop those not on it?
		return { handle: self._htmlElementHandler.bind(self) };
	}
};

/**
 * Serialize the content of a text node
 */
WSP._serializeTextNode = function(node, state, cb) {
	// write out a potential separator?
	var res = node.nodeValue;
	var doubleNewlineMatch = res.match(/\n([ \t]*\n)+/g);
	var doubleNewlineCount = doubleNewlineMatch && doubleNewlineMatch.length || 0;

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
			doubleNewlineCount !== 1)) {
			// Strip more than one consecutive newline
			res = res.replace(/\n([ \t]*\n)+/g, '\n');
		}
		// Strip trailing newlines from text content
		// if (node.nextSibling && DU.isElt(node.nextSibling)) {
		// 	res = res.replace(/\n$/, ' ');
		// } else {
		// 	res = res.replace(/\n$/, '');
		// }

		// Strip leading newlines and other whitespace
		// They are already added to the separator source in handleSeparatorText.
		res = res.replace(/^[ \t]*\n+\s*/, '');
	}

	// Always escape entities
	res = Util.escapeEntities(res);

	// If not in nowiki and pre context, escape wikitext
	// XXX refactor: Handle this with escape handlers instead!
	state.escapeText = (state.onSOL || !state.currNodeUnmodified) && !state.inNoWiki && !state.inHTMLPre;
	cb(res, node);
	state.escapeText = false;

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

WSP._getDOMAttribs = function(attribs) {
	// convert to list of key-value pairs
	var out = [];
	for (var i = 0, l = attribs.length; i < l; i++) {
		var attrib = attribs.item(i);
		if (!IGNORED_ATTRIBUTES.has(attrib.name)) {
			out.push({ k: attrib.name, v: attrib.value });
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
WSP._serializeNode = function(node, state, cb) {
	var prev, next, nextNode;

	if (state.selserMode) {
		this.trace(function() { return traceNodeName(node); },
			"; prev-unmodified: ", state.prevNodeUnmodified,
			"; SOL: ", state.onSOL);
	} else {
		this.trace(function() { return traceNodeName(node); },
			"; SOL: ", state.onSOL);
	}

	// serialize this node
	switch (node.nodeType) {
		case node.ELEMENT_NODE:

			// Ignore DiffMarker metas, but clear unmodified node state
			if (DU.isMarkerMeta(node, "mw:DiffMarker")) {
				state.sep.lastSourceNode = node;
				// Update modification flags
				state.updateModificationFlags(node);
				return node.nextSibling;
			}

			var dp = DU.getDataParsoid(node);
			dp.dsr = dp.dsr || [];

			// Update separator constraints
			var domHandler = this._getDOMHandler(node, state, cb);
			prev = DU.previousNonSepSibling(node) || node.parentNode;
			if (prev) {
				this.updateSeparatorConstraints(state,
						prev,  this._getDOMHandler(prev, state, cb),
						node,  domHandler);
			}

			var handled = false;
			var wrapperUnmodified = false;

			// To serialize a node from source, the node should satisfy these conditions:
			// 1. It should not have a diff marker or be in a modified subtree
			//    WTS should not be in a subtree with a modification flag that applies
			//    to every node of a subtree (rather than an indication that some node
			//    in the subtree is modified).
			//
			// 2. It should continue to be valid in any surrounding edited context
			//    For some nodes, modification of surrounding context
			//    can change serialized output of this node
			//    (ex: <td>s and whether you emit | or || for them)
			//
			// 3. It should have valid, usable DSR
			//
			// 4. Either it has non-zero positive DSR width, or meets one of the following
			//    4a. It is content like <p><br/><p> or an
			//        automatically-inserted wikitext <references/> (HTML <ol>)
			//        (will have dsr-width 0)
			//    4b. it is fostered content (will have dsr-width 0)
			//    4c. it is misnested content (will have dsr-width 0)
			//
			// SSS FIXME: Additionally, we can guard against buggy DSR with
			// some sanity checks. We can test that non-sep src content
			// leading wikitext markup corresponds to the node type.
			//
			//  Ex: If node.nodeName is 'UL', then src[0] should be '*'
			//
			//  TO BE DONE

			if (state.selserMode
				&& !state.inModifiedContent
				&& DU.origSrcValidInEditedContext(state.env, node)
				&& dp && Util.isValidDSR(dp.dsr)
				&& (dp.dsr[1] > dp.dsr[0]
						// FIXME: <p><br/></p>
						// nodes that have dsr width 0 because currently,
						// we emit newlines outside the p-nodes. So, this check
						// tries to handle that scenario.
						// Zero-width <ol> corresponds to automatically-inserted
						// <references/> nodes.
					|| (dp.dsr[1] === dp.dsr[0] && /^(P|BR|OL)$/.test(node.nodeName))
					|| dp.fostered || dp.misnested)) {
				if (!DU.hasDiffMarkers(node, this.env)) {
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
					if (DU.isZeroWidthWikitextElt(node) &&
						node.childNodes.length > 0 &&
						state.sep.constraints.constraintInfo.sepType === 'sibling') {
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

					// When reusing source, we should only suppress serializing
					// to a single line for the cases we've whitelisted in
					// normal serialization.
					var suppressSLC = DU.isFirstEncapsulationWrapperNode(node) ||
							['DL', 'UL', 'OL'].indexOf(node.nodeName) > -1 ||
							(node.nodeName === 'TABLE' &&
								node.parentNode.nodeName === 'DD' &&
								DU.previousNonSepSibling(node) === null);

					// Use selser to serialize this text!  The original
					// wikitext is `out`.  But first allow
					// `ConstrainedText.fromSelSer` to figure out the right
					// type of ConstrainedText chunk(s) to use to represent
					// `out`, based on the node type.  Since we might actually
					// have to break this wikitext into multiple chunks,
					// `fromSelSer` returns an array.
					if (suppressSLC) { state.singleLineContext.disable(); }
					ConstrainedText.fromSelSer(out, node, dp, state.env).forEach(function(ct) {
						cb(ct, ct.node);
					});
					if (suppressSLC) { state.singleLineContext.pop(); }

					// Skip over encapsulated content since it has already been serialized
					if (DU.isFirstEncapsulationWrapperNode(node)) {
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
					// It may be okay to use this for other tags.
					((!dp.autoInsertedStart && !dp.autoInsertedEnd) || /^(TD|TH|TR)$/.test(node.nodeName))) {
					wrapperUnmodified = true;
				}
			}

			if (!handled) {
				state.currNodeUnmodified = false;

				// console.warn("USED NEW");
				if (domHandler && domHandler.handle) {
					// DOM-based serialization
					try {
						if (state.selserMode && DU.hasInsertedDiffMark(node, this.env)) {
							state.inModifiedContent = true;
							nextNode = domHandler.handle(node, state, cb, wrapperUnmodified);
							state.inModifiedContent = false;
						} else {
							nextNode = domHandler.handle(node, state, cb, wrapperUnmodified);
						}
					} catch (e) {
						this.env.log("fatal", e);
					}
					// The handler is responsible for serializing its children
				} else {
					// Used to be token-based serialization
					this.env.log("error", 'No dom handler found for', node.outerHTML);
				}
			}

			// Update modification flags
			state.updateModificationFlags(node);

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
				if (state.selserMode) {
					// If unmodified, emit output and return
					prev = node.previousSibling;
					if (!state.inModifiedContent && (
						(!prev && DU.isBody(node.parentNode)) ||
						(prev && !DU.isMarkerMeta(prev, "mw:DiffMarker")))
						) {
						state.currNodeUnmodified = true;
					} else {
						state.currNodeUnmodified = false;
					}
				}

				// Text is not just whitespace
				prev = DU.previousNonSepSibling(node) || node.parentNode;
				if (prev) {
					this.updateSeparatorConstraints(state,
							prev, this._getDOMHandler(prev, state, cb),
							node, {});
				}
				// regular serialization
				this._serializeTextNode(node, state, cb);
				next = DU.nextNonSepSibling(node) || node.parentNode;
				if (next) {
					this.updateSeparatorConstraints(state,
							node, {},
							next, this._getDOMHandler(next, state, cb));
				}

				// Update modification flags
				state.updateModificationFlags(node);
			}
			break;
		case node.COMMENT_NODE:
			// Merge this into separators
			this.handleSeparatorText(node, state);
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

function stripUnnecessaryIndentPreNowikis(env, wt) {
	// FIXME: The solTransparentWikitextRegexp includes redirects, which really
	// only belong at the SOF and should be unique. See the "New redirect" test.
	var noWikiRegexp = new RegExp(
		'^' + env.conf.wiki.solTransparentWikitextNoWsRegexp.source +
		'(<nowiki>\\s+</nowiki>)([^\n]*(?:\n|$))', 'im'
	);
	var pieces = wt.split(noWikiRegexp);
	var out = pieces[0];
	for (var i = 1; i < pieces.length; i += 4) {
		out += pieces[i];
		var nowiki = pieces[i + 1];
		var rest = pieces[i + 2];
		// Ignore comments
		var htmlTags = rest.match(/<[^!][^<>]*>/g) || [];

		// Not required if just sol transparent wt.
		var reqd = !env.conf.wiki.solTransparentWikitextRegexp.test(rest);

		if (reqd) {
			for (var j = 0; j < htmlTags.length; j++) {
				// Strip </, attributes, and > to get the tagname
				var tagName = htmlTags[j].replace(/<\/?|\s.*|>/g, '').toUpperCase();
				if (!Consts.HTML.HTML5Tags.has(tagName)) {
					// If we encounter any tag that is not a html5 tag,
					// it could be an extension tag. We could do a more complex
					// regexp or tokenize the string to determine if any block tags
					// show up outside the extension tag. But, for now, we just
					// conservatively bail and leave the nowiki as is.
					reqd = true;
					break;
				} else if (Consts.HTML.BlockTags.has(tagName)) {
					// Block tags on a line suppress nowikis
					reqd = false;
				}
			}
		}

		if (!reqd) {
			nowiki = nowiki.replace(/^<nowiki>(\s+)<\/nowiki>/, '$1');
		} else if (env.scrubWikitext) {
			nowiki = nowiki.replace(/^<nowiki>(\s+)<\/nowiki>/, '');
			rest = rest.replace(/^\s*/, '');
		}
		out = out + nowiki + rest + pieces[i + 3];
	}
	return out;
}

// This implements a heuristic to strip two common sources of <nowiki/>s.
// When <i> and <b> tags are matched up properly,
// - any single ' char before <i> or <b> does not need <nowiki/> protection.
// - any single ' char before </i> or </b> does not need <nowiki/> protection.
function stripUnnecessaryQuoteNowikis(wt) {
	return wt.split(/\n|$/).map(function(line) {
		// Optimization: We are interested in <nowiki/>s before quote chars.
		// So, skip this if we don't have both.
		if (!(/<nowiki\s*\/>/.test(line) && /'/.test(line))) {
			return line;
		}

		// * Split out all the [[ ]] {{ }} '' ''' ''''' <..> </...>
		//   parens in the regexp mean that the split segments will
		//   be spliced into the result array as the odd elements.
		// * If we match up the tags properly and we see opening
		//   <i> / <b> / <i><b> tags preceded by a '<nowiki/>, we
		//   can remove all those nowikis.
		//   Ex: '<nowiki/>''foo'' bar '<nowiki/>'''baz'''
		// * If we match up the tags properly and we see closing
		//   <i> / <b> / <i><b> tags preceded by a '<nowiki/>, we
		//   can remove all those nowikis.
		//   Ex: ''foo'<nowiki/>'' bar '''baz'<nowiki/>'''
		var p = line.split(/('''''|'''|''|\[\[|\]\]|\{\{|\}\}|<\w+(?:\s+[^>]*?|\s*?)\/?>|<\/\w+\s*>)/);

		// Which nowiki do we strip out?
		var nowikiIndex = -1;

		// Verify that everything else is properly paired up.
		var stack = [];
		var quotesOnStack = 0;
		var n = p.length;
		var nowiki = false;
		var ref = false;
		for (var j = 1; j < n; j += 2) {
			// For HTML tags, pull out just the tag name for clearer code below.
			var tag = (/^<(\/?\w+)/.exec(p[j]) || '')[1] || p[j];
			var selfClose = false;
			if (/\/>$/.test(p[j])) { tag += '/'; selfClose = true; }
			// Ignore <ref>..</ref> sections
			if (tag === 'ref') { ref = true; continue; }
			if (ref) {
				if (tag === '/ref') { ref = false; }
				continue;
			}

			// Ignore <nowiki>..</nowiki> sections
			if (tag === 'nowiki') { nowiki = true; continue; }
			if (nowiki) {
				if (tag === '/nowiki') { nowiki = false; }
				continue;
			}

			if (tag === ']]') {
				if (stack.pop() !== '[[') { return line; }
			} else if (tag === '}}') {
				if (stack.pop() !== '{{') { return line; }
			} else if (tag[0] === '/') { // closing html tag
				// match html/ext tags
				var opentag = stack.pop();
				if (tag !== ('/' + opentag)) {
					return line;
				}
			} else if (tag === 'nowiki/') {
				// We only want to process:
				// - trailing single quotes (bar')
				// - or single quotes by themselves without a preceding '' sequence
				if (/'$/.test(p[j - 1]) && !(p[j - 1] === "'" && /''$/.test(p[j - 2])) &&
					// Consider <b>foo<i>bar'</i>baz</b> or <b>foo'<i>bar'</i>baz</b>.
					// The <nowiki/> before the <i> or </i> cannot be stripped
					// if the <i> is embedded inside another quote.
					(quotesOnStack === 0
					// The only strippable scenario with a single quote elt on stack
					// is: ''bar'<nowiki/>''
					//   -> ["", "''", "bar'", "<nowiki/>", "", "''"]
					|| (quotesOnStack === 1
						&& j + 2 < n
						&& p[j + 1] === ""
						&& p[j + 2][0] === "'"
						&& p[j + 2] === stack[stack.length - 1])
					)) {
					nowikiIndex = j;
				}
				continue;
			} else if (selfClose || tag === "br") {
				// Skip over self-closing tags or what should have been self-closed.
				// ( While we could do this for all void tags defined in
				//   mediawiki.wikitext.constants.js, <br> is the most common
				//   culprit. )
				continue;
			} else if (tag[0] === "'" && stack[stack.length - 1] === tag) {
				stack.pop();
				quotesOnStack--;
			} else {
				stack.push(tag);
				if (tag[0] === "'") { quotesOnStack++; }
			}
		}

		if (stack.length) { return line; }

		if (nowikiIndex !== -1) {
			// We can only remove the final trailing nowiki.
			//
			// HTML  : <i>'foo'</i>
			// line  : ''<nowiki/>'foo'<nowiki/>''
			p[nowikiIndex] = '';
			return p.join('');
		} else {
			return line;
		}
	}).join("\n");
}

/**
 * Serialize an HTML DOM document synchronously.
 * WARNING: You probably want to use DU.serializeDOM instead.
 */
WSP.serializeDOMSync = function(body, selserMode) {
	console.assert(DU.isBody(body), 'Expected a body node.');

	this.logType = selserMode ? "trace/selser" : "trace/wts";
	this.trace = this.env.log.bind(this.env, this.logType);

	if (!this.env.page.editedDoc) {
		this.env.page.editedDoc = body.ownerDocument;
	}

	var state = new SerializerState(this, this.options);

	// Init state
	state.selserMode = selserMode || false;
	state.rtTestMode = state.rtTestMode && !state.selserMode; // always false in selser mode

	// Normalize the DOM
	(new Normalizer(state)).normalizeDOM(body);

	// Don't serialize the DOM if debugging is disabled
	this.trace(function() {
		return "--- DOM --- \n" + body.outerHTML + "\n-----------";
	});

	var out = '';

	state.sep.lastSourceNode = body;
	state.currLine.firstNode = body.firstChild;

	// Wrapper CB for every chunk that emits any required separators
	// before emitting the chunk itself.
	var chunkCBWrapper = function(chunk, node, atEOF) {
		var accum = function(o) { out += o; };
		state.emitSepAndOutput(chunk, node, accum, "OUT:");
		state.atStartOfOutput = false;
		if (atEOF === 'EOF') {
			state.flushLine(accum);
		}
	};

	// Kick it off
	state.serializeChildren(body, chunkCBWrapper);

	// Handle EOF
	chunkCBWrapper('', body, 'EOF');

	if (state.hasIndentPreNowikis) {
		// FIXME: Perhaps this can be done on a per-line basis
		// rather than do one post-pass on the entire document.
		//
		// Strip excess/useless nowikis
		out = stripUnnecessaryIndentPreNowikis(this.env, out);
	}

	if (state.hasQuoteNowikis) {
		// FIXME: Perhaps this can be done on a per-line basis
		// rather than do one post-pass on the entire document.
		//
		// Strip excess/useless nowikis
		out = stripUnnecessaryQuoteNowikis(out);
	}

	return out;
};


if (typeof module === "object") {
	module.exports.WikitextSerializer = WikitextSerializer;
}
