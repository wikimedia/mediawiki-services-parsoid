/*
 * General DOM utilities.
 */
'use strict';
require('./core-upgrade.js');

var domino = require('domino');
var entities = require('entities');
var Util = require('./mediawiki.Util.js').Util;
var JSUtils = require('./jsutils').JSUtils;
var Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;
var pd = require('./mediawiki.parser.defines.js');
var ApiRequest = require('./mediawiki.ApiRequest.js');
var XMLSerializer = require('./XMLSerializer');

// define some constructor shortcuts
var ParsoidCacheRequest = ApiRequest.ParsoidCacheRequest;
var TemplateRequest = ApiRequest.TemplateRequest;
var KV = pd.KV;


/**
 * @class DOMUtils
 * General DOM utilities
 * @singleton
 */
var DU, DOMUtils;
DOMUtils = DU = {

	/**
	 * Check whether this is a DOM element node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isElt: function(node) {
		return node && node.nodeType === 1;
	},

	/**
	 * Check whether this is a DOM text node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isText: function(node) {
		return node && node.nodeType === 3;
	},

	/**
	 * Check whether this is a DOM comment node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
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
	 * See Util#isBlockTag()
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
		return DU.isElt(node) && node.nodeName === "BODY";
	},

	/**
	 * Is 'node' a block node that is also visible in wikitext?
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
			dp.stx && (dp.stx === "url" || dp.stx === "magiclink");
	},

	/**
	 * Attribute equality test
	 * @param {Node} nodeA
	 * @param {Node} nodeB
	 * @param {Set} [ignoreableAttribs] Set of attributes that should be ignored
	 * @param {Map} [specializedAttribHandlers] Map of attributes with specialized equals handlers
	 */
	attribsEquals: function(nodeA, nodeB, ignoreableAttribs, specializedAttribHandlers) {
		if (!ignoreableAttribs) {
			ignoreableAttribs = new Set();
		}

		function arrayToHash(attrs) {
			var h = {};
			var count = 0;
			for (var i = 0, n = attrs.length; i < n; i++) {
				var a = attrs.item(i);
				if (!ignoreableAttribs.has(a.name)) {
					count++;
					h[a.name] = a.value;
				}
			}

			return { h: h, count: count };
		}

		var xA = arrayToHash(nodeA.attributes || []);
		var xB = arrayToHash(nodeB.attributes || []);

		if (xA.count !== xB.count) {
			return false;
		}

		var hA = xA.h;
		var keysA = Object.keys(hA).sort();
		var hB = xB.h;
		var keysB = Object.keys(hB).sort();

		if (!specializedAttribHandlers) {
			specializedAttribHandlers = new Map();
		}

		for (var i = 0; i < xA.count; i++) {
			var k = keysA[i];
			if (k !== keysB[i]) {
				return false;
			}

			var attribEquals = specializedAttribHandlers.get(k);
			if (attribEquals) {
				// Use a specialized compare function, if provided
				if (!hA[k] || !hB[k] || !attribEquals(nodeA, JSON.parse(hA[k]), nodeB, JSON.parse(hB[k]))) {
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
	 * getAttribute/setAttribute/removeAttribute
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

	// Direct manipulation of the nodes for load and store.

	loadDataAttrib: function(node, name, defaultVal) {
		if (!DU.isElt(node)) {
			return;
		}
		var data = this.getNodeData(node);
		if (data[name] === undefined) {
			data[name] = this.getJSONAttribute(node, 'data-' + name, defaultVal);
		}
		return data[name];
	},

	saveDataAttribs: function(node) {
		if (!DU.isElt(node)) {
			return;
		}
		var data = DU.getNodeData(node);
		Object.keys(data).forEach(function(key) {
			if (key.match(/^tmp_/) !== null) {
				return;
			}
			var val = data[key];
			if (val && val.constructor === String) {
				node.setAttribute('data-' + key, val);
			} else if (val instanceof Object) {
				DU.setJSONAttribute(node, 'data-' + key, val);
			}
			// Else: throw error?
		});
	},

	// Save data attributes for nodes of this DOM.
	saveDataAttribsForDOM: function(node) {
		DU.saveDataAttribs(node);
		node = node.firstChild;
		while (node) {
			DU.saveDataAttribsForDOM(node);
			node = node.nextSibling;
		}
	},

	// Load and stores the data as JSON attributes on the nodes.
	// These should only used when transferring between pipelines
	// ie. when the serialized nodes will lose their .dataobject's

	loadDataAttribs: function(node) {
		if (!DU.isElt(node)) {
			return;
		}
		[ "Parsoid", "Mw" ].forEach(function(attr) {
			DU["loadData" + attr](node);
			node.removeAttribute("data-" + attr);
		});
	},

	loadDataParsoid: function(node) {
		if (!DU.isElt(node)) {
			return;
		}

		var dp = this.loadDataAttrib(node, 'parsoid', {});
		if (!dp.tmp) {
			dp.tmp = {};
		}
	},

	loadDataMw: function(node) {
		var mw = this.loadDataAttrib(node, 'mw', {});
	},

	storeDataParsoid: function(node, dpObj) {
		return this.setJSONAttribute(node, "data-parsoid", dpObj);
	},

	storeDataMw: function(node, dmObj) {
		return this.setJSONAttribute(node, "data-mw", dmObj);
	},

	// The following getters and setters load from the .dataobject store,
	// with the intention of eventually moving them off the nodes themselves.

	getDataParsoid: function(node) {
		var data = this.getNodeData(node);
		if (!data.parsoid) {
			this.loadDataParsoid(node);
		}
		return data.parsoid;
	},

	getDataMw: function(node) {
		var data = this.getNodeData(node);
		if (!data.mw) {
			this.loadDataMw(node);
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
	 * @param {String} name Name of the attribute
	 * @param {Mixed} defaultVal What should be returned if we fail to find a valid JSON structure
	 */
	getJSONAttribute: function(node, name, defaultVal) {
		if (!DU.isElt(node)) {
			return defaultVal !== undefined ? defaultVal : {};
		}

		var attVal = node.getAttribute(name);
		if (!attVal) {
			return defaultVal !== undefined ? defaultVal : {};
		}
		try {
			return JSON.parse(attVal);
		} catch (e) {
			console.warn('ERROR: Could not decode attribute-val ' + attVal +
					' for ' + name + ' on node ' + node.outerHTML);
			return defaultVal !== undefined ? defaultVal : {};
		}
	},

	/**
	 * Set an attribute on a node to a JSON-encoded object.
	 *
	 * @param {Node} node
	 * @param {string} name Name of the attribute
	 * @param {Object} obj
	 * @return {Node} The `node` parameter
	 */
	setJSONAttribute: function(node, name, obj) {
		node.setAttribute(name, JSON.stringify(obj));
		return node;
	},

	/**
	 * Get shadowed information about an attribute on a node.
	 *
	 * @param {Node} node
	 * @param {string} name
	 * @return {Object}
	 *   @return {Mixed} return.value
	 *   @return {boolean} return.modified If the value of the attribute changed since we parsed the wikitext
	 *   @return {boolean} return.fromsrc Whether we got the value from source-based roundtripping
	 */
	getAttributeShadowInfo: function(node, name) {
		var curVal = node.getAttribute(name);
		var dp = this.getDataParsoid(node);

		// Not the case, continue regular round-trip information.
		if (dp.a === undefined) {
			return { // jscs:ignore jsDoc
				value: curVal,
				// Mark as modified if a new element
				modified: this.isNewElt(node),
				fromsrc: false,
			};
		} else if (dp.a[name] !== curVal) {
			return { // jscs:ignore jsDoc
				value: curVal,
				modified: true,
				fromsrc: false,
			};
		} else if (dp.sa === undefined || dp.sa[name] === undefined) {
			return { // jscs:ignore jsDoc
				value: curVal,
				modified: false,
				fromsrc: false,
			};
		} else {
			return { // jscs:ignore jsDoc
				value: dp.sa[name],
				modified: false,
				fromsrc: true,
			};
		}
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
			kvs.push(new KV(attrib.name, attrib.value));
		}
		return kvs;
	},

	/**
	 * Build path from a node to its passed-in ancestor.
	 * Doesn't include the ancestor in the returned path.
	 *
	 * @param {Node} node
	 * @param {Node} ancestor Should be an ancestor of `node`
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
	 * @param {Node} n1 The node you expect to come first
	 * @param {Node} n2 Expected later sibling
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
	 * @param {Node} n1 The suspected ancestor
	 * @param {Node} n2 The suspected descendant
	 */
	isAncestorOf: function(n1, n2) {
		while (n2 && n2 !== n1) {
			n2 = n2.parentNode;
		}
		return n2 !== null;
	},

	/**
	 * Check whether 'node' has an ancesor of name 'name'
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
	 * Check whether a node's name is...
	 *
	 * @param {Node} n
	 * @param {string} name
	 */
	hasNodeName: function(n, name) {
		return n.nodeName.toLowerCase() === name;
	},

	/**
	 * Determine whether the node matches the given nodeName and typeof
	 * attribute value.
	 *
	 * @param {Node} n
	 * @param {string} name Passed into #hasNodeName
	 * @param {string} type Expected value of "typeof" attribute
	 */
	isNodeOfType: function(n, name, type) {
		return n.nodeName.toLowerCase() === name && n.getAttribute("typeof") === type;
	},

	/**
	 * Check a node to see whether it's a meta with some typeof.
	 *
	 * @param {Node} n
	 * @param {string} type Passed into #isNodeOfType
	 */
	isMarkerMeta: function(n, type) {
		return this.isNodeOfType(n, "meta", type);
	},

	// FIXME: What is the convention we should use for constants like this?
	// Or, is there one for node.js already?
	TPL_META_TYPE_REGEXP: /(?:^|\s)(mw:(?:Transclusion|Param)(?:\/End)?)(?=$|\s)/,

	/**
	 * Check whether a meta's typeof indicates that it is a template expansion.
	 *
	 * @param {string} nType
	 */
	isTplMetaType: function(nType) {
		return this.TPL_META_TYPE_REGEXP.test(nType);
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
			this.hasNodeName(node, "meta") &&
			this.isTplMetaType(node.getAttribute("typeof"))
		);
	},

	/**
	 * Check whether a node is a meta signifying the start of a template expansion.
	 */
	isTplStartMarkerMeta: function(node) {
		if (this.hasNodeName(node, "meta")) {
			var t = node.getAttribute("typeof");
			var tMatch = /(?:^|\s)mw:Transclusion(\/[^\s]+)*(?=$|\s)/.test(t);
			return tMatch && !/\/End(?=$|\s)/.test(t);
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
		if (this.hasNodeName(n, "meta")) {
			var t = n.getAttribute("typeof");
			return (/(?:^|\s)mw:Transclusion(\/[^\s]+)*\/End(?=$|\s)/).test(t);
		} else {
			return false;
		}
	},

	/**
	 * Check whether a node's data-parsoid object includes
	 * an indicator that the original wikitext was a literal
	 * HTML element (like table or p)
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
		return node.getAttribute('data-parsoid') === null;
	},

	/**
	 * Run a node through #hasLiteralHTMLMarker
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
		return this.hasNodeName(node, "pre") && !this.isLiteralHTMLNode(node);
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

	isGeneratedFigure: function(n) {
		return DU.isElt(n) && (/(^|\s)mw:Image(\s|$|\/)/).test(n.getAttribute("typeof"));
	},

	/**
	 * Get the first preceding sibling of 'node' that is an element,
	 * or return `null` if there is no such sibling element.
	 */
	getPrevElementSibling: function(node) {
		var sibling = node.previousSibling;
		while (sibling) {
			if (DU.isElt(sibling)) {
				return sibling;
			}
			sibling = sibling.previousSibling;
		}
		return null;
	},

	/**
	 * Get the first succeeding sibling of 'node' that is an element,
	 * or return `null` if there is no such sibling element.
	 */
	getNextElementSibling: function(node) {
		var sibling = node.nextSibling;
		while (sibling) {
			if (DU.isElt(sibling)) {
				return sibling;
			}
			sibling = sibling.nextSibling;
		}
		return null;
	},

	/**
	 * Check whether a node has any children that are elements.
	 */
	hasElementChild: function(node) {
		var children = node.childNodes;
		for (var i = 0, n = children.length; i < n; i++) {
			if (DU.isElt(children[i])) {
				return true;
			}
		}

		return false;
	},

	/**
	 * Check if a node has a block-level element descendant.
	 */
	hasBlockElementDescendant: function(node) {
		var children = node.childNodes;
		for (var i = 0, n = children.length; i < n; i++) {
			var child = children[i];
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
	isTplOrExtToplevelNode: function(node) {
		if (DU.isElt(node)) {
			var about = node.getAttribute('about');
			// SSS FIXME: Verify that our DOM spec clarifies this
			// expectation on about-ids and that our clients respect this.
			return about && Util.isParsoidObjectId(about);
		} else {
			return false;
		}
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
	 * @param {MWParserEnvironment} env
	 * @param {Node} node
	 * @param {boolean} [wt2htmlMode]
	 */
	emitsSolTransparentSingleLineWT: function(env, node, wt2htmlMode) {
		if (DU.isText(node)) {
			// NB: We differ here to meet the nl condition.
			return node.nodeValue.match(/^[ \t]*$/);
		} else if (DU.isSolTransparentLink(node)) {
			return (wt2htmlMode || !DU.isNewElt(node));
		} else if (DU.isComment(node)) {
			return true;
		} else if (DU.isBehaviorSwitch(env, node)) {
			return (wt2htmlMode || !DU.isNewElt(node));
		} else if (node.nodeName !== 'META') {
			return false;
		} else {  // only metas left
			// NB: The only metas in a DOM should be for behavior switches and
			// include directives, other than explicit HTML meta tags. This
			// differs from our counterpart in Util where ref meta tokens
			// haven't been expanded to spans yet.
			return DU.getDataParsoid(node).stx !== 'html';
		}
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
			return node.childNodes.length === 0 || node.innerHTML.match(/^\n/);
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
			var dp;
			for (var i = 0, n = attrs.length; i < n; i++) {
				var a = attrs.item(i);
				if (a.name === "data-parsoid") {
					dp = JSON.parse(a.value);
				} else {
					out.push(new KV(a.name, a.value));
				}
			}
			return { attrs: out, dataAttrs: dp };
		}

		switch (node.nodeType) {
			case node.ELEMENT_NODE:
				var nodeName = node.nodeName.toLowerCase();
				var children = node.childNodes;
				var attrInfo = domAttrsToTagAttrs(node.attributes);

				if (Util.isVoidElement(nodeName)) {
					tokBuf.push(new pd.SelfclosingTagTk(nodeName, attrInfo.attrs, attrInfo.dataAttrs));
				} else {
					tokBuf.push(new pd.TagTk(nodeName, attrInfo.attrs, attrInfo.dataAttrs));
					for (var i = 0, n = children.length; i < n; i++) {
						tokBuf = this.convertDOMtoTokens(tokBuf, children[i]);
					}
					var endTag = new pd.EndTagTk(nodeName);
					// Keep stx parity
					if (this.isLiteralHTMLNode(node)) {
						endTag.dataAttribs = { 'stx': 'html'};
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

	isDiffMarker: function(node) {
		return node && this.isMarkerMeta(node, "mw:DiffMarker");
	},

	currentDiffMark: function(node, env) {
		if (!node || !DU.isElt(node)) {
			return null;
		}
		var data = this.getNodeData(node);
		var dpd = data["parsoid-diff"];
		if (!dpd) {
			dpd = this.loadDataAttrib(node, "parsoid-diff");
		}
		return dpd !== {} && dpd.id === env.page.id ? dpd : null;
	},

	/**
	 * Check that the diff markers on the node exist and are recent.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	hasDiffMarkers: function(node, env) {
		return this.currentDiffMark(node, env) !== null;
	},

	hasDiffMark: function(node, env, mark) {
		// For 'deletion' and 'insertion' markers on non-element nodes,
		// a mw:DiffMarker met is added
		if (mark === 'deleted' || (mark === 'inserted' && !DU.isElt(node))) {
			return this.isDiffMarker(node.previousSibling);
		} else {
			var diffMark = this.currentDiffMark(node, env);
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
		var dmark = this.currentDiffMark(node, env);
		return dmark && dmark.diff.every(function subTreechangeMarker(mark) {
			return mark === 'subtree-changed' || mark === 'children-changed';
		});
	},

	addDiffMark: function(node, env, mark) {
		if (mark === 'deleted' || mark === 'moved') {
			DU.prependTypedMeta(node, 'mw:DiffMarker');
		} else if (DU.isText(node) || DU.isComment(node)) {
			if (mark !== 'inserted') {
				env.log("error", "BUG! CHANGE-marker for ", node.nodeType, " node is: ", mark);
			}
			DU.prependTypedMeta(node, 'mw:DiffMarker');
		} else {
			DU.setDiffMark(node, env, mark);
		}
	},

	/**
	 * Set a diff marker on a node.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 * @param {string} change
	 */
	setDiffMark: function(node, env, change) {
		var dpd = this.getJSONAttribute(node, 'data-parsoid-diff', null);
		if (dpd !== null && dpd.id === env.page.id) {
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

		// Clear out the loaded value
		this.getNodeData(node)["parsoid-diff"] = undefined;

		// Add serialization info to this node
		this.setJSONAttribute(node, 'data-parsoid-diff', dpd);
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
		return node && this.isElt(node) && this.isDiffMarker(node);
	},

	/**
	 * Is node a mw:DiffMarker node that represents a deleted block node?
	 * This annotation is added by the DOMDiff pass
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
	nextToDeletedBlockNodeInWT: function(env, origNode, before) {
		if (!origNode || DU.isBody(origNode)) {
			return false;
		}

		while (true) {
			// Find the nearest node that shows up in HTML (ignore nodes that show up
			// in wikitext but don't affect sol-state or HTML rendering -- note that
			// whitespace is being ignored, but that whitespace occurs between block nodes).
			var node = origNode;
			do {
				node = before ? node.previousSibling : node.nextSibling;
				if (DU.maybeDeletedNode(node)) {
					return this.isDeletedBlockNode(node);
				}
			} while (node && this.emitsSolTransparentSingleLineWT(env, node));

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
	 * whitespace-only text nodes and comments.
	 */
	firstNonSepChildNode: function(node) {
		var child = node.firstChild;
		while (child && !this.isContentNode(child)) {
			child = child.nextSibling;
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
			if (!this.isDiffMarker(child)) {
				n++;
			}
			child = child.nextSibling;
		}
		return n;
	},

	/**
	 * Get the first mw:DiffMarker child of node
	 */
	firstNonDeletedChildNode: function(node) {
		var child = node.firstChild;
		while (child && this.isDiffMarker(child)) {
			child = child.nextSibling;
		}
		return child;
	},

	/**
	 * Get the last mw:DiffMarker child of node
	 */
	lastNonDeletedChildNode: function(node) {
		var child = node.lastChild;
		while (child && this.isDiffMarker(child)) {
			child = child.previousSibling;
		}
		return child;
	},

	/**
	 * Get the next non mw:DiffMarker sibling
	 */
	nextNonDeletedSibling: function(node) {
		node = node.nextSibling;
		while (node && this.isDiffMarker(node)) {
			node = node.nextSibling;
		}
		return node;
	},

	/**
	 * Get the previous non mw:DiffMarker sibling
	 */
	previousNonDeletedSibling: function(node) {
		node = node.previousSibling;
		while (node && this.isDiffMarker(node)) {
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
		var childNodes = node.childNodes;
		if (0 === childNodes.length) {
			return true;
		} else {
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
		}
	},

	/**
	 * Make a span element to wrap some bare text.
	 *
	 * @param {TextNode} node
	 * @param {string} type The type for the wrapper span
	 * @return {Element} The wrapper span
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
	 * Create a `EndTagTk` corresponding to a DOM node
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
	 * Create a new DOM node with attributes
	 */
	createNodeWithAttributes: function(document, type, attrs) {
		var node = document.createElement(type);
		DU.addAttributes(node, attrs);
		return node;
	},

	/**
	 * Return `true` iff the element has a `class` attribute containing
	 * `someClass` (among other space-separated classes).
	 * @param {Element} ele
	 * @param {string} someClass
	 */
	hasClass: function(ele, someClass) {
		if (!ele || !DU.isElt(ele)) {
			return false;
		}

		var classes = ele.getAttribute('class');

		return new RegExp('(?:^|\\s)' + someClass + '(?=$|\\s)').test(classes);
	},

	hasBlockContent: function(node) {
		var child = node.firstChild;
		while (child) {
			if (this.isBlockNode(child)) {
				return true;
			}
			child = child.nextSibling;
		}

		return false;
	},

	/**
	 * Check if the dom-subtree rooted at node has an element with tag name 'tagName'
	 * The root node is not checked
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
		// FIXME: For some reason, the 'deep' equivalent of this function
		// is optional and domino does not support it.
		function importNode(destDoc, n) {
			var newN = destDoc.importNode(n);
			DU.loadDataAttribs(newN);
			n = n.firstChild;
			while (n) {
				newN.appendChild(importNode(destDoc, n));
				n = n.nextSibling;
			}
			return newN;
		}

		if (beforeNode === undefined) {
			beforeNode = null;
		}

		var n = from.firstChild;
		var destDoc = to.ownerDocument;
		while (n) {
			to.insertBefore(importNode(destDoc, n), beforeNode);
			n = n.nextSibling;
		}
	},

	FIRST_ENCAP_REGEXP: /(?:^|\s)(mw:(?:Transclusion|Param|Extension(\/[^\s]+)))(?=$|\s)/,

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
		if (!this.isTplOrExtToplevelNode(node)) {
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
		while (nodes.length && this.isIEW(nodes.last())) {
			nodes.pop();
		}

		return nodes;
	},

	/**
	 * This function is only intended to be used on encapsulated nodes
	 * (Template/Extension/Param content)
	 *
	 * Given a 'node' that has an about-id, it is assumed that it is generated
	 * by templates or extensions.  This function skips over all
	 * following content nodes and returns the first non-template node
	 * that follows it.
	 */
	skipOverEncapsulatedContent: function(node) {
		var about = node.getAttribute('about');
		if (about) {
			return this.getAboutSiblings(node, about).last().nextSibling;
		} else {
			return node.nextSibling;
		}
	},

	/**
	 * Extract transclusion and extension expansions from a DOM, and return
	 * them in a structure like this:
	 *
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
	 */
	extractExpansions: function(doc) {
		var node = doc.body;
		var expansion;
		var expansions = {
			transclusions: {},
			extensions: {},
			files: {},
		};

		function doExtractExpansions(node) {
			var nodes, expAccum;

			while (node) {
				if (DU.isElt(node)) {
					var typeOf = node.getAttribute('typeof');
					var about = node.getAttribute('about');
					if ((/(?:^|\s)(?:mw:(?:Transclusion(?=$|\s)|Extension\/))/
								.test(typeOf) && about) ||
							/(?:^|\s)(?:mw:Image(?:(?=$|\s)|\/))/.test(typeOf)) {
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
							expAccum = expansions.files;
							// XXX gwicke: use proper key that is not
							// source-based? This also needs to work for
							// transclusion output.
							key = dp.cacheKey;
						}

						if (key) {
							expAccum[key] = {
								nodes: nodes,
								html: nodes.map(function(node) {
									return node.outerHTML;
								}).join(''),
							};
						}
						node = nodes.last();
					} else {
						doExtractExpansions(node.firstChild);
					}
				}
				node = node.nextSibling;
			}
		}
		// Kick off the extraction
		doExtractExpansions(doc.body.firstChild);
		return expansions;
	},


	/**
	 * Wrap text and comment nodes in a node list into spans, so that all
	 * top-level nodes are elements.
	 *
	 * @param {Node[]} nodes List of DOM nodes to wrap, mix of node types
	 * @return {Node[]} List of *element* nodes
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
			span.setAttribute("data-parsoid", JSON.stringify({tmp: { wrapper: true }}));
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
	 * @param {Node[]} nodes List of DOM nodes that need to be tunneled through
	 * @param {Object} opts The pipeline opts that generated the DOM
	 * @return {Array} List of token representatives
	 */
	getWrapperTokens: function(nodes, opts) {

		function makeWrapperForNode(node, wrapperType) {
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
			if (DU.isElt(node) && node.childNodes.length || wrapperName !== node.nodeName) {
				// Create a copy of the node without children
				workNode = node.ownerDocument.createElement(wrapperName);
				// copy over attributes
				for (var i = 0; i < node.attributes.length; i++) {
					var attribute = node.attributes.item(i);
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

			// Now convert our node to tokens
			var res = [];
			DU.convertDOMtoTokens(res, workNode);
			return res;
		}

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
		var firstNode = nodes[0];
		var lastNode = nodes.length > 1 ? nodes.last() : null;
		var wrapperType;
		if (opts.noPWrapping) {
			// If the DOM fragment is being processed in the context where P wrapping
			// has been suppressed, we represent the DOM fragment with inline-tokens.
			//
			// SSS FIXME: Looks like we have some "impedance mismatch" here. But, this
			// is correct in scenarios where link-content or image-captions are being
			// processed in a sub-pipeline and we don't want a <div> in the link-caption
			// to cause the <a>..</a> to get split apart.
			//
			wrapperType = 'INLINE';
		} else if (lastNode && DU.isBlockNode(lastNode)) {
			wrapperType = 'BLOCK';
		} else {
			wrapperType = 'INLINE';
			for (var i = 0; i < nodes.length; i++) {
				if (DU.isBlockNode(nodes[i]) || DU.hasBlockElementDescendant(nodes[i])) {
					wrapperType = 'BLOCK';
					break;
				}
			}
		}

		// Get two tokens each representing the start and end elements.
		//
		// The assumption behind this is that in order to tunnel the  DOM fragment
		// through the token stream intact (which, please note, has already
		// been through all token transforms), we just need to figure out how
		// the edges of the DOM fragment interact with the rest of the DOM that
		// will get built up. In order to do this, we can just look at the edges
		// of the fragment as represented by the first and last nodes.
		var tokens = makeWrapperForNode(firstNode, wrapperType);
		if (lastNode) {
			tokens = tokens.concat(makeWrapperForNode(lastNode, wrapperType));
		}

		// Remove the typeof attribute from the first token. It will be
		// replaced with mw:DOMFragment.
		tokens[0].removeAttribute('typeof');

		return tokens;
	},

	isDOMFragmentWrapper: function(node) {
		function hasRightType(node) {
			return (/(?:^|\s)mw:DOMFragment(?=$|\s)/).test(node.getAttribute("typeof"));
		}
		function previousSiblingIsWrapper(sibling, about) {
			return sibling &&
				DU.isElt(sibling) &&
				about === sibling.getAttribute("about") &&
				hasRightType(sibling);
		}
		if (!DU.isElt(node)) {
			return false;
		}
		var about = node.getAttribute("about");
		return about && (
			hasRightType(node) ||
			previousSiblingIsWrapper(node.previousSibling, about)
		);
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
	 * @param {String} expansion.html
	 *    HTML of the expansion
	 * @param {Node[]} expansion.nodes
	 *    Outermost nodes of the HTML
	 *
	 * @param {Object} [opts]
	 * @param {String} opts.aboutId
	 *    The about-id to set on the generated tokens.
	 * @param {Boolean} opts.noAboutId
	 *    If true, an about-id will not be added to the tokens
	 *    if an aboutId is not provided.
	 *    For example: `<figure>`
	 * @param {Object} opts.tsr
	 *    The TSR to set on the generated tokens. This TSR is
	 *    used to compute DSR on the placeholder tokens.
	 *    The computed DSR is transferred over to the unpacked DOM
	 *    if setDSR is true (see below).
	 * @param {Boolean} opts.setDSR
	 *    When the DOM fragment is unpacked, this option governs
	 *    whether the DSR from the placeholder node is transferred
	 *    over to the unpacked DOM or not.
	 *    For example: Cite, reused transclusions
	 * @param {Boolean} opts.isForeignContent
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
		firstWrapperToken.setAttribute('typeof', 'mw:DOMFragment');
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
	 * @param {Node|String} docOrHTML
	 *    The DOM (or HTML string) that the token expanded to.
	 *
	 * @param {Function} addAttrsCB
	 *    Callback that adds additional attributes to the generated tokens.
	 *
	 * @param {Object} opts
	 *    Options to be passed onto the encapsulation code
	 *    See encapsulateExpansionHTML's doc. for more info about these options.
	 */
	buildDOMFragmentTokens: function(env, token, docOrHTML, addAttrsCB, opts) {
		var doc = docOrHTML.constructor === String ? this.parseHTML(docOrHTML) : docOrHTML;
		var nodes = doc.body.childNodes;

		if (nodes.length === 0) {
			// RT extensions expanding to nothing.
			nodes = [doc.createElement('link')];
		}

		// Wrap bare text nodes into spans
		nodes = this.addSpanWrappers(nodes);

		if (addAttrsCB) {
			addAttrsCB(nodes[0]);
		}

		// Get placeholder tokens to get our subdom through the token processing
		// stages. These will be finally unwrapped on the DOM.
		return this.encapsulateExpansionHTML(
			env,
			token,
			{
				nodes: nodes,
				html: nodes.map(function(n) { return n.outerHTML; }).join(''),
			},
			opts
		);
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

	// For an explanation of what TSR is, see dom.computeDSR.js
	//
	// TSR info on all these tags are only valid for the opening tag.
	// (closing tags dont have attrs since tree-builder strips them
	//  and adds meta-tags tracking the corresponding TSR)
	//
	// On other tags, a, hr, br, meta-marker tags, the tsr spans
	// the entire DOM, not just the tag.
	//
	// This code is not in mediawiki.wikitext.constants.js because this
	// information is Parsoid-implementation-specific.
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
			this.isNodeOfType(n, 'span', 'mw:Nowiki')
		);
	},

	// Applies a data-parsoid JSON structure to the document.
	// Leaves id attributes behind -- they are used by citation
	// code to extract <ref> body from the DOM.
	applyDataParsoid: function(document, dp) {
		function applyToSiblings(node) {
			var id;
			while (node) {
				if (DU.isElt(node)) {
					id = node.getAttribute("id");
					if (dp.ids.hasOwnProperty(id)) {
						DU.setJSONAttribute(node, 'data-parsoid', dp.ids[id]);
					}
					if (node.childNodes.length > 0) {
						applyToSiblings(node.firstChild);
					}
				}
				node = node.nextSibling;
			}
		}
		applyToSiblings(document.body);
	},

	// Removes the data-parsoid attribute from a node,
	// and migrates the data to the document's JSON store.
	// Generates a unique id with the following format:
	//   mw<base64-encoded counter>
	// but attempts to keep user defined ids.
	stripDataParsoid: function(env, node, dp) {
		var uid = node.getAttribute('id');
		var document = node.ownerDocument;
		var docDp = DU.getDataParsoid(document);
		var origId = uid || null;
		if (docDp.ids.hasOwnProperty(uid)) {
			uid = null;
			// FIXME: Protect mw ids while tokenizing to avoid false positives.
			env.log('warning', 'Wikitext for this page has duplicate ids: ' + origId);
		}
		if (!uid) {
			do {
				docDp.counter += 1;
				uid = 'mw' + JSUtils.counterToBase64(docDp.counter);
			} while (document.getElementById(uid));
			DU.addNormalizedAttribute(node, 'id', uid, origId);
		}
		docDp.ids[uid] = dp;
		DU.getNodeData(node).parsoid = undefined;
		// It would be better to instrument all the load sites.
		node.removeAttribute('data-parsoid');
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
		if (origVal !== undefined && !dp.a.hasOwnProperty(name)) {
			dp.sa[ name ] = origVal;
		}
		dp.a[ name ] = val;
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

	// Map a wikitext-escaped comment to an HTML DOM-escaped comment.
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

	// Map an HTML DOM-escaped comment to a wikitext-escaped comment.
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

	// Utility function: we often need to know the wikitext DSR length for
	// an HTML DOM comment value.
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

};

// FIXME: Maybe we need a serializer dom-utils file?

// In selser mode, check if an unedited node's wikitext from source wikitext
// is reusable as is.
DOMUtils.origSrcValidInEditedContext = function(env, node) {
	var prev;

	if (node.nodeName === 'TH' || node.nodeName === 'TD') {
		// The wikitext representation for them is dependent
		// on cell position (first cell is always single char).

		// If there is no previous sibling, nothing to worry about.
		prev = node.previousSibling;
		if (!prev) {
			return true;
		}

		// If previous sibling is unmodified, nothing to worry about.
		if (!DU.isMarkerMeta(prev, "mw:DiffMarker") &&
			!DU.hasInsertedDiffMark(prev, env)) {
			return true;
		}

		// If it didn't have a stx_v marker that indicated that the cell
		// showed up on the same line via the "||" or "!!" syntax, nothing
		// to worry about.
		return DU.getDataParsoid(node).stx_v !== 'row';
	} else if (DU.isNestedListOrListItem(node)) {
		// If there are no previous siblings, bullets were assigned to
		// containing elements in the ext.core.ListHandler. For example,
		//
		//   *** a
		//
		// Will assign bullets as,
		//
		//   <ul><li-*>
		//     <ul><li-*>
		//       <ul><li-*> a</li></ul>
		//     </li></ul>
		//   </li></ul>
		//
		// If we reuse the src for the inner li with the a, we'd be missing
		// two bullets because the tag handler for lists in the serializer only
		// emits start tag src when it hits a first child that isn't a list
		// element. We need to walk up and get them.
		prev = node.previousSibling;
		if (!prev) {
			return false;
		}

		// If a previous sibling was modified, we can't reuse the start dsr.
		while (prev) {
			if (DU.isMarkerMeta(prev, 'mw:DiffMarker') ||
				DU.hasInsertedDiffMark(prev, env)
			) {
				return false;
			}
			prev = prev.previousSibling;
		}

		return true;
	} else {
		return true;
	}
};

var XMLSerializer = new XMLSerializer();

/**
 * @method
 *
 * Serialize a HTML DOM3 document to XHTML
 * The output is identical to standard XHTML5 DOM serialization, as given by
 * http://www.w3.org/TR/html-polyglot/
 * and
 * https://html.spec.whatwg.org/multipage/syntax.html#serialising-html-fragments
 * except that we may quote attributes with single quotes, *only* where that would
 * result in more compact output than the standard double-quoted serialization.
 *
 * @param {Node} doc
 * @param {Object} [options]
 * @param {boolean} [options.smartQuote=true]
 * @param {boolean} [options.innerXML=false]
 * @param {boolean} [options.captureOffsets=false]
 * @return {Object}
 * @return {string} return.str
 */
DOMUtils.serializeNode = function(doc, options) {
	if (!options) { options = {}; }
	if (!options.hasOwnProperty('smartQuote')) {
		options.smartQuote = true;
	}
	if (doc.nodeName === '#document') {
		doc = doc.documentElement;
	}
	var res = XMLSerializer.serializeToString(doc, options);
	// Ensure there's a doctype for documents.
	if (!options.innerXML && /^html$/i.test(doc.nodeName)) {
		res.str = '<!DOCTYPE html>\n' + res.str;
	}
	return res;
};

/**
 * @method
 *
 * Serialize the children of a HTML DOM3 node to XHTML
 * The output is identical to standard XHTML5 DOM serialization, as given by
 * http://www.w3.org/TR/html-polyglot/
 * and
 * https://html.spec.whatwg.org/multipage/syntax.html#serialising-html-fragments
 * except that we may quote attributes with single quotes, *only* where that would
 * result in more compact output than the standard double-quoted serialization.
 *
 * @param {Node} node
 * @param {Object} [options]
 * @param {boolean} [options.smartQuote]
 * @param {boolean} [options.captureOffsets]
 * @return {string}
 */
DOMUtils.serializeChildren = function(node, options) {
	if (!options) {
		options = {
			smartQuote: true,
		};
	}
	options.innerXML = true;
	return this.serializeNode(node, options).str;
};

/**
 * @method
 *
 * Normalize newlines in IEW to spaces instead.
 *
 * @param {Node} body
 *   The document `<body>` node to normalize.
 * @param {RegExp} [stripSpanTypeof]
 * @param {Boolean} [parsoidOnly=false]
 * @return {Node}
 */
DOMUtils.normalizeIEW = function(body, stripSpanTypeof, parsoidOnly) {
	var newlineAround = function(node) {
		return node && /^(BODY|CAPTION|DIV|DD|DT|LI|P|TABLE|TR|TD|TH|TBODY|DL|OL|UL|H[1-6])$/.test(node.nodeName);
	};
	var cleanSpans = function(node) {
		var child, next;
		for (child = node.firstChild; child && stripSpanTypeof; child = next) {
			next = child.nextSibling;
			if (child.nodeName === 'SPAN' &&
				stripSpanTypeof.test(child.getAttribute('typeof') || '')) {
				unwrapSpan(node, child);
			}
		}
	};
	var unwrapSpan = function(parent, node) {
		var child, next, placeholder;
		// first recurse to unwrap any spans in the immediate children.
		cleanSpans(node);
		// now unwrap this span.
		placeholder = node.ownerDocument.createTextNode('XXX');
		parent.replaceChild(placeholder, node);
		for (child = node.firstChild; child; child = next) {
			next = child.nextSibling;
			parent.insertBefore(child, placeholder);
		}
		parent.removeChild(placeholder);
	};
	var visit = function(node, stripLeadingWS, stripTrailingWS, inPRE) {
		var child, next, prev, nl, placeholder;
		if (node.nodeName === 'PRE') {
			// Preserve newlines in <pre> tags
			inPRE = true;
		}
		if (DOMUtils.isText(node)) {
			if (!inPRE) {
				node.data = node.data.replace(/\s+/g, ' ');
			}
			if (stripLeadingWS) {
				node.data = node.data.replace(/^\s+/, '');
			}
			if (stripTrailingWS) {
				node.data = node.data.replace(/\s+$/, '');
			}
		}
		// unwrap certain SPAN nodes
		cleanSpans(node);
		// now remove comment nodes
		if (!parsoidOnly) {
			for (child = node.firstChild; child; child = next) {
				next = child.nextSibling;
				if (DOMUtils.isComment(child)) {
					node.removeChild(child);
				}
			}
		}
		// reassemble text nodes split by a comment or span, if necessary
		node.normalize();
		// now recurse.
		if (node.nodeName === 'PRE') {
			// hack, since PHP adds a newline before </pre>
			stripLeadingWS = false;
			stripTrailingWS = true;
		} else if (node.nodeName === 'SPAN' &&
				/^mw[:]/.test(node.getAttribute('typeof') || '')) {
			// SPAN is transparent; pass the strip parameters down to kids
			/* jshint noempty: false */
		} else {
			stripLeadingWS = stripTrailingWS = newlineAround(node);
		}
		for (child = node.firstChild; child; child = next) {
			next = child.nextSibling;
			visit(child,
				stripLeadingWS && !child.previousSibling,
				stripTrailingWS && !child.nextSibling,
				inPRE);
		}
		// now add newlines around appropriate nodes.
		for (child = node.firstChild; child && !inPRE; child = next) {
			prev = child.previousSibling;
			next = child.nextSibling;
			if (newlineAround(child)) {
				if (prev && DOMUtils.isText(prev)) {
					prev.data = prev.data.replace(/\s*$/, '\n');
				} else {
					prev = node.ownerDocument.createTextNode('\n');
					node.insertBefore(prev, child);
				}
				if (next && DOMUtils.isText(next)) {
					next.data = next.data.replace(/^\s*/, '\n');
				} else {
					next = node.ownerDocument.createTextNode('\n');
					node.insertBefore(next, child.nextSibling);
				}
			}
		}
		return node;
	};
	// clone body first, since we're going to destructively mutate it.
	return visit(body.cloneNode(true), true, true, false);
};

/**
 * Strip some php output we aren't generating.
 */
DOMUtils.normalizePhpOutput = function(html) {
	return html
		// do not expect section editing for now
		.replace(/<span[^>]+class="mw-headline"[^>]*>(.*?)<\/span> *(<span class="mw-editsection"><span class="mw-editsection-bracket">\[<\/span>.*?<span class="mw-editsection-bracket">\]<\/span><\/span>)?/g, '$1')
		.replace(/<a[^>]+class="mw-headline-anchor"[^>]*>§<\/a>/g, '');
};

/**
 * @method
 *
 * Normalize the expected parser output by parsing it using a HTML5 parser and
 * re-serializing it to HTML. Ideally, the parser would normalize inter-tag
 * whitespace for us. For now, we fake that by simply stripping all newlines.
 *
 * @param {string} source
 * @return {string}
 */
DOMUtils.normalizeHTML = function(source) {
	try {
		var body = this.normalizeIEW(this.parseHTML(source).body);
		var html = this.serializeChildren(body)
			// a few things we ignore for now..
			//  .replace(/\/wiki\/Main_Page/g, 'Main Page')
			// do not expect a toc for now
			.replace(/<div[^>]+?id="toc"[^>]*>\s*<div id="toctitle">[\s\S]+?<\/div>[\s\S]+?<\/div>\s*/g, '');
		return this.normalizePhpOutput(html)
			// remove empty span tags
			.replace(/(\s)<span>\s*<\/span>\s*/g, '$1')
			.replace(/<span>\s*<\/span>/g, '')
			// general class and titles, typically on links
			.replace(/ (class|rel|about|typeof)="[^"]*"/g, '')
			// strip red link markup, we do not check if a page exists yet
			.replace(/\/index.php\?title=([^']+?)&amp;action=edit&amp;redlink=1/g, '/wiki/$1')
			// strip red link title info
			.replace(/ \((?:page does not exist|encara no existeix|bet ele jaratılmag'an|lonkásá  ezalí tɛ̂)\)/g, '')
			// the expected html has some extra space in tags, strip it
			.replace(/<a +href/g, '<a href')
			.replace(/href="\/wiki\//g, 'href="')
			.replace(/" +>/g, '">')
			// parsoid always add a page name to lonely fragments
			.replace(/href="#/g, 'href="Main Page#')
			// replace unnecessary URL escaping
			.replace(/ href="[^"]*"/g, Util.decodeURI)
			// strip empty spans
			.replace(/(\s)<span>\s*<\/span>\s*/g, '$1')
			.replace(/<span>\s*<\/span>/g, '');
	} catch (e) {
		console.log("normalizeHTML failed on" +
			source + " with the following error: " + e);
		console.trace();
		return source;
	}
};

/**
 * @method
 *
 * Specialized normalization of the wiki parser output, mostly to ignore a few
 * known-ok differences.  If parsoidOnly is true-ish, then we allow more
 * markup through (like property and typeof attributes), for better
 * checking of parsoid-only test cases.
 *
 * @param {String} out
 * @param {Boolean} [parsoidOnly=false]
 * @return {String}
 */
DOMUtils.normalizeOut = function(out, parsoidOnly) {
	if (typeof (out) === 'string') {
		out = this.parseHTML(out).body;
	}
	var stripTypeof = parsoidOnly ?
		/(?:^|mw:DisplaySpace\s+)mw:Placeholder$/ :
		/^mw:(?:(?:DisplaySpace\s+mw:)?Placeholder|Nowiki|Transclusion|Entity)$/;
	out = this.serializeChildren(this.normalizeIEW(out, stripTypeof, parsoidOnly));
	// NOTE that we use a slightly restricted regexp for "attribute"
	//  which works for the output of DOM serialization.  For example,
	//  we know that attribute values will be surrounded with double quotes,
	//  not unquoted or quoted with single quotes.  The serialization
	//  algorithm is given by:
	//  http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#serializing-html-fragments
	if (!/[^<]*(<\w+(\s+[^\0-\cZ\s"'>\/=]+(="[^"]*")?)*\/?>[^<]*)*/.test(out)) {
		throw new Error("normalizeOut input is not in standard serialized form");
	}
	if (parsoidOnly) {
		// strip <nowiki /> mw:Placeholders because we frequently test WTS
		// <nowiki> insertion by providing an html/parsoid section with the
		// <meta> tags stripped out, allowing the html2wt test to verify that
		// the <nowiki> is correctly added during WTS, while still allowing
		// the html2html and wt2html versions of the test to pass as a
		// sanity check.  If <meta>s were not stripped, these tests would all
		// have to be modified and split up.  Not worth it at this time.
		// (see commit 689b22431ad690302420d049b10e689de6b7d426)
		out = out.
			replace(/<meta typeof="mw:Placeholder" [^/]*nowiki\s*\/\s*>[^/]*\/>/g, '');

		// unnecessary attributes, we don't need to check these
		// style is in there because we should only check classes.
		out = out.replace(/ (data-parsoid|prefix|about|rev|datatype|inlist|vocab|content|style)="[^\"]*"/g, '');
		// single-quoted variant
		out = out.replace(/ (data-parsoid|prefix|about|rev|datatype|inlist|vocab|content|style)='[^\']*'/g, '');
		// strip leading ./ from href -- eventually we will remove this unless
		// the href contains a colon (since that could be parsed as protocol)
		out = out.replace(/(href=")(?:\.\/)/g, '$1');
		return out;
	}
	// strip meta/link elements
	out = out.
		replace(/<\/?(?:meta|link)(?: [^\0-\cZ\s"'>\/=]+(?:=(?:"[^"]*"|'[^']*'))?)*\/?>/g, '');
	// Ignore troublesome attributes.
	// Strip JSON attributes like data-mw and data-parsoid early so that
	// comment stripping in normalizeNewlines does not match unbalanced
	// comments in wikitext source.
	out = out.replace(/ (data-mw|data-parsoid|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content|class)="[^\"]*"/g, '');
	// single-quoted variant
	out = out.replace(/ (data-mw|data-parsoid|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content|class)='[^\']*'/g, '');
	// strip typeof last
	out = out.replace(/ typeof="[^\"]*"/g, '');

	return out.
		// replace mwt ids
		replace(/ id="mw((t\d+)|([\w-]{2,}))"/g, '').
		replace(/<span[^>]+about="[^"]*"[^>]*>/g, '').
		replace(/(\s)<span>\s*<\/span>\s*/g, '$1').
		replace(/<span>\s*<\/span>/g, '').
		replace(/(href=")(?:\.?\.\/)+/g, '$1').
		// replace unnecessary URL escaping
		replace(/ href="[^"]*"/g, Util.decodeURI).
		// strip thumbnail size prefixes
		replace(/(src="[^"]*?)\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^\/]+)\/[0-9]+px-[^"\/]+(?=")/g, '$1$2');
};

/**
 * @method
 *
 * Parse HTML, return the tree.
 *
 * @param {String} html
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
 * Merge a text node with text node siblings
 *
 * @param {Node} node
 */
DOMUtils.mergeSiblingTextNodes = function(node) {
	var otherNode = node.previousSibling;
	while (otherNode && this.isText(otherNode)) {
		node.nodeValue = otherNode.nodeValue + node.nodeValue;
		node.parentNode.removeChild(otherNode);
		otherNode = node.previousSibling;
	}

	otherNode = node.nextSibling;
	while (otherNode && this.isText(otherNode)) {
		node.nodeValue = node.nodeValue + otherNode.nodeValue;
		node.parentNode.removeChild(otherNode);
		otherNode = node.nextSibling;
	}
};

/**
 * @method
 *
 * Little helper function for encoding XML entities
 *
 * @param {string} string
 * @return {string}
 */
DOMUtils.encodeXml = function(string) {
	return entities.encodeXML(string);
};

var WikitextSerializer;
var SelectiveSerializer;
/**
 * @method
 *
 * The main serializer handler.
 *
 * @param {Object} env The environment.
 * @param {Node} body The document body to serialize.
 * @param {Boolean} useSelser Use the selective serializer, or not.
 * @param {Function} cb Optional callback.
 */
DOMUtils.serializeDOM = function(env, body, useSelser, cb) {
	// Circular refs
	if (!WikitextSerializer) {
		WikitextSerializer = require('./mediawiki.WikitextSerializer.js')
			.WikitextSerializer;
		SelectiveSerializer = require('./mediawiki.SelectiveSerializer.js')
			.SelectiveSerializer;
	}

	console.assert(DU.isBody(body), 'Expected a body node.');

	var hasOldId = (env.page.id && env.page.id !== '0');
	var needsWt = useSelser && hasOldId && (env.page.src === null);
	var needsOldDOM = useSelser && !(env.page.dom || env.page.domdiff);
	var useCache = env.conf.parsoid.parsoidCacheURI && hasOldId;

	var steps = [];
	if (needsWt) {
		steps.push(function() {
			var target = env.resolveTitle(env.normalizeTitle(env.page.name), '');
			return TemplateRequest.setPageSrcInfo(
				env, target, env.page.id
			).catch(function(err) {
				env.log('error', 'Error while fetching page source.');
			});
		});
	}
	if (needsOldDOM) {
		if (useCache) {
			steps.push(function() {
				return ParsoidCacheRequest.promise(
					env, env.page.name, env.page.id, { evenIfNotCached: true }
				).then(function(html) {
					env.page.dom = DU.parseHTML(html).body;
				}, function(err) {
					env.log('error', 'Error while fetching original DOM.');
				});
			});
		} else {
			steps.push(function() {
				if (env.page.src === null) {
					// The src fetch failed or we never had an oldid.
					// We'll just fallback to non-selser.
					return;
				}
				return env.pipelineFactory.parse(
					env, env.page.src
				).then(function(doc) {
					env.page.dom = DU.parseHTML(DU.serializeNode(doc).str).body;
				}, function(err) {
					env.log('error', 'Error while parsing original DOM.');
				});
			});
		}
	}

	// If we can, perform these steps in parallel (w/ map).
	var p;
	if (!useSelser) {
		p = Promise.resolve();
	} else if (useCache) {
		p = Promise.map(steps, function(func) { return func(); });
	} else {
		p = Promise.reduce(steps, function(prev, func) {
			return func();
		}, null);
	}

	return p.then(function() {
		var Serializer = useSelser ? SelectiveSerializer : WikitextSerializer;
		var serializer = new Serializer({ env: env });
		return serializer.serializeDOMSync(body);
	}).nodify(cb);
};

// Pull the data-parsoid script element out of the doc before serializing.
DOMUtils.extractDpAndSerialize = function(doc, options) {
	var dpScriptElt = doc.getElementById('mw-data-parsoid');
	dpScriptElt.parentNode.removeChild(dpScriptElt);
	var out = DU.serializeNode(options.bodyOnly ? doc.body : doc, {
		captureOffsets: true,
		innerXML: options.innerXML,
	});
	out.dp = JSON.parse(dpScriptElt.text);
	out.type = dpScriptElt.getAttribute('type');
	// Add the wt offsets.
	Object.keys(out.offsets).forEach(function(key) {
		var dp = out.dp.ids[key];
		console.assert(dp);
		if (Util.isValidDSR(dp.dsr)) {
			out.offsets[key].wt = dp.dsr.slice(0, 2);
		}
	});
	out.dp.sectionOffsets = out.offsets;
	return out;
};

if (typeof module === "object") {
	module.exports.DOMUtils = DOMUtils;
}
