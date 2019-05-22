/**
 * Stand-alone XMLSerializer for DOM3 documents
 *
 * The output is identical to standard XHTML5 DOM serialization, as given by
 * http://www.w3.org/TR/html-polyglot/
 * and
 * https://html.spec.whatwg.org/multipage/syntax.html#serialising-html-fragments
 * except that we may quote attributes with single quotes, *only* where that would
 * result in more compact output than the standard double-quoted serialization.
 * @module
 */

'use strict';

const entities = require('entities');
const { DOMUtils } = require('../utils/DOMUtils.js');
const { JSUtils } = require('../utils/jsutils.js');
const { WTUtils } = require('../utils/WTUtils.js');
const { WikitextConstants } = require('../config/WikitextConstants.js');

// nodeType constants
var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;
var DOCUMENT_NODE = 9;
var DOCUMENT_FRAGMENT_NODE = 11;

/**
 * HTML5 void elements
 * @namespace
 * @private
 */
var emptyElements = {
	area: true,
	base: true,
	basefont: true,
	bgsound: true,
	br: true,
	col: true,
	command: true,
	embed: true,
	frame: true,
	hr: true,
	img: true,
	input: true,
	keygen: true,
	link: true,
	meta: true,
	param: true,
	source: true,
	track: true,
	wbr: true,
};

/**
 * HTML5 elements with raw (unescaped) content
 * @namespace
 * @private
 */
var hasRawContent = {
	style: true,
	script: true,
	xmp: true,
	iframe: true,
	noembed: true,
	noframes: true,
	plaintext: true,
	noscript: true,
};

/**
 * Elements that strip leading newlines
 * http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#html-fragment-serialization-algorithm
 * @namespace
 * @private
 */
var newlineStrippingElements = {
	pre: true,
	textarea: true,
	listing: true,
};

/**
 * @namespace
 */
var XMLSerializer = {};

function serializeToString(node, options, accum) {
	var child;
	if (options.tunnelFosteredContent && WikitextConstants.HTML.FosterablePosition.has(node.nodeName)) {
		// Tunnel fosterable metas as comments.
		// This is analogous to what is done when treebuilding.
		const ownerDoc = node.ownerDocument;
		const allowedTags = WikitextConstants.HTML.TableContentModels.get(node.nodeName);
		child = node.firstChild;
		while (child) {
			const next = child.nextSibling;
			if (DOMUtils.isText(child)) {
				console.assert(DOMUtils.isIEW(child), 'Only expecting whitespace!');
			} else if (DOMUtils.isElt(child) && !allowedTags.includes(child.nodeName)) {
				console.assert(child.nodeName === 'META', 'Only fosterable metas expected!');
				const comment = WTUtils.fosterCommentData(
					child.getAttribute('typeof'),
					Array.from(child.attributes).map(a => [a.name, a.value]),
					true
				);
				node.replaceChild(ownerDoc.createComment(comment), child);
			}
			child = next;
		}
	}
	switch (node.nodeType) {
		case ELEMENT_NODE:
			child = node.firstChild;
			var attrs = node.attributes;
			var len = attrs.length;
			var nodeName = node.tagName.toLowerCase();
			var localName = node.localName;
			accum('<' + localName, node);
			for (var i = 0; i < len; i++) {
				var attr = attrs.item(i);
				if (options.smartQuote &&
						// More double quotes than single quotes in value?
						(attr.value.match(/"/g) || []).length >
						(attr.value.match(/'/g) || []).length) {
					// use single quotes
					accum(' ' + attr.name + "='"
							+ attr.value.replace(/[<&']/g, entities.encodeHTML5) + "'",
							node);
				} else {
					// use double quotes
					accum(' ' + attr.name + '="'
							+ attr.value.replace(/[<&"]/g, entities.encodeHTML5) + '"',
							node);
				}
			}
			if (child || !emptyElements[nodeName]) {
				accum('>', node, 'start');
				// if is cdata child node
				if (hasRawContent[nodeName]) {
					// TODO: perform context-sensitive escaping?
					// Currently this content is not normally part of our DOM, so
					// no problem. If it was, we'd probably have to do some
					// tag-specific escaping. Examples:
					// * < to \u003c in <script>
					// * < to \3c in <style>
					// ...
					if (child) {
						accum(child.data, node);
					}
				} else {
					if (child && newlineStrippingElements[localName]
							&& child.nodeType === TEXT_NODE && /^\n/.test(child.data)) {
						/* If current node is a pre, textarea, or listing element,
						 * and the first child node of the element, if any, is a
						 * Text node whose character data has as its first
						 * character a U+000A LINE FEED (LF) character, then
						 * append a U+000A LINE FEED (LF) character. */
						accum('\n', node);
					}
					while (child) {
						serializeToString(child, options, accum);
						child = child.nextSibling;
					}
				}
				accum('</' + localName + '>', node, 'end');
			} else {
				accum('/>', node, 'end');
			}
			return;
		case DOCUMENT_NODE:
		case DOCUMENT_FRAGMENT_NODE:
			child = node.firstChild;
			while (child) {
				serializeToString(child, options, accum);
				child = child.nextSibling;
			}
			return;
		case TEXT_NODE:
			return accum(node.data.replace(/[<&]/g, entities.encodeHTML5), node);
		case COMMENT_NODE:
			// According to
			// http://www.w3.org/TR/DOM-Parsing/#dfn-concept-serialize-xml
			// we could throw an exception here if node.data would not create
			// a "well-formed" XML comment.  But we use entity encoding when
			// we create the comment node to ensure that node.data will always
			// be okay; see WTUtils.encodeComment().
			return accum('<!--' + node.data + '-->', node);
		default:
			accum('??' + node.nodeName, node);
	}
}

var accumOffsets = function(out, bit, node, flag) {
	if (DOMUtils.isBody(node)) {
		out.html += bit;
		if (flag === 'start') {
			out.start = out.html.length;
		} else if (flag === 'end') {
			out.start = null;
			out.uid = null;
		}
	} else if (!DOMUtils.isElt(node) || out.start === null || !DOMUtils.isBody(node.parentNode)) {
		// In case you're wondering, out.start may never be set if body
		// isn't a child of the node passed to serializeToString, or if it
		// is the node itself but options.innerXML is true.
		out.html += bit;
		if (out.uid !== null) {
			out.offsets[out.uid].html[1] += bit.length;
		}
	} else {
		var newUid = node.hasAttribute('id') ? node.getAttribute('id') : null;
		// Encapsulated siblings don't have generated ids (but may have an id),
		// so associate them with preceding content.
		if (newUid && newUid !== out.uid && !out.last) {
			if (!WTUtils.isEncapsulationWrapper(node)) {
				out.uid = newUid;
			} else if (WTUtils.isFirstEncapsulationWrapperNode(node)) {
				var about = node.getAttribute('about');
				out.last = JSUtils.lastItem(WTUtils.getAboutSiblings(node, about));
				out.uid = newUid;
			}
		}
		if (out.last === node && flag === "end") {
			out.last = null;
		}
		console.assert(out.uid !== null);
		if (!out.offsets.hasOwnProperty(out.uid)) {
			var dt = out.html.length - out.start;
			out.offsets[out.uid] = { html: [dt, dt] };
		}
		out.html += bit;
		out.offsets[out.uid].html[1] += bit.length;
	}
};

/**
 * Serialize an HTML DOM3 node to XHTML.
 *
 * @param {Node} node
 * @param {Object} [options]
 * @param {boolean} [options.smartQuote=true]
 * @param {boolean} [options.innerXML=false]
 * @param {boolean} [options.captureOffsets=false]
 */
XMLSerializer.serialize = function(node, options) {
	if (!options) { options = {}; }
	if (!options.hasOwnProperty('smartQuote')) {
		options.smartQuote = true;
	}
	if (node.nodeName === '#document') {
		node = node.documentElement;
	}
	var out = { html: '', offsets: {}, start: null, uid: null, last: null };
	var accum = options.captureOffsets ?
		(bit, node, flag) => accumOffsets(out, bit, node, flag) : (bit) => { out.html += bit; };
	if (options.innerXML) {
		for (var child = node.firstChild; child; child = child.nextSibling) {
			serializeToString(child, options, accum);
		}
	} else {
		serializeToString(node, options, accum);
	}
	// Ensure there's a doctype for documents.
	if (!options.innerXML && /^html$/i.test(node.nodeName)) {
		out.html = '<!DOCTYPE html>\n' + out.html;
	}
	// Drop the bookkeeping
	const bookkeeping = { start: undefined, uid: undefined, last: undefined };
	if (!options.captureOffsets) { bookkeeping.offsets = undefined; }
	Object.assign(out, bookkeeping);
	return out;
};


module.exports = XMLSerializer;
