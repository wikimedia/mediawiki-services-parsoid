"use strict";

/**
 * General DOM utilities.
 */

require('./core-upgrade.js');
var domino = require( './domino' ),
	entities = require( 'entities' ),
	Util = require('./mediawiki.Util.js').Util,
	JSUtils = require('./jsutils').JSUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	pd = require('./mediawiki.parser.defines.js'),
	XMLSerializer = require('./XMLSerializer');

// define some constructor shortcuts
var KV = pd.KV;

/**
 * @class
 * @singleton
 * General DOM utilities
 */
var DOMUtils = {

	/**
	 * Check whether this is a DOM element node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isElt: function(node) {
		return node.nodeType === node.ELEMENT_NODE;
	},

	/**
	 * Check whether this is a DOM text node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isText: function(node) {
		return node.nodeType === node.TEXT_NODE;
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
		return node && Consts.HTML.FormattingTags.has( node.nodeName );
	},

	isQuoteElt: function(node) {
		return node && Consts.WTQuoteTags.has( node.nodeName );
	},

	/**
	 * Attribute equality test
	 * @param {Node} nodeA
	 * @param {Node} nodeB
	 * @param {ignoreableAttribs} Set of attributes that should be ignored
	 * @param {specializedAttribHandlers} Map of attributes with specialized equals handlers
	 */
	attribsEquals: function(nodeA, nodeB, ignoreableAttribs, specializedAttribHandlers) {
		if (!ignoreableAttribs) {
			ignoreableAttribs = new Set();
		}

		function arrayToHash(attrs) {
			var h = {}, count = 0;
			for (var i = 0, n = attrs.length; i < n; i++) {
				var a = attrs.item(i);
				if (!ignoreableAttribs.has(a.name)) {
					count++;
					h[a.name] = a.value;
				}
			}

			return { h: h, count: count };
		}

		var xA = arrayToHash(nodeA.attributes),
			xB = arrayToHash(nodeB.attributes);

		if (xA.count !== xB.count) {
			return false;
		}

		var hA = xA.h, keysA = Object.keys(hA).sort(),
			hB = xB.h, keysB = Object.keys(hB).sort();

		if (!specializedAttribHandlers) {
			specializedAttribHandlers = new Map();
		}

		for (var i = 0; i < xA.count; i++) {
			var k = keysA[i];
			if (k !== keysB[i]) {
				return false;
			}

			if (hA[k] !== hB[k]) {
				// Use a specialized compare function, if provided
				var attribEquals = specializedAttribHandlers.get(k);
				if (attribEquals) {
					if (!hA[k] || !hB[k] || !attribEquals(JSON.parse(hA[k]), JSON.parse(hB[k]))) {
						return false;
					}
				} else {
					return false;
				}
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
		function notType (t) {
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

	/**
	 * Decode a JSON object into the data member of DOM nodes
	 *
	 * @param {Node} node
	 * @param {string} name We'll use the data-[name] attribute of the passed-in node as the new value.
	 * @param {Mixed} defaultVal What to use if there is no JSON attribute by that name.
	 */
	loadDataAttrib: function(node, name, defaultVal) {
		if ( !this.isElt(node) ) {
			return;
		}
		var data = this.getNodeData( node );
		if ( data[name] === undefined ) {
			data[name] = this.getJSONAttribute(node, 'data-' + name, defaultVal);
		}
		return data[name];
	},

	/**
	 * Save all node.data.* structures to data attributes
	 */
	saveDataAttribs: function(node) {
		if ( !this.isElt(node) ) {
			return;
		}
		var data = this.getNodeData( node );
		for(var key in data) {
			if ( key.match( /^tmp_/ ) !== null ) {
				continue;
			}
			var val = data[key];
			if ( val && val.constructor === String ) {
				node.setAttribute('data-' + key, val);
			} else if (val instanceof Object) {
				this.setJSONAttribute(node, 'data-' + key, val);
			}
			// Else: throw error?
		}
	},

	/**
	 * Decode data-parsoid into node.data.parsoid
	 */
	loadDataParsoid: function ( node ) {
		var dp = this.loadDataAttrib( node, 'parsoid', {} );
		if ( this.isElt( node ) && !dp.tmp ) {
			dp.tmp = {};
		}
	},

	getDataParsoid: function ( node ) {
		var data = this.getNodeData( node );
		if ( !data.parsoid ) {
			this.loadDataParsoid( node );
		}
		return data.parsoid;
	},

	getDataMw: function ( node ) {
		var data = this.getNodeData( node );
		if ( !data.mw ) {
			this.loadDataAttrib( node, 'mw', {} );
		}
		return data.mw;
	},

	/**
	 * Set the data-parsoid attribute on a node.
	 *
	 * @param {Object} dpObj The new value for data-parsoid
	 * @returns {Node} `node`, with the attribute set on it
	 */
	setDataParsoid: function(node, dpObj) {
		return this.setJSONAttribute( node, "data-parsoid", dpObj );
	},

	getNodeData: function ( node ) {
		if ( !node.dataobject ) {
			node.dataobject = {};
		}
		return node.dataobject;
	},

	setNodeData: function ( node, data ) {
		node.dataobject = data;
	},

	/**
	 * Get an object from a JSON-encoded XML attribute on a node.
	 *
	 * @param {string} name Name of the attribute
	 * @param {Mixed} defaultVal What should be returned if we fail to find a valid JSON structure
	 */
	getJSONAttribute: function(node, name, defaultVal) {
		if ( !this.isElt(node) ) {
			return defaultVal !== undefined ? defaultVal : {};
		}

		var attVal = node.getAttribute(name);
		if (!attVal) {
			return defaultVal !== undefined ? defaultVal : {};
		}
		try {
			return JSON.parse(attVal);
		} catch(e) {
			console.warn('ERROR: Could not decode attribute-val ' + attVal +
					' for ' + name + ' on node ' + node.outerHTML);
			return defaultVal !== undefined ? defaultVal : {};
		}
	},

	/**
	 * Set an attribute on a node to a JSON-encoded object.
	 *
	 * @param {Node} n
	 * @param {string} name Name of the attribute
	 * @param {Object} obj
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
	 * @returns {Object}
	 *   @returns {Mixed} return.value
	 *   @returns {boolean} return.modified If the value of the attribute changed since we parsed the wikitext
	 *   @returns {boolean} return.fromsrc Whether we got the value from source-based roundtripping
	 */
	getAttributeShadowInfo: function ( node, name ) {
		var curVal = node.getAttribute(name),
			dp = this.getDataParsoid( node );

		// Not the case, continue regular round-trip information.
		if ( dp.a === undefined ) {
			return {
				value: curVal,
				// Mark as modified if a new element
				modified: this.isNewElt(node),
				fromsrc: false
			};
		} else if ( dp.a[name] !== curVal ) {
			//console.log(name, node.getAttribute(name), node.attributes.name.value);
			//console.log(
			//		node.outerHTML, name, JSON.stringify([curVal, dp.a[name]]));
			return {
				value: curVal,
				modified: true,
				fromsrc: false
			};
		} else if ( dp.sa === undefined ) {
			return {
				value: curVal,
				modified: false,
				fromsrc: false
			};
		} else {
			return {
				value: dp.sa[name],
				modified: false,
				fromsrc: true
			};
		}
	},

	/**
	 * Get the attributes on a node in an array of KV objects.
	 *
	 * @returns {KV[]}
	 */
	getAttributeKVArray: function(node) {
		var attribs = node.attributes,
			kvs = [];
		for(var i = 0, l = attribs.length; i < l; i++) {
			var attrib = attribs.item(i);
			kvs.push(new KV(attrib.name, attrib.value));
		}
		return kvs;
	},

	/**
	 * Build path from a node to its passed-in ancestor.
	 * Doesn't include the ancestor in the returned path.
	 *
	 * @param {Node} ancestor Should be an ancestor of `node`
	 * @returns {Node[]}
	 */
	pathToAncestor: function (node, ancestor) {
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
	 * @returns {Node[]}
	 */
	pathToRoot: function(node) {
		return this.pathToAncestor(node, null);
	},

	/**
	 * Build path from a node to its passed-in sibling.
	 *
	 * @param {Node} sibling
	 * @param {boolean} left Whether to go backwards, i.e., use previousSibling instead of nextSibling.
	 * @returns {Node[]} Will not include the passed-in sibling.
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
	 * Check that a node `n1` is an ancestor of another node `n2` in
	 * the DOM.
	 *
	 * @param {Node} n1 The suspected ancestor
	 * @param {Node} n2 The suspected descendant
	 */
	isAncestorOf: function (n1, n2) {
		while (n2 && n2 !== n1) {
			n2 = n2.parentNode;
		}
		return n2 !== null;
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
		return this.hasNodeName(n, name) && n.getAttribute("typeof") === type;
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

	/**
	 * Check whether a meta's typeof indicates that it is a template expansion.
	 *
	 * @param {string} nType
	 */
	isTplMetaType: function(nType)  {
		return (/(?:^|\s)mw:Transclusion(\/[^\s]+)*(?=$|\s)/).test(nType);
	},

	/**
	 * Check whether a meta's typeof indicates that it signifies an
	 * expanded attribute.
	 *
	 * @param {string} nType
	 */
	isExpandedAttrsMetaType: function(nType) {
		return (/(?:^|\s)mw:ExpandedAttrs(\/[^\s]+)*(?=$|\s)/).test(nType);
	},

	/**
	 * Check whether a node is a meta tag that signifies a template expansion.
	 */
	isTplMarkerMeta: function(node)  {
		return (
			this.hasNodeName(node, "meta") &&
			this.isTplMetaType(node.getAttribute("typeof"))
		);
	},

	/**
	 * Check whether a node is a meta signifying the start of a template expansion.
	 */
	isTplStartMarkerMeta: function(node)  {
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
	isTplEndMarkerMeta: function(n)  {
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
	 *   @param {string/undefined} dp.stx
	 */
	hasLiteralHTMLMarker: function(dp) {
		return dp.stx === 'html';
	},

	isNewElt: function(n) {
		return n.getAttribute('data-parsoid') === null;
	},

	/**
	 * Run a node through #hasLiteralHTMLMarker
	 */
	isLiteralHTMLNode: function(node) {
		return (node &&
			this.isElt(node) &&
			this.hasLiteralHTMLMarker(this.getDataParsoid(node)));
	},

	/**
	 * Check whether a pre is caused by indentation in the original wikitext.
	 */
	isIndentPre: function(node) {
		return this.hasNodeName(node, "pre") && !this.isLiteralHTMLNode(node);
	},

	isFosterablePosition: function(n) {
		return n && Consts.HTML.FosterablePosition.has( n.parentNode.nodeName );
	},

	isList: function(n) {
		return n && Consts.HTML.ListTags.has( n.nodeName );
	},

	isListItem: function(n) {
		return n && Consts.HTML.ListItemTags.has( n.nodeName );
	},

	isListOrListItem: function(n) {
		return this.isList(n) || this.isListItem(n);
	},

	/**
	 * Get the first preceding sibling of 'node' that is an element,
	 * or return `null` if there is no such sibling element.
	 */
	getPrevElementSibling: function(node) {
		var sibling = node.previousSibling;
		while (sibling) {
			if (this.isElt(sibling)) {
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
			if (this.isElt(sibling)) {
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
			if (this.isElt(children[i])) {
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
			if (this.isElt(child) &&
					// Is a block-level node
					( this.isBlockNode(child) ||
					  // or has a block-level child or grandchild or..
					  this.hasBlockElementDescendant(child) ) )
			{
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
	 * @returns {number}
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
				numNLs = (textNode.nodeValue.match(/\n./g)||[]).length;
			} else {
				numNLs = (textNode.nodeValue.match(/\n/g)||[]).length;
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
	 * @param {MWParserEnvironment} env
	 * @param {Node} node
	 */
	isTplElementNode: function(env, node) {
		if (this.isElt(node)) {
			var about = node.getAttribute('about');
			return about && env.isParsoidObjectId(about);
		} else {
			return false;
		}
	},

	/**
	 * Check if 'node' emits wikitext that is sol-transparent in wikitext form.
	 * This is a test for wikitext that doesn't introduce line breaks.
	 *
	 * Comment, whitespace text nodes, category links, redirect links, and include
	 * directives currently satisfy this defintion.
	 *
	 * @param {Node} node
	 */
	emitsSolTransparentSingleLineWT: function(node) {
		if (node.nodeType === node.COMMENT_NODE) {
			return true;
		} else if (node.nodeType === node.TEXT_NODE) {
			return node.nodeValue.match(/^[ \t]*$/);
		} else if (node.nodeName === 'META') {
			return (/(^|\s)mw:Includes\//).test(node.getAttribute('typeof'));
		} else {
			return !this.isNewElt(node) && node.nodeName === 'LINK' &&
				/mw:PageProp\/(?:Category|redirect)/.test(node.getAttribute('rel'));
		}
	},

	/**
	 * Check if whitespace preceding this node would NOT trigger an indent-pre.
	 */
	precedingSpaceSuppressesIndentPre: function(node) {
		if (this.isText(node)) {
			return node.nodeValue.match(/^[ \t]*\n/);
		} else if (node.nodeName === 'BR') {
			return true;
		} else if (this.isFirstEncapsulationWrapperNode(node)) {
			// Dont try any harder than this
			return node.childNodes.length === 0 || node.innerHTML.match(/^\n/);
		} else if (this.isLiteralHTMLNode(node) || !Consts.HTMLTagsWithWTEquivalents.has(node.nodeName)) {
			return this.isBlockNode(node);
		} else {
			return Consts.LeadingWSAcceptingTags.has(node.nodeName);
		}
	},

	/**
	 * @param {Token[]} tokBuf This is where the tokens get stored.
	 */
	convertDOMtoTokens: function(tokBuf, node) {
		function domAttrsToTagAttrs(attrs) {
			var out = [], dp;
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

		switch(node.nodeType) {
			case node.ELEMENT_NODE:
				var nodeName = node.nodeName.toLowerCase(),
					children = node.childNodes,
					attrInfo = domAttrsToTagAttrs(node.attributes);

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
				console.warn( "Unhandled node type: " + node.outerHTML );
				break;
		}
		return tokBuf;
	},

	currentDiffMark: function(node, env) {
		if (!node || !this.isElt(node)) {
			return null;
		}
		var data = this.getNodeData( node );
		var dpd = data["parsoid-diff"];
		if ( !dpd ) {
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
	hasCurrentDiffMark: function(node, env) {
		return this.currentDiffMark(node, env) !== null;
	},

	onlySubtreeChanged: function(node, env) {
		var dmark = this.currentDiffMark(node, env);
		return dmark && dmark.diff.length === 1 && dmark.diff[0] === 'subtree-changed';
	},

	directChildrenChanged: function(node, env) {
		var dmark = this.currentDiffMark(node, env);
		return dmark && dmark.diff.indexOf('children-changed') !== -1;
	},

	hasInsertedOrModifiedDiffMark: function(node, env) {
		var diffMark = this.currentDiffMark(node, env);
		return diffMark &&
			(diffMark.diff.indexOf('modified') >= 0 ||
			 diffMark.diff.indexOf('inserted') >= 0);
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
				diff: [change]
			};
		}

		// Add serialization info to this node
		this.setJSONAttribute(node, 'data-parsoid-diff', dpd);
	},

	/**
	 * Is a node representing inter-element whitespace?
	 */
	isIEW: function (node) {
		// ws-only
		return this.isText(node) && node.nodeValue.match(/^\s*$/);
	},

	isContentNode: function(node) {
		return node.nodeType !== node.COMMENT_NODE &&
			!this.isIEW(node) &&
			!this.isMarkerMeta(node, "mw:DiffMarker");
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

	previousNonSepSibling: function (node) {
		var prev = node.previousSibling;
		while (prev && !this.isContentNode(prev)) {
			prev = prev.previousSibling;
		}
		return prev;
	},

	nextNonSepSibling: function (node) {
		var next = node.nextSibling;
		while (next && !this.isContentNode(next)) {
			next = next.nextSibling;
		}
		return next;
	},

	// Skip deleted-node markers
	nextNonDeletedSibling: function(node) {
		node = node.nextSibling;
		while (node && this.isMarkerMeta(node, "mw:DiffMarker")) {
			node = node.nextSibling;
		}
		return node;
	},

	// Skip deleted-node markers
	previousNonDeletedSibling: function(node) {
		node = node.previousSibling;
		while (node && this.isMarkerMeta(node, "mw:DiffMarker")) {
			node = node.previousSibling;
		}
		return node;
	},

	/**
	 * Are all children of this node text nodes?
	 */
	allChildrenAreText: function (node) {
		var child = node.firstChild;
		while (child) {
			if (!this.isMarkerMeta(child, "mw:DiffMarker") && !this.isText(child)) {
				return false;
			}
			child = child.nextSibling;
		}
		return true;
	},

	/**
	 * Does `node` contain nothing or just non-newline whitespace?
	 */
	nodeEssentiallyEmpty: function (node) {
		var childNodes = node.childNodes;
		if (0 === childNodes.length) {
			return true;
		} else if (childNodes.length > 1) {
			return false;
		} else {
			var child = childNodes[0];
			return (child.nodeName === "#text" &&
				/^[ \t]*$/.test(child.nodeValue));
		}
	},

	/**
	 * Make a span element to wrap some bare text.
	 *
	 * @param {TextNode} node
	 * @param {string} type The type for the wrapper span
	 * @returns {Element} The wrapper span
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
	 * @returns {Element} The new meta.
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
	mkTagTk: function (node) {
		var attribKVs = this.getAttributeKVArray(node);
		return new pd.TagTk(node.nodeName.toLowerCase(), attribKVs, this.getDataParsoid( node ));
	},

	/**
	 * Create a `EndTagTk` corresponding to a DOM node
	 */
	mkEndTagTk: function (node) {
		var attribKVs = this.getAttributeKVArray(node);
		return new pd.EndTagTk(node.nodeName.toLowerCase(), attribKVs, this.getDataParsoid( node ));
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
	createNodeWithAttributes: function ( document, type, attrs ) {
		var node = document.createElement( type );
		this.addAttributes(node, attrs);
		return node;
	},

	/**
	 * Return `true` iff the element has a `class` attribute containing
	 * `someClass` (among other space-separated classes).
	 * @param {Element} ele
	 * @param {string} someClass
	 */
	hasClass: function ( ele, someClass ) {
		if ( !ele || !this.isElt(ele) ) {
			return false;
		}

		var classes = ele.getAttribute( 'class' );

		return new RegExp( '(?:^|\\s)' + someClass + '(?=$|\\s)' ).test(classes);
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
			if (this.isElt(node)) {
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

		var n = from.firstChild,
			destDoc = to.ownerDocument;
		while (n) {
			to.insertBefore(importNode(destDoc, n), beforeNode);
			n = n.nextSibling;
		}
	},

	/**
	 * Is node the first wrapper element of encapsulated content?
	 */
	isFirstEncapsulationWrapperNode: function(node) {
		return this.isElt(node) && (/(?:^|\s)mw:(?:Transclusion(?=$|\s)|Param(?=$|\s)|Extension\/[^\s]+)/).test(node.getAttribute('typeof'));
	},

	/**
	 * Find the first wrapper element of encapsulated content.
	 */
	findFirstEncapsulationWrapperNode: function ( node ) {
		var about = node.getAttribute('about');
		if ( !about ) {
			return null;
		}

		while ( !this.isFirstEncapsulationWrapperNode( node ) ) {
			node = node.previousSibling;
			if ( !node || !this.isElt(node) ||
				node.getAttribute('about') !== about ) {
				return null;
			}
		}
		return node;
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
		if (!this.isElt(node)) {
			return false;
		}

		return this.findFirstEncapsulationWrapperNode( node ) !== null;
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
				this.isElt(node) && node.getAttribute('about') === about ||
				this.isFosterablePosition(node) && !this.isElt(node) && this.isIEW(node)
			))
		{
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
	 * ```
	 * {
	 *     transclusions: {
	 *         'key1': {
	 *				html: 'html1',
	 *				nodes: [<node1>, <node2>]
	 *			}
	 *     },
	 *     extensions: {
	 *         'key2': {
	 *				html: 'html2',
	 *				nodes: [<node1>, <node2>]
	 *			}
	 *     },
	 *     files: {
	 *         'key3': {
	 *				html: 'html3',
	 *				nodes: [<node1>, <node2>]
	 *			}
	 *     }
	 * }
	 * ```
	 */
	extractExpansions: function (doc) {
		var DU = this;

		var node = doc.body,
			expansion,
			expansions = {
				transclusions: {},
				extensions: {},
				files: {}
			};


		function doExtractExpansions (node) {
			var nodes, expAccum;

			while (node) {
				if (node.nodeType === node.ELEMENT_NODE) {
					var typeOf = node.getAttribute('typeof'),
						about = node.getAttribute('about');
					if ((/(?:^|\s)(?:mw:(?:Transclusion(?=$|\s)|Extension\/))/
								.test(typeOf) && about) ||
							/(?:^|\s)(?:mw:Image(?:(?=$|\s)|\/))/.test(typeOf))
					{
						var dp = DU.getDataParsoid( node );
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
						//console.log(key);

						if (key) {
							expAccum[key] = {
								nodes: nodes,
								html: nodes.map(function(node) {
									return node.outerHTML;
								}).join('')
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
	 * @param array List of DOM nodes to wrap, mix of node types
	 * @return array List of *element* nodes
	 */
	addSpanWrappers: function (nodes) {
		var textCommentAccum = [],
			out = [],
			doc = nodes[0] && nodes[0].ownerDocument;

		function wrapAccum () {
			// Wrap accumulated nodes in a span
			var span = doc.createElement('span'),
				parentNode = textCommentAccum[0].parentNode;
			parentNode.insertBefore(span, textCommentAccum[0]);
			textCommentAccum.forEach( function(n) {
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
			if (node.nodeType === node.TEXT_NODE ||
				node.nodeType === node.COMMENT_NODE) {
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
	 * Get tokens representing a DOM subtree in the token processing stages,
	 * mainly for transclusion and extension processing.
	 */
	getWrapperTokens: function ( nodes ) {
		var DU = this;
		function makeWrapperForNode ( node ) {
			var workNode;
			if (node.nodeType === node.ELEMENT_NODE && node.childNodes.length) {
				// Create a copy of the node without children
				// Do not use 'A' as a wrapper node because it could
				// end up getting nested inside another 'A' and the DOM
				// structure can change where the wrapper tokens are not
				// longer siblings.
				// Ex: "[http://foo.com Bad nesting [[Here]]].
				var wrapperName = (node.nodeName === 'A') ? 'SPAN' : node.nodeName;
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
			var res = [];
			// Now convert our node to tokens
			DU.convertDOMtoTokens(res, workNode);
			return res;
		}

		// XXX: not sure if we have to care about nested block-levels, as
		// those that would break up higher-level inline elements would have
		// broken things up already when building the DOM for the first time.
		//var hasBlockElement = false;
		//for (var i = 0; i < nodes.length; i++) {
		//	if (DU.hasBlockElementDescendant(nodes[i])) {
		//		hasBlockElement = true;
		//		break;
		//	}
		//}

		// First, get two tokens representing the start element
		var tokens = makeWrapperForNode ( nodes[0] );

		var needBlockWrapper = false;
		if (!DU.isBlockNode(nodes[0]) && !DU.isBlockNode(nodes.last())) {
			nodes.forEach(function(n) {
				if (!needBlockWrapper && DU.hasBlockElementDescendant(n)) {
					needBlockWrapper = true;
				}
			});
		}

		if (needBlockWrapper) {
			// Create a block-level wrapper to suppress paragraph
			// wrapping, as the fragment contains a block-level element
			// somewhere further down the tree.
			var blockPlaceholder = nodes[0].ownerDocument.createElement('hr');
			tokens = tokens.concat(makeWrapperForNode(blockPlaceholder));
		} else if (nodes.length > 1) {
			// If we have several siblings, also represent the last sibling.
			tokens = tokens.concat(makeWrapperForNode(nodes.last()));
		}

		// Remove the typeof attribute from the first token. It will be
		// replaced with mw:DOMFragment.
		tokens[0].removeAttribute('typeof');

		return tokens;
	},

	isDOMFragmentWrapper: function(node) {
		var DU = this;

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
	 * @param {Object} env
	 *    The active environment/context.
	 *
	 * @param {Object} token
	 *    The token that generated the DOM.
	 *
	 * @param {Object} expansion
	 *    expansion.html  -- HTML of the expansion
	 *    expansion.nodes -- outermost nodes of the HTML
	 *
	 * @param {Object} addAttrsCB
	 *    Callback that adds additional attributes to the generated tokens.
	 *
	 * @param {Object} opts
	 *    aboutId   : The about-id to set on the generated tokens.
	 *
	 *    noAboutId : If true, an about-id will not be added to the tokens
	 *                if an aboutId is not provided.
	 *                Ex: <figure>
	 *
	 *    tsr       : The TSR to set on the generated tokens. This TSR is
	 *                used to compute DSR on the placeholder tokens.
	 *                The computed DSR is transferred over to the unpacked DOM
	 *                if setDSR is true (see below).
	 *
	 *    setDSR    : When the DOM-fragment is unpacked, this option governs
	 *                whether the DSR from the placeholder node is transferred
	 *                over to the unpacked DOM or not.
	 *                Ex: Cite, reused transclusions
	 *
	 *    isForeignContent :
	 *                Does the DOM come from outside the main page? This governs
	 *                how the encapsulation ids are assigned to the unpacked DOM.
	 *                Ex: transclusions, extensions -- all siblings get the same
	 *                about id. This is not true for <figure> HTML.
	 *
	 */
	encapsulateExpansionHTML: function(env, token, expansion, opts) {
		opts = opts || {};

		// Get placeholder tokens to get our subdom through the token processing
		// stages. These will be finally unwrapped on the DOM.
		var toks = this.getWrapperTokens(expansion.nodes),
			firstWrapperToken = toks[0];

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
			var endTsr = [tokenTsr[1],tokenTsr[1]];
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
	 * @param {Object} env
	 *    The active environment/context.
	 *
	 * @param {Object} token
	 *    The token that generated the DOM.
	 *
	 * @param {Object} docOrHTML
	 *    The DOM (or HTML string) that the token expanded to.
	 *
	 * @param {Object} addAttrsCB
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
				html: nodes.map(function(n) { return n.outerHTML; }).join('')
			},
			opts
		);
	},

	/**
	 * Compute, when possible, the wikitext source for a node in
	 * an environment env. Returns null if the source cannot be
	 * extracted.
	 */
	getWTSource: function ( env, node ) {
		var data = this.getDataParsoid( node ),
		    dsr = (undefined !== data) ? data.dsr : null;
		return dsr ? env.page.src.substring(dsr[0], dsr[1]) : null;
	},

	deleteNode: function(node) {
		if ( node.parentNode ) {
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
	WT_tagsWithLimitedTSR: {
		"b" : true,
		"i" : true,
		"h1" : true,
		"h2" : true,
		"h3" : true,
		"h4" : true,
		"h5" : true,
		"ul" : true,
		"ol" : true,
		"dl" : true,
		"li" : true,
		"dt" : true,
		"dd" : true,
		"table" : true,
		"caption" : true,
		"tr" : true,
		"td" : true,
		"th" : true,
		"hr" : true, // void element
		"br" : true, // void element
		"pre" : true
	},

	tsrSpansTagDOM: function(n, parsoidData) {
		// - tags known to have tag-specific tsr
		// - html tags with 'stx' set
		// - span tags with 'mw:Nowiki' type
		var name = n.nodeName.toLowerCase();
		return !(
			this.WT_tagsWithLimitedTSR[name] ||
			this.hasLiteralHTMLMarker(parsoidData) ||
			this.isNodeOfType(n, 'span', 'mw:Nowiki')
		);
	},

	isComment: function( node ) {
		return this.hasNodeName( node, "#comment" );
	},

	// Applies a data-parsoid JSON structure to the document.
	// Removes the generated ids from each elements,
	// and adds back the data-parsoid attributes.
	applyDataParsoid: function ( document, dp ) {
		Object.keys( dp.ids ).forEach(function ( key ) {
			var el = document.getElementById( key );
			if ( el ) {
				this.setJSONAttribute( el, 'data-parsoid', dp.ids[key] );
				if ( /^mw[\w-]{2,}$/.test( key ) ) {
					el.removeAttribute( 'id' );
				}
			}
		}.bind( this ));
	},

	// Removes the data-parsoid attribute from a node,
	// and migrates the data to the document's JSON store.
	// Generates a unique id with the following format:
	//   mw<base64-encoded counter>
	// but attempts to keep user defined ids.
	storeDataParsoid: function ( node, dp ) {
		var uid = node.id;
		var document = node.ownerDocument;
		if ( !uid ) {
			do {
				document.data.parsoid.counter += 1;
				uid = "mw" + JSUtils.counterToBase64( document.data.parsoid.counter );
			} while ( document.getElementById( uid ) );
			node.setAttribute( "id", uid );
		}
		document.data.parsoid.ids[uid] = dp;
		delete node.data.parsoid;
	}

};

/**
 * Check if a node is a table element or nested in one
 */
DOMUtils.inTable = function(node) {
	while (node ) {
		if (Consts.HTML.TableTags.has(node.nodeName)) {
			return true;
		}
		node = node.parentNode;
	}
	return false;
};


var XMLSerializer = new XMLSerializer();

/**
 * @method serializeNode
 *
 * Serialize a HTML DOM3 document to XHTML
 * The output is identical to standard XHTML5 DOM serialization, as given by
 * http://dev.w3.org/html5/html-xhtml-author-guide/html-xhtml-authoring-guide.html
 * and
 * http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#serializing-html-fragments
 * except that we may quote attributes with single quotes, *only* where that would
 * result in more compact output than the standard double-quoted serialization.
 *
 * @param {Node} doc
 * @param {Object} options: flags smartQuote, innerHTML
 * @returns {string}
 */
DOMUtils.serializeNode = function (doc, options) {
	var html;
	if (!options) {
		options = {
			smartQuote: true,
			innerXML: false
		};
	}
	if (doc.nodeName==='#document') {
		html = XMLSerializer.serializeToString(doc.documentElement, options);
	} else {
		html = XMLSerializer.serializeToString(doc, options);
	}
	// ensure there's a doctype for documents
	if (!options.innerXML && (doc.nodeName === '#document' || /^html$/i.test(doc.nodeName))) {
		html = '<!DOCTYPE html>\n' + html;
	}

	return html;
};

/**
 * @method serializeChildren
 *
 * Serialize the children of a HTML DOM3 node to XHTML
 * The output is identical to standard XHTML5 DOM serialization, as given by
 * http://dev.w3.org/html5/html-xhtml-author-guide/html-xhtml-authoring-guide.html
 * and
 * http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#serializing-html-fragments
 * except that we may quote attributes with single quotes, *only* where that would
 * result in more compact output than the standard double-quoted serialization.
 *
 * @param {Node} node
 * @param {Object} options: flags smartQuote, innerHTML
 * @returns {string}
 */
DOMUtils.serializeChildren = function (node, options) {
	if (!options) {
		options = {
			smartQuote: true
		};
	}
	options.innerXML = true;
	return this.serializeNode(node, options);
};

/**
 * Normalize a bit of source by stripping out unnecessary newlines.
 * FIXME: Replace IEW newlines with spaces on the DOM!
 *
 * @method
 * @param {string} source
 * @returns {string}
 */
var normalizeNewlines = function ( source ) {
	return source
				// strip comments first
				.replace(/<!--(?:[^\-]|-(?!->))*-->/gm, '')

				// preserve a space for non-inter-tag-whitespace
				// non-tag content followed by non-tag content
				//.replace(/([^<> \s]|<\/span>|(?:^|>)[^<]*>)[\r\n\t ]+([^ \r\n<]|<span typeof="mw:)/gm, '$1 $2')

				// and eat all remaining newlines
				.replace(/[\r\n]/g, '');
};

/**
 * @method normalizeHTML
 *
 * Normalize the expected parser output by parsing it using a HTML5 parser and
 * re-serializing it to HTML. Ideally, the parser would normalize inter-tag
 * whitespace for us. For now, we fake that by simply stripping all newlines.
 *
 * @param source {string}
 * @return {string}
 */
DOMUtils.normalizeHTML = function ( source ) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	try {
		var doc = this.parseHTML( source );
		//console.log(source, normalizeNewlines(this.serializeChildren(doc.body)));
		return normalizeNewlines(this.serializeChildren(doc.body))
			// a few things we ignore for now..
			//.replace(/\/wiki\/Main_Page/g, 'Main Page')
			// do not expect a toc for now
			.replace(/<div[^>]+?id="toc"[^>]*><div id="toctitle">.+?<\/div>.+?<\/div>/mg, '')
			// do not expect section editing for now
			.replace(/<span[^>]+class="mw-headline"[^>]*>(.*?)<\/span> *(<span class="mw-editsection"><span class="mw-editsection-bracket">\[<\/span>.*?<span class="mw-editsection-bracket">\]<\/span><\/span>)?/g, '$1')
			// remove empty span tags
			.replace(/<span><\/span>/g, '')
			// general class and titles, typically on links
			.replace(/ (title|class|rel|about|typeof)="[^"]*"/g, '')
			// strip red link markup, we do not check if a page exists yet
			.replace(/\/index.php\?title=([^']+?)&amp;action=edit&amp;redlink=1/g, '/wiki/$1')
			// the expected html has some extra space in tags, strip it
			.replace(/<a +href/g, '<a href')
			.replace(/href="\/wiki\//g, 'href="')
			.replace(/" +>/g, '">')
			// parsoid always add a page name to lonely fragments
			.replace(/href="#/g, 'href="Main Page#')
			// replace unnecessary URL escaping
			.replace(/ href="[^"]*"/g, Util.decodeURI)
			// strip empty spans
			.replace(/<span><\/span>/g, '')
			.replace(/(<(table|tbody|tr|th|td|\/th|\/td)[^<>]*>)\s+/g, '$1');
	} catch(e) {
		console.log("normalizeHTML failed on" +
		            source + " with the following error: " + e);
		console.trace();
		return source;
	}
};

/**
 * @method normalizeOut
 *
 * Specialized normalization of the wiki parser output, mostly to ignore a few
 * known-ok differences.  If parsoidOnly is true-ish, then we allow more
 * markup through (like property and typeof attributes), for better
 * checking of parsoid-only test cases.
 *
 * @param {string} out
 * @param {bool} parsoidOnly
 * @returns {string}
 */
DOMUtils.normalizeOut = function ( out, parsoidOnly ) {
	var last;
	// TODO: Do not strip newlines in pre and nowiki blocks!
	// NOTE that we use a slightly restricted regexp for "attribute"
	//  which works for the output of DOM serialization.  For example,
	//  we know that attribute values will be surrounded with double quotes,
	//  not unquoted or quoted with single quotes.  The serialization
	//  algorithm is given by:
	//  http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#serializing-html-fragments
	if (!/[^<]*(<\w+(\s+[^\0-\cZ\s"'>\/=]+(="[^"]*")?)*\/?>[^<]*)*/.test(out)) {
		throw new Error("normalizeOut input is not in standard serialized form");
	}
	if ( !parsoidOnly ) {
		// Strip comment-and-ws-only lines that PHP parser strips out
		out = out.replace(/\n[ \t]*<!--([^-]|-(?!->))*-->([ \t]|<!--([^-]|-(?!->))*-->)*\n/g, '\n');
		// Ignore troublesome attributes.
		// Strip JSON attributes like data-mw and data-parsoid early so that
		// comment stripping in normalizeNewlines does not match unbalanced
		// comments in wikitext source.
		out = out.replace(/ (data-mw|data-parsoid|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content|title|class)="[^\"]*"/g, '');
		// single-quoted variant
		out = out.replace(/ (data-mw|data-parsoid|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content|title|class)='[^\']*'/g, '');
		out = normalizeNewlines( out );
		// remove possibly nested <span typeof="....">....</span>
		while ( last !== out ) {
			last = out;
			out = out.replace(/<span(?:[^>]*) typeof="mw:(?:Placeholder|Nowiki|Transclusion|Entity)"(?: [^\0-\cZ\s\"\'>\/=]+(?:="[^"]*")?)*>((?:[^<]+|(?!<\/span).)*)<\/span>/g, '$1');
		}
		// strip typeof last
		out = out.replace(/ typeof="[^\"]*"/g, '');
	} else {
		// unnecessary attributes, we don't need to check these
		// style is in there because we should only check classes.
		out = out.replace(/ (data-parsoid|prefix|about|rev|datatype|inlist|vocab|content|style)="[^\"]*"/g, '');
		// single-quoted variant
		out = out.replace(/ (data-parsoid|prefix|about|rev|datatype|inlist|vocab|content|style)='[^\']*'/g, '');
		out = normalizeNewlines( out ).
			// remove <span typeof="mw:Placeholder">....</span>
			replace(/<span(?: [^>]+)* typeof="mw:Placeholder"(?: [^\0-\cZ\s\"\'>\/=]+(?:="[^"]*")?)*>((?:[^<]+|(?!<\/span).)*)<\/span>/g, '$1').
			replace(/<\/?(?:meta|link)(?: [^\0-\cZ\s"'>\/=]+(?:="[^"]*")?)*\/?>/g, '');
	}
	return out.
		// replace mwt ids
		replace(/ id="mwt\d+"/, '').
		//.replace(/<!--.*?-->\n?/gm, '')
		replace(/<span[^>]+about="[^"]*"[^>]*>/g, '').
		replace(/<span><\/span>/g, '').
		replace(/(href=")(?:\.?\.\/)+/g, '$1').
		// replace unnecessary URL escaping
		replace(/ href="[^"]*"/g, Util.decodeURI).
		// strip thumbnail size prefixes
		replace(/(src="[^"]*?)\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^\/]+)\/[0-9]+px-[^"\/]+(?=")/g, '$1$2').
		replace(/(<(table|tbody|tr|th|td|\/th|\/td)[^<>]*>)\s+/g, '$1');
};



/**
 * @method formatHTML
 *
 * Insert newlines before some block-level start tags.
 *
 * @param {string} source
 * @returns {string}
 */
DOMUtils.formatHTML = function ( source ) {
	return source.replace(
		/(?!^)<((div|dd|dt|li|p|table|tr|td|tbody|dl|ol|ul|h1|h2|h3|h4|h5|h6)[^>]*)>/g, '\n<$1>');
};

/**
 * @method parseHTML
 *
 * Parse HTML, return the tree.
 *
 * @param {string} html
 * @returns {Node}
 */
DOMUtils.parseHTML = function ( html ) {
	if(! html.match(/^<(?:!doctype|html|body)/i)) {
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
 * @param {object} Node
 */
DOMUtils.mergeSiblingTextNodes = function( node ) {
	var otherNode = node.previousSibling;
	while (otherNode && otherNode.nodeType === node.TEXT_NODE) {
		node.nodeValue = otherNode.nodeValue + node.nodeValue;
		node.parentNode.removeChild(otherNode);
		otherNode = node.previousSibling;
	}

	otherNode = node.nextSibling;
	while (otherNode && otherNode.nodeType === node.TEXT_NODE) {
		node.nodeValue = node.nodeValue + otherNode.nodeValue;
		node.parentNode.removeChild(otherNode);
		otherNode = node.nextSibling;
	}
};




/**
 * @method encodeXml
 *
 * Little helper function for encoding XML entities
 *
 * @param {string} string
 * @returns {string}
 */
DOMUtils.encodeXml = function ( string ) {
	return entities.encodeXML(string);
};

if (typeof module === "object") {
	module.exports.DOMUtils = DOMUtils;
}
