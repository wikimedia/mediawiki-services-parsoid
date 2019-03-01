/**
 * DOM utilities for querying the DOM. This is largely independent of Parsoid
 * although some Parsoid details (diff markers, TokenUtils, inline content version)
 * have snuck in. Trying to prevent that is probably not worth the effort yet
 * at this stage of refactoring.
 *
 * @module
 */

'use strict';

const domino = require('domino');

const Consts = require('../config/WikitextConstants.js').WikitextConstants;
const { JSUtils } = require('./jsutils.js');
const { TokenUtils } = require('./TokenUtils.js');

class DOMUtils {
	/**
	 * Parse HTML, return the tree.
	 *
	 * @param {string} html
	 * @return {Node}
	 */
	static parseHTML(html) {
		html = html || '';
		if (!html.match(/^<(?:!doctype|html|body)/i)) {
			// Make sure that we parse fragments in the body. Otherwise comments,
			// link and meta tags end up outside the html element or in the head
			// element.
			html = '<body>' + html;
		}
		return domino.createDocument(html);
	}

	/**
	 * This is a simplified version of the DOMTraverser.
	 * Consider using that before making this more complex.
	 *
	 * FIXME: Move to DOMTraverser OR create a new class?
	 */
	static visitDOM(node, handler, ...args) {
		handler(node, ...args);
		node = node.firstChild;
		while (node) {
			const next = node.nextSibling;
			this.visitDOM(node, handler, ...args);
			node = next;
		}
	}

	/**
	 * Move 'from'.childNodes to 'to' adding them before 'beforeNode'
	 * If 'beforeNode' is null, the nodes are appended at the end.
	 */
	static migrateChildren(from, to, beforeNode) {
		if (beforeNode === undefined) {
			beforeNode = null;
		}
		while (from.firstChild) {
			to.insertBefore(from.firstChild, beforeNode);
		}
	}

	/**
	 * Move 'from'.childNodes to 'to' adding them before 'beforeNode'
	 * 'from' and 'to' belong to different documents.
	 *
	 * If 'beforeNode' is null, the nodes are appended at the end.
	 */
	static migrateChildrenBetweenDocs(from, to, beforeNode) {
		if (beforeNode === undefined) {
			beforeNode = null;
		}
		var n = from.firstChild;
		var destDoc = to.ownerDocument;
		while (n) {
			to.insertBefore(destDoc.importNode(n, true), beforeNode);
			n = n.nextSibling;
		}
	}

	/**
	 * Check whether this is a DOM element node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	static isElt(node) {
		return node && node.nodeType === 1;
	}

	/**
	 * Check whether this is a DOM text node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	static isText(node) {
		return node && node.nodeType === 3;
	}

	/**
	 * Check whether this is a DOM comment node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param {Node} node
	 */
	static isComment(node) {
		return node && node.nodeType === 8;
	}

	/**
	 * Determine whether this is a block-level DOM element.
	 * @see TokenUtils.isBlockTag
	 * @param {Node} node
	 */
	static isBlockNode(node) {
		return node && TokenUtils.isBlockTag(node.nodeName);
	}

	static isFormattingElt(node) {
		return node && Consts.HTML.FormattingTags.has(node.nodeName);
	}

	static isQuoteElt(node) {
		return node && Consts.WTQuoteTags.has(node.nodeName);
	}

	static isBody(node) {
		return node && node.nodeName === 'BODY';
	}

	/**
	 * Test the number of children this node has without using
	 * `Node#childNodes.length`.  This walks the sibling list and so
	 * takes O(`nchildren`) time -- so `nchildren` is expected to be small
	 * (say: 0, 1, or 2).
	 *
	 * Skips all diff markers by default.
	 */
	static hasNChildren(node, nchildren, countDiffMarkers) {
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (!countDiffMarkers && this.isDiffMarker(child)) {
				continue;
			}
			if (nchildren <= 0) { return false; }
			nchildren -= 1;
		}
		return (nchildren === 0);
	}

	/**
	 * Build path from a node to its passed-in ancestor.
	 * Doesn't include the ancestor in the returned path.
	 *
	 * @param {Node} node
	 * @param {Node} ancestor Should be an ancestor of `node`.
	 * @return {Node[]}
	 */
	static pathToAncestor(node, ancestor) {
		var path = [];
		while (node && node !== ancestor) {
			path.push(node);
			node = node.parentNode;
		}

		return path;
	}

	/**
	 * Build path from a node to the root of the document.
	 *
	 * @return {Node[]}
	 */
	static pathToRoot(node) {
		return this.pathToAncestor(node, null);
	}

	/**
	 * Build path from a node to its passed-in sibling.
	 *
	 * @param {Node} node
	 * @param {Node} sibling
	 * @param {boolean} left Whether to go backwards, i.e., use previousSibling instead of nextSibling.
	 * @return {Node[]} Will not include the passed-in sibling.
	 */
	static pathToSibling(node, sibling, left) {
		var path = [];
		while (node && node !== sibling) {
			path.push(node);
			node = left ? node.previousSibling : node.nextSibling;
		}

		return path;
	}

	/**
	 * Check whether a node `n1` comes before another node `n2` in
	 * their parent's children list.
	 *
	 * @param {Node} n1 The node you expect to come first.
	 * @param {Node} n2 Expected later sibling.
	 */
	static inSiblingOrder(n1, n2) {
		while (n1 && n1 !== n2) {
			n1 = n1.nextSibling;
		}
		return n1 !== null;
	}

	/**
	 * Check that a node 'n1' is an ancestor of another node 'n2' in
	 * the DOM. Returns true if n1 === n2.
	 *
	 * @param {Node} n1 The suspected ancestor.
	 * @param {Node} n2 The suspected descendant.
	 */
	static isAncestorOf(n1, n2) {
		while (n2 && n2 !== n1) {
			n2 = n2.parentNode;
		}
		return n2 !== null;
	}

	/**
	 * Check whether `node` has an ancesor named `name`.
	 *
	 * @param {Node} node
	 * @param {string} name
	 */
	static hasAncestorOfName(node, name) {
		while (node && node.nodeName !== name) {
			node = node.parentNode;
		}
		return node !== null;
	}

	/**
	 * Determine whether the node matches the given nodeName and typeof
	 * attribute value.
	 *
	 * @param {Node} n
	 * @param {string} name node name to test for
	 * @param {RegExp} type Expected value of "typeof" attribute.
	 * @return {string|null} Matching typeof value, or `null` if the node
	 *    doesn't match.
	 */
	static matchNameAndTypeOf(n, name, type) {
		return (n.nodeName === name) ? this.matchTypeOf(n, type) : null;
	}

	/**
	 * Determine whether the node matches the given nodeName and typeof
	 * attribute value; the typeof is given as string.
	 *
	 * @param {Node} n
	 * @param {string} name node name to test for
	 * @param {string} type Expected value of "typeof" attribute.
	 * @return {bool} True if the node matches.
	 */
	static hasNameAndTypeOf(n, name, type) {
		return this.matchNameAndTypeOf(
			n, name, JSUtils.rejoin('^', JSUtils.escapeRegExp(type), '$')
		) !== null;
	}

	/**
	 * Determine whether the node matches the given typeof attribute value.
	 *
	 * @param {Node} n
	 * @param {RegExp} type Expected value of "typeof" attribute.
	 * @return {string|null} Matching typeof value, or `null` if the node
	 *    doesn't match.
	 */
	static matchTypeOf(n, type) {
		if (!this.isElt(n)) { return null; }
		if (!n.hasAttribute('typeof')) { return null; }
		for (const ty of n.getAttribute('typeof').split(/\s+/g)) {
			if (type.test(ty)) { return ty; }
		}
		return null;
	}

	/**
	 * Determine whether the node matches the given typeof attribute value.
	 *
	 * @param {Node} n
	 * @param {string} type Expected value of "typeof" attribute, as a literal
	 *   string.
	 * @return {bool} True if the node matches.
	 */
	static hasTypeOf(n, type) {
		return this.matchTypeOf(
			n, JSUtils.rejoin('^', JSUtils.escapeRegExp(type), '$')
		) !== null;
	}

	static isFosterablePosition(n) {
		return n && Consts.HTML.FosterablePosition.has(n.parentNode.nodeName);
	}

	static isList(n) {
		return n && Consts.HTML.ListTags.has(n.nodeName);
	}

	static isListItem(n) {
		return n && Consts.HTML.ListItemTags.has(n.nodeName);
	}

	static isListOrListItem(n) {
		return this.isList(n) || this.isListItem(n);
	}

	static isNestedInListItem(n) {
		var parentNode = n.parentNode;
		while (parentNode) {
			if (this.isListItem(parentNode)) {
				return true;
			}
			parentNode = parentNode.parentNode;
		}
		return false;
	}

	static isNestedListOrListItem(n) {
		return (this.isList(n) || this.isListItem(n)) && this.isNestedInListItem(n);
	}

	/**
	 * Check a node to see whether it's a meta with some typeof.
	 *
	 * @param {Node} n
	 * @param {string} type Passed into {@link #hasNameAndTypeOf}.
	 * @return {bool}
	 */
	static isMarkerMeta(n, type) {
		return this.hasNameAndTypeOf(n, "META", type);
	}

	// FIXME: This would ideally belong in DiffUtils.js
	// but that would introduce circular dependencies.
	static isDiffMarker(node, mark) {
		if (!node) { return false; }

		if (mark) {
			return this.isMarkerMeta(node, 'mw:DiffMarker/' + mark);
		} else {
			return node.nodeName === 'META' && /\bmw:DiffMarker\/\w*\b/.test(node.getAttribute('typeof') || '');
		}
	}

	/**
	 * Check whether a node has any children that are elements.
	 */
	static hasElementChild(node) {
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (this.isElt(child)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if a node has a block-level element descendant.
	 */
	static hasBlockElementDescendant(node) {
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (this.isElt(child) &&
					// Is a block-level node
					(this.isBlockNode(child) ||
						// or has a block-level child or grandchild or..
						this.hasBlockElementDescendant(child))) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Is a node representing inter-element whitespace?
	 */
	static isIEW(node) {
		// ws-only
		return this.isText(node) && node.nodeValue.match(/^[ \t\r\n]*$/);
	}

	static isDocumentFragment(node) {
		return node && node.nodeType === 11;
	}

	static atTheTop(node) {
		return this.isDocumentFragment(node) || this.isBody(node);
	}

	static isContentNode(node) {
		return !this.isComment(node) &&
			!this.isIEW(node) &&
			!this.isDiffMarker(node);
	}

	/**
	 * Get the first child element or non-IEW text node, ignoring
	 * whitespace-only text nodes, comments, and deleted nodes.
	 */
	static firstNonSepChild(node) {
		var child = node.firstChild;
		while (child && !this.isContentNode(child)) {
			child = child.nextSibling;
		}
		return child;
	}

	/**
	 * Get the last child element or non-IEW text node, ignoring
	 * whitespace-only text nodes, comments, and deleted nodes.
	 */
	static lastNonSepChild(node) {
		var child = node.lastChild;
		while (child && !this.isContentNode(child)) {
			child = child.previousSibling;
		}
		return child;
	}

	static previousNonSepSibling(node) {
		var prev = node.previousSibling;
		while (prev && !this.isContentNode(prev)) {
			prev = prev.previousSibling;
		}
		return prev;
	}

	static nextNonSepSibling(node) {
		var next = node.nextSibling;
		while (next && !this.isContentNode(next)) {
			next = next.nextSibling;
		}
		return next;
	}

	static numNonDeletedChildNodes(node) {
		var n = 0;
		var child = node.firstChild;
		while (child) {
			if (!this.isDiffMarker(child)) { // FIXME: This is ignoring both inserted/deleted
				n++;
			}
			child = child.nextSibling;
		}
		return n;
	}

	/**
	 * Get the first non-deleted child of node.
	 */
	static firstNonDeletedChild(node) {
		var child = node.firstChild;
		while (child && this.isDiffMarker(child)) { // FIXME: This is ignoring both inserted/deleted
			child = child.nextSibling;
		}
		return child;
	}

	/**
	 * Get the last non-deleted child of node.
	 */
	static lastNonDeletedChild(node) {
		var child = node.lastChild;
		while (child && this.isDiffMarker(child)) { // FIXME: This is ignoring both inserted/deleted
			child = child.previousSibling;
		}
		return child;
	}

	/**
	 * Get the next non deleted sibling.
	 */
	static nextNonDeletedSibling(node) {
		node = node.nextSibling;
		while (node && this.isDiffMarker(node)) { // FIXME: This is ignoring both inserted/deleted
			node = node.nextSibling;
		}
		return node;
	}

	/**
	 * Get the previous non deleted sibling.
	 */
	static previousNonDeletedSibling(node) {
		node = node.previousSibling;
		while (node && this.isDiffMarker(node)) { // FIXME: This is ignoring both inserted/deleted
			node = node.previousSibling;
		}
		return node;
	}

	/**
	 * Are all children of this node text or comment nodes?
	 */
	static allChildrenAreTextOrComments(node) {
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
	}

	/**
	 * Are all children of this node text nodes?
	 */
	static allChildrenAreText(node) {
		var child = node.firstChild;
		while (child) {
			if (!this.isDiffMarker(child) && !this.isText(child)) {
				return false;
			}
			child = child.nextSibling;
		}
		return true;
	}

	/**
	 * Does `node` contain nothing or just non-newline whitespace?
	 * `strict` adds the condition that all whitespace is forbidden.
	 */
	static nodeEssentiallyEmpty(node, strict) {
		var n = node.firstChild;
		while (n) {
			if (this.isElt(n) && !this.isDiffMarker(n)) {
				return false;
			} else if (this.isText(n) &&
					(strict || !/^[ \t]*$/.test(n.nodeValue))) {
				return false;
			} else if (this.isComment(n)) {
				return false;
			}
			n = n.nextSibling;
		}
		return true;
	}

	/**
	 * Check if the dom-subtree rooted at node has an element with tag name 'tagName'
	 * The root node is not checked.
	 */
	static treeHasElement(node, tagName) {
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
	}

	/**
	 * Is node a table tag (table, tbody, td, tr, etc.)?
	 * @param {Node} node
	 * @return {boolean}
	 */
	static isTableTag(node) {
		return Consts.HTML.TableTags.has(node.nodeName);
	}

	/**
	 * Returns a media element nested in `node`
	 *
	 * @param {Node} node
	 * @return {Node|null}
	 */
	static selectMediaElt(node) {
		return node.querySelector('img, video, audio');
	}

	/**
	 * Extract http-equiv headers from the HTML, including content-language and
	 * vary headers, if present
	 *
	 * @param {Document} doc
	 * @return {Object}
	 */
	static findHttpEquivHeaders(doc) {
		return Array.from(doc.querySelectorAll('meta[http-equiv][content]'))
		.reduce((r,el) => {
			r[el.getAttribute('http-equiv').toLowerCase()] =
				el.getAttribute('content');
			return r;
		}, {});
	}

	/**
	 * @param {Document} doc
	 * @return {string|null}
	 */
	static extractInlinedContentVersion(doc) {
		var el = doc.querySelector('meta[property="mw:html:version"]');
		return el ? el.getAttribute('content') : null;
	}
}

if (typeof module === "object") {
	module.exports.DOMUtils = DOMUtils;
}
