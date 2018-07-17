/**
 * General DOM utilities.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var domino = require('domino');
var entities = require('entities');
var semver = require('semver');

var Promise = require('./promise.js');
var Util = require('./Util.js').Util;
var JSUtils = require('./jsutils.js').JSUtils;
var Consts = require('../config/WikitextConstants.js').WikitextConstants;
var ApiRequest = require('../mw/ApiRequest.js');
var Batcher = require('../mw/Batcher.js').Batcher;
var pd = require('../wt2html/parser.defines.js');
var XMLSerializer = require('../wt2html/XMLSerializer.js');

// define some constructor shortcuts
var TemplateRequest = ApiRequest.TemplateRequest;
var lastItem = JSUtils.lastItem;


/**
 * @class DOMUtils
 * General DOM utilities
 * @namespace
 */
var DOMUtils, DU;
DU = DOMUtils = {

	/**
	 * Check whether this is a DOM element node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isElt: function(node) {
		return node && node.nodeType === 1;
	},

	/**
	 * Check whether this is a DOM text node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isText: function(node) {
		return node && node.nodeType === 3;
	},

	/**
	 * Check whether this is a DOM comment node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isComment: function(node) {
		return node && node.nodeType === 8;
	},

	debugOut: function(node) {
		return JSON.stringify(node.outerHTML || node.nodeValue || '').substr(0, 40);
	},

	/**
	 * Determine whether this is a block-level DOM element.
	 * @see Util.isBlockTag
	 * @param {Node} node
	 */
	isBlockNode: function(node) {
		return node && Util.isBlockTag(node.nodeName);
	},

	isFormattingElt: function(node) {
		return node && Consts.HTML.FormattingTags.has(node.nodeName);
	},

	isQuoteElt: function(node) {
		return node && Consts.WTQuoteTags.has(node.nodeName);
	},

	isZeroWidthWikitextElt: function(node) {
		return Consts.ZeroWidthWikitextTags.has(node.nodeName) &&
			!this.isLiteralHTMLNode(node);
	},

	isBody: function(node) {
		return node && node.nodeName === 'BODY';
	},

	/**
	 * Test the number of children this node has without using
	 * `Node#childNodes.length`.  This walks the sibling list and so
	 * takes O(`nchildren`) time -- so `nchildren` is expected to be small
	 * (say: 0, 1, or 2).
	 *
	 * Skips all diff markers by default.
	 */
	hasNChildren: function(node, nchildren, countDiffMarkers) {
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (!countDiffMarkers && DU.isDiffMarker(child)) {
				continue;
			}
			if (nchildren <= 0) { return false; }
			nchildren -= 1;
		}
		return (nchildren === 0);
	},

	/**
	 * Is `node` a block node that is also visible in wikitext?
	 * An example of an invisible block node is a `<p>`-tag that
	 * Parsoid generated, or a `<ul>`, `<ol>` tag.
	 *
	 * @param {Node} node
	 */
	isBlockNodeWithVisibleWT: function(node) {
		return DU.isBlockNode(node) && !DU.isZeroWidthWikitextElt(node);
	},

	/**
	 * Helper functions to detect when an A-node uses [[..]]/[..]/... style
	 * syntax (for wikilinks, ext links, url links). rel-type is not sufficient
	 * anymore since mw:ExtLink is used for all the three link syntaxes.
	 */
	usesWikiLinkSyntax: function(aNode, dp) {
		if (dp === undefined) {
			dp = this.getDataParsoid(aNode);
		}

		// SSS FIXME: This requires to be made more robust
		// for when dp.stx value is not present
		return aNode.getAttribute("rel") === "mw:WikiLink" ||
			(dp.stx && dp.stx !== "url" && dp.stx !== "magiclink");
	},

	usesExtLinkSyntax: function(aNode, dp) {
		if (dp === undefined) {
			dp = this.getDataParsoid(aNode);
		}

		// SSS FIXME: This requires to be made more robust
		// for when dp.stx value is not present
		return aNode.getAttribute("rel") === "mw:ExtLink" &&
			(!dp.stx || (dp.stx !== "url" && dp.stx !== "magiclink"));
	},

	usesURLLinkSyntax: function(aNode, dp) {
		if (dp === undefined) {
			dp = this.getDataParsoid(aNode);
		}

		// SSS FIXME: This requires to be made more robust
		// for when dp.stx value is not present
		return aNode.getAttribute("rel") === "mw:ExtLink" &&
			dp.stx && dp.stx === "url";
	},

	usesMagicLinkSyntax: function(aNode, dp) {
		if (dp === undefined) {
			dp = this.getDataParsoid(aNode);
		}

		// SSS FIXME: This requires to be made more robust
		// for when dp.stx value is not present
		return aNode.getAttribute("rel") === "mw:ExtLink" &&
			dp.stx && dp.stx === "magiclink";
	},

	/**
	 * Attribute equality test.
	 * @param {Node} nodeA
	 * @param {Node} nodeB
	 * @param {Set} [ignoreableAttribs] Set of attributes that should be ignored.
	 * @param {Map} [specializedAttribHandlers] Map of attributes with specialized equals handlers.
	 */
	attribsEquals: function(nodeA, nodeB, ignoreableAttribs, specializedAttribHandlers) {
		if (!ignoreableAttribs) {
			ignoreableAttribs = new Set();
		}
		if (!specializedAttribHandlers) {
			specializedAttribHandlers = new Map();
		}

		function arrayToHash(node) {
			var attrs = node.attributes || [];
			var h = {};
			var count = 0;
			for (var j = 0, n = attrs.length; j < n; j++) {
				var a = attrs.item(j);
				if (!ignoreableAttribs.has(a.name)) {
					count++;
					h[a.name] = a.value;
				}
			}
			// If there's no special attribute handler, we want a straight
			// comparison of these.
			if (!ignoreableAttribs.has('data-parsoid')) {
				h['data-parsoid'] = DU.getDataParsoid(node);
				count++;
			}
			if (!ignoreableAttribs.has('data-mw') && DU.validDataMw(node)) {
				h['data-mw'] = DU.getDataMw(node);
				count++;
			}
			return { h: h, count: count };
		}

		var xA = arrayToHash(nodeA);
		var xB = arrayToHash(nodeB);

		if (xA.count !== xB.count) {
			return false;
		}

		var hA = xA.h;
		var keysA = Object.keys(hA).sort();
		var hB = xB.h;
		var keysB = Object.keys(hB).sort();

		for (var i = 0; i < xA.count; i++) {
			var k = keysA[i];
			if (k !== keysB[i]) {
				return false;
			}

			var attribEquals = specializedAttribHandlers.get(k);
			if (attribEquals) {
				// Use a specialized compare function, if provided
				if (!hA[k] || !hB[k] || !attribEquals(nodeA, hA[k], nodeB, hB[k])) {
					return false;
				}
			} else if (hA[k] !== hB[k]) {
				return false;
			}
		}

		return true;
	},

	/**
	 * Add a type to the typeof attribute. This method works for both tokens
	 * and DOM nodes as it only relies on getAttribute and setAttribute, which
	 * are defined for both.
	 */
	addTypeOf: function(node, type) {
		var typeOf = node.getAttribute('typeof');
		if (typeOf) {
			var types = typeOf.split(' ');
			if (types.indexOf(type) === -1) {
				// not in type set yet, so add it.
				types.push(type);
			}
			node.setAttribute('typeof', types.join(' '));
		} else {
			node.setAttribute('typeof', type);
		}
	},

	/**
	 * Remove a type from the typeof attribute. This method works on both
	 * tokens and DOM nodes as it only relies on
	 * getAttribute/setAttribute/removeAttribute.
	 */
	removeTypeOf: function(node, type) {
		var typeOf = node.getAttribute('typeof');
		function notType(t) {
			return t !== type;
		}
		if (typeOf) {
			var types = typeOf.split(' ').filter(notType);

			if (types.length) {
				node.setAttribute('typeof', types.join(' '));
			} else {
				node.removeAttribute('typeof');
			}
		}
	},

	/**
	 * Test if a node matches a given typeof.
	 */
	hasTypeOf: function(node, type) {
		if (!node.getAttribute) {
			return false;
		}
		var typeOfs = node.getAttribute('typeof');
		if (!typeOfs) {
			return false;
		}
		return typeOfs.split(' ').indexOf(type) !== -1;
	},

	validDataMw: function(node) {
		return !!Object.keys(DU.getDataMw(node)).length;
	},

	/**
	 * This is a simplified version of the DOMTraverser.
	 * Consider using that before making this more complex.
	 */
	visitDOM: function(node, handler) {
		var args = [node].concat(Array.prototype.slice.call(arguments, 2));
		function inner(n) {
			args[0] = n;
			handler.apply(null, args);
			n = n.firstChild;
			while (n) {
				inner(n);
				n = n.nextSibling;
			}
		}
		inner(node);
	},

	/**
	 * Applies the `data-*` attributes JSON structure to the document.
	 * Leaves `id` attributes behind -- they are used by citation
	 * code to extract `<ref>` body from the DOM.
	 */
	applyPageBundle: function(doc, pb) {
		DU.visitDOM(doc.body, function(node) {
			if (DU.isElt(node)) {
				var id = node.getAttribute('id');
				if (pb.parsoid.ids.hasOwnProperty(id)) {
					DU.setJSONAttribute(node, 'data-parsoid', pb.parsoid.ids[id]);
				}
				if (pb.mw && pb.mw.ids.hasOwnProperty(id)) {
					// Only apply if it isn't already set.  This means earlier
					// applications of the pagebundle have higher precedence,
					// inline data being the highest.
					if (node.getAttribute('data-mw') === null) {
						DU.setJSONAttribute(node, 'data-mw', pb.mw.ids[id]);
					}
				}
			}
		});
	},

	/**
	 * Removes the `data-*` attribute from a node, and migrates the data to the
	 * document's JSON store. Generates a unique id with the following format:
	 * ```
	 * mw<base64-encoded counter>
	 * ```
	 * but attempts to keep user defined ids.
	 */
	storeInPageBundle: function(node, env, data) {
		var uid = node.getAttribute('id');
		var document = node.ownerDocument;
		var pb = DU.getDataParsoid(document).pagebundle;
		var docDp = pb.parsoid;
		var origId = uid || null;
		if (docDp.ids.hasOwnProperty(uid)) {
			uid = null;
			// FIXME: Protect mw ids while tokenizing to avoid false positives.
			env.log('info', 'Wikitext for this page has duplicate ids: ' + origId);
		}
		if (!uid) {
			do {
				docDp.counter += 1;
				uid = 'mw' + JSUtils.counterToBase64(docDp.counter);
			} while (document.getElementById(uid));
			DU.addNormalizedAttribute(node, 'id', uid, origId);
		}
		docDp.ids[uid] = data.parsoid;
		if (data.hasOwnProperty('mw')) {
			pb.mw.ids[uid] = data.mw;
		}
	},

	// These are intended be used on a document after post-processing, so that
	// the underlying .dataobject is transparently applied (in the store case)
	// and reloaded (in the load case), rather than worrying about keeping
	// the attributes up-to-date throughout that phase.  For the most part,
	// using DU.ppTo* should be sufficient and using these directly should be
	// avoided.

	loadDataAttribs: function(node, markNew) {
		if (!DU.isElt(node)) {
			return;
		}
		var dp = DU.getJSONAttribute(node, 'data-parsoid', {});
		if (markNew) {
			if (!dp.tmp) { dp.tmp = {}; }
			dp.tmp.isNew = (node.getAttribute('data-parsoid') === null);
		}
		DU.setDataParsoid(node, dp);
		node.removeAttribute('data-parsoid');
		DU.setDataMw(node, DU.getJSONAttribute(node, 'data-mw', undefined));
		node.removeAttribute('data-mw');
	},

	/**
	 * @param {Node} node
	 * @param {Object} [options]
	 */
	storeDataAttribs: function(node, options) {
		if (!DU.isElt(node)) { return; }
		options = options || {};
		console.assert(!(options.discardDataParsoid && options.keepTmp));  // Just a sanity check
		var dp = DU.getDataParsoid(node);
		// Don't modify `options`, they're reused.
		var discardDataParsoid = options.discardDataParsoid;
		if (dp.tmp.isNew) {
			// Only necessary to support the cite extension's getById,
			// that's already been loaded once.
			//
			// This is basically a hack to ensure that DU.isNewElt
			// continues to work since we effectively rely on the absence
			// of data-parsoid to identify new elements. But, loadDataAttribs
			// creates an empty {} if one doesn't exist. So, this hack
			// ensures that a loadDataAttribs + storeDataAttribs pair don't
			// dirty the node by introducing an empty data-parsoid attribute
			// where one didn't exist before.
			//
			// Ideally, we'll find a better solution for this edge case later.
			discardDataParsoid = true;
		}
		var data = null;
		if (!discardDataParsoid) {
			// WARNING: keeping tmp might be a bad idea.  It can have DOM
			// nodes, which aren't going to serialize well.  You better know
			// of what you do.
			if (!options.keepTmp) { dp.tmp = undefined; }
			if (options.storeInPageBundle) {
				data = data || {};
				data.parsoid = dp;
			} else {
				DU.setJSONAttribute(node, 'data-parsoid', dp);
			}
		}
		// Strip invalid data-mw attributes
		if (DU.validDataMw(node)) {
			if (options.storeInPageBundle && options.env &&
					// The pagebundle didn't have data-mw before 999.x
					semver.satisfies(options.env.contentVersion, '^999.0.0')) {
				data = data || {};
				data.mw = DU.getDataMw(node);
			} else {
				DU.setJSONAttribute(node, 'data-mw', DU.getDataMw(node));
			}
		}
		// Store pagebundle
		if (data !== null) {
			DU.storeInPageBundle(node, options.env, data);
		}
	},

	// The following getters and setters load from the .dataobject store,
	// with the intention of eventually moving them off the nodes themselves.

	getDataParsoid: function(node) {
		var data = this.getNodeData(node);
		if (!data.parsoid) {
			data.parsoid = {};
		}
		if (!data.parsoid.tmp) {
			data.parsoid.tmp = {};
		}
		return data.parsoid;
	},

	getDataMw: function(node) {
		var data = this.getNodeData(node);
		if (!data.mw) {
			data.mw = {};
		}
		return data.mw;
	},

	setDataParsoid: function(node, dpObj) {
		var data = this.getNodeData(node);
		data.parsoid = dpObj;
		return data.parsoid;
	},

	setDataMw: function(node, dmObj) {
		var data = this.getNodeData(node);
		data.mw = dmObj;
		return data.mw;
	},

	getNodeData: function(node) {
		if (!node.dataobject) {
			node.dataobject = {};
		}
		return node.dataobject;
	},

	setNodeData: function(node, data) {
		node.dataobject = data;
	},

	/**
	 * Get an object from a JSON-encoded XML attribute on a node.
	 *
	 * @param {Node} node
	 * @param {string} name Name of the attribute
	 * @param {any} defaultVal What should be returned if we fail to find a valid JSON structure
	 */
	getJSONAttribute: function(node, name, defaultVal) {
		if (!DU.isElt(node)) {
			return defaultVal;
		}
		var attVal = node.getAttribute(name);
		if (!attVal) {
			return defaultVal;
		}
		try {
			return JSON.parse(attVal);
		} catch (e) {
			console.warn('ERROR: Could not decode attribute-val ' + attVal +
					' for ' + name + ' on node ' + node.outerHTML);
			return defaultVal;
		}
	},

	/**
	 * Set an attribute on a node to a JSON-encoded object.
	 *
	 * @param {Node} node
	 * @param {string} name Name of the attribute.
	 * @param {Object} obj
	 */
	setJSONAttribute: function(node, name, obj) {
		node.setAttribute(name, JSON.stringify(obj));
	},

	/**
	 * For new elements, attrs are always considered modified.  However, For
	 * old elements, we only consider an attribute modified if we have shadow
	 * info for it and it doesn't match the current value.
	 * @return {Object}
	 *   @return {any} return.value
	 *   @return {boolean} return.modified If the value of the attribute changed since we parsed the wikitext.
	 *   @return {boolean} return.fromsrc Whether we got the value from source-based roundtripping.
	 */
	getShadowInfo: function(node, name, curVal) {
		var dp = this.getDataParsoid(node);

		// Not the case, continue regular round-trip information.
		if (dp.a === undefined || dp.a[name] === undefined) {
			return {
				value: curVal,
				// Mark as modified if a new element
				modified: this.isNewElt(node),
				fromsrc: false,
			};
		} else if (dp.a[name] !== curVal) {
			return {
				value: curVal,
				modified: true,
				fromsrc: false,
			};
		} else if (dp.sa === undefined || dp.sa[name] === undefined) {
			return {
				value: curVal,
				modified: false,
				fromsrc: false,
			};
		} else {
			return {
				value: dp.sa[name],
				modified: false,
				fromsrc: true,
			};
		}
	},

	/**
	 * Get shadowed information about an attribute on a node.
	 *
	 * @param {Node} node
	 * @param {string} name
	 * @return {Object}
	 *   @return {any} return.value
	 *   @return {boolean} return.modified If the value of the attribute changed since we parsed the wikitext.
	 *   @return {boolean} return.fromsrc Whether we got the value from source-based roundtripping.
	 */
	getAttributeShadowInfo: function(node, name) {
		return DU.getShadowInfo(node, name, node.getAttribute(name));
	},

	/**
	 * Get the attributes on a node in an array of KV objects.
	 *
	 * @param {Node} node
	 * @return {KV[]}
	 */
	getAttributeKVArray: function(node) {
		var attribs = node.attributes;
		var kvs = [];
		for (var i = 0, l = attribs.length; i < l; i++) {
			var attrib = attribs.item(i);
			kvs.push(new pd.KV(attrib.name, attrib.value));
		}
		return kvs;
	},

	/**
	 * Build path from a node to its passed-in ancestor.
	 * Doesn't include the ancestor in the returned path.
	 *
	 * @param {Node} node
	 * @param {Node} ancestor Should be an ancestor of `node`.
	 * @return {Node[]}
	 */
	pathToAncestor: function(node, ancestor) {
		var path = [];
		while (node && node !== ancestor) {
			path.push(node);
			node = node.parentNode;
		}

		return path;
	},

	/**
	 * Build path from a node to the root of the document.
	 *
	 * @return {Node[]}
	 */
	pathToRoot: function(node) {
		return this.pathToAncestor(node, null);
	},

	/**
	 * Build path from a node to its passed-in sibling.
	 *
	 * @param {Node} node
	 * @param {Node} sibling
	 * @param {boolean} left Whether to go backwards, i.e., use previousSibling instead of nextSibling.
	 * @return {Node[]} Will not include the passed-in sibling.
	 */
	pathToSibling: function(node, sibling, left) {
		var path = [];
		while (node && node !== sibling) {
			path.push(node);
			node = left ? node.previousSibling : node.nextSibling;
		}

		return path;
	},

	/**
	 * Check whether a node `n1` comes before another node `n2` in
	 * their parent's children list.
	 *
	 * @param {Node} n1 The node you expect to come first.
	 * @param {Node} n2 Expected later sibling.
	 */
	inSiblingOrder: function(n1, n2) {
		while (n1 && n1 !== n2) {
			n1 = n1.nextSibling;
		}
		return n1 !== null;
	},

	/**
	 * Check that a node 'n1' is an ancestor of another node 'n2' in
	 * the DOM. Returns true if n1 === n2.
	 *
	 * @param {Node} n1 The suspected ancestor.
	 * @param {Node} n2 The suspected descendant.
	 */
	isAncestorOf: function(n1, n2) {
		while (n2 && n2 !== n1) {
			n2 = n2.parentNode;
		}
		return n2 !== null;
	},

	/**
	 * Check whether `node` has an ancesor named `name`.
	 *
	 * @param {Node} node
	 * @param {string} name
	 */
	hasAncestorOfName: function(node, name) {
		while (node && node.nodeName !== name) {
			node = node.parentNode;
		}
		return node !== null;
	},

	/**
	 * Determine whether the node matches the given nodeName and typeof
	 * attribute value.
	 *
	 * @param {Node} n
	 * @param {string} name node name to test for
	 * @param {string} type Expected value of "typeof" attribute.
	 */
	isNodeOfType: function(n, name, type) {
		return n.nodeName === name && n.getAttribute("typeof") === type;
	},

	/**
	 * Check a node to see whether it's a meta with some typeof.
	 *
	 * @param {Node} n
	 * @param {string} type Passed into {@link #isNodeOfType}.
	 */
	isMarkerMeta: function(n, type) {
		return this.isNodeOfType(n, "META", type);
	},

	/**
	 * Check whether a meta's typeof indicates that it is a template expansion.
	 *
	 * @param {string} nType
	 */
	isTplMetaType: function(nType) {
		return Util.TPL_META_TYPE_REGEXP.test(nType);
	},

	/**
	 * Check whether a typeof indicates that it signifies an
	 * expanded attribute.
	 */
	hasExpandedAttrsType: function(node) {
		var nType = node.getAttribute('typeof');
		return (/(?:^|\s)mw:ExpandedAttrs(\/[^\s]+)*(?=$|\s)/).test(nType);
	},

	/**
	 * Check whether a node is a meta tag that signifies a template expansion.
	 */
	isTplMarkerMeta: function(node) {
		return (
			node.nodeName === "META" &&
			this.isTplMetaType(node.getAttribute("typeof"))
		);
	},

	/**
	 * Check whether a node is a meta signifying the start of a template expansion.
	 */
	isTplStartMarkerMeta: function(node) {
		if (node.nodeName === "META") {
			var t = node.getAttribute("typeof");
			return this.isTplMetaType(t) && !/\/End(?=$|\s)/.test(t);
		} else {
			return false;
		}
	},

	/**
	 * Check whether a node is a meta signifying the end of a template
	 * expansion.
	 *
	 * @param {Node} n
	 */
	isTplEndMarkerMeta: function(n) {
		if (n.nodeName === "META") {
			var t = n.getAttribute("typeof");
			return this.isTplMetaType(t) && /\/End(?=$|\s)/.test(t);
		} else {
			return false;
		}
	},

	/**
	 * Check whether a node's data-parsoid object includes
	 * an indicator that the original wikitext was a literal
	 * HTML element (like table or p).
	 *
	 * @param {Object} dp
	 *   @param {string|undefined} [dp.stx]
	 */
	hasLiteralHTMLMarker: function(dp) {
		return dp.stx === 'html';
	},

	/**
	 * This tests whether a DOM node is a new node added during an edit session
	 * or an existing node from parsed wikitext.
	 *
	 * As written, this function can only be used on non-template/extension content
	 * or on the top-level nodes of template/extension content. This test will
	 * return the wrong results on non-top-level nodes of template/extension content.
	 *
	 * @param {Node} node
	 */
	isNewElt: function(node) {
		// We cannot determine newness on text/comment nodes.
		if (!DU.isElt(node)) {
			return false;
		}

		// For template/extension content, newness should be
		// checked on the encapsulation wrapper node.
		node = this.findFirstEncapsulationWrapperNode(node) || node;
		return !!DU.getDataParsoid(node).tmp.isNew;
	},

	/**
	 * Run a node through {@link #hasLiteralHTMLMarker}.
	 */
	isLiteralHTMLNode: function(node) {
		return (node &&
			DU.isElt(node) &&
			this.hasLiteralHTMLMarker(this.getDataParsoid(node)));
	},

	/**
	 * Check whether a pre is caused by indentation in the original wikitext.
	 */
	isIndentPre: function(node) {
		return node.nodeName === "PRE" && !this.isLiteralHTMLNode(node);
	},

	isFosterablePosition: function(n) {
		return n && Consts.HTML.FosterablePosition.has(n.parentNode.nodeName);
	},

	isList: function(n) {
		return n && Consts.HTML.ListTags.has(n.nodeName);
	},

	isListItem: function(n) {
		return n && Consts.HTML.ListItemTags.has(n.nodeName);
	},

	isListOrListItem: function(n) {
		return this.isList(n) || this.isListItem(n);
	},

	isNestedInListItem: function(n) {
		var parentNode = n.parentNode;
		while (parentNode) {
			if (this.isListItem(parentNode)) {
				return true;
			}
			parentNode = parentNode.parentNode;
		}
		return false;
	},

	isNestedListOrListItem: function(n) {
		return (this.isList(n) || this.isListItem(n)) && this.isNestedInListItem(n);
	},

	isInlineMedia: function(n) {
		return DU.isElt(n) && (/\bmw:(?:Image|Video|Audio)\b/).test(n.getAttribute("typeof")) &&
			n.nodeName === 'FIGURE-INLINE';
	},

	isGeneratedFigure: function(n) {
		return DU.isElt(n) && (/(^|\s)mw:(?:Image|Video|Audio)(\s|$|\/)/).test(n.getAttribute("typeof"));
	},

	/**
	 * Check whether a node has any children that are elements.
	 */
	hasElementChild: function(node) {
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (DU.isElt(child)) {
				return true;
			}
		}

		return false;
	},

	/**
	 * Check if a node has a block-level element descendant.
	 */
	hasBlockElementDescendant: function(node) {
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (DU.isElt(child) &&
					// Is a block-level node
					(this.isBlockNode(child) ||
						// or has a block-level child or grandchild or..
						this.hasBlockElementDescendant(child))) {
				return true;
			}
		}

		return false;
	},

	/**
	 * Check if node is a text-node and has a leading newline.
	 */
	nodeHasLeadingNL: function(node) {
		return node && this.isText(node) && node.nodeValue.match(/^\n/);
	},

	/**
	 * Check if node is a text-node and has a trailing newline.
	 */
	nodeHasTrailingNL: function(node) {
		return node && this.isText(node) && node.nodeValue.match(/\n$/);
	},

	/**
	 * Find how much offset is necessary for the DSR of an
	 * indent-originated pre tag.
	 *
	 * @param {TextNode} textNode
	 * @return {number}
	 */
	indentPreDSRCorrection: function(textNode) {
		// NOTE: This assumes a text-node and doesn't check that it is one.
		//
		// FIXME: Doesn't handle text nodes that are not direct children of the pre
		if (this.isIndentPre(textNode.parentNode)) {
			var numNLs;
			if (textNode.parentNode.lastChild === textNode) {
				// We dont want the trailing newline of the last child of the pre
				// to contribute a pre-correction since it doesn't add new content
				// in the pre-node after the text
				numNLs = (textNode.nodeValue.match(/\n./g) || []).length;
			} else {
				numNLs = (textNode.nodeValue.match(/\n/g) || []).length;
			}
			return numNLs;
		} else {
			return 0;
		}
	},

	/**
	 * Check if node is an ELEMENT node belongs to a template/extension.
	 *
	 * NOTE: Use with caution. This technique works reliably for the
	 * root level elements of tpl-content DOM subtrees since only they
	 * are guaranteed to be  marked and nested content might not
	 * necessarily be marked.
	 *
	 * @param {Node} node
	 * @return {boolean}
	 */
	hasParsoidAboutId: function(node) {
		if (DU.isElt(node)) {
			var about = node.getAttribute('about');
			// SSS FIXME: Verify that our DOM spec clarifies this
			// expectation on about-ids and that our clients respect this.
			return about && Util.isParsoidObjectId(about);
		} else {
			return false;
		}
	},

	isRedirectLink: function(node) {
		return DU.isElt(node) && node.nodeName === 'LINK' &&
			/\bmw:PageProp\/redirect\b/.test(node.getAttribute('rel'));
	},

	isCategoryLink: function(node) {
		return DU.isElt(node) && node.nodeName === 'LINK' &&
			/\bmw:PageProp\/Category\b/.test(node.getAttribute('rel'));
	},

	isSolTransparentLink: function(node) {
		return DU.isElt(node) && node.nodeName === 'LINK' &&
			Util.solTransparentLinkRegexp.test(node.getAttribute('rel'));
	},

	isBehaviorSwitch: function(env, node) {
		return DU.isElt(node) && node.nodeName === 'META' &&
			env.conf.wiki.bswPagePropRegexp.test(node.getAttribute('property'));
	},

	/**
	 * Check if 'node' emits wikitext that is sol-transparent in wikitext form.
	 * This is a test for wikitext that doesn't introduce line breaks.
	 *
	 * Comment, whitespace text nodes, category links, redirect links, behavior
	 * switches, and include directives currently satisfy this definition.
	 *
	 * This should come close to matching Util.isSolTransparent(), but with
	 * the single line caveat.
	 *
	 * @param {Node} node
	 */
	emitsSolTransparentSingleLineWT: function(node) {
		if (DU.isText(node)) {
			// NB: We differ here to meet the nl condition.
			return node.nodeValue.match(/^[ \t]*$/);
		} else if (DU.isRenderingTransparentNode(node)) {
			// NB: The only metas in a DOM should be for behavior switches and
			// include directives, other than explicit HTML meta tags. This
			// differs from our counterpart in Util where ref meta tokens
			// haven't been expanded to spans yet.
			return true;
		} else {
			return false;
		}
	},

	isFallbackIdSpan: function(node) {
		return node.nodeName === 'SPAN' && node.getAttribute('typeof') === 'mw:FallbackId';
	},

	/**
	 * These are primarily 'metadata'-like nodes that don't show up in output rendering.
	 * - In Parsoid output, they are represented by link/meta tags.
	 * - In the PHP parser, they are completely stripped from the input early on.
	 *   Because of this property, these rendering-transparent nodes are also
	 *   SOL-transparent for the purposes of parsing behavior.
	 */
	isRenderingTransparentNode: function(node) {
		// FIXME: Can we change this entire thing to
		// DU.isComment(node) ||
		// DU.getDataParsoid(node).stx !== 'html' &&
		//   (node.nodeName === 'META' || node.nodeName === 'LINK')
		//
		var typeOf = DU.isElt(node) && node.getAttribute('typeof');
		return DU.isComment(node) ||
			DU.isSolTransparentLink(node) ||
			// Catch-all for everything else.
			(node.nodeName === 'META' &&
				// (Start|End)Tag metas clone data-parsoid from the tokens
				// they're shadowing, which trips up on the stx check.
				// TODO: Maybe that data should be nested in a property?
				(/(mw:StartTag)|(mw:EndTag)/.test(typeOf) || DU.getDataParsoid(node).stx !== 'html')) ||
			DU.isFallbackIdSpan(node);
	},

	/**
	 * Check if whitespace preceding this node would NOT trigger an indent-pre.
	 */
	precedingSpaceSuppressesIndentPre: function(node, sepNode) {
		if (node !== sepNode && this.isText(node)) {
			// if node is the same as sepNode, then the separator text
			// at the beginning of it has been stripped out already, and
			// we cannot use it to test it for indent-pre safety
			return node.nodeValue.match(/^[ \t]*\n/);
		} else if (node.nodeName === 'BR') {
			return true;
		} else if (this.isFirstEncapsulationWrapperNode(node)) {
			// Dont try any harder than this
			return (!node.hasChildNodes()) || node.innerHTML.match(/^\n/);
		} else {
			return this.isBlockNodeWithVisibleWT(node);
		}
	},

	/**
	 * @param {Token[]} tokBuf This is where the tokens get stored.
	 */
	convertDOMtoTokens: function(tokBuf, node) {
		function domAttrsToTagAttrs(attrs) {
			var out = [];
			for (var j = 0, m = attrs.length; j < m; j++) {
				var a = attrs.item(j);
				out.push(new pd.KV(a.name, a.value));
			}
			return { attrs: out, dataAttrs: DU.getDataParsoid(node) };
		}

		switch (node.nodeType) {
			case node.ELEMENT_NODE:
				var nodeName = node.nodeName.toLowerCase();
				var attrInfo = domAttrsToTagAttrs(node.attributes);

				if (Util.isVoidElement(nodeName)) {
					tokBuf.push(new pd.SelfclosingTagTk(nodeName, attrInfo.attrs, attrInfo.dataAttrs));
				} else {
					tokBuf.push(new pd.TagTk(nodeName, attrInfo.attrs, attrInfo.dataAttrs));
					for (var child = node.firstChild; child; child = child.nextSibling) {
						tokBuf = this.convertDOMtoTokens(tokBuf, child);
					}
					var endTag = new pd.EndTagTk(nodeName);
					// Keep stx parity
					if (this.isLiteralHTMLNode(node)) {
						endTag.dataAttribs = { 'stx': 'html' };
					}
					tokBuf.push(endTag);
				}
				break;

			case node.TEXT_NODE:
				tokBuf = tokBuf.concat(Util.newlinesToNlTks(node.nodeValue));
				break;

			case node.COMMENT_NODE:
				tokBuf.push(new pd.CommentTk(node.nodeValue));
				break;

			default:
				console.warn("Unhandled node type: " + node.outerHTML);
				break;
		}
		return tokBuf;
	},

	isDiffMarker: function(node, mark) {
		if (mark) {
			return node && this.isMarkerMeta(node, 'mw:DiffMarker/' + mark);
		} else {
			return node && node.nodeName === 'META' && /\bmw:DiffMarker\/\w*\b/.test(node.getAttribute('typeof'));
		}
	},

	/**
	 * Check that the diff markers on the node exist and are recent.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	hasDiffMarkers: function(node, env) {
		return this.getDiffMark(node, env) !== null || this.isDiffMarker(node);
	},

	hasDiffMark: function(node, env, mark) {
		// For 'deletion' and 'insertion' markers on non-element nodes,
		// a mw:DiffMarker met is added
		if (mark === 'deleted' || (mark === 'inserted' && !DU.isElt(node))) {
			return this.isDiffMarker(node.previousSibling, mark);
		} else {
			var diffMark = this.getDiffMark(node, env);
			return diffMark && diffMark.diff.indexOf(mark) >= 0;
		}
	},

	directChildrenChanged: function(node, env) {
		return this.hasDiffMark(node, env, 'children-changed');
	},

	hasInsertedDiffMark: function(node, env) {
		return this.hasDiffMark(node, env, 'inserted');
	},

	onlySubtreeChanged: function(node, env) {
		var dmark = this.getDiffMark(node, env);
		return dmark && dmark.diff.every(function subTreechangeMarker(mark) {
			return mark === 'subtree-changed' || mark === 'children-changed';
		});
	},

	addDiffMark: function(node, env, mark) {
		if (mark === 'deleted' || mark === 'moved') {
			DU.prependTypedMeta(node, 'mw:DiffMarker/' + mark);
		} else if (DU.isText(node) || DU.isComment(node)) {
			if (mark !== 'inserted') {
				env.log("error", "BUG! CHANGE-marker for ", node.nodeType, " node is: ", mark);
			}
			DU.prependTypedMeta(node, 'mw:DiffMarker/' + mark);
		} else {
			DU.setDiffMark(node, env, mark);
		}
	},

	/**
	 * Get a node's diff marker.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 * @return {Object|null}
	 */
	getDiffMark: function(node, env) {
		if (!DU.isElt(node)) { return null; }
		var data = DU.getNodeData(node);
		var dpd = data['parsoid-diff'];
		return dpd && dpd.id === env.page.id ? dpd : null;
	},

	/**
	 * Set a diff marker on a node.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 * @param {string} change
	 */
	setDiffMark: function(node, env, change) {
		if (!DU.isElt(node)) { return; }
		var dpd = DU.getDiffMark(node, env);
		if (dpd) {
			// Diff is up to date, append this change if it doesn't already exist
			if (dpd.diff.indexOf(change) === -1) {
				dpd.diff.push(change);
			}
		} else {
			// Was an old diff entry or no diff at all, reset
			dpd = {
				// The base page revision this change happened on
				id: env.page.id,
				diff: [change],
			};
		}
		DU.getNodeData(node)['parsoid-diff'] = dpd;
	},

	/**
	 * Store a diff marker on a node in a data attibute.
	 * Only to be used for dumping.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	storeDiffMark: function(node, env) {
		var dpd = DU.getDiffMark(node, env);
		if (dpd) {
			DU.setJSONAttribute(node, 'data-parsoid-diff', dpd);
		}
	},

	/**
	 * Is a node representing inter-element whitespace?
	 */
	isIEW: function(node) {
		// ws-only
		return this.isText(node) && node.nodeValue.match(/^\s*$/);
	},

	isDocumentFragment: function(node) {
		return node && node.nodeType === 11;
	},

	atTheTop: function(node) {
		return DU.isDocumentFragment(node) || DU.isBody(node);
	},

	isContentNode: function(node) {
		return !this.isComment(node) &&
			!this.isIEW(node) &&
			!this.isDiffMarker(node);
	},

	maybeDeletedNode: function(node) {
		return node && this.isElt(node) && this.isDiffMarker(node, 'deleted');
	},

	/**
	 * Is node a mw:DiffMarker node that represents a deleted block node?
	 * This annotation is added by the DOMDiff pass.
	 */
	isDeletedBlockNode: function(node) {
		return DU.maybeDeletedNode(node) &&
			node.getAttribute('data-is-block');
	},

	/**
	 * In wikitext, did origNode occur next to a block node which has been
	 * deleted? While looking for next, we look past DOM nodes that are
	 * transparent in rendering. (See emitsSolTransparentSingleLineWT for
	 * which nodes.)
	 */
	nextToDeletedBlockNodeInWT: function(origNode, before) {
		if (!origNode || DU.isBody(origNode)) {
			return false;
		}

		while (true) {  // eslint-disable-line
			// Find the nearest node that shows up in HTML (ignore nodes that show up
			// in wikitext but don't affect sol-state or HTML rendering -- note that
			// whitespace is being ignored, but that whitespace occurs between block nodes).
			var node = origNode;
			do {
				node = before ? node.previousSibling : node.nextSibling;
				if (DU.maybeDeletedNode(node)) {
					return this.isDeletedBlockNode(node);
				}
			} while (node && this.emitsSolTransparentSingleLineWT(node));

			if (node) {
				return false;
			} else {
				// Walk up past zero-width wikitext parents
				node = origNode.parentNode;
				if (!this.isZeroWidthWikitextElt(node)) {
					// If the parent occupies space in wikitext,
					// clearly, we are not next to a deleted block node!
					// We'll eventually hit BODY here and return.
					return false;
				}
				origNode = node;
			}
		}
	},

	/**
	 * Get the first child element or non-IEW text node, ignoring
	 * whitespace-only text nodes, comments, and deleted nodes.
	 */
	firstNonSepChild: function(node) {
		var child = node.firstChild;
		while (child && !this.isContentNode(child)) {
			child = child.nextSibling;
		}
		return child;
	},

	/**
	 * Get the last child element or non-IEW text node, ignoring
	 * whitespace-only text nodes, comments, and deleted nodes.
	 */
	lastNonSepChild: function(node) {
		var child = node.lastChild;
		while (child && !this.isContentNode(child)) {
			child = child.previousSibling;
		}
		return child;
	},

	previousNonSepSibling: function(node) {
		var prev = node.previousSibling;
		while (prev && !this.isContentNode(prev)) {
			prev = prev.previousSibling;
		}
		return prev;
	},

	nextNonSepSibling: function(node) {
		var next = node.nextSibling;
		while (next && !this.isContentNode(next)) {
			next = next.nextSibling;
		}
		return next;
	},

	numNonDeletedChildNodes: function(node) {
		var n = 0;
		var child = node.firstChild;
		while (child) {
			if (!this.isDiffMarker(child)) { // FIXME: This is ignoring both inserted/deleted
				n++;
			}
			child = child.nextSibling;
		}
		return n;
	},

	/**
	 * Get the first non-deleted child of node.
	 */
	firstNonDeletedChild: function(node) {
		var child = node.firstChild;
		while (child && this.isDiffMarker(child)) { // FIXME: This is ignoring both inserted/deleted
			child = child.nextSibling;
		}
		return child;
	},

	/**
	 * Get the last non-deleted child of node.
	 */
	lastNonDeletedChild: function(node) {
		var child = node.lastChild;
		while (child && this.isDiffMarker(child)) { // FIXME: This is ignoring both inserted/deleted
			child = child.previousSibling;
		}
		return child;
	},

	/**
	 * Get the next non deleted sibling.
	 */
	nextNonDeletedSibling: function(node) {
		node = node.nextSibling;
		while (node && this.isDiffMarker(node)) { // FIXME: This is ignoring both inserted/deleted
			node = node.nextSibling;
		}
		return node;
	},

	/**
	 * Get the previous non deleted sibling.
	 */
	previousNonDeletedSibling: function(node) {
		node = node.previousSibling;
		while (node && this.isDiffMarker(node)) { // FIXME: This is ignoring both inserted/deleted
			node = node.previousSibling;
		}
		return node;
	},

	/**
	 * Are all children of this node text or comment nodes?
	 */
	allChildrenAreTextOrComments: function(node) {
		var child = node.firstChild;
		while (child) {
			if (!this.isDiffMarker(child)
				&& !this.isText(child)
				&& !this.isComment(child)) {
				return false;
			}
			child = child.nextSibling;
		}
		return true;
	},

	/**
	 * Are all children of this node text nodes?
	 */
	allChildrenAreText: function(node) {
		var child = node.firstChild;
		while (child) {
			if (!this.isDiffMarker(child) && !this.isText(child)) {
				return false;
			}
			child = child.nextSibling;
		}
		return true;
	},

	/**
	 * Does `node` contain nothing or just non-newline whitespace?
	 * `strict` adds the condition that all whitespace is forbidden.
	 */
	nodeEssentiallyEmpty: function(node, strict) {
		var n = node.firstChild;
		while (n) {
			if (DU.isElt(n) && !this.isDiffMarker(n)) {
				return false;
			} else if (DU.isText(n) &&
					(strict || !/^[ \t]*$/.test(n.nodeValue))) {
				return false;
			} else if (DU.isComment(n)) {
				return false;
			}
			n = n.nextSibling;
		}
		return true;
	},

	/**
	 * Make a span element to wrap some bare text.
	 *
	 * @param {TextNode} node
	 * @param {string} type The type for the wrapper span.
	 * @return {Element} The wrapper span.
	 */
	wrapTextInTypedSpan: function(node, type) {
		var wrapperSpanNode = node.ownerDocument.createElement('span');
		wrapperSpanNode.setAttribute('typeof', type);
		// insert the span
		node.parentNode.insertBefore(wrapperSpanNode, node);
		// move the node into the wrapper span
		wrapperSpanNode.appendChild(node);
		return wrapperSpanNode;
	},

	/**
	 * Insert a meta element with the passed-in typeof attribute before a node.
	 *
	 * @param {Node} node
	 * @param {string} type
	 * @return {Element} The new meta.
	 */
	prependTypedMeta: function(node, type) {
		var meta = node.ownerDocument.createElement('meta');
		meta.setAttribute('typeof', type);
		node.parentNode.insertBefore(meta, node);
		return meta;
	},

	/**
	 * Create a `TagTk` corresponding to a DOM node.
	 */
	mkTagTk: function(node) {
		var attribKVs = this.getAttributeKVArray(node);
		return new pd.TagTk(node.nodeName.toLowerCase(), attribKVs, this.getDataParsoid(node));
	},

	/**
	 * Create a `EndTagTk` corresponding to a DOM node.
	 */
	mkEndTagTk: function(node) {
		var attribKVs = this.getAttributeKVArray(node);
		return new pd.EndTagTk(node.nodeName.toLowerCase(), attribKVs, this.getDataParsoid(node));
	},

	addAttributes: function(elt, attrs) {
		Object.keys(attrs).forEach(function(k) {
			if (attrs[k] !== null && attrs[k] !== undefined) {
				elt.setAttribute(k, attrs[k]);
			}
		});
	},

	/**
	 * Create a new DOM node with attributes.
	 */
	createNodeWithAttributes: function(document, type, attrs) {
		var node = document.createElement(type);
		DU.addAttributes(node, attrs);
		return node;
	},

	/**
	 * Check if the dom-subtree rooted at node has an element with tag name 'tagName'
	 * The root node is not checked.
	 */
	treeHasElement: function(node, tagName) {
		node = node.firstChild;
		while (node) {
			if (DU.isElt(node)) {
				if (node.nodeName === tagName || this.treeHasElement(node, tagName)) {
					return true;
				}
			}
			node = node.nextSibling;
		}

		return false;
	},

	/**
	 * Move 'from'.childNodes to 'to' adding them before 'beforeNode'
	 * If 'beforeNode' is null, the nodes are appended at the end.
	 */
	migrateChildren: function(from, to, beforeNode) {
		if (beforeNode === undefined) {
			beforeNode = null;
		}
		while (from.firstChild) {
			to.insertBefore(from.firstChild, beforeNode);
		}
	},

	/**
	 * Move 'from'.childNodes to 'to' adding them before 'beforeNode'
	 * 'from' and 'to' belong to different documents.
	 *
	 * If 'beforeNode' is null, the nodes are appended at the end.
	 */
	migrateChildrenBetweenDocs: function(from, to, beforeNode) {
		if (beforeNode === undefined) {
			beforeNode = null;
		}
		var n = from.firstChild;
		var destDoc = to.ownerDocument;
		while (n) {
			to.insertBefore(destDoc.importNode(n, true), beforeNode);
			n = n.nextSibling;
		}
	},

	FIRST_ENCAP_REGEXP: /(?:^|\s)(mw:(?:Transclusion|Param|LanguageVariant|Extension(\/[^\s]+)))(?=$|\s)/,

	/**
	 * Is node the first wrapper element of encapsulated content?
	 */
	isFirstEncapsulationWrapperNode: function(node) {
		return DU.isElt(node) &&
			this.FIRST_ENCAP_REGEXP.test(node.getAttribute('typeof'));
	},

	/**
	 * Find the first wrapper element of encapsulated content.
	 */
	findFirstEncapsulationWrapperNode: function(node) {
		if (!this.hasParsoidAboutId(node)) {
			return null;
		}
		var about = node.getAttribute('about');
		var prev = node;
		do {
			node = prev;
			prev = DU.previousNonDeletedSibling(node);
		} while (prev && DU.isElt(prev) && prev.getAttribute('about') === about);
		return DU.isFirstEncapsulationWrapperNode(node) ? node : null;
	},

	/**
	 * Is node an encapsulation wrapper elt?
	 *
	 * All root-level nodes of generated content are considered
	 * encapsulation wrappers and share an about-id.
	 */
	isEncapsulationWrapper: function(node) {
		// True if it has an encapsulation type or while walking backwards
		// over elts with identical about ids, we run into a node with an
		// encapsulation type.
		if (!DU.isElt(node)) {
			return false;
		}

		return this.findFirstEncapsulationWrapperNode(node) !== null;
	},

	/**
	 * Gets all siblings that follow 'node' that have an 'about' as
	 * their about id.
	 *
	 * This is used to fetch transclusion/extension content by using
	 * the about-id as the key.  This works because
	 * transclusion/extension content is a forest of dom-trees formed
	 * by adjacent dom-nodes.  This is the contract that templace
	 * encapsulation, dom-reuse, and VE code all have to abide by.
	 *
	 * The only exception to this adjacency rule is IEW nodes in
	 * fosterable positions (in tables) which are not span-wrapped to
	 * prevent them from getting fostered out.
	 */
	getAboutSiblings: function(node, about) {
		var nodes = [node];

		if (!about) {
			return nodes;
		}

		node = node.nextSibling;
		while (node && (
			DU.isElt(node) && node.getAttribute('about') === about ||
				this.isFosterablePosition(node) && !DU.isElt(node) && this.isIEW(node)
		)) {
			nodes.push(node);
			node = node.nextSibling;
		}

		// Remove already consumed trailing IEW, if any
		while (nodes.length && this.isIEW(lastItem(nodes))) {
			nodes.pop();
		}

		return nodes;
	},

	/**
	 * This function is only intended to be used on encapsulated nodes
	 * (Template/Extension/Param content).
	 *
	 * Given a 'node' that has an about-id, it is assumed that it is generated
	 * by templates or extensions.  This function skips over all
	 * following content nodes and returns the first non-template node
	 * that follows it.
	 */
	skipOverEncapsulatedContent: function(node) {
		var about = node.getAttribute('about');
		if (about) {
			return lastItem(this.getAboutSiblings(node, about)).nextSibling;
		} else {
			return node.nextSibling;
		}
	},

	/**
	 * Extract transclusion and extension expansions from a DOM, and return
	 * them in a structure like this:
	 * ```
	 *     {
	 *         transclusions: {
	 *             'key1': {
	 *                  html: 'html1',
	 *                  nodes: [<node1>, <node2>]
	 *             }
	 *         },
	 *         extensions: {
	 *             'key2': {
	 *                  html: 'html2',
	 *                  nodes: [<node1>, <node2>]
	 *             }
	 *         },
	 *         files: {
	 *             'key3': {
	 *                  html: 'html3',
	 *                  nodes: [<node1>, <node2>]
	 *             }
	 *         }
	 *     }
	 * ```
	 */
	extractExpansions: function(env, body) {
		var expansions = {
			transclusions: {},
			extensions: {},
			media: {},
		};
		function doExtractExpansions(node) {
			var nodes, expAccum;
			while (node) {
				if (DU.isElt(node)) {
					var typeOf = node.getAttribute('typeof');
					var about = node.getAttribute('about');
					if ((/(?:^|\s)(?:mw:(?:Transclusion(?=$|\s)|Extension\/))/.test(typeOf) && about) ||
							/(?:^|\s)(?:mw:(?:Image|Video|Audio)(?:(?=$|\s)|\/))/.test(typeOf)) {
						var dp = DU.getDataParsoid(node);
						nodes = DU.getAboutSiblings(node, about);

						var key;
						if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
							expAccum = expansions.transclusions;
							key = dp.src;
						} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
							expAccum = expansions.extensions;
							key = dp.src;
						} else {
							expAccum = expansions.media;
							// XXX gwicke: use proper key that is not
							// source-based? This also needs to work for
							// transclusion output.
							key = null;
						}

						if (key) {
							expAccum[key] = DU.makeExpansion(env, nodes);
						}

						node = lastItem(nodes);
					} else {
						doExtractExpansions(node.firstChild);
					}
				}
				node = node.nextSibling;
			}
		}
		// Kick off the extraction
		doExtractExpansions(body.firstChild);
		return expansions;
	},


	/**
	 * Wrap text and comment nodes in a node list into spans, so that all
	 * top-level nodes are elements.
	 *
	 * @param {Node[]} nodes List of DOM nodes to wrap, mix of node types.
	 * @return {Node[]} List of *element* nodes.
	 */
	addSpanWrappers: function(nodes) {
		var textCommentAccum = [];
		var out = [];
		var doc = nodes[0] && nodes[0].ownerDocument;

		function wrapAccum() {
			// Wrap accumulated nodes in a span
			var span = doc.createElement('span');
			var parentNode = textCommentAccum[0].parentNode;
			parentNode.insertBefore(span, textCommentAccum[0]);
			textCommentAccum.forEach(function(n) {
				span.appendChild(n);
			});
			DU.setDataParsoid(span, { tmp: { wrapper: true } });
			out.push(span);
			textCommentAccum = [];
		}

		// Build a real array out of nodes.
		//
		// Operating directly on DOM child-nodes array
		// and manipulating them by adding span wrappers
		// changes the traversal itself
		var nodeBuf = [];
		for (var i = 0; i < nodes.length; i++) {
			nodeBuf.push(nodes[i]);
		}

		nodeBuf.forEach(function(node) {
			if (DU.isText(node) || DU.isComment(node)) {
				textCommentAccum.push(node);
			} else {
				if (textCommentAccum.length) {
					wrapAccum();
				}
				out.push(node);
			}
		});

		if (textCommentAccum.length) {
			wrapAccum();
		}

		return out;
	},

	/**
	 * Get tokens representing a DOM forest (from transclusions, extensions,
	 * whatever that were generated as part of a separate processing pipeline)
	 * in the token stream. These tokens will tunnel the subtree through the
	 * token processing while preserving token stream semantics as if
	 * the DOM had been converted to tokens.
	 *
	 * @param {Node[]} nodes List of DOM nodes that need to be tunneled through.
	 * @param {Object} opts The pipeline opts that generated the DOM.
	 * @return {Array} List of token representatives.
	 */
	getWrapperTokens: function(nodes, opts) {
		var node = nodes[0];

		// Do we represent this with inline or block elements?
		// This is to ensure that we get p-wrapping correct.
		//
		// * If all content is inline, we use inline-elements to represent this
		//   so that this content gets swallowed into the P tag that wraps
		//   adjacent inline content.
		//
		// * If any part of this is a block content, we treat extension content
		//   independent of surrounding content and don't want inline content
		//   here to be swallowed into a P tag that wraps adjacent inline content.
		//
		// This behavior ensures that we and clients can "drop-in" extension content
		// into the DOM without messing with fixing up paragraph tags of surrounding
		// content. It could potentially introduce minor rendering differences when
		// compared to PHP parser output, but we'll swallow it for now.
		var wrapperType = 'INLINE';
		if (opts.noPWrapping) {
			// If the DOM fragment is being processed in the context where P wrapping
			// has been suppressed, we represent the DOM fragment with inline-tokens.
			//
			// FIXME(SSS): Looks like we have some "impedance mismatch" here. But, this
			// is correct in scenarios where link-content or image-captions are being
			// processed in a sub-pipeline and we don't want a <div> in the link-caption
			// to cause the <a>..</a> to get split apart.
		} else if (opts.unwrapFragment === false) {
			// Sealed fragments aren't amenable to inspection, since the
			// ultimate content is unknown.  For example, refs shuttle content
			// through treebuilding that ends up in the references list.
			//
			// FIXME(arlolra): Do we need a mechanism to specify content
			// categories?
		} else {
			for (var i = 0; i < nodes.length; i++) {
				if (DU.isBlockNode(nodes[i]) || DU.hasBlockElementDescendant(nodes[i])) {
					wrapperType = 'BLOCK';
					break;
				}
			}
		}

		var wrapperName;
		if (wrapperType === 'BLOCK' && !DU.isBlockNode(node)) {
			wrapperName = 'DIV';
		} else if (node.nodeName === 'A') {
			// Do not use 'A' as a wrapper node because it could
			// end up getting nested inside another 'A' and the DOM
			// structure can change where the wrapper tokens are no
			// longer siblings.
			// Ex: "[http://foo.com Bad nesting [[Here]]].
			wrapperName = 'SPAN';
		} else if (wrapperType === 'INLINE') {
			wrapperName = 'SPAN';
		} else {
			wrapperName = node.nodeName;
		}

		var workNode;
		if (DU.isElt(node) && node.hasChildNodes() || wrapperName !== node.nodeName) {
			// Create a copy of the node without children
			workNode = node.ownerDocument.createElement(wrapperName);
			// copy over attributes
			for (var j = 0; j < node.attributes.length; j++) {
				var attribute = node.attributes.item(j);
				if (attribute.name !== 'typeof') {
					workNode.setAttribute(attribute.name, attribute.value);
				}
			}
			// dataAttribs are not copied over so that we don't inject
			// broken tsr or dsr values. This also lets these tokens pass
			// through the sanitizer as stx.html is not set.
		} else {
			workNode = node;
		}

		var tokens = [];
		DU.convertDOMtoTokens(tokens, workNode);

		// Remove the typeof attribute from the first token. It will be
		// replaced with mw:DOMFragment.
		tokens[0].removeAttribute('typeof');

		return tokens;
	},

	isDOMFragmentWrapper: function(node) {
		return DU.isElt(node) &&
			node.getAttribute('about') &&
			Util.isDOMFragmentType(node.getAttribute('typeof'));
	},

	isSealedFragmentOfType: function(node, type) {
		if (!DU.isElt(node)) {
			return false;
		}
		const re = new RegExp('(?:^|\\s)mw:DOMFragment\\/sealed\\/' + type + '(?=$|\\s)');
		return re.test(node.getAttribute('typeof'));
	},

	/**
	 * Generates wrapper tokens for a HTML expansion -- the wrapper
	 * tokens are placeholders that adequately represent semantics
	 * of the HTML DOM for the purposes of additional token transformations
	 * that will be applied to them.
	 *
	 * @param {MWParserEnvironment} env
	 *    The active environment/context.
	 *
	 * @param {Token} token
	 *    The token that generated the DOM.
	 *
	 * @param {Object} expansion
	 * @param {string} expansion.html
	 *    HTML of the expansion.
	 * @param {Node[]} expansion.nodes
	 *    Outermost nodes of the HTML.
	 *
	 * @param {Object} [opts]
	 * @param {string} opts.aboutId
	 *    The about-id to set on the generated tokens.
	 * @param {boolean} opts.noAboutId
	 *    If true, an about-id will not be added to the tokens
	 *    if an aboutId is not provided.
	 *    For example: `<figure>`
	 * @param {Object} opts.tsr
	 *    The TSR to set on the generated tokens. This TSR is
	 *    used to compute DSR on the placeholder tokens.
	 *    The computed DSR is transferred over to the unpacked DOM
	 *    if setDSR is true (see below).
	 * @param {boolean} opts.setDSR
	 *    When the DOM fragment is unpacked, this option governs
	 *    whether the DSR from the placeholder node is transferred
	 *    over to the unpacked DOM or not.
	 *    For example: Cite, reused transclusions.
	 * @param {boolean} opts.isForeignContent
	 *    Does the DOM come from outside the main page? This governs
	 *    how the encapsulation ids are assigned to the unpacked DOM.
	 *    For example: transclusions, extensions -- all siblings get the same
	 *    about id. This is not true for `<figure>` HTML.
	 */
	encapsulateExpansionHTML: function(env, token, expansion, opts) {
		opts = opts || {};

		// Get placeholder tokens to get our subdom through the token processing
		// stages. These will be finally unwrapped on the DOM.
		var toks = this.getWrapperTokens(expansion.nodes, opts);
		var firstWrapperToken = toks[0];

		// Add the DOMFragment type so that we get unwrapped later.
		firstWrapperToken.setAttribute('typeof', 'mw:DOMFragment' + (opts.unwrapFragment === false ? '/sealed/' + opts.wrapperName : ''));

		// Assign the HTML fragment to the data-parsoid.html on the first wrapper token.
		firstWrapperToken.dataAttribs.html = expansion.html;

		// Set foreign content flag.
		if (opts.isForeignContent) {
			if (!firstWrapperToken.dataAttribs.tmp) {
				firstWrapperToken.dataAttribs.tmp = {};
			}
			firstWrapperToken.dataAttribs.tmp.isForeignContent = true;
		}

		// Pass through setDSR flag
		if (opts.setDSR) {
			if (!firstWrapperToken.dataAttribs.tmp) {
				firstWrapperToken.dataAttribs.tmp = {};
			}
			firstWrapperToken.dataAttribs.tmp.setDSR = opts.setDSR;
		}

		// Add about to all wrapper tokens, if necessary.
		var about = opts.aboutId;
		if (!about && !opts.noAboutId) {
			about = env.newAboutId();
		}
		if (about) {
			toks.forEach(function(tok) {
				tok.setAttribute('about', about);
			});
		}

		// Transfer the tsr.
		// The first token gets the full width, the following tokens zero width.
		var tokenTsr = opts.tsr || (token.dataAttribs ? token.dataAttribs.tsr : null);
		if (tokenTsr) {
			firstWrapperToken.dataAttribs.tsr = tokenTsr;
			firstWrapperToken.dataAttribs.tagWidths = token.dataAttribs ? token.dataAttribs.tagWidths : null;
			var endTsr = [tokenTsr[1], tokenTsr[1]];
			for (var i = 1; i < toks.length; i++) {
				toks[i].dataAttribs.tsr = endTsr;
			}
		}

		return toks;
	},

	/**
	 * Convert a HTML5 DOM into a mw:DOMFragment and generate appropriate
	 * tokens to insert into the token stream for further processing.
	 *
	 * The DOMPostProcessor will unpack the fragment and insert the HTML
	 * back into the DOM.
	 *
	 * @param {MWParserEnvironment} env
	 *    The active environment/context.
	 *
	 * @param {Token} token
	 *    The token that generated the DOM.
	 *
	 * @param {Node} body
	 *    The DOM that the token expanded to.
	 *
	 * @param {Function} addAttrsCB
	 *    Callback that adds additional attributes to the generated tokens.
	 *
	 * @param {Object} opts
	 *    Options to be passed onto the encapsulation code
	 *    See encapsulateExpansionHTML's doc. for more info about these options.
	 */
	buildDOMFragmentTokens: function(env, token, body, addAttrsCB, opts) {
		console.assert(DU.isBody(body), 'DOMFragment expected body node.');

		var nodes;
		if (body.hasChildNodes()) {
			nodes = body.childNodes;
		} else {
			// RT extensions expanding to nothing.
			nodes = [body.ownerDocument.createElement('link')];
		}

		// Wrap bare text nodes into spans
		nodes = DU.addSpanWrappers(nodes);

		if (addAttrsCB) {
			addAttrsCB(nodes[0]);
		}

		// Get placeholder tokens to get our subdom through the token processing
		// stages. These will be finally unwrapped on the DOM.
		var expansion = DU.makeExpansion(env, nodes);
		return DU.encapsulateExpansionHTML(env, token, expansion, opts);
	},

	makeExpansion: function(env, nodes) {
		nodes.forEach(function(n) {
			// The nodes have been through post-processing and,
			// therefore, had their tmp data stripped.  However,
			// we just added tmp info in the span wrapping above,
			// so keep it; it's necessary and safe.
			DU.visitDOM(n, DU.storeDataAttribs, { keepTmp: true });
		});
		return { nodes: nodes, html: env.setFragment(nodes) };
	},

	/**
	 * Compute, when possible, the wikitext source for a node in
	 * an environment env. Returns null if the source cannot be
	 * extracted.
	 * @param {MWParserEnvironment} env
	 * @param {Node} node
	 */
	getWTSource: function(env, node) {
		var data = this.getDataParsoid(node);
		var dsr = (undefined !== data) ? data.dsr : null;
		return dsr && Util.isValidDSR(dsr) ?
			env.page.src.substring(dsr[0], dsr[1]) : null;
	},

	/**
	 * @param {Node} node
	 */
	deleteNode: function(node) {
		if (node.parentNode) {
			node.parentNode.removeChild(node);
		} else {
			console.warn('ERROR: Null parentNode in deleteNode');
			console.trace();
		}
	},

	/**
	 * For an explanation of what TSR is, see
	 * {@link computeDSR.js}.
	 *
	 * TSR info on all these tags are only valid for the opening tag.
	 * (closing tags dont have attrs since tree-builder strips them
	 *  and adds meta-tags tracking the corresponding TSR)
	 *
	 * On other tags, a, hr, br, meta-marker tags, the tsr spans
	 * the entire DOM, not just the tag.
	 *
	 * This code is not in {@link WikitextConstants} because this
	 * information is Parsoid-implementation-specific.
	 * @namespace
	 */
	WtTagsWithLimitedTSR: {
		"b":       true,
		"i":       true,
		"h1":      true,
		"h2":      true,
		"h3":      true,
		"h4":      true,
		"h5":      true,
		"ul":      true,
		"ol":      true,
		"dl":      true,
		"li":      true,
		"dt":      true,
		"dd":      true,
		"table":   true,
		"caption": true,
		"tr":      true,
		"td":      true,
		"th":      true,
		"hr":      true, // void element
		"br":      true, // void element
		"pre":     true,
	},

	tsrSpansTagDOM: function(n, parsoidData) {
		// - tags known to have tag-specific tsr
		// - html tags with 'stx' set
		// - span tags with 'mw:Nowiki' type
		var name = n.nodeName.toLowerCase();
		return !(
			this.WtTagsWithLimitedTSR[name] ||
			this.hasLiteralHTMLMarker(parsoidData) ||
			this.isNodeOfType(n, 'SPAN', 'mw:Nowiki')
		);
	},

	// Similar to the method on tokens
	addNormalizedAttribute: function(node, name, val, origVal) {
		node.setAttribute(name, val);
		DU.setShadowInfo(node, name, val, origVal);
	},

	// Similar to the method on tokens
	setShadowInfo: function(node, name, val, origVal) {
		if (val === origVal || origVal === null) { return; }
		var dp = DU.getDataParsoid(node);
		if (!dp.a) { dp.a = {}; }
		if (!dp.sa) { dp.sa = {}; }
		if (origVal !== undefined &&
				// FIXME: This is a hack to not overwrite already shadowed info.
				// We should either fix the call site that depends on this
				// behaviour to do an explicit check, or double down on this
				// by porting it to the token method as well.
				!dp.a.hasOwnProperty(name)) {
			dp.sa[name] = origVal;
		}
		dp.a[name] = val;
	},

	// Comment encoding/decoding.
	//
	//  * Some relevant phab tickets: T94055, T70146, T60184, T95039
	//
	// The wikitext comment rule is very simple: <!-- starts a comment,
	// and --> ends a comment.  This means we can have almost anything as the
	// contents of a comment (except the string "-->", but see below), including
	// several things that are not valid in HTML5 comments:
	//
	//  * For one, the html5 comment parsing algorithm [0] leniently accepts
	//    --!> as a closing comment tag, which differs from the php+tidy combo.
	//
	//  * If the comment's data matches /^-?>/, html5 will end the comment.
	//    For example, <!-->stuff<--> breaks up as
	//    <!--> (the comment) followed by, stuff<--> (as text).
	//
	//  * Finally, comment data shouldn't contain two consecutive hyphen-minus
	//    characters (--), nor end in a hyphen-minus character (/-$/) as defined
	//    in the spec [1].
	//
	// We work around all these problems by using HTML entity encoding inside
	// the comment body.  The characters -, >, and & must be encoded in order
	// to prevent premature termination of the comment by one of the cases
	// above.  Encoding other characters is optional; all entities will be
	// decoded during wikitext serialization.
	//
	// In order to allow *arbitrary* content inside a wikitext comment,
	// including the forbidden string "-->" we also do some minimal entity
	// decoding on the wikitext.  We are also limited by our inability
	// to encode DSR attributes on the comment node, so our wikitext entity
	// decoding must be 1-to-1: that is, there must be a unique "decoded"
	// string for every wikitext sequence, and for every decoded string there
	// must be a unique wikitext which creates it.
	//
	// The basic idea here is to replace every string ab*c with the string with
	// one more b in it.  This creates a string with no instance of "ac",
	// so you can use 'ac' to encode one more code point.  In this case
	// a is "--&", "b" is "amp;", and "c" is "gt;" and we use ac to
	// encode "-->" (which is otherwise unspeakable in wikitext).
	//
	// Note that any user content which does not match the regular
	// expression /--(>|&(amp;)*gt;)/ is unchanged in its wikitext
	// representation, as shown in the first two examples below.
	//
	// User-authored comment text    Wikitext       HTML5 DOM
	// --------------------------    -------------  ----------------------
	// & - >                         & - >          &amp; &#43; &gt;
	// Use &gt; here                 Use &gt; here  Use &amp;gt; here
	// -->                           --&gt;         &#43;&#43;&gt;
	// --&gt;                        --&amp;gt;     &#43;&#43;&amp;gt;
	// --&amp;gt;                    --&amp;amp;gt; &#43;&#43;&amp;amp;gt;
	//
	// [0] http://www.w3.org/TR/html5/syntax.html#comment-start-state
	// [1] http://www.w3.org/TR/html5/syntax.html#comments

	/**
	 * Map a wikitext-escaped comment to an HTML DOM-escaped comment.
	 * @param {string} comment Wikitext-escaped comment.
	 * @return {string} DOM-escaped comment.
	 */
	encodeComment: function(comment) {
		// Undo wikitext escaping to obtain "true value" of comment.
		var trueValue = comment
			.replace(/--&(amp;)*gt;/g, Util.decodeEntities);
		// Now encode '-', '>' and '&' in the "true value" as HTML entities,
		// so that they can be safely embedded in an HTML comment.
		// This part doesn't have to map strings 1-to-1.
		return trueValue
			.replace(/[->&]/g, Util.entityEncodeAll);
	},

	/**
	 * Map an HTML DOM-escaped comment to a wikitext-escaped comment.
	 * @param {string} comment DOM-escaped comment.
	 * @return {string} Wikitext-escaped comment.
	 */
	decodeComment: function(comment) {
		// Undo HTML entity escaping to obtain "true value" of comment.
		var trueValue = Util.decodeEntities(comment);
		// ok, now encode this "true value" of the comment in such a way
		// that the string "-->" never shows up.  (See above.)
		return trueValue
			.replace(/--(&(amp;)*gt;|>)/g, function(s) {
				return s === '-->' ? '--&gt;' : '--&amp;' + s.slice(3);
			});
	},

	/**
	 * Utility function: we often need to know the wikitext DSR length for
	 * an HTML DOM comment value.
	 * @param {Node} node A comment node containing a DOM-escaped comment.
	 * @return {number} The wikitext length necessary to encode this comment,
	 *   including 7 characters for the `<!--` and `-->` delimiters.
	 */
	decodedCommentLength: function(node) {
		console.assert(DU.isComment(node));
		// Add 7 for the "<!--" and "-->" delimiters in wikitext.
		return DU.decodeComment(node.data).length + 7;
	},

	/**
	 * Escape `<nowiki>` tags.
	 *
	 * @param {string} text
	 * @return {string}
	 */
	escapeNowikiTags: function(text) {
		return text.replace(/<(\/?nowiki\s*\/?\s*)>/gi, '&lt;$1&gt;');
	},

	/**
	 * Is node a table tag (table, tbody, td, tr, etc.)?
	 * @param {Node} node
	 * @return {boolean}
	 */
	isTableTag: function(node) {
		return Consts.HTML.TableTags.has(node.nodeName);
	},

	/**
	 * Is node nested inside a table tag that uses HTML instead of native
	 * wikitext?
	 * @param {Node} node
	 * @return {boolean}
	 */
	inHTMLTableTag: function(node) {
		var p = node.parentNode;
		while (DU.isTableTag(p)) {
			if (DU.isLiteralHTMLNode(p)) {
				return true;
			} else if (p.nodeName === 'TABLE') {
				// Don't cross <table> boundaries
				return false;
			}
			p = p.parentNode;
		}

		return false;
	},
};

/**
 * XML Serializer.
 *
 * @param {Node} node
 * @param {Object} [options] XMLSerializer options.
 * @return {string}
 */
DOMUtils.toXML = function(node, options) {
	return XMLSerializer.serialize(node, options).html;
};

/**
 * .dataobject aware XML serializer, to be used in the DOM
 * post-processing phase.
 *
 * @param {Node} node
 * @param {Object} [options]
 * @return {string}
 */
DOMUtils.ppToXML = function(node, options) {
	// We really only want to pass along `options.keepTmp`
	DU.visitDOM(node, DU.storeDataAttribs, options);
	return DU.toXML(node, options);
};

/**
 * .dataobject aware HTML parser, to be used in the DOM
 * post-processing phase.
 *
 * @param {string} html
 * @param {Object} [options]
 * @return {Node}
 */
DOMUtils.ppToDOM = function(html, options) {
	options = options || {};
	var node = options.node;
	if (node === undefined) {
		node = DU.parseHTML(html).body;
	} else {
		node.innerHTML = html;
	}
	DU.visitDOM(node, DU.loadDataAttribs, options.markNew);
	return node;
};

/**
 * @param {Document} doc
 * @param {Object} obj
 */
DOMUtils.injectPageBundle = function(doc, obj) {
	var pb = JSON.stringify(obj);
	var script = doc.createElement('script');
	DU.addAttributes(script, {
		id: 'mw-pagebundle',
		type: 'application/x-mw-pagebundle',
	});
	script.appendChild(doc.createTextNode(pb));
	doc.head.appendChild(script);
};

/**
 * @param {Document} doc
 * @return {Object|null}
 */
DOMUtils.extractPageBundle = function(doc) {
	var pb = null;
	var dpScriptElt = doc.getElementById('mw-pagebundle');
	if (dpScriptElt) {
		dpScriptElt.parentNode.removeChild(dpScriptElt);
		pb = JSON.parse(dpScriptElt.text);
	}
	return pb;
};

/**
 * Pull the data-parsoid script element out of the doc before serializing.
 *
 * @param {Node} node
 * @param {Object} [options] XMLSerializer options.
 * @return {string}
 */
DOMUtils.extractDpAndSerialize = function(node, options) {
	if (!options) { options = {}; }
	options.captureOffsets = true;
	var pb = DU.extractPageBundle(DU.isBody(node) ? node.ownerDocument : node);
	var out = XMLSerializer.serialize(node, options);
	// Add the wt offsets.
	Object.keys(out.offsets).forEach(function(key) {
		var dp = pb.parsoid.ids[key];
		console.assert(dp);
		if (Util.isValidDSR(dp.dsr)) {
			out.offsets[key].wt = dp.dsr.slice(0, 2);
		}
	});
	pb.parsoid.sectionOffsets = out.offsets;
	Object.assign(out, { pb: pb, offsets: undefined });
	return out;
};

/**
 * Dump the DOM with attributes.
 *
 * @param {Node} rootNode
 * @param {string} title
 * @param {Object} [options]
 */
DOMUtils.dumpDOM = function(rootNode, title, options) {
	options = options || {};
	if (options.storeDiffMark || options.dumpFragmentMap) { console.assert(options.env); }
	function cloneData(node, clone) {
		if (!DU.isElt(node)) { return; }
		var d = DU.getNodeData(node);
		DU.setNodeData(clone, Util.clone(d));
		if (options.storeDiffMark) {
			DU.storeDiffMark(clone, options.env);
		}
		node = node.firstChild;
		clone = clone.firstChild;
		while (node) {
			cloneData(node, clone);
			node = node.nextSibling;
			clone = clone.nextSibling;
		}
	}

	// cloneNode doesn't clone data => walk DOM to clone it
	var clonedRoot = rootNode.cloneNode(true);
	cloneData(rootNode, clonedRoot);

	var str = DU.ppToXML(clonedRoot);

	if (!options.quiet) {
		console.warn('----- ' + title + ' -----');
	}

	console.warn(str);

	// Dump cached fragments
	if (options.dumpFragmentMap) {
		Array.from(options.env.fragmentMap.keys()).forEach(function(k) {
			var newOpts = Util.clone(options);
			newOpts.dumpFragmentMap = false;
			newOpts.quiet = true;
			console.warn('='.repeat(15));
			console.warn("FRAGMENT " + k + "\n");
			const fragment = options.env.fragmentMap.get(k);
			DU.dumpDOM(Array.isArray(fragment) ? fragment[0] : fragment, '', newOpts);
		});
	}

	if (!options.quiet) {
		console.warn('-'.repeat(title.length + 12));
	}
};

/**
 * Parse HTML, return the tree.
 *
 * @param {string} html
 * @return {Node}
 */
DOMUtils.parseHTML = function(html) {
	if (!html.match(/^<(?:!doctype|html|body)/i)) {
		// Make sure that we parse fragments in the body. Otherwise comments,
		// link and meta tags end up outside the html element or in the head
		// element.
		html = '<body>' + html;
	}
	return domino.createDocument(html);
};

/**
 * Little helper function for encoding XML entities.
 *
 * @param {string} string
 * @return {string}
 */
DOMUtils.encodeXml = function(string) {
	return entities.encodeXML(string);
};

/**
 * Convert mediawiki-format language code to a BCP47-compliant language
 * code suitable for including in HTML.  See
 * `GlobalFunctions.php::wfBCP47()` in mediawiki sources.
 *
 * @param {string} code Mediawiki language code.
 * @return {string} BCP47 language code.
 */
DOMUtils.bcp47 = function(code) {
	var codeSegment = code.split('-');
	var codeBCP = [];
	codeSegment.forEach(function(seg, segNo) {
		// When previous segment is x, it is a private segment and should be lc
		if (segNo > 0 && /^x$/i.test(codeSegment[segNo - 1])) {
			codeBCP[segNo] = seg.toLowerCase();
		// ISO 3166 country code
		} else if (seg.length === 2 && segNo > 0) {
			codeBCP[segNo] = seg.toUpperCase();
		// ISO 15924 script code
		} else if (seg.length === 4 && segNo > 0) {
			codeBCP[segNo] = seg[0].toUpperCase() + seg.slice(1).toLowerCase();
		// Use lowercase for other cases
		} else {
			codeBCP[segNo] = seg.toLowerCase();
		}
	});
	return codeBCP.join('-');
};

var WikitextSerializer;
var SelectiveSerializer;
/**
 * Fetch prior DOM for selser.  This is factored out of
 * {@link .serializeDOM} so that it can be reused by alternative
 * content handlers which support selser.
 *
 * @param {Object} env The environment.
 * @param {boolean} useSelser Use the selective serializer, or not.
 * @return {Promise} A promise that is resolved after selser information
 *   has been loaded.
 */
DOMUtils.fetchSelser = function(env, useSelser) {
	var hasOldId = !!env.page.meta.revision.revid;
	var needsContent = useSelser && hasOldId && (env.page.src === null);
	var needsOldDOM = useSelser && !(env.page.dom || env.page.domdiff);

	var p = Promise.resolve();
	if (needsContent) {
		p = p.then(function() {
			var target = env.normalizeAndResolvePageTitle();
			return TemplateRequest.setPageSrcInfo(env, target, env.page.meta.revision.revid)
			.catch(function(err) {
				env.log('error', 'Error while fetching page source.', err);
			});
		});
	}
	if (needsOldDOM) {
		p = p.then(function() {
			if (env.page.src === null) {
				// The src fetch failed or we never had an oldid.
				// We'll just fallback to non-selser.
				return;
			}
			return env.getContentHandler().toHTML(env)
			.then(function(doc) {
				env.page.dom = DU.parseHTML(DU.toXML(doc)).body;
			})
			.catch(function(err) {
				env.log('error', 'Error while parsing original DOM.', err);
			});
		});
	}

	return p;
};

/**
 * The main serializer from DOM to *wikitext*.
 *
 * If you could be handling non-wikitext content, use
 * `env.getContentHandler().fromHTML(env, body, useSelser)` instead.
 * See {@link MWParserEnvironment#getContentHandler}.
 *
 * @param {Object} env The environment.
 * @param {Node} body The document body to serialize.
 * @param {boolean} useSelser Use the selective serializer, or not.
 * @param {Function} cb Optional callback.
 */
DOMUtils.serializeDOM = function(env, body, useSelser, cb) {
	// Circular refs
	if (!WikitextSerializer) {
		WikitextSerializer = require('../html2wt/WikitextSerializer.js')
			.WikitextSerializer;
		SelectiveSerializer = require('../html2wt/SelectiveSerializer.js')
			.SelectiveSerializer;
	}
	console.assert(DU.isBody(body), 'Expected a body node.');

	return DOMUtils.fetchSelser(env, useSelser).then(function() {
		var Serializer = useSelser ? SelectiveSerializer : WikitextSerializer;
		var serializer = new Serializer({ env: env });
		// TODO(arlolra): There's probably an opportunity to refactor callers
		// of `DU.serializeDOM` to use `DU.ppToDOM` but this is a safe bet
		// for now, since it's the main entrypoint to serialization.
		DU.visitDOM(body, DU.loadDataAttribs, true);
		if (useSelser && env.page.dom) {
			DU.visitDOM(env.page.dom, DU.loadDataAttribs, true);
		}
		env.page.editedDoc = body.ownerDocument;
		return serializer.serializeDOM(body);
	}).nodify(cb);
};

/** @private */
var processPage = function(page) {
	return {
		missing: page.missing !== undefined,
		known: page.known !== undefined,
		redirect: page.redirect !== undefined,
		disambiguation: page.pageprops &&
			page.pageprops.disambiguation !== undefined,
	};
};

/**
 * Add red links to a document.
 *
 * @param {MWParserEnvironment} env
 * @param {Document} doc
 */
DOMUtils.addRedLinks = Promise.async(function *(env, doc) {
	const wikiLinks = doc.body.querySelectorAll('a[rel~="mw:WikiLink"]');

	const titleSet = wikiLinks.reduce(function(s, a) {
		const title = a.getAttribute('title');
		// Magic links, at least, don't have titles
		if (title !== null) { s.add(title); }
		return s;
	}, new Set());

	const titles = Array.from(titleSet.values());
	if (titles.length === 0) { return; }

	const titleMap = new Map();
	(yield Batcher.getPageProps(env, titles)).forEach(function(r) {
		Object.keys(r.batchResponse).forEach(function(t) {
			const o = r.batchResponse[t];
			titleMap.set(o.title, processPage(o));
		});
	});
	wikiLinks.forEach(function(a) {
		const k = a.getAttribute('title');
		if (k === null) { return; }
		let data = titleMap.get(k);
		if (data === undefined) {
			let err = true;
			// Unfortunately, normalization depends on db state for user
			// namespace aliases, depending on gender choices.  Workaround
			// it by trying them all.
			const title = env.makeTitleFromURLDecodedStr(k, undefined, true);
			if (title !== null) {
				const ns = title.getNamespace();
				if (ns.isUser() || ns.isUserTalk()) {
					const key = ':' + title._key.replace(/_/g, ' ');
					err = !(env.conf.wiki.siteInfo.namespacealiases || [])
						.some(function(a) {
							if (a.id === ns._id && titleMap.has(a['*'] + key)) {
								data = titleMap.get(a['*'] + key);
								return true;
							}
							return false;
						});
				}
			}
			if (err) {
				env.log('warn', 'We should have data for the title: ' + k);
				return;
			}
		}
		a.removeAttribute('class');  // Clear all
		if (data.missing && !data.known) {
			a.classList.add('new');
		}
		if (data.redirect) {
			a.classList.add('mw-redirect');
		}
		// Jforrester suggests that, "ideally this'd be a registry so that
		// extensions could, er, extend this functionality – this is an
		// API response/CSS class that is provided by the Disambigutation
		// extension."
		if (data.disambiguation) {
			a.classList.add('mw-disambig');
		}
	});
});

DOMUtils.isParsoidSectionTag = function(node) {
	return node.nodeName === 'SECTION' &&
		node.getAttribute('data-mw-section-id') !== null;
};

DOMUtils.stripSectionTagsAndFallbackIds = function(node) {
	var n = node.firstChild;
	while (n) {
		var next = n.nextSibling;
		if (DU.isElt(n)) {
			// Recurse into subtree before stripping this
			DU.stripSectionTagsAndFallbackIds(n);

			// Strip <section> tags
			if (DU.isParsoidSectionTag(n)) {
				DU.migrateChildren(n, n.parentNode, n);
				DU.deleteNode(n);
			}

			// Strip <span typeof='mw:FallbackId' ...></span>
			if (DU.isFallbackIdSpan(n)) {
				DU.deleteNode(n);
			}
		}
		n = next;
	}
};

/**
 * Is the node from extension content?
 * @param {Node} node
 * @param {string} extType
 * @return {boolean}
 */
DOMUtils.fromExtensionContent = function(node, extType) {
	var parentNode = node.parentNode;
	var extReg = new RegExp('\\bmw:Extension\\/' + extType + '\\b');
	while (parentNode && !DU.atTheTop(parentNode)) {
		if (extReg.test(parentNode.getAttribute('typeof'))) {
			return true;
		}
		parentNode = parentNode.parentNode;
	}
	return false;
};

/**
 * @param {Document} doc
 * @param {Object} obj
 * @return {boolean}
 */
DOMUtils.extractInlinedContentVersion = function(doc, obj) {
	var el = doc.querySelector('meta[property=mw:html:version]');
	if (el) {
		obj.originalVersion = el.getAttribute('content');
		return true;
	}
	return false;
};

/**
 * Extract http-equiv headers from the HTML, including content-language and
 * vary headers, if present
 *
 * @param {Document} doc
 * @return {Object}
 */
DOMUtils.findHttpEquivHeaders = function(doc) {
	return Array.from(doc.querySelectorAll('meta[http-equiv][content]'))
	.reduce((r,el) => {
		r[el.getAttribute('http-equiv').toLowerCase()] =
			el.getAttribute('content');
		return r;
	}, {});
};

/**
 * Returns a media element nested in `node`
 *
 * @param {Node} node
 * @return {Node|null}
 */
DOMUtils.selectMediaElt = function(node) {
	return node.querySelector('img, video, audio');
};

if (typeof module === "object") {
	module.exports.DOMUtils = DOMUtils;
}
