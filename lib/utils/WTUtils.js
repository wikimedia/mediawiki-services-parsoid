/**
 * These utilites pertain to extracting / modifying wikitext information from the DOM.
 * @module
 */

'use strict';

const Consts = require('../config/WikitextConstants.js').WikitextConstants;
const { DOMDataUtils } = require('./DOMDataUtils.js');
const { DOMUtils } = require('./DOMUtils.js');
const { JSUtils } = require('./jsutils.js');
const { TokenUtils } = require('./TokenUtils.js');
const { Util } = require('./Util.js');

const lastItem = JSUtils.lastItem;

/**
 * Regexp for checking marker metas typeofs representing
 * transclusion markup or template param markup.
 * @property {RegExp}
 */
const TPL_META_TYPE_REGEXP = /^mw:(?:Transclusion|Param)(?:\/End)?$/;

class WTUtils {

	/**
	 * Check whether a node's data-parsoid object includes
	 * an indicator that the original wikitext was a literal
	 * HTML element (like table or p).
	 *
	 * @param {Object} dp
	 *   @param {string|undefined} [dp.stx]
	 */
	static hasLiteralHTMLMarker(dp) {
		return dp.stx === 'html';
	}

	/**
	 * Run a node through {@link #hasLiteralHTMLMarker}.
	 */
	static isLiteralHTMLNode(node) {
		return (node &&
			DOMUtils.isElt(node) &&
			this.hasLiteralHTMLMarker(DOMDataUtils.getDataParsoid(node)));
	}

	static isZeroWidthWikitextElt(node) {
		return Consts.ZeroWidthWikitextTags.has(node.nodeName) &&
			!this.isLiteralHTMLNode(node);
	}

	/**
	 * Is `node` a block node that is also visible in wikitext?
	 * An example of an invisible block node is a `<p>`-tag that
	 * Parsoid generated, or a `<ul>`, `<ol>` tag.
	 *
	 * @param {Node} node
	 */
	static isBlockNodeWithVisibleWT(node) {
		return DOMUtils.isBlockNode(node) && !this.isZeroWidthWikitextElt(node);
	}

	/**
	 * Helper functions to detect when an A-node uses [[..]]/[..]/... style
	 * syntax (for wikilinks, ext links, url links). rel-type is not sufficient
	 * anymore since mw:ExtLink is used for all the three link syntaxes.
	 */
	static usesWikiLinkSyntax(aNode, dp) {
		if (dp === undefined) {
			dp = DOMDataUtils.getDataParsoid(aNode);
		}

		// SSS FIXME: This requires to be made more robust
		// for when dp.stx value is not present
		return aNode.getAttribute("rel") === "mw:WikiLink" ||
			(dp.stx && dp.stx !== "url" && dp.stx !== "magiclink");
	}

	static usesExtLinkSyntax(aNode, dp) {
		if (dp === undefined) {
			dp = DOMDataUtils.getDataParsoid(aNode);
		}

		// SSS FIXME: This requires to be made more robust
		// for when dp.stx value is not present
		return aNode.getAttribute("rel") === "mw:ExtLink" &&
			(!dp.stx || (dp.stx !== "url" && dp.stx !== "magiclink"));
	}

	static usesURLLinkSyntax(aNode, dp) {
		if (dp === undefined) {
			dp = DOMDataUtils.getDataParsoid(aNode);
		}

		// SSS FIXME: This requires to be made more robust
		// for when dp.stx value is not present
		return aNode.getAttribute("rel") === "mw:ExtLink" &&
			dp.stx && dp.stx === "url";
	}

	static usesMagicLinkSyntax(aNode, dp) {
		if (dp === undefined) {
			dp = DOMDataUtils.getDataParsoid(aNode);
		}

		// SSS FIXME: This requires to be made more robust
		// for when dp.stx value is not present
		return aNode.getAttribute("rel") === "mw:ExtLink" &&
			dp.stx && dp.stx === "magiclink";
	}

	/**
	 * Check whether a node's typeof indicates that it is a template expansion.
	 *
	 * @param {Node} node
	 * @return {string|null} The matched type, or null if no match.
	 */
	static matchTplType(node) {
		return DOMUtils.matchTypeOf(node, TPL_META_TYPE_REGEXP);
	}

	/**
	 * Check whether a typeof indicates that it signifies an
	 * expanded attribute.
	 * @return {bool}
	 */
	static hasExpandedAttrsType(node) {
		return DOMUtils.matchTypeOf(node, /^mw:ExpandedAttrs(\/[^\s]+)*$/) !== null;
	}

	/**
	 * Check whether a node is a meta tag that signifies a template expansion.
	 */
	static isTplMarkerMeta(node) {
		return DOMUtils.matchNameAndTypeOf(node, 'META', TPL_META_TYPE_REGEXP) !== null;
	}

	/**
	 * Check whether a node is a meta signifying the start of a template expansion.
	 */
	static isTplStartMarkerMeta(node) {
		var t = DOMUtils.matchNameAndTypeOf(node, 'META', TPL_META_TYPE_REGEXP);
		return t && !/\/End$/.test(t);
	}

	/**
	 * Check whether a node is a meta signifying the end of a template
	 * expansion.
	 *
	 * @param {Node} n
	 */
	static isTplEndMarkerMeta(n) {
		var t = DOMUtils.matchNameAndTypeOf(n, 'META', TPL_META_TYPE_REGEXP);
		return t && /\/End$/.test(t);
	}

	/**
	 * Find the first wrapper element of encapsulated content.
	 */
	static findFirstEncapsulationWrapperNode(node) {
		if (!this.hasParsoidAboutId(node)) {
			return null;
		}
		var about = node.getAttribute('about') || '';
		var prev = node;
		do {
			node = prev;
			prev = DOMUtils.previousNonDeletedSibling(node);
		} while (prev && DOMUtils.isElt(prev) && prev.getAttribute('about') === about);
		return this.isFirstEncapsulationWrapperNode(node) ? node : null;
	}

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
	static isNewElt(node) {
		// We cannot determine newness on text/comment nodes.
		if (!DOMUtils.isElt(node)) {
			return false;
		}

		// For template/extension content, newness should be
		// checked on the encapsulation wrapper node.
		node = this.findFirstEncapsulationWrapperNode(node) || node;
		return !!DOMDataUtils.getDataParsoid(node).tmp.isNew;
	}

	/**
	 * Check whether a pre is caused by indentation in the original wikitext.
	 */
	static isIndentPre(node) {
		return node.nodeName === "PRE" && !this.isLiteralHTMLNode(node);
	}

	static isInlineMedia(n) {
		return DOMUtils.matchNameAndTypeOf(n, 'FIGURE-INLINE', /^mw:(?:Image|Video|Audio)($|\/)/) !== null;
	}

	static isGeneratedFigure(n) {
		return DOMUtils.matchTypeOf(n, /^mw:(?:Image|Video|Audio)($|\/)/) !== null;
	}

	/**
	 * Find how much offset is necessary for the DSR of an
	 * indent-originated pre tag.
	 *
	 * @param {TextNode} textNode
	 * @return {number}
	 */
	static indentPreDSRCorrection(textNode) {
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
	}

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
	static hasParsoidAboutId(node) {
		if (DOMUtils.isElt(node)) {
			var about = node.getAttribute('about') || '';
			// SSS FIXME: Verify that our DOM spec clarifies this
			// expectation on about-ids and that our clients respect this.
			return about && Util.isParsoidObjectId(about);
		} else {
			return false;
		}
	}

	static isRedirectLink(node) {
		return DOMUtils.isElt(node) && node.nodeName === 'LINK' &&
			/\bmw:PageProp\/redirect\b/.test(node.getAttribute('rel') || '');
	}

	static isCategoryLink(node) {
		return DOMUtils.isElt(node) && node.nodeName === 'LINK' &&
			/\bmw:PageProp\/Category\b/.test(node.getAttribute('rel') || '');
	}

	static isSolTransparentLink(node) {
		return DOMUtils.isElt(node) && node.nodeName === 'LINK' &&
			TokenUtils.solTransparentLinkRegexp.test(node.getAttribute('rel') || '');
	}

	/**
	 * Check if 'node' emits wikitext that is sol-transparent in wikitext form.
	 * This is a test for wikitext that doesn't introduce line breaks.
	 *
	 * Comment, whitespace text nodes, category links, redirect links, behavior
	 * switches, and include directives currently satisfy this definition.
	 *
	 * This should come close to matching TokenUtils.isSolTransparent()
	 *
	 * @param {Node} node
	 */
	static emitsSolTransparentSingleLineWT(node) {
		if (DOMUtils.isText(node)) {
			// NB: We differ here to meet the nl condition.
			return node.nodeValue.match(/^[ \t]*$/);
		} else if (this.isRenderingTransparentNode(node)) {
			// NB: The only metas in a DOM should be for behavior switches and
			// include directives, other than explicit HTML meta tags. This
			// differs from our counterpart in Util where ref meta tokens
			// haven't been expanded to spans yet.
			return true;
		} else {
			return false;
		}
	}

	static isFallbackIdSpan(node) {
		return DOMUtils.hasNameAndTypeOf(node, 'SPAN', 'mw:FallbackId');
	}

	/**
	 * These are primarily 'metadata'-like nodes that don't show up in output rendering.
	 * - In Parsoid output, they are represented by link/meta tags.
	 * - In the PHP parser, they are completely stripped from the input early on.
	 *   Because of this property, these rendering-transparent nodes are also
	 *   SOL-transparent for the purposes of parsing behavior.
	 */
	static isRenderingTransparentNode(node) {
		// FIXME: Can we change this entire thing to
		// DOMUtils.isComment(node) ||
		// DOMUtils.getDataParsoid(node).stx !== 'html' &&
		//   (node.nodeName === 'META' || node.nodeName === 'LINK')
		//
		return DOMUtils.isComment(node) ||
			this.isSolTransparentLink(node) ||
			// Catch-all for everything else.
			(node.nodeName === 'META' &&
				// (Start|End)Tag metas clone data-parsoid from the tokens
				// they're shadowing, which trips up on the stx check.
				// TODO: Maybe that data should be nested in a property?
				(DOMUtils.matchTypeOf(node, /^mw:(StartTag|EndTag)$/) !== null ||
				DOMDataUtils.getDataParsoid(node).stx !== 'html')) ||
			this.isFallbackIdSpan(node);
	}

	/**
	 * Is node nested inside a table tag that uses HTML instead of native
	 * wikitext?
	 * @param {Node} node
	 * @return {boolean}
	 */
	static inHTMLTableTag(node) {
		var p = node.parentNode;
		while (DOMUtils.isTableTag(p)) {
			if (this.isLiteralHTMLNode(p)) {
				return true;
			} else if (p.nodeName === 'TABLE') {
				// Don't cross <table> boundaries
				return false;
			}
			p = p.parentNode;
		}

		return false;
	}

	static FIRST_ENCAP_REGEXP() { return /(?:^|\s)(mw:(?:Transclusion|Param|LanguageVariant|Extension(\/[^\s]+)))(?=$|\s)/; }

	/**
	 * Is node the first wrapper element of encapsulated content?
	 */
	static isFirstEncapsulationWrapperNode(node) {
		return DOMUtils.matchTypeOf(node, this.FIRST_ENCAP_REGEXP()) !== null;
	}

	/**
	 * Is node an encapsulation wrapper elt?
	 *
	 * All root-level nodes of generated content are considered
	 * encapsulation wrappers and share an about-id.
	 */
	static isEncapsulationWrapper(node) {
		// True if it has an encapsulation type or while walking backwards
		// over elts with identical about ids, we run into a node with an
		// encapsulation type.
		if (!DOMUtils.isElt(node)) {
			return false;
		}

		return this.findFirstEncapsulationWrapperNode(node) !== null;
	}

	static isDOMFragmentWrapper(node) {
		return DOMUtils.isElt(node) &&
			TokenUtils.isDOMFragmentType(node.getAttribute('typeof') || '');
	}

	static isSealedFragmentOfType(node, type) {
		return DOMUtils.hasTypeOf(node, 'mw:DOMFragment/sealed/' + type);
	}

	static isParsoidSectionTag(node) {
		return node.nodeName === 'SECTION' &&
			node.hasAttribute('data-mw-section-id');
	}

	/**
	 * Is the node from extension content?
	 * @param {Node} node
	 * @param {string} extType
	 * @return {boolean}
	 */
	static fromExtensionContent(node, extType) {
		var parentNode = node.parentNode;
		while (parentNode && !DOMUtils.atTheTop(parentNode)) {
			if (DOMUtils.hasTypeOf(parentNode, 'mw:Extension/' + extType)) {
				return true;
			}
			parentNode = parentNode.parentNode;
		}
		return false;
	}

	/**
	 * Compute, when possible, the wikitext source for a node in
	 * an frame f. Returns null if the source cannot be
	 * extracted.
	 * @param {Frame} frame
	 * @param {Node} node
	 */
	static getWTSource(frame, node) {
		var data = DOMDataUtils.getDataParsoid(node);
		var dsr = (undefined !== data) ? data.dsr : null;
		return dsr && Util.isValidDSR(dsr) ?
			frame.srcText.substring(dsr[0], dsr[1]) : null;
	}

	/**
	 * Gets all siblings that follow 'node' that have an 'about' as
	 * their about id.
	 *
	 * This is used to fetch transclusion/extension content by using
	 * the about-id as the key.  This works because
	 * transclusion/extension content is a forest of dom-trees formed
	 * by adjacent dom-nodes.  This is the contract that template
	 * encapsulation, dom-reuse, and VE code all have to abide by.
	 *
	 * The only exception to this adjacency rule is IEW nodes in
	 * fosterable positions (in tables) which are not span-wrapped to
	 * prevent them from getting fostered out.
	 */
	static getAboutSiblings(node, about) {
		var nodes = [node];

		if (!about) {
			return nodes;
		}

		node = node.nextSibling;
		while (node && (
			DOMUtils.isElt(node) && node.getAttribute('about') === about ||
				DOMUtils.isFosterablePosition(node) && !DOMUtils.isElt(node) && DOMUtils.isIEW(node)
		)) {
			nodes.push(node);
			node = node.nextSibling;
		}

		// Remove already consumed trailing IEW, if any
		while (nodes.length && DOMUtils.isIEW(lastItem(nodes))) {
			nodes.pop();
		}

		return nodes;
	}

	/**
	 * This function is only intended to be used on encapsulated nodes
	 * (Template/Extension/Param content).
	 *
	 * Given a 'node' that has an about-id, it is assumed that it is generated
	 * by templates or extensions.  This function skips over all
	 * following content nodes and returns the first non-template node
	 * that follows it.
	 */
	static skipOverEncapsulatedContent(node) {
		if (node.hasAttribute('about')) {
			var about = node.getAttribute('about');
			return lastItem(this.getAboutSiblings(node, about)).nextSibling;
		} else {
			return node.nextSibling;
		}
	}

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
	static encodeComment(comment) {
		// Undo wikitext escaping to obtain "true value" of comment.
		var trueValue = comment
			.replace(/--&(amp;)*gt;/g, Util.decodeWtEntities);
		// Now encode '-', '>' and '&' in the "true value" as HTML entities,
		// so that they can be safely embedded in an HTML comment.
		// This part doesn't have to map strings 1-to-1.
		return trueValue
			.replace(/[->&]/g, Util.entityEncodeAll);
	}

	/**
	 * Map an HTML DOM-escaped comment to a wikitext-escaped comment.
	 * @param {string} comment DOM-escaped comment.
	 * @return {string} Wikitext-escaped comment.
	 */
	static decodeComment(comment) {
		// Undo HTML entity escaping to obtain "true value" of comment.
		var trueValue = Util.decodeWtEntities(comment);
		// ok, now encode this "true value" of the comment in such a way
		// that the string "-->" never shows up.  (See above.)
		return trueValue
			.replace(/--(&(amp;)*gt;|>)/g, function(s) {
				return s === '-->' ? '--&gt;' : '--&amp;' + s.slice(3);
			});
	}

	/**
	 * Utility function: we often need to know the wikitext DSR length for
	 * an HTML DOM comment value.
	 * @param {Node} node A comment node containing a DOM-escaped comment.
	 * @return {number} The wikitext length necessary to encode this comment,
	 *   including 7 characters for the `<!--` and `-->` delimiters.
	 */
	static decodedCommentLength(node) {
		console.assert(DOMUtils.isComment(node));
		// Add 7 for the "<!--" and "-->" delimiters in wikitext.
		return this.decodeComment(node.data).length + 7;
	}

	/**
	 * Escape `<nowiki>` tags.
	 *
	 * @param {string} text
	 * @return {string}
	 */
	static escapeNowikiTags(text) {
		return text.replace(/<(\/?nowiki\s*\/?\s*)>/gi, '&lt;$1&gt;');
	}

	/**
	 * Conditional encoding is because, while treebuilding, the value goes
	 * directly from token to dom node without the comment itself being
	 * stringified and parsed where the comment encoding would be necessary.
	 */
	static fosterCommentData(typeOf, attrs, encode) {
		let str = JSON.stringify({
			'-type': typeOf,
			attrs,
		});
		if (encode) { str = WTUtils.encodeComment(str); }
		return str;
	}

	static reinsertFosterableContent(env, node, decode) {
		if (DOMUtils.isComment(node) && /^\{[^]+\}$/.test(node.data)) {
			decode = false;
			// Convert serialized meta tags back from comments.
			// We use this trick because comments won't be fostered,
			// providing more accurate information about where tags are expected
			// to be found.
			var data, type;
			try {
				data = JSON.parse(decode ? WTUtils.decodeComment(node.data) : node.data);
				type = data["-type"];
			} catch (e) {
				// not a valid json attribute, do nothing
				return null;
			}
			if (/^mw:/.test(type)) {
				var meta = node.ownerDocument.createElement("meta");
				data.attrs.forEach(function(attr) {
					try {
						meta.setAttribute(...attr);
					} catch (e) {
						env.log("warn", "prepareDOM: Dropped invalid attribute", JSON.stringify(attr));
					}
				});
				node.parentNode.replaceChild(meta, node);
				return meta;
			}
		}
		return null;
	}

	static getNativeExt(env, node) {
		const prefixLen = "mw:Extension/".length;
		const match = DOMUtils.matchTypeOf(node, /^mw:Extension\/(.+?)$/);
		return match && env.conf.wiki.extConfig.tags.get(match.slice(prefixLen));
	}
}

if (typeof module === "object") {
	module.exports.WTUtils = WTUtils;
}
