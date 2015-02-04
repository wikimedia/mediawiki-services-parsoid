"use strict";

/**
 * General DOM utilities.
 */

require('./core-upgrade.js');
var domino = require( 'domino' ),
	entities = require( 'entities' ),
	Util = require('./mediawiki.Util.js').Util,
	JSUtils = require('./jsutils').JSUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	pd = require('./mediawiki.parser.defines.js'),
	XMLSerializer = require('./XMLSerializer');

// define some constructor shortcuts
var KV = pd.KV;

var isElt = function(node) {
	return node.nodeType === 1;
};

/**
 * @class
 * @singleton
 * General DOM utilities
 */
var DU, DOMUtils;
DOMUtils = DU = {

	/**
	 * Check whether this is a DOM element node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isElt: isElt,

	/**
	 * Check whether this is a DOM text node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isText: function(node) {
		return node.nodeType === 3;
	},

	/**
	 * Check whether this is a DOM comment node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isComment: function( node ) {
		return node.nodeType === 8;
	},

	debugOut: function(node) {
		return JSON.stringify(node.outerHTML || node.nodeValue || '').substr(0,40);
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

	isZeroWidthWikitextElt: function(node) {
		return Consts.ZeroWidthWikitextTags.has(node.nodeName) &&
			!this.isLiteralHTMLNode(node);
	},

	/**
	 * Is 'node' a block node that is also visible in wikitext?
	 * An example of an invisible block node is a <p>-tag that
	 * Parsoid generated, or a <ul>, <ol> tag.
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

	// Direct manipulation of the nodes for load and store.

	loadDataAttrib: function(node, name, defaultVal) {
		if ( !isElt(node) ) {
			return;
		}
		var data = this.getNodeData( node );
		if ( data[name] === undefined ) {
			data[name] = this.getJSONAttribute(node, 'data-' + name, defaultVal);
		}
		return data[name];
	},

	saveDataAttribs: function(node) {
		if ( !isElt(node) ) {
			return;
		}
		var data = this.getNodeData( node );
		for (var key in data) {
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

	// Load and stores the data as JSON attributes on the nodes.
	// These should only used when transferring between pipelines
	// ie. when the serialized nodes will lose their .dataobject's

	loadDataAttribs: function(node) {
		if ( !isElt(node) ) {
			return;
		}
		[ "Parsoid", "Mw" ].forEach(function(attr) {
			DU["loadData" + attr](node);
			node.removeAttribute( "data-" + attr );
		});
	},

	loadDataParsoid: function( node ) {
		var dp = this.loadDataAttrib( node, 'parsoid', {} );
		if ( isElt( node ) && !dp.tmp ) {
			dp.tmp = {};
		}
	},

	loadDataMw: function( node ) {
		var mw = this.loadDataAttrib( node, 'mw', {} );
	},

	storeDataParsoid: function(node, dpObj) {
		return this.setJSONAttribute( node, "data-parsoid", dpObj );
	},

	storeDataMw: function(node, dmObj) {
		return this.setJSONAttribute( node, "data-mw", dmObj );
	},

	// The following getters and setters load from the .dataobject store,
	// with the intention of eventually moving them off the nodes themselves.

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
			this.loadDataMw( node );
		}
		return data.mw;
	},

	setDataParsoid: function(node, dpObj) {
		var data = this.getNodeData( node );
		data.parsoid = dpObj;
		return data.parsoid;
	},

	setDataMw: function(node, dmObj) {
		var data = this.getNodeData( node );
		data.mw = dmObj;
		return data.mw;
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
		if ( !isElt(node) ) {
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
		} else if ( dp.sa === undefined || dp.sa[name] === undefined ) {
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
	 * Check that a node 'n1' is an ancestor of another node 'n2' in
	 * the DOM. Returns true if n1 === n2.
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
	TPL_META_TYPE_REGEXP: /(?:^|\s)(mw:(?:Transclusion|Param)(\/[^\s]+)?)(?=$|\s)/,

	/**
	 * Check whether a meta's typeof indicates that it is a template expansion.
	 *
	 * @param {string} nType
	 */
	isTplMetaType: function(nType)  {
		return this.TPL_META_TYPE_REGEXP.test(nType);
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
		if (!this.isElt(node)) {
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
			isElt(node) &&
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

	isGeneratedFigure: function(n) {
		return this.isElt(n) && (/(^|\s)mw:Image(\s|$|\/)/).test(n.getAttribute("typeof"));
	},

	/**
	 * Get the first preceding sibling of 'node' that is an element,
	 * or return `null` if there is no such sibling element.
	 */
	getPrevElementSibling: function(node) {
		var sibling = node.previousSibling;
		while (sibling) {
			if (isElt(sibling)) {
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
			if (isElt(sibling)) {
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
			if (isElt(children[i])) {
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
			if (isElt(child) &&
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
	isTplOrExtToplevelNode: function(node) {
		if (this.isElt(node)) {
			var about = node.getAttribute('about');
			// SSS FIXME: Verify that our DOM spec clarifies this
			// expectation on about-ids and that our clients respect this.
			return about && Util.isParsoidObjectId(about);
		} else {
			return false;
		}
	},

	traverseTplOrExtNodes: function (cb, node, env, options, atTopLevel, tplInfo) {
		// Don't bother with sub-pipelines
		if (!atTopLevel || !node) {
			return;
		}

		var c = node.firstChild;
		while (c) {
			var next = c.nextSibling;

			if (DU.isElt(c)) {
				// Identify template/extension content (not interested in "mw:Param" nodes).
				// We are interested in the very first node.
				if (this.isTplOrExtToplevelNode(c) &&
					/(^|\s)mw:(Extension|Transclusion)/.test(c.getAttribute("typeof")))
				{
					// We know that tplInfo will be null here since we don't
					// mark up nested transclusions.
					var about = c.getAttribute('about');
					tplInfo = {
						first: c,
						last: DU.getAboutSiblings(c, about).last(),
						// Set next to change the next node to be traversed
						next: null,
						// Set done to stop traversing
						done: false
					};
				}

				// Process subtree first
				this.traverseTplOrExtNodes(cb, c, env, options, atTopLevel, tplInfo);

				if (tplInfo) {
					cb(c, tplInfo, options);

					// Clear tpl info
					if (c === tplInfo.last || tplInfo.done) {
						tplInfo = null;
					}
				}
			}

			if (tplInfo && tplInfo.next) {
				c = tplInfo.next;
			} else {
				c = next;
			}
		}
	},

	isSolTransparentLink: function( node ) {
		return DU.isElt(node) && node.nodeName === 'LINK' &&
			/mw:PageProp\/(?:Category|redirect)/.test(node.getAttribute('rel'));
	},

	/**
	 * Check if 'node' emits wikitext that is sol-transparent in wikitext form.
	 * This is a test for wikitext that doesn't introduce line breaks.
	 *
	 * Comment, whitespace text nodes, category links, redirect links, and include
	 * directives currently satisfy this definition.
	 *
	 * @param {Node} node
	 */
	emitsSolTransparentSingleLineWT: function(node, wt2htmlMode) {
		if (this.isComment(node)) {
			return true;
		} else if (this.isText(node)) {
			return node.nodeValue.match(/^[ \t]*$/);
		} else if (node.nodeName === 'META') {
			return (/(^|\s)mw:Includes\//).test(node.getAttribute('typeof'));
		} else {
			return (wt2htmlMode || !this.isNewElt(node)) && DU.isSolTransparentLink(node);
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
		if (!node || !isElt(node)) {
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

		// Clear out the loaded value
		this.getNodeData(node)["parsoid-diff"] = undefined;

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

	isDocumentFragment: function( node ) {
		return node && node.nodeType === 11;
	},

	isContentNode: function(node) {
		return !this.isComment(node) &&
			!this.isIEW(node) &&
			!this.isMarkerMeta(node, "mw:DiffMarker");
	},

	/**
	 * Is node a mw:DiffMarker node that represents a deleted block node?
	 * This annotation is added by the DOMDiff pass
	 */
	isDeletedBlockNode: function(node) {
		return node && this.isElt(node) &&
			this.isMarkerMeta(node, "mw:DiffMarker") &&
			node.getAttribute("data-is-block");
	},

	/**
	 * In wikitext, did origNode occur next to a block node which has been deleted?
	 * While looking for next, we look past DOM nodes that are transparent in rendering.
	 * Ex: meta tags, category links, whitespace (this is between block nodes), comments.
	 */
	nextToDeletedBlockNodeInWT: function(origNode, before) {
		if (!origNode || origNode.nodeName === 'BODY') {
			return false;
		}

		while (true) {
			// Find the nearest node that shows up in HTML (ignore nodes that show up
			// in wikitext but don't affect sol-state or HTML rendering -- note that
			// whitespace is being ignored, but that whitespace occurs between block nodes).
			var node = origNode;
			do {
				node = before ? node.previousSibling : node.nextSibling;
			} while (node && this.emitsSolTransparentSingleLineWT(node));

			if (node) {
				return this.isDeletedBlockNode(node);
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

	numNonDeletedChildNodes: function(node) {
		var n = 0, child = node.firstChild;
		while (child) {
			if (!this.isMarkerMeta(child, "mw:DiffMarker")) {
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
		while (child && this.isMarkerMeta(child, "mw:DiffMarker")) {
			child = child.nextSibling;
		}
		return child;
	},

	/**
	 * Get the last mw:DiffMarker child of node
	 */
	lastNonDeletedChildNode: function(node) {
		var child = node.lastChild;
		while (child && this.isMarkerMeta(child, "mw:DiffMarker")) {
			child = child.previousSibling;
		}
		return child;
	},

	/**
	 * Get the next non mw:DiffMarker sibling
	 */
	nextNonDeletedSibling: function(node) {
		node = node.nextSibling;
		while (node && this.isMarkerMeta(node, "mw:DiffMarker")) {
			node = node.nextSibling;
		}
		return node;
	},

	/**
	 * Get the previous non mw:DiffMarker sibling
	 */
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
		DU.addAttributes(node, attrs);
		return node;
	},

	/**
	 * Return `true` iff the element has a `class` attribute containing
	 * `someClass` (among other space-separated classes).
	 * @param {Element} ele
	 * @param {string} someClass
	 */
	hasClass: function ( ele, someClass ) {
		if ( !ele || !isElt(ele) ) {
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
			if (isElt(node)) {
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
		return isElt(node) && (/(?:^|\s)mw:(?:Transclusion(?=$|\s)|Param(?=$|\s)|Extension\/[^\s]+)/).test(node.getAttribute('typeof'));
	},

	/**
	 * Find the first wrapper element of encapsulated content.
	 */
	findFirstEncapsulationWrapperNode: function ( node ) {
		if (!this.isTplOrExtToplevelNode(node)) {
			return null;
		}

		var about = node.getAttribute('about');
		while ( !this.isFirstEncapsulationWrapperNode( node ) ) {
			node = this.previousNonDeletedSibling(node);
			if ( !node || !isElt(node) || node.getAttribute('about') !== about ) {
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
		if (!isElt(node)) {
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
				isElt(node) && node.getAttribute('about') === about ||
				this.isFosterablePosition(node) && !isElt(node) && this.isIEW(node)
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
				if (DU.isElt(node)) {
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
	 * @param nodes List of DOM nodes that need to be tunneled through
	 * @param opts The pipeline opts that generated the DOM
	 * @return array List of token representatives
	 */
	getWrapperTokens: function ( nodes, opts ) {

		function makeWrapperForNode (node, wrapperType) {
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
		var firstNode = nodes[0], lastNode = nodes.length > 1 ? nodes.last() : null;
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
				isElt(sibling) &&
				about === sibling.getAttribute("about") &&
				hasRightType(sibling);
		}

		if (!isElt(node)) {
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
		var toks = this.getWrapperTokens(expansion.nodes, opts),
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
	stripDataParsoid: function ( node, dp ) {
		var uid = node.id,
			document = node.ownerDocument,
			docDp = this.getDataParsoid( document );
		if ( !uid ) {
			do {
				docDp.counter += 1;
				uid = "mw" + JSUtils.counterToBase64( docDp.counter );
			} while ( document.getElementById( uid ) );
			node.setAttribute( "id", uid );
		}
		docDp.ids[uid] = dp;
		delete this.getNodeData( node ).parsoid;
		// It would be better to instrument all the load sites.
		node.removeAttribute( "data-parsoid" );
	}

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
 * @method normalizeIEW
 *
 * Normalize newlines in IEW to spaces instead.  Newlines are
 * preserved/inserted around the same set of tags that formatHTML would
 * add them in front of.
 *
 * @param source {document}
 * @return {document}
 */
DOMUtils.normalizeIEW = function( body, stripSpanTypeof ) {
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
		for (child = node.firstChild; child; child = next) {
			next = child.nextSibling;
			if (DOMUtils.isComment(child)) {
				node.removeChild(child);
			}
		}
		// reassemble text nodes split by a comment or span, if necessary
		node.normalize();
		// now recurse.
		if (node.nodeName==='PRE') {
			// hack, since PHP adds a newline before </pre>
			stripLeadingWS = false;
			stripTrailingWS = true;
		} else if (node.nodeName==='SPAN' &&
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
	try {
		var body = this.normalizeIEW( this.parseHTML( source ).body );
		//console.log(source, this.serializeChildren(body));
		return this.serializeChildren(body)
			// a few things we ignore for now..
			//.replace(/\/wiki\/Main_Page/g, 'Main Page')
			// do not expect a toc for now
			.replace(/<div[^>]+?id="toc"[^>]*>\s*<div id="toctitle">[\s\S]+?<\/div>[\s\S]+?<\/div>\s*/g, '')
			// do not expect section editing for now
			.replace(/<span[^>]+class="mw-headline"[^>]*>(.*?)<\/span> *(<span class="mw-editsection"><span class="mw-editsection-bracket">\[<\/span>.*?<span class="mw-editsection-bracket">\]<\/span><\/span>)?/g, '$1')
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
	if (typeof(out) === 'string') {
		out = this.parseHTML( out ).body;
	}
	var stripTypeof = parsoidOnly ?
		/^mw:Placeholder$/ :
		/^mw:(?:Placeholder|Nowiki|Transclusion|Entity)$/;
	out = this.serializeChildren( this.normalizeIEW( out, stripTypeof ) );
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
		// Ignore troublesome attributes.
		// Strip JSON attributes like data-mw and data-parsoid early so that
		// comment stripping in normalizeNewlines does not match unbalanced
		// comments in wikitext source.
		out = out.replace(/ (data-mw|data-parsoid|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content|class)="[^\"]*"/g, '');
		// single-quoted variant
		out = out.replace(/ (data-mw|data-parsoid|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content|class)='[^\']*'/g, '');
		// strip typeof last
		out = out.replace(/ typeof="[^\"]*"/g, '');
	} else {
		// unnecessary attributes, we don't need to check these
		// style is in there because we should only check classes.
		out = out.replace(/ (data-parsoid|prefix|about|rev|datatype|inlist|vocab|content|style)="[^\"]*"/g, '');
		// single-quoted variant
		out = out.replace(/ (data-parsoid|prefix|about|rev|datatype|inlist|vocab|content|style)='[^\']*'/g, '');
	}
	return out.
		// strip meta/link elements
		replace(/<\/?(?:meta|link)(?: [^\0-\cZ\s"'>\/=]+(?:="[^"]*")?)*\/?>/g, '').
		// replace mwt ids
		replace(/ id="mwt\d+"/, '').
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
 * @method formatHTML
 *
 * Insert newlines before some block-level start tags.
 *
 * @param {string} source
 * @returns {string}
 */
DOMUtils.formatHTML = function ( source ) {
	// We do this in normalizeIEW now, no need for a separate function.
	if (true) {
		return source;
	} else {
		return source.replace(
				/(?!^)<((div|dd|dt|li|p|table|tr|td|tbody|dl|ol|ul|h1|h2|h3|h4|h5|h6)[^>]*)>/g, '\n<$1>');
	}
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
