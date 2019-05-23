/**
 * DOM pass that walks the DOM tree, detects specific wikitext patterns,
 * and emits them as linter events via the lint/* logger type.
 * @module
 */

'use strict';

const { WikitextConstants: Consts } = require('../../../config/WikitextConstants.js');
const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { JSUtils } = require('../../../utils/jsutils.js');
const { Util } = require('../../../utils/Util.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

class Linter {
	constructor() {
		this.tagsWithChangedMisnestingBehavior = null;
		this.obsoleteTagsRE = null;
	}

	/* ------------------------------------------------------------------------------
	 * We are trying to find HTML5 tags that have different behavior compared to HTML4
	 * in some misnesting scenarios around wikitext paragraphs.
	 *
	 * Ex: Input: <p><small>a</p><p>b</small></p>
	 *     Tidy  output: <p><small>a</small></p><p><small>b</small></p>
	 *     HTML5 output: <p><small>a</small></p><p><small>b</small></p>
	 *
	 * So, all good here.
	 * But, see how output changes when we use <span> instead
	 *
	 * Ex: Input: <p><span>a</p><p>b</span></p>
	 *     Tidy  output: <p><span>a</span></p><p><span>b</span></p>
	 *     HTML5 output: <p><span>a</span></p><p>b</p>
	 *
	 * The source wikitext is "<span>a\n\nb</span>". The difference persists even
	 * when you have "<span>a\n\n<div>b</div>" or "<span>a\n\n{|\n|x\n|}\nbar".
	 *
	 * This is because Tidy seems to be doing the equivalent of HTM5-treebuilder's
	 * active formatting element reconstruction step on all *inline* elements.
	 * However, HTML5 parsers only do that on formatting elements. So, we need
	 * to compute which HTML5 tags are subject to this differential behavior.
	 *
	 * We compute that by excluding the following tags from the list of all HTML5 tags
	 * - If our sanitizer doesn't whitelist them, they will be escaped => ignore them
	 * - HTML4 block tags are excluded (obviously)
	 * - Void tags don't matter since they cannot wrap anything (obviously)
	 * - Active formatting elements have special handling in the HTML5 tree building
	 *   algorithm where they are reconstructed to wrap all originally intended content.
	 *   (ex: <small> above)
	 *
	 * Here is the list of 22 HTML5 tags that are affected:
	 *    ABBR, BDI, BDO, CITE, DATA, DEL, DFN, INS, KBD, MARK,
	 *    Q, RB, RP, RT, RTC, RUBY, SAMP, SPAN, SUB, SUP, TIME, VAR
	 *
	 * https://phabricator.wikimedia.org/T176363#3628173 verifies that this list of
	 * tags all demonstrate this behavior.
	 * ------------------------------------------------------------------------------ */
	getTagsWithChangedMisnestingBehavior() {
		if (!this.tagsWithChangedMisnestingBehavior) {
			this.tagsWithChangedMisnestingBehavior = new Set();
			Consts.HTML.HTML5Tags.forEach((t) => {
				if (Consts.Sanitizer.TagWhiteList.has(t) &&
					!Consts.HTML.HTML4BlockTags.has(t) &&
					!Consts.HTML.FormattingTags.has(t) &&
					!Consts.HTML.VoidTags.has(t)
				) {
					this.tagsWithChangedMisnestingBehavior.add(t);
				}
			});
		}

		return this.tagsWithChangedMisnestingBehavior;
	}

	leftMostDescendent(node, match) {
		if (!DOMUtils.isElt(node)) {
			return null;
		}

		if (DOMUtils.isMarkerMeta(node, 'mw:Placeholder/StrippedTag')) {
			return DOMDataUtils.getDataParsoid(node).name === match.nodeName ? node : null;
		}

		if (node.nodeName === match.nodeName) {
			var dp = DOMDataUtils.getDataParsoid(node);
			if (DOMDataUtils.getDataParsoid(match).stx === dp.stx && dp.autoInsertedStart) {
				if (dp.autoInsertedEnd) {
					return this.getNextMatchingNode(node, match);
				} else {
					return node;
				}
			}
		}

		return this.leftMostDescendent(node.firstChild, match);
	}

	/**
	 * Get the next matching node that is considered adjacent
	 * to this node. If no next sibling, walk up and down the tree
	 * as necessary to find it.
	 * @private
	 */
	getNextMatchingNode(node, match) {
		if (DOMUtils.isBody(node)) {
			return null;
		}

		if (node.nextSibling) {
			return this.leftMostDescendent(DOMUtils.nextNonSepSibling(node), match);
		}

		return this.getNextMatchingNode(node.parentNode, match);
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {Object} tplInfo Template info.
	 * @return {string}
	 * @private
	 */
	findEnclosingTemplateName(env, tplInfo) {
		if (!tplInfo) {
			return undefined;
		}

		if (!DOMUtils.hasTypeOf(tplInfo.first, 'mw:Transclusion')) {
			return undefined;
		}
		var dmw = DOMDataUtils.getDataMw(tplInfo.first);
		if (dmw.parts && dmw.parts.length === 1) {
			var p0 = dmw.parts[0];
			var name;
			if (p0.template && p0.template.target.href) {  // Could be "function"
				name = p0.template.target.href.replace(/^\.\//, '');
			} else {
				name = (p0.template || p0.templatearg).target.wt.trim();
			}
			return { name: name };
		} else {
			return { multiPartTemplateBlock: true };
		}
	}

	findLintDSR(tplLintInfo, tplInfo, nodeDSR, updateNodeDSR) {
		if (tplLintInfo || (tplInfo && !Util.isValidDSR(nodeDSR))) {
			return DOMDataUtils.getDataParsoid(tplInfo.first).dsr;
		} else {
			return updateNodeDSR ? updateNodeDSR(nodeDSR) : nodeDSR;
		}
	}

	hasIdenticalNestedTag(node, name) {
		var c = node.firstChild;
		while (c) {
			if (c.nodeName === name && !DOMDataUtils.getDataParsoid(c).autoInsertedInd) {
				return true;
			}

			if (DOMUtils.isElt(c)) {
				return this.hasIdenticalNestedTag(c, name);
			}

			c = c.nextSibling;
		}

		return false;
	}

	hasMisnestableContent(node, name) {
		// For A, TD, TH, H* tags, Tidy doesn't seem topropagate
		// the unclosed tag outside these tags.
		// No need to check for tr/table since content cannot show up there
		if (DOMUtils.isBody(node) || /^(A|TD|TH|H\d)$/.test(node.nodeName)) {
			return false;
		}

		var next = DOMUtils.nextNonSepSibling(node);
		if (!next) {
			return this.hasMisnestableContent(node.parentNode, name);
		}

		var contentNode;
		if (next.nodeName === 'P' && !WTUtils.isLiteralHTMLNode(next)) {
			contentNode = DOMUtils.firstNonSepChild(next);
		} else {
			contentNode = next;
		}

		return contentNode &&
			// If the first "content" node we find is a matching
			// stripped tag, we have nothing that can get misnested
			!(DOMUtils.isMarkerMeta(contentNode, 'mw:Placeholder/StrippedTag') &&
			DOMDataUtils.getDataParsoid(contentNode).name === name);
	}

	endTagOptional(node) {
		// See https://www.w3.org/TR/html5/syntax.html#optional-tags
		//
		// End tags for tr/td/th/li are entirely optional since they
		// require a parent container and can only be followed by like
		// kind.
		//
		// Caveat: <li>foo</li><ol>..</ol> and <li>foo<ol>..</ol>
		// generate different DOM trees, so explicit </li> tag
		// is required to specify which of the two was intended.
		//
		// With that one caveat around nesting, the parse with/without
		// the end tag is identical. For now, ignoring that caveat
		// since they aren't like to show up in our corpus much.
		//
		// For the other tags in that w3c spec section, I haven't reasoned
		// through when exactly they are optional. Not handling that complexity
		// for now since those are likely uncommon use cases in our corpus.
		return /^(TR|TD|TH|LI)$/.test(node.nodeName);
	}

	getHeadingAncestor(node) {
		while (node && !/^H[1-6]$/.test(node.nodeName)) {
			node = node.parentNode;
		}
		return node;
	}

	/*
	 * For formatting tags, Tidy seems to be doing this "smart" fixup of
	 * unclosed tags by looking for matching unclosed pairs of identical tags
	 * and if the content ends in non-whitespace text, it treats the second
	 * unclosed opening tag as a closing tag. But, a HTML5 parser won't do this.
	 * So, detect this pattern and flag for linter fixup.
	 */
	matchedOpenTagPairExists(c, dp) {
		var lc = c.lastChild;
		if (!lc || lc.nodeName !== c.nodeName) {
			return false;
		}

		var lcDP = DOMDataUtils.getDataParsoid(lc);
		if (!lcDP.autoInsertedEnd || lcDP.stx !== dp.stx) {
			return false;
		}

		var prev = lc.previousSibling;
		if (DOMUtils.isText(prev) && !/\s$/.test(prev.data)) {
			return true;
		}

		return false;
	}

	/*
	 * Log Treebuilder fixups marked by dom.markTreeBuilderFixup.js
	 * It handles the following scenarios:
	 *
	 * 1. Unclosed end tags
	 * 2. Unclosed start tags
	 * 3. Stripped tags
	 *
	 * In addition, we have specialized categories for some patterns
	 * where we encounter unclosed end tags.
	 *
	 * 4. misnested-tag
	 * 5. html5-misnesting
	 * 6. multiple-unclosed-formatting-tags
	 * 7. unclosed-quotes-in-heading
	 */
	logTreeBuilderFixup(env, c, dp, tplInfo) {
		// This might have been processed as part of
		// misnested-tag category identification.
		if ((dp.tmp || {}).linted) {
			return;
		}

		var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
		// During DSR computation, stripped meta tags
		// surrender their width to its previous sibling.
		// We record the original DSR in the tmp attribute
		// for that reason.
		var dsr = this.findLintDSR(templateInfo, tplInfo, dp.tmp.origDSR || dp.dsr);
		var lintObj;
		if (DOMUtils.isMarkerMeta(c, 'mw:Placeholder/StrippedTag')) {
			lintObj = {
				dsr: dsr,
				templateInfo: templateInfo,
				params: { name: dp.name.toLowerCase() }
			};
			env.log('lint/stripped-tag', lintObj);
		}

		// Dont bother linting for auto-inserted start/end or self-closing-tag if:
		// 1. c is a void element
		//    Void elements won't have auto-inserted start/end tags
		//    and self-closing versions are valid for them.
		//
		// 2. c is tbody (FIXME: don't remember why we have this exception)
		//
		// 3. c is not an HTML element (unless they are i/b quotes)
		//
		// 4. c doesn't have DSR info and doesn't come from a template either
		var cNodeName = c.nodeName.toLowerCase();
		var ancestor;
		if (!Util.isVoidElement(cNodeName) &&
			cNodeName !== 'tbody' &&
			(WTUtils.hasLiteralHTMLMarker(dp) || DOMUtils.isQuoteElt(c)) &&
			(tplInfo || dsr)) {

			if (dp.selfClose && cNodeName !== 'meta') {
				lintObj = {
					dsr: dsr,
					templateInfo: templateInfo,
					params: { name: cNodeName },
				};
				env.log('lint/self-closed-tag', lintObj);
				// The other checks won't pass - no need to test them.
				return;
			}

			if (dp.autoInsertedEnd === true && (tplInfo || dsr[2] > 0)) {
				lintObj = {
					dsr: dsr,
					templateInfo: templateInfo,
					params: { name: cNodeName },
				};

				// FIXME: This literal html marker check is strictly not required
				// (a) we've already checked that above and know that isQuoteElt is
				//     not one of our tags.
				// (b) none of the tags in the list have native wikitext syntax =>
				//     they will show up as literal html tags.
				// But, in the interest of long-term maintenance in the face of
				// changes (to wikitext or html specs), let us make it explicit.
				if (WTUtils.hasLiteralHTMLMarker(dp) &&
					this.getTagsWithChangedMisnestingBehavior().has(c.nodeName) &&
					this.hasMisnestableContent(c, c.nodeName) &&
					// Tidy WTF moment here!
					// I don't know why Tidy does something very different
					// when there is an identical nested tag here.
					//
					// <p><span id='1'>a<span>X</span></p><p>b</span></p>
					//      vs.
					// <p><span id='1'>a</p><p>b</span></p>  OR
					// <p><span id='1'>a<del>X</del></p><p>b</span></p>
					//
					// For the first snippet, Tidy only wraps "a" with the id='1' span
					// For the second and third snippets, Tidy wraps "b" with the id='1' span as well.
					//
					// For the corresponding wikitext that generates the above token stream,
					// Parsoid (and Remex) won't wrap 'b' with the id=1' span at all.
					!this.hasIdenticalNestedTag(c, c.nodeName)
				) {
					env.log('lint/html5-misnesting', lintObj);
				} else if (!WTUtils.hasLiteralHTMLMarker(dp) && DOMUtils.isQuoteElt(c) && (ancestor = this.getHeadingAncestor(c.parentNode))) {
					lintObj.params.ancestorName = ancestor.nodeName.toLowerCase();
					env.log('lint/unclosed-quotes-in-heading', lintObj);
				} else {
					var adjNode = this.getNextMatchingNode(c, c);
					if (adjNode) {
						var adjDp = DOMDataUtils.getDataParsoid(adjNode);
						if (!adjDp.tmp) {
							adjDp.tmp = {};
						}
						adjDp.tmp.linted = true;
						env.log('lint/misnested-tag', lintObj);
					} else if (!this.endTagOptional(c) && !dp.autoInsertedStart) {
						lintObj.params.inTable = DOMUtils.hasAncestorOfName(c, 'TABLE');
						env.log('lint/missing-end-tag', lintObj);
						if (Consts.HTML.FormattingTags.has(c.nodeName) && this.matchedOpenTagPairExists(c, dp)) {
							env.log('lint/multiple-unclosed-formatting-tags', lintObj);
						}
					}
				}
			}
		}
	}

	/*
	 * Log fostered content marked by markFosteredContent.js
	 * This will log cases like:
	 *
	 * {|
	 * foo
	 * |-
	 * | bar
	 * |}
	 *
	 * Here 'foo' gets fostered out.
	 */
	logFosteredContent(env, node, dp, tplInfo) {
		var maybeTable = node.nextSibling;
		var clear = false;

		while (maybeTable && maybeTable.nodeName !== 'TABLE') {
			if (tplInfo && maybeTable === tplInfo.last) {
				clear = true;
			}
			maybeTable = maybeTable.nextSibling;
		}

		if (!maybeTable) {
			return null;
		} else if (clear && tplInfo) {
			tplInfo.clear = true;
		}

		// In pathological cases, we might walk past fostered nodes
		// that carry templating information. This then triggers
		// other errors downstream. So, walk back to that first node
		// and ignore this fostered content error. The new node will
		// trigger fostered content lint error.
		if (!tplInfo && WTUtils.hasParsoidAboutId(maybeTable) &&
			!WTUtils.isFirstEncapsulationWrapperNode(maybeTable)
		) {
			var tplNode = WTUtils.findFirstEncapsulationWrapperNode(maybeTable);
			if (tplNode !== null) {
				return tplNode;
			}

			// We got misled by the about id on 'maybeTable'.
			// Let us carry on with regularly scheduled programming.
		}

		var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
		var lintObj = {
			dsr: this.findLintDSR(templateInfo, tplInfo, DOMDataUtils.getDataParsoid(maybeTable).dsr),
			templateInfo: templateInfo
		};
		env.log('lint/fostered', lintObj);

		return maybeTable;
	}

	logObsoleteHTMLTags(env, c, dp, tplInfo) {
		if (!this.obsoleteTagsRE) {
			var elts = [];
			Consts.HTML.OlderHTMLTags.forEach((tag) =>  {
				// Looks like all existing editors let editors add the <big> tag.
				// VE has a button to add <big>, it seems so does the WikiEditor
				// and JS wikitext editor. So, don't flag BIG as an obsolete tag.
				if (tag !== 'BIG') {
					elts.push(tag);
				}
			});
			this.obsoleteTagsRE = new RegExp('^(' + elts.join('|') + ')$');
		}

		var templateInfo;
		if (!(dp.autoInsertedStart && dp.autoInsertedEnd) && this.obsoleteTagsRE.test(c.nodeName)) {
			templateInfo = this.findEnclosingTemplateName(env, tplInfo);
			var lintObj = {
				dsr: this.findLintDSR(templateInfo, tplInfo, dp.dsr),
				templateInfo: templateInfo,
				params: { name: c.nodeName.toLowerCase() },
			};
			env.log('lint/obsolete-tag', lintObj);
		}

		if (c.nodeName === 'FONT' && c.hasAttribute('color')) {
			/* ----------------------------------------------------------
			 * Tidy migrates <font> into the link in these cases
			 *     <font>[[Foo]]</font>
			 *     <font>[[Foo]]l</font> (link-trail)
			 *     <font><!--boo-->[[Foo]]</font>
			 *     <font>__NOTOC__[[Foo]]</font>
			 *     <font>[[Category:Foo]][[Foo]]</font>
			 *     <font>{{1x|[[Foo]]}}</font>
			 *
			 * Tidy does not migrate <font> into the link in these cases
			 *     <font> [[Foo]]</font>
			 *     <font>[[Foo]] </font>
			 *     <font>[[Foo]]L</font> (not a link-trail)
			 *     <font>[[Foo]][[Bar]]</font>
			 *     <font>[[Foo]][[Bar]]</font>
			 *
			 * <font> is special.
			 * This behavior is not seen with other formatting tags.
			 *
			 * Remex/parsoid won't do any of this.
			 * This difference in behavior only matters when the font tag
			 * specifies a link colour because the link no longer renders
			 * as blue/red but in the font-specified colour.
			 * ---------------------------------------------------------- */
			var tidyFontBug = c.firstChild !== null;
			var haveLink = false;
			for (var n = c.firstChild; n; n = n.nextSibling) {
				if (n.nodeName !== 'A' &&
					!WTUtils.isRenderingTransparentNode(n) &&
					!WTUtils.isTplMarkerMeta(n)
				) {
					tidyFontBug = false;
					break;
				}

				if (n.nodeName === 'A' || n.nodeName === 'FIGURE') {
					if (!haveLink) {
						haveLink = true;
					} else {
						tidyFontBug = false;
						break;
					}
				}
			}

			if (tidyFontBug) {
				templateInfo = this.findEnclosingTemplateName(env, tplInfo);
				env.log('lint/tidy-font-bug', {
					dsr: this.findLintDSR(templateInfo, tplInfo, dp.dsr),
					templateInfo: templateInfo,
					params: { name: 'font' },
				});
			}
		}
	}

	/*
	 * Log bogus (=unrecognized) media options
	 * See - https://www.mediawiki.org/wiki/Help:Images#Syntax
	 */
	logBogusMediaOptions(env, c, dp, tplInfo) {
		if (WTUtils.isGeneratedFigure(c) && dp.optList) {
			var items = [];
			dp.optList.forEach((item) => {
				if (item.ck === "bogus") {
					items.push(item.ak);
				}
			});
			if (items.length) {
				var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
				env.log('lint/bogus-image-options', {
					dsr: this.findLintDSR(templateInfo, tplInfo, dp.dsr),
					templateInfo: templateInfo,
					params: { items: items },
				});
			}
		}
	}

	/*
	 * In this example below, the second table is in a fosterable position
	 * (inside a <tr>). The tree builder closes the first table at that point
	 * and starts a new table there. We are detecting this pattern because
	 * Tidy does something very different here. It strips the inner table
	 * and retains the outer table. So, for preserving rendering of pages
	 * that are tailored for Tidy, editors have to fix up this wikitext
	 * to strip the inner table (to mimic what Tidy does).
	 *
	 *   {| style='border:1px solid red;'
	 *   |a
	 *   |-
	 *   {| style='border:1px solid blue;'
	 *   |b
	 *   |c
	 *   |}
	 *   |}
	*/
	logDeletableTables(env, c, dp, tplInfo) {
		if (c.nodeName === 'TABLE') {
			var prev = DOMUtils.previousNonSepSibling(c);
			if (prev && prev.nodeName === 'TABLE' && DOMDataUtils.getDataParsoid(prev).autoInsertedEnd) {
				var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
				var dsr = this.findLintDSR(templateInfo, tplInfo, dp.dsr, (nodeDSR) => {
					// Identify the dsr-span of the opening tag
					// of the table that needs to be deleted
					var x = Util.clone(nodeDSR);
					if (x[2]) {
						x[1] = x[0] + x[2];
						x[2] = 0;
						x[3] = 0;
					}
					return x;
				});
				var lintObj = {
					dsr: dsr,
					templateInfo: templateInfo,
					params: { name: 'table' },
				};
				env.log('lint/deletable-table-tag', lintObj);
			}
		}
	}

	findMatchingChild(node, filter) {
		var c = node.firstChild;
		while (c && !filter(c)) {
			c = c.nextSibling;
		}

		return c;
	}

	hasNoWrapCSS(node) {
		// In the general case, this CSS can come from a class,
		// or from a <style> tag or a stylesheet or even from JS code.
		// But, for now, we are restricting this inspection to inline CSS
		// since the intent is to aid editors in fixing patterns that
		// can be automatically detected.
		//
		// Special case for enwiki that has Template:nowrap which
		// assigns class='nowrap' with CSS white-space:nowrap in
		// MediaWiki:Common.css
		return /nowrap/.test(node.getAttribute('style') || '') ||
			/(^|\s)nowrap($|\s)/.test(node.getAttribute('class') || '');
	}

	logBadPWrapping(env, node, dp, tplInfo) {
		if (!DOMUtils.isBlockNode(node) && DOMUtils.isBlockNode(node.parentNode) && this.hasNoWrapCSS(node)) {
			var p = this.findMatchingChild(node, e => e.nodeName === 'P');
			if (p) {
				var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
				var lintObj = {
					dsr: this.findLintDSR(templateInfo, tplInfo, dp.dsr),
					templateInfo: templateInfo,
					params: {
						root: node.parentNode.nodeName.toLowerCase(),
						child: node.nodeName.toLowerCase()
					},
				};
				env.log('lint/pwrap-bug-workaround', lintObj);
			}
		}
	}

	logTidyDivSpanFlip(env, node, dp, tplInfo) {
		if (node.nodeName !== 'SPAN') {
			return;
		}

		const fc = DOMUtils.firstNonSepChild(node);
		if (!fc || fc.nodeName !== 'DIV') {
			return;
		}

		// No style/class attributes -- so, this won't affect rendering
		if (!node.hasAttribute('class') && !node.hasAttribute('style') &&
			!fc.hasAttribute('class') && !fc.hasAttribute('style')
		) {
			return;
		}

		var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
		var lintObj = {
			dsr: this.findLintDSR(templateInfo, tplInfo, dp.dsr),
			templateInfo: templateInfo,
			params: { subtype: 'div-span-flip' },
		};
		env.log('lint/misc-tidy-replacement-issues', lintObj);
	}

	logTidyWhitespaceBug(env, node, dp, tplInfo) {
		// We handle a run of nodes in one shot.
		// No need to reprocess repeatedly.
		if (dp && dp.tmp.processedTidyWSBug) {
			return;
		}

		// Find the longest run of nodes that are affected by white-space:nowrap CSS
		// in a way that leads to unsightly rendering in HTML5 compliant browsers.
		//
		// Check if Tidy does buggy whitespace hoisting there to provide the browser
		// opportunities to split the content in short segments.
		//
		// If so, editors would need to edit this run of nodes to introduce
		// whitespace breaks as necessary so that HTML5 browsers get that
		// same opportunity when Tidy is removed.
		var s, ws;
		var nowrapNodes = [];
		var startNode = node;
		var haveTidyBug = false;
		var runLength = 0;

		// <br>, <wbr>, <hr> break a line
		while (node && !DOMUtils.isBlockNode(node) && !/^(H|B|WB)R$/.test(node.nodeName)) {
			if (DOMUtils.isText(node) || !this.hasNoWrapCSS(node)) {
				// No CSS property that affects whitespace.
				s = node.textContent;
				ws = s.match(/\s/);
				if (ws) {
					runLength += ws.index;
					nowrapNodes.push({ node: node, tidybug: false, hasLeadingWS: /^\s/.test(s) });
					break;
				} else {
					nowrapNodes.push({ node: node, tidybug: false });
					runLength += s.length;
				}
			} else {
				// Find last non-comment child of node
				var last = node.lastChild;
				while (last && DOMUtils.isComment(last)) {
					last = last.previousSibling;
				}

				var bug = false; // Set this explicitly always (because vars aren't block-scoped)
				if (last && DOMUtils.isText(last) && /\s$/.test(last.data)) {
					// In this scenario, when Tidy hoists the whitespace to
					// after the node, that whitespace is not subject to the
					// nowrap CSS => browsers can break content there.
					//
					// But, non-Tidy libraries won't hoist the whitespace.
					// So, browsers don't have a place to break content.
					bug = true;
					haveTidyBug = true;
				}

				nowrapNodes.push({ node: node, tidybug: bug });
				runLength += node.textContent.length;
			}

			// Don't cross template boundaries at the top-level
			if (tplInfo && tplInfo.last === node) {
				// Exiting a top-level template
				break;
			} else if (!tplInfo && WTUtils.findFirstEncapsulationWrapperNode(node)) {
				// Entering a top-level template
				break;
			}

			// Move to the next non-comment sibling
			node = node.nextSibling;
			while (node && DOMUtils.isComment(node)) {
				node = node.nextSibling;
			}
		}

		var markProcessedNodes = function() { // Helper
			nowrapNodes.forEach((o) => {
				if (DOMUtils.isElt(o.node)) {
					DOMDataUtils.getDataParsoid(o.node).tmp.processedTidyWSBug = true;
				}
			});
		};

		if (!haveTidyBug) {
			// Mark processed nodes and bail
			markProcessedNodes();
			return;
		}

		// Find run before startNode that doesn't have a whitespace break
		var prev = startNode.previousSibling;
		while (prev && !DOMUtils.isBlockNode(prev)) {
			if (!DOMUtils.isComment(prev)) {
				s = prev.textContent;
				// Find the last \s in the string
				ws = s.match(/\s[^\s]*$/);
				if (ws) {
					runLength += (s.length - ws.index - 1); // -1 for the \s
					break;
				} else {
					runLength += s.length;
				}
			}
			prev = prev.previousSibling;
		}

		if (runLength < env.conf.parsoid.linter.tidyWhitespaceBugMaxLength) {
			// Mark processed nodes and bail
			markProcessedNodes();
			return;
		}

		// For every node where Tidy hoists whitespace,
		// emit an event to flag a whitespace fixup opportunity.
		var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
		var n = nowrapNodes.length - 1;
		nowrapNodes.forEach((o, i) => {
			if (o.tidybug && i < n && !nowrapNodes[i + 1].hasLeadingWS) {
				var lintObj = {
					dsr: this.findLintDSR(templateInfo, tplInfo, DOMDataUtils.getDataParsoid(o.node).dsr),
					templateInfo: templateInfo,
					params: {
						node: o.node.nodeName.toLowerCase(),
						sibling: o.node.nextSibling.nodeName.toLowerCase(),
					},
				};

				env.log('lint/tidy-whitespace-bug', lintObj);
			}
		});

		markProcessedNodes();
	}

	detectMultipleUnclosedFormattingTags(lints) {
		// Detect multiple-unclosed-formatting-tags errors.
		//
		// Since unclosed <small> and <big> tags accumulate their effects
		// in HTML5 parsers (unlike in Tidy where it seems to suppress
		// multiple unclosed elements of the same name), such pages will
		// break pretty spectacularly with Remex.
		//
		// Ex: https://it.wikipedia.org/wiki/Hubert_H._Humphrey_Metrodome?oldid=93017491#Note
		var firstUnclosedTag = {
			small: null,
			big: null,
		};
		var multiUnclosedTagName = null;
		lints.find((item) => {
			// Unclosed tags in tables don't leak out of the table
			if (item.type === 'missing-end-tag' && !item.params.inTable) {
				if (item.params.name === 'small' || item.params.name === 'big') {
					var tagName = item.params.name;
					if (!firstUnclosedTag[tagName]) {
						firstUnclosedTag[tagName] = item;
					} else {
						multiUnclosedTagName = tagName;
						return true;
					}
				}
			}
			return false;
		});

		if (multiUnclosedTagName) {
			var item = firstUnclosedTag[multiUnclosedTagName];
			lints.push({
				type: 'multiple-unclosed-formatting-tags',
				params: item.params,
				dsr: item.dsr,
				templateInfo: item.templateInfo,
			});
		}
	}

	postProcessLints(lints) {
		this.detectMultipleUnclosedFormattingTags(lints);
	}

	getWikitextListItemAncestor(node) {
		while (node && !DOMUtils.isListItem(node)) {
			node = node.parentNode;
		}
		return (node && !WTUtils.isLiteralHTMLNode(node) && !WTUtils.fromExtensionContent(node, 'references')) ? node : null;
	}

	logPHPParserBug(env, node, dp, tplInfo) {
		var li;
		if (!WTUtils.isLiteralHTMLNode(node) ||
			node.nodeName !== 'TABLE' ||
			!(li = this.getWikitextListItemAncestor(node)) ||
			!/\n/.test(node.outerHTML)
		) {
			return;
		}

		// We have an HTML table nested inside a list
		// that has a newline break in its outer HTML
		// => we are in trouble with the PHP Parser + Remex combo
		var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
		var lintObj = {
			dsr: this.findLintDSR(templateInfo, tplInfo, DOMDataUtils.getDataParsoid(node).dsr),
			templateInfo: templateInfo,
			params: {
				name: 'table',
				ancestorName: li.nodeName.toLowerCase(),
			}
		};
		env.log('lint/multiline-html-table-in-list', lintObj);
	}

	// HTML tags can be nested but this is not the case for <a> tags
	// which when nested outputs the <a> tags adjacent to each other
	// In the example below, [[Google]] is a wikilink that is nested
	// in the outer external link
	// [http://google.com This is [[Google]]'s search page]
	logWikilinksInExtlinks(env, c, dp, tplInfo) {
		const sibling = c.nextSibling;
		if (c.nodeName === 'A' && sibling !== null && sibling.nodeName === 'A' &&
			c.getAttribute('rel') === 'mw:ExtLink' && sibling.getAttribute('rel') === 'mw:WikiLink' &&
			DOMDataUtils.getDataParsoid(sibling).misnested === true
		) {
			var templateInfo = this.findEnclosingTemplateName(env, tplInfo);
			var lintObj = {
				dsr: this.findLintDSR(templateInfo, tplInfo, DOMDataUtils.getDataParsoid(c).dsr),
				templateInfo: templateInfo,
			};
			env.log('lint/wikilink-in-extlink', lintObj);
		}
	}

	logWikitextFixups(node, env, tplInfo) {
		var dp = DOMDataUtils.getDataParsoid(node);

		this.logTreeBuilderFixup(env, node, dp, tplInfo);
		this.logDeletableTables(env, node, dp, tplInfo); // For T161341
		this.logBadPWrapping(env, node, dp, tplInfo);    // For T161306
		this.logObsoleteHTMLTags(env, node, dp, tplInfo);
		this.logBogusMediaOptions(env, node, dp, tplInfo);
		this.logTidyWhitespaceBug(env, node, dp, tplInfo);
		this.logTidyDivSpanFlip(env, node, dp, tplInfo);

		// When an HTML table is nested inside a list and if any part of the table
		// is on a new line, the PHP parser misnests the list and the table.
		// Tidy fixes the misnesting one way (puts table inside/outside the list)
		// HTML5 parser fix it another way (list expands to rest of the page!)
		this.logPHPParserBug(env, node, dp, tplInfo);
		this.logWikilinksInExtlinks(env, node, dp, tplInfo);

		// Log fostered content, but skip rendering-transparent nodes
		if (dp.fostered && !WTUtils.isRenderingTransparentNode(node)) {
			return this.logFosteredContent(env, node, dp, tplInfo);
		} else {
			return null;
		}
	}

	findLints(root, env, tplInfo) {
		var node = root.firstChild;
		while (node !== null) {
			if (!DOMUtils.isElt(node)) {
				node = node.nextSibling;
				continue;
			}

			// !tplInfo check is to protect against templated content in
			// extensions which might in turn be nested in templated content.
			if (!tplInfo && WTUtils.isFirstEncapsulationWrapperNode(node)) {
				tplInfo = {
					first: node,
					last: JSUtils.lastItem(WTUtils.getAboutSiblings(node, node.getAttribute("about") || '')),
					dsr: DOMDataUtils.getDataParsoid(node).dsr,
					isTemplated: DOMUtils.hasTypeOf(node, 'mw:Transclusion'),
					clear: false,
				};
			}

			var nextNode;
			var nativeExt = WTUtils.getNativeExt(env, node);
			if (nativeExt && nativeExt.lintHandler) {
				// Let native extensions lint their content
				nextNode = nativeExt.lintHandler(node, env, tplInfo, (...args) => this.findLints(...args));
			} else { // Default node handler
				// Lint this node
				nextNode = this.logWikitextFixups(node, env, tplInfo);
				if (tplInfo && tplInfo.clear) {
					tplInfo = null;
				}

				// Lint subtree
				if (!nextNode) {
					this.findLints(node, env, tplInfo);
				}
			}

			if (tplInfo && tplInfo.last === node) {
				tplInfo = null;
			}

			node = nextNode || node.nextSibling;
		}
	}

	/**
	 */
	run(body, env, options) {
		// Skip linting if we cannot lint it
		if (!env.page.hasLintableContentModel()) {
			return;
		}

		this.findLints(body, env);
		this.postProcessLints(env.lintLogger.buffer);
	}
}

if (typeof module === "object") {
	module.exports.Linter = Linter;
}
