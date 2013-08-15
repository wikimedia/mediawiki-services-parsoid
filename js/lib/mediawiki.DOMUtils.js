"use strict";

/**
 * General DOM utilities
 */

require('./core-upgrade.js');
var Util = require('./mediawiki.Util.js').Util,
	wtc = require('./mediawiki.wikitext.constants.js'),
	Consts = wtc.WikitextConstants,
	Node = wtc.Node,
	pd = require('./mediawiki.parser.defines.js');

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
		return node.nodeType === Node.ELEMENT_NODE;
	},

	/**
	 * Check whether this is a DOM text node.
	 * See http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	isText: function(node) {
		return node.nodeType === Node.TEXT_NODE;
	},

	/**
	 * Determine whether this is a block-level DOM element.
	 * See Util#isBlockTag()
	 * @param {Node} node
	 */
	isBlockNode: function(node) {
		return node && Util.isBlockTag(node.nodeName.toLowerCase());
	},

	isFormattingElt: function(node) {
		return node && node.nodeName in Consts.HTML.FormattingTags;
	},

	isQuoteElt: function(node) {
		return node && node.nodeName in Consts.WTQuoteTags;
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
				node.setAttribute('typeof', types.join(''));
			} else {
				node.removeAttribute('typeof');
			}
		}
	},

	/**
	 * Decode a JSON object into the data member of DOM nodes
	 *
	 * @param {Node} node
	 * @param {string} name We'll use the data-[name] attribute of the passed-in node as the new value.
	 * @param {Mixed} defaultVal What to use if there is no JSON attribute by that name.
	 */
	loadDataAttrib: function(node, name, defaultVal) {
		if ( node.nodeType !== node.ELEMENT_NODE ) {
			return;
		}

		if ( ! node.data ) {
			node.data = {};
		}
		if ( node.data[name] === undefined ) {
			node.data[name] = this.getJSONAttribute(node, 'data-' + name, defaultVal);
		}
		// nothing to do if already loaded
	},

	/**
	 * Save all node.data.* structures to data attributes
	 */
	saveDataAttribs: function(node) {
		if ( node.nodeType !== node.ELEMENT_NODE ) {
			return;
		}

		for(var key in node.data) {
			if ( key.match( /^tmp_/ ) !== null ) {
				continue;
			}
			var val = node.data[key];
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
	loadDataParsoid: function(node) {
		this.loadDataAttrib(node, 'parsoid', {});
	},

	getDataParsoid: function ( n ) {
		if ( ! ( n.data && n.data.parsoid ) ) {
			this.loadDataParsoid( n );
		}
		return n.data.parsoid;
	},

	getDataMw: function ( n ) {
		if ( ! ( n.data && n.data.mw ) ) {
			this.loadDataAttrib( n, 'mw', {} );
		}
		return n.data.mw;
	},

	/**
	 * Set the data-parsoid attribute on a node.
	 *
	 * TODO use this.setJSONAttribute
	 *
	 * @param {Object} dpObj The new value for data-parsoid
	 * @returns {Node} `node`, with the attribute set on it
	 */
	setDataParsoid: function(node, dpObj) {
		node.setAttribute("data-parsoid", JSON.stringify(dpObj));
		return node;
	},

	/**
	 * Get an object from a JSON-encoded XML attribute on a node.
	 *
	 * @param {string} name Name of the attribute
	 * @param {Mixed} defaultVal What should be returned if we fail to find a valid JSON structure
	 */
	getJSONAttribute: function(node, name, defaultVal) {
		if ( node.nodeType !== node.ELEMENT_NODE ) {
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
	 * @param {Object} tplAttrs
	 * @returns {Object}
	 *   @returns {Mixed} return.value
	 *   @returns {boolean} return.modified If the value of the attribute changed since we parsed the wikitext
	 *   @returns {boolean} return.fromsrc Whether we got the value from source-based roundtripping
	 */
	getAttributeShadowInfo: function ( node, name, tplAttrs ) {
		this.getDataParsoid( node );
		if ( node.nodeType !== node.ELEMENT_NODE ||
				!node.data || !node.data.parsoid ) {
			return node.getAttribute( name );
		}
		var curVal = node.getAttribute(name),
			dp = node.data.parsoid;

		// If tplAttrs is truish, check if this attribute was
		// template-generated. Return that value if set.
		if ( tplAttrs ) {
			var type = node.getAttribute('typeof'),
				about = node.getAttribute('about') || '',
				tplAttrState = tplAttrs[about];
			if (type && type.match(/\bmw:ExpandedAttrs\/[^\s]+/) &&
					tplAttrState &&
					tplAttrState.vs[name] )
			{
				return {
					value: tplAttrState.vs[name],
					modified: false,
					fromsrc: true
				};
			}
		}

		// Not the case, continue regular round-trip information.
		if ( dp.a === undefined ) {
			return {
				value: curVal,
				// Mark as modified if a new element
				modified: !node.hasAttribute('data-parsoid'),
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
		return nType && nType.match(/\bmw:Transclusion(\/[^\s]+)*\b/);
	},

	/**
	 * Check whether a meta's typeof indicates that it signifies an
	 * expanded attribute.
	 *
	 * @param {string} nType
	 */
	isExpandedAttrsMetaType: function(nType) {
		return nType && nType.match(/\bmw:ExpandedAttrs(\/[^\s]+)*\b/);
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
			var tMatch = t && t.match(/\bmw:Transclusion(\/[^\s]+)*\b/);
			return tMatch && !t.match(/\/End\b/);
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
			return t && t.match(/\bmw:Transclusion(\/[^\s]+)*\/End\b/);
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
		return n && n.parentNode.nodeName in {TABLE:1, TBODY:1, TR:1};
	},

	isList: function(n) {
		return n && n.nodeName in Consts.HTML.ListTags;
	},

	isListItem: function(n) {
		return n && n.nodeName in Consts.HTML.ListItemTags;
	},

	isListOrListItem: function(n) {
		return this.isList(n) || this.isListItem(n);
	},

	/**
	 * Get the node's previous sibling that is an element, or else
	 * return `null` if there is no such sibling element.
	 */
	getPrecedingElementSibling: function(node) {
		var sibling = node.previousSibling;
		while (sibling) {
			if (sibling.nodeType === node.ELEMENT_NODE) {
				return sibling;
			}
			sibling = node.previousSibling;
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
			if (child.nodeType === child.ELEMENT_NODE &&
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

	isEncapsulatedElt: function(node) {
		return (/\bmw:(?:Transclusion\b|Param\b|Extension\/[^\s]+)/).test(node.getAttribute('typeof'));
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
			case Node.ELEMENT_NODE:
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
					tokBuf.push(new pd.EndTagTk(nodeName));
				}
				break;

			case Node.TEXT_NODE:
				tokBuf = tokBuf.concat(Util.newlinesToNlTks(node.nodeValue));
				break;

			case Node.COMMENT_NODE:
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
			return false;
		}
		if ( !( node.data && node.data["parsoid-diff"] ) ) {
			this.loadDataAttrib(node, "parsoid-diff");
		}
		var dpd = node.data["parsoid-diff"];
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
			// Diff is up to date, append this change
			dpd.diff.push(change);
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

	/**
	 * Are all children of this node text nodes?
	 */
	allChildrenAreText: function (node) {
		var child = node.firstChild;
		while(child) {
			if(child.nodeType !== node.TEXT_NODE) {
				return false;
			}
			child = child.nextSibling;
		}
		return true;
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
		return new pd.TagTk(node.nodeName.toLowerCase(), attribKVs, node.data.parsoid);
	},

	/**
	 * Create a `EndTagTk` corresponding to a DOM node
	 */
	mkEndTagTk: function (node) {
		var attribKVs = this.getAttributeKVArray(node);
		return new pd.EndTagTk(node.nodeName.toLowerCase(), attribKVs, node.data.parsoid);
	},

	addAttributes: function(elt, attrs) {
		Object.keys(attrs).forEach(function(k) {
			if (attrs[k] !== null && attrs[k] !== undefined) {
				elt.setAttribute(k, attrs[k]);
			}
		});
	},

	/**
	 * Return `true` iff the element has a `class` attribute containing
	 * `someClass` (among other space-separated classes).
	 * @param {Element} ele
	 * @param {string} someClass
	 */
	hasClass: function ( ele, someClass ) {
		if ( !ele || ele.nodeType !== ele.ELEMENT_NODE ) {
			return false;
		}

		var classes = ele.getAttribute( 'class' );

		if ( classes && classes.match( new RegExp( '\\b' + someClass + '\\b' ) ) ) {
			return true;
		} else {
			return false;
		}
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

	migrateChildren: function(from, to) {
		var child = from.firstChild;
		while (child) {
			var next = child.nextSibling;
			to.appendChild(child);
			child = next;
		}
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

		node = node.nextSibling;
		while (node && (
				this.isElt(node) && node.getAttribute('about') === about ||
				this.isFosterablePosition(node) && !this.isElt(node) && this.isIEW(node)
			))
		{
			nodes.push(node);
			node = node.nextSibling;
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
		return this.getAboutSiblings(node, about).last().nextSibling;
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
			var nodes, expAccum,
				outerHTML = function (n) {
					return n.outerHTML;
				};

			while (node) {
				if (node.nodeType === node.ELEMENT_NODE) {
					var typeOf = node.getAttribute('typeof'),
						about = node.getAttribute('about');
					if ((/\b(?:mw:(?:Transclusion\b|Extension\/))/
								.test(typeOf) && about) ||
							/\b(?:mw:Image(?:\b|\/))/.test(typeOf))
					{
						DU.loadDataParsoid(node);
						nodes = DU.getAboutSiblings(node, about);
						var key;
						if (/\bmw:Transclusion\b/.test(typeOf)) {
							expAccum = expansions.transclusions;
							key = node.data.parsoid.src;
						} else if (/\bmw:Extension\//.test(typeOf)) {
							expAccum = expansions.extensions;
							key = node.data.parsoid.src;
						} else {
							expAccum = expansions.files;
							// XXX gwicke: use proper key that is not
							// source-based? This also needs to work for
							// transclusion output.
							key = node.data.parsoid.cacheKey;
						}

						if (key) {
							expAccum[key] = {
								nodes: nodes,
								html: nodes.map(outerHTML).join('')
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
			out.push(span);
			textCommentAccum = [];
		}

		nodes.forEach( function(node) {
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
				// create a copy of the node without children
				workNode = node.ownerDocument.createElement(node.nodeName);
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

	/**
	 * Compute, when possible, the wikitext source for a node in
	 * an environment env. Returns null if the source cannot be
	 * extracted.
	 */
	getWTSource: function ( env, node ) {
		var data = node.data.parsoid,
		    dsr = (undefined !== data) ? data.dsr : null;
		return dsr ? env.page.src.substring(dsr[0], dsr[1]) : null;
	}
};



if (typeof module === "object") {
	module.exports.DOMUtils = DOMUtils;
}
