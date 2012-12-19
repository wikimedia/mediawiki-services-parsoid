"use strict";

/**
 * General DOM utilities
 */

var HTML5 = require( 'html5' ).HTML5,
	Util = require('./mediawiki.Util.js').Util,
	Node = require('./mediawiki.wikitext.constants.js').Node;

var DOMUtils = {
	dataParsoid: function(n) {
		var str = n.getAttribute("data-parsoid");
		return str ? JSON.parse(str) : {};
	},

	setDataParsoid: function(n, dpObj) {
		n.setAttribute("data-parsoid", JSON.stringify(dpObj));
	},

	// Build path from n ---> ancestor
	// Doesn't include ancestor in the path itself
	pathToAncestor: function (n, ancestor) {
		var path = [];
		while (n && n !== ancestor) {
			path.push(n);
			n = n.parentNode;
		}

		return path;
	},

	pathToRoot: function(n) {
		return this.pathToAncestor(n, null);
	},

	// Build path from n ---> sibling (default)
	// If left is true, will build from sibling ---> n
	// Doesn't include sibling in the path in either case
	pathToSibling: function(n, sibling, left) {
		var path = [];
		while (n && n !== sibling) {
			path.push(n);
			n = left ? n.previousSibling : n.nextSibling;
		}

		return path;
	},

	// Does 'n1' occur before 'n2 in their parent's children list?
	inSiblingOrder: function(n1, n2) {
		while (n1 && n1 !== n2) {
			n1 = n1.nextSibling;
		}
		return n1 !== null;
	},

	// Is 'n1' an ancestor of 'n2' in the DOM?
	isAncestorOf: function (n1, n2) {
		while (n2 && n2 !== n1) {
			n2 = n2.parentNode;
		}
		return n2 !== null;
	},

	hasNodeName: function(n, name) {
		return n.nodeName.toLowerCase() === name;
	},

	isMarkerMeta: function(n, type) {
		return this.hasNodeName(n, "meta") && n.getAttribute("typeof") === type;
	},

	isTplMetaType: function(nType)  {
		return nType.match(/\bmw:Object(\/[^\s]+)*\b/);
	},

	isTplMarkerMeta: function(n)  {
		return (
			this.hasNodeName(n, "meta") &&
			this.isTplMetaType(n.getAttribute("typeof"))
		);
	},

	isTplStartMarkerMeta: function(n)  {
		if (this.hasNodeName(n, "meta")) {
			var t = n.getAttribute("typeof");
			var tMatch = t.match(/\bmw:Object(\/[^\s]+)*\b/);
			return tMatch && !t.match(/\/End\b/);
		} else {
			return false;
		}
	},

	isTplEndMarkerMeta: function(n)  {
		if (this.hasNodeName(n, "meta")) {
			var t = n.getAttribute("typeof");
			return t.match(/\bmw:Object(\/[^\s]+)*\/End\b/);
		} else {
			return false;
		}
	},

	hasLiteralHTMLMarker: function(dp) {
		return dp.stx === 'html';
	},

	isLiteralHTMLNode: function(n) {
		return this.hasLiteralHTMLMarker(this.dataParsoid(n));
	},

	isIndentPre: function(n) {
		return this.hasNodeName(n, "pre") && !this.isLiteralHTMLNode(n);
	},

	indentPreDSRCorrection: function(textNode) {
		// NOTE: This assumes a text-node and doesn't check that it is one.
		var numNLs;
		if (textNode.parentNode.lastChild === textNode) {
			// We dont want the trailing newline of the last child of the pre
			// to contribute a pre-correction since it doesn't add new content
			// in the pre-node after the text
			numNLs = (textNode.data.match(/\n./g)||[]).length;
		} else {
			numNLs = (textNode.data.match(/\n/g)||[]).length;
		}
		return numNLs && this.isIndentPre(textNode.parentNode) ? numNLs : 0;
	},

	// Check if node is an ELEMENT node belongs to a template/extension.
	//
	// NOTE: Use with caution. This technique works reliably for the
	// root level elements of tpl-content DOM subtrees since only they
	// are guaranteed to be  marked and nested content might not
	// necessarily be marked.
	isTplElementNode: function(env, node) {
		if (node.nodeType === Node.ELEMENT_NODE) {
			var about = node.getAttribute('about');
			return about && env.isParsoidObjectId(about);
		} else {
			return false;
		}
	},

	/**
	 * This method should return "true" for a node that can be edited in the
	 * VisualEditor extension. We're using this to basically ignore changes on
	 * things that can't have changed, because nothing could possibly have changed
	 * them.
	 *
	 * For now, template/extension content is not editable.
	 * TODO: Add anything else that is not covered here.
	 */
	isNodeEditable: function(env, someNode) {
		return !this.isTplElementNode(env, someNode);
	},

	convertDOMtoTokens: function(tokBuf, node) {
		function domAttrsToTagAttrs(attrs) {
			var out = [];
			for (var i = 0, n = attrs.length; i < n; i++) {
				var a = attrs.item(i);
				out.push(new KV(a.name, a.value));
			}
			return out;
		}

		switch(node.nodeType) {
			case Node.ELEMENT_NODE:
				var nodeName = node.nodeName.toLowerCase(),
					children = node.childNodes,
					tagAttrs = domAttrsToTagAttrs(node.attributes);

				if (Util.isVoidElement(nodeName)) {
					tokBuf.push(new SelfclosingTagTk(nodeName, tagAttrs));
				} else {
					tokBuf.push(new TagTk(nodeName, tagAttrs));
					for (var i = 0, n = children.length; i < n; i++) {
						this.convertDOMtoTokens(tokBuf, children[i]);
					}
					tokBuf.push(new EndTagTk(nodeName));
				}
				break;

			case Node.TEXT_NODE:
				// FIXME: Hmm .. what about newlines?
				// This might not be handled properly by the p-wrapper
				// which might expect newlines to be its own NlTk!
				var txt = node.data;
				tokBuf.push(node.data);
				break;

			case Node.COMMENT_NODE:
				tokBuf.push(new CommentTk(node.data));
				break;

			default:
				console.warn( "Unhandled node type: " + node.outerHTML );
				break;
		}
	}
};

if (typeof module === "object") {
	module.exports.DOMUtils = DOMUtils;
}
