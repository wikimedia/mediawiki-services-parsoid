/*
 * DOM pass that walks the DOM tree, detects specific wikitext patterns,
 * and emits them as linter events via the lint/* logger type.
 */

'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var Util = require('../../../utils/Util.js').Util;
var JSUtils = require('../../../utils/jsutils.js').JSUtils;
var Consts = require('../../../config/WikitextConstants.js').WikitextConstants;

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
var tagsWithChangedMisnestingBehavior;
function getTagsWithChangedMisnestingBehavior() {
	if (!tagsWithChangedMisnestingBehavior) {
		tagsWithChangedMisnestingBehavior = new Set();
		Consts.HTML.HTML5Tags.forEach(function(t) {
			if (Consts.Sanitizer.TagWhiteList.has(t) &&
				!Consts.HTML.HTML4BlockTags.has(t) &&
				!Consts.HTML.FormattingTags.has(t) &&
				!Consts.HTML.VoidTags.has(t)
			) {
				tagsWithChangedMisnestingBehavior.add(t);
			}
		});
	}

	return tagsWithChangedMisnestingBehavior;
}

var getNextMatchingNode, leftMostDescendent;

leftMostDescendent = function(node, match) {
	if (!DU.isElt(node)) {
		return null;
	}

	if (DU.isMarkerMeta(node, 'mw:Placeholder/StrippedTag')) {
		return DU.getDataParsoid(node).name === match.nodeName ? node : null;
	}

	if (node.nodeName === match.nodeName) {
		var dp = DU.getDataParsoid(node);
		if (DU.getDataParsoid(match).stx === dp.stx && dp.autoInsertedStart) {
			if (dp.autoInsertedEnd) {
				return getNextMatchingNode(node, match);
			} else {
				return node;
			}
		}
	}

	return leftMostDescendent(node.firstChild, match);
};

// Get the next matching node that is considered adjacent
// to this node. If no next sibling, walk up and down the tree
// as necessary to find it.
getNextMatchingNode = function(node, match) {
	if (DU.isBody(node)) {
		return null;
	}

	if (node.nextSibling) {
		return leftMostDescendent(DU.nextNonSepSibling(node), match);
	}

	return getNextMatchingNode(node.parentNode, match);
};

/**
 * @method
 *
 * @param {Object} tplInfo Template info
 * @return {string}
 */
function findEnclosingTemplateName(env, tplInfo) {
	if (!tplInfo) {
		return undefined;
	}

	var typeOf = tplInfo.first.getAttribute('typeof');
	if (!/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
		return undefined;
	}
	var dmw = DU.getDataMw(tplInfo.first);
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

function findLintDSR(tplLintInfo, tplInfo, nodeDSR, updateNodeDSR) {
	if (tplLintInfo || (tplInfo && !Util.isValidDSR(nodeDSR))) {
		return tplInfo.dsr;
	} else {
		return updateNodeDSR ? updateNodeDSR(nodeDSR) : nodeDSR;
	}
}

function hasIdenticalNestedTag(node, name) {
	var c = node.firstChild;
	while (c) {
		if (c.nodeName === name && !DU.getDataParsoid(c).autoInsertedInd) {
			return true;
		}

		if (DU.isElt(c)) {
			return hasIdenticalNestedTag(c, name);
		}

		c = c.nextSibling;
	}

	return false;
}

function hasMisnestableContent(node, name) {
	// For A, TD, TH, H* tags, Tidy doesn't seem topropagate
	// the unclosed tag outside these tags.
	// No need to check for tr/table since content cannot show up there
	if (DU.isBody(node) || /^(A|TD|TH|H\d)$/.test(node.nodeName)) {
		return false;
	}

	var next = DU.nextNonSepSibling(node);
	if (!next) {
		return hasMisnestableContent(node.parentNode, name);
	}

	var contentNode;
	if (next.nodeName === 'P' && !DU.isLiteralHTMLNode(next)) {
		contentNode = DU.firstNonSepChildNode(next);
	} else {
		contentNode = next;
	}

	return contentNode &&
		// If the first "content" node we find is a matching
		// stripped tag, we have nothing that can get misnested
		!(DU.isMarkerMeta(contentNode, 'mw:Placeholder/StrippedTag') &&
		DU.getDataParsoid(contentNode).name === name);
}

function endTagOptional(node) {
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

function getHeadingAncestor(node) {
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
function matchedOpenTagPairExists(c, dp) {
	var lc = c.lastChild;
	if (!lc || lc.nodeName !== c.nodeName) {
		return false;
	}

	var lcDP = DU.getDataParsoid(lc);
	if (!lcDP.autoInsertedEnd || lcDP.stx !== dp.stx) {
		return false;
	}

	var prev = lc.previousSibling;
	if (DU.isText(prev) && !/\s$/.test(prev.data)) {
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
function logTreeBuilderFixup(env, c, dp, tplInfo) {
	// This might have been processed as part of
	// misnested-tag category identification.
	if ((dp.tmp || {}).linted) {
		return;
	}

	var templateInfo = findEnclosingTemplateName(env, tplInfo);
	// During DSR computation, stripped meta tags
	// surrender their width to its previous sibling.
	// We record the original DSR in the tmp attribute
	// for that reason.
	var dsr = findLintDSR(templateInfo, tplInfo, dp.tmp.origDSR || dp.dsr);
	var lintObj;
	if (DU.isMarkerMeta(c, 'mw:Placeholder/StrippedTag')) {
		lintObj = { dsr: dsr, templateInfo: templateInfo, params: { name: dp.name } };
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
		(DU.hasLiteralHTMLMarker(dp) || DU.isQuoteElt(c)) &&
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
			if (DU.hasLiteralHTMLMarker(dp) &&
				getTagsWithChangedMisnestingBehavior().has(c.nodeName) &&
				hasMisnestableContent(c, c.nodeName) &&
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
				!hasIdenticalNestedTag(c, c.nodeName)
			) {
				env.log('lint/html5-misnesting', lintObj);
			} else if (!DU.hasLiteralHTMLMarker(dp) && DU.isQuoteElt(c) && (ancestor = getHeadingAncestor(c.parentNode))) {
				lintObj.params.ancestorName = ancestor.nodeName.toLowerCase();
				env.log('lint/unclosed-quotes-in-heading', lintObj);
			} else {
				var adjNode = getNextMatchingNode(c, c);
				if (adjNode) {
					var adjDp = DU.getDataParsoid(adjNode);
					if (!adjDp.tmp) {
						adjDp.tmp = {};
					}
					adjDp.tmp.linted = true;
					env.log('lint/misnested-tag', lintObj);
				} else if (!endTagOptional(c) && !dp.autoInsertedStart) {
					lintObj.params.inTable = DU.hasAncestorOfName(c, 'TABLE');
					env.log('lint/missing-end-tag', lintObj);
					if (Consts.HTML.FormattingTags.has(c.nodeName) && matchedOpenTagPairExists(c, dp)) {
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
function logFosteredContent(env, node, dp, tplInfo) {
	var maybeTable = node.nextSibling;
	var clear = false;

	while (maybeTable && !DU.hasNodeName(maybeTable, 'table')) {
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
	if (!tplInfo && DU.hasParsoidAboutId(maybeTable) &&
		!DU.isFirstEncapsulationWrapperNode(maybeTable)
	) {
		var tplNode = DU.findFirstEncapsulationWrapperNode(maybeTable);
		if (tplNode !== null) {
			return tplNode;
		}

		// We got misled by the about id on 'maybeTable'.
		// Let us carry on with regularly scheduled programming.
	}

	var templateInfo = findEnclosingTemplateName(env, tplInfo);
	var lintObj = {
		dsr: findLintDSR(templateInfo, tplInfo, DU.getDataParsoid(maybeTable).dsr),
		templateInfo: templateInfo
	};
	env.log('lint/fostered', lintObj);

	return maybeTable;
}

var obsoleteTagsRE = null;

function logObsoleteHTMLTags(env, c, dp, tplInfo) {
	if (!obsoleteTagsRE) {
		var elts = [];
		Consts.HTML.OlderHTMLTags.forEach(function(tag) {
			// Looks like all existing editors let editors add the <big> tag.
			// VE has a button to add <big>, it seems so does the WikiEditor
			// and JS wikitext editor. So, don't flag BIG as an obsolete tag.
			if (tag !== 'BIG') {
				elts.push(tag);
			}
		});
		obsoleteTagsRE = new RegExp('^(' + elts.join('|') + ')$');
	}

	var templateInfo;
	if (!(dp.autoInsertedStart && dp.autoInsertedEnd) && obsoleteTagsRE.test(c.nodeName)) {
		templateInfo = findEnclosingTemplateName(env, tplInfo);
		var lintObj = {
			dsr: findLintDSR(templateInfo, tplInfo, dp.dsr),
			templateInfo: templateInfo,
			params: { name: c.nodeName.toLowerCase() },
		};
		env.log('lint/obsolete-tag', lintObj);
	}

	if (c.nodeName === 'FONT' && c.getAttribute('color')) {
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
			if (!DU.isComment(n) &&
				n.nodeName !== 'A' &&
				!DU.isBehaviorSwitch(env, n) &&
				!DU.isSolTransparentLink(n) &&
				!(n.nodeName === 'META' && Util.TPL_META_TYPE_REGEXP.test(n.getAttribute('typeof')))
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
			templateInfo = findEnclosingTemplateName(env, tplInfo);
			env.log('lint/tidy-font-bug', {
				dsr: findLintDSR(templateInfo, tplInfo, dp.dsr),
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
function logBogusMediaOptions(env, c, dp, tplInfo) {
	if (DU.isGeneratedFigure(c) && dp.optList) {
		var items = [];
		dp.optList.forEach(function(item) {
			if (item.ck === "bogus") {
				items.push(item.ak);
			}
		});
		if (items.length) {
			var templateInfo = findEnclosingTemplateName(env, tplInfo);
			env.log('lint/bogus-image-options', {
				dsr: findLintDSR(templateInfo, tplInfo, dp.dsr),
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
function logDeletableTables(env, c, dp, tplInfo) {
	if (c.nodeName === 'TABLE') {
		var prev = DU.previousNonSepSibling(c);
		if (prev && prev.nodeName === 'TABLE' && DU.getDataParsoid(prev).autoInsertedEnd) {
			var templateInfo = findEnclosingTemplateName(env, tplInfo);
			var dsr = findLintDSR(templateInfo, tplInfo, dp.dsr,
				function(nodeDSR) {
					// Identify the dsr-span of the opening tag
					// of the table that needs to be deleted
					var x = Util.clone(nodeDSR);
					if (x[2]) {
						x[1] = x[0] + x[2];
						x[2] = 0;
						x[3] = 0;
					}
					return x;
				}
			);
			var lintObj = {
				dsr: dsr,
				templateInfo: templateInfo,
				params: { name: 'table' },
			};
			env.log('lint/deletable-table-tag', lintObj);
		}
	}
}

function findMatchingChild(node, filter) {
	var c = node.firstChild;
	while (c && !filter(c)) {
		c = c.nextSibling;
	}

	return c;
}

function hasNoWrapCSS(node) {
	// In the general case, this CSS can come from a class,
	// or from a <style> tag or a stylesheet or even from JS code.
	// But, for now, we are restricting this inspection to inline CSS
	// since the intent is to aid editors in fixing patterns that
	// can be automatically detected.
	//
	// Special case for enwiki that has Template:nowrap which
	// assigns class='nowrap' with CSS white-space:nowrap in
	// MediaWiki:Common.css
	return /nowrap/.test(node.getAttribute('style')) ||
		/(^|\s)nowrap($|\s)/.test(node.getAttribute('class'));
}

function logBadPWrapping(env, node, dp, tplInfo) {
	if (!DU.isBlockNode(node) && DU.isBlockNode(node.parentNode) && hasNoWrapCSS(node)) {
		var findP = function(e) { return e.nodeName === 'P'; };
		var p = findMatchingChild(node, findP);
		if (p) {
			var templateInfo = findEnclosingTemplateName(env, tplInfo);
			var lintObj = {
				dsr: findLintDSR(templateInfo, tplInfo, dp.dsr),
				templateInfo: templateInfo,
				params: { root: node.parentNode.nodeName, child: node.nodeName },
			};
			env.log('lint/pwrap-bug-workaround', lintObj);
		}
	}
}

function logTidyWhitespaceBug(env, node, dp, tplInfo) {
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
	while (node && !DU.isBlockNode(node) && !/^(H|B|WB)R$/.test(node.nodeName)) {
		if (DU.isText(node) || !hasNoWrapCSS(node)) {
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
			while (last && DU.isComment(last)) {
				last = last.previousSibling;
			}

			var bug = false; // Set this explicitly always (because vars aren't block-scoped)
			if (last && DU.isText(last) && /\s$/.test(last.data)) {
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
		} else if (!tplInfo && DU.findFirstEncapsulationWrapperNode(node)) {
			// Entering a top-level template
			break;
		}

		// Move to the next non-comment sibling
		node = node.nextSibling;
		while (node && DU.isComment(node)) {
			node = node.nextSibling;
		}
	}

	var markProcessedNodes = function() { // Helper
		nowrapNodes.forEach(function(o) {
			if (DU.isElt(o.node)) {
				DU.getDataParsoid(o.node).tmp.processedTidyWSBug = true;
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
	while (prev && !DU.isBlockNode(prev)) {
		if (!DU.isComment(prev)) {
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
	var templateInfo = findEnclosingTemplateName(env, tplInfo);
	var n = nowrapNodes.length - 1;
	nowrapNodes.forEach(function(o, i) {
		if (o.tidybug && i < n && !nowrapNodes[i + 1].hasLeadingWS) {
			var lintObj = {
				dsr: findLintDSR(templateInfo, tplInfo, DU.getDataParsoid(o.node).dsr),
				templateInfo: templateInfo,
				params: {
					node: o.node.nodeName,
					sibling: o.node.nextSibling.nodeName,
				},
			};

			env.log('lint/tidy-whitespace-bug', lintObj);
		}
	});

	markProcessedNodes();
}

function detectMultipleUnclosedFormattingTags(lints) {
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
	lints.find(function(item) {
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

function postProcessLints(lints) {
	detectMultipleUnclosedFormattingTags(lints);
}

function getWikitextListItemAncestor(node) {
	while (node && !DU.isListItem(node)) {
		node = node.parentNode;
	}

	// If the list item is a HTML list item, ignore it
	// If the list item comes from references content, ignore it
	if (node && !DU.isLiteralHTMLNode(node) &&
		!(/mw:Extension\/references/.test(node.parentNode.getAttribute('typeof')))
	)  {
		return node;
	} else {
		return null;
	}
}

function logPHPParserBug(env, node, dp, tplInfo) {
	var li;
	if (!DU.isLiteralHTMLNode(node) ||
		node.nodeName !== 'TABLE' ||
		!(li = getWikitextListItemAncestor(node)) ||
		!/\n/.test(node.outerHTML)
	) {
		return;
	}

	// We have an HTML table nested inside a list
	// that has a newline break in its outer HTML
	// => we are in trouble with the PHP Parser + Remex combo
	var templateInfo = findEnclosingTemplateName(env, tplInfo);
	var lintObj = {
		dsr: findLintDSR(templateInfo, tplInfo, DU.getDataParsoid(node).dsr),
		templateInfo: templateInfo,
		params: {
			name: 'table',
			ancestorName: li.nodeName.toLowerCase(),
		}
	};
	env.log('lint/multiline-html-table-in-list', lintObj);
}

function logWikitextFixups(node, env, tplInfo) {
	var dp = DU.getDataParsoid(node);

	logTreeBuilderFixup(env, node, dp, tplInfo);
	logDeletableTables(env, node, dp, tplInfo); // For T161341
	logBadPWrapping(env, node, dp, tplInfo);    // For T161306
	logObsoleteHTMLTags(env, node, dp, tplInfo);
	logBogusMediaOptions(env, node, dp, tplInfo);
	logTidyWhitespaceBug(env, node, dp, tplInfo);

	// When an HTML table is nested inside a list and if any part of the table
	// is on a new line, the PHP parser misnests the list and the table.
	// Tidy fixes the misnesting one way (puts table inside/outside the list)
	// HTML5 parser fix it another way (list expands to rest of the page!)
	logPHPParserBug(env, node, dp, tplInfo);

	// Log fostered content, but skip rendering-transparent nodes
	//
	// FIXME: Create a separate emitsRenderingTransparentHTML helper
	// and use it everywhere where this helper is being used as a proxy.
	if (dp.fostered && !DU.emitsSolTransparentSingleLineWT(env, node, true)) {
		return logFosteredContent(env, node, dp, tplInfo);
	} else {
		return null;
	}
}

function findLints(root, env, tplInfo) {
	var node = root.firstChild;
	while (node !== null) {
		if (!DU.isElt(node)) {
			node = node.nextSibling;
			continue;
		}

		var nodeTypeOf = node.getAttribute('typeof');

		// !tplInfo check is to protect against templated content in
		// extensions which might in turn be nested in templated content.
		if (!tplInfo && DU.isFirstEncapsulationWrapperNode(node)) {
			tplInfo = {
				first: node,
				last: JSUtils.lastItem(DU.getAboutSiblings(node, node.getAttribute("about"))),
				dsr: DU.getDataParsoid(node).dsr,
				isTemplated: /\bmw:Transclusion\b/.test(nodeTypeOf),
				clear: false,
			};
		}

		var nextNode;
		var nativeExt;
		var match = (nodeTypeOf || '').match(/\bmw:Extension\/(.+?)\b/);
		if (match &&
			(nativeExt = env.conf.wiki.extensionTags.get(match[1])) &&
			nativeExt.lintHandler
		) { // Let native extensions lint their content
			nextNode = nativeExt.lintHandler(node, env, tplInfo, findLints);
		} else { // Default node handler
			// Lint this node
			nextNode = logWikitextFixups(node, env, tplInfo);
			if (tplInfo && tplInfo.clear) {
				tplInfo = null;
			}

			// Lint subtree
			if (!nextNode) {
				findLints(node, env, tplInfo);
			}
		}

		if (tplInfo && tplInfo.last === node) {
			tplInfo = null;
		}

		node = nextNode || node.nextSibling;
	}
}

function linter(body, env, options, atTopLevel) {
	// Only on the final DOM for the top-level page.
	// Skip linting if we cannot lint it
	if (!atTopLevel || !env.page.hasLintableContentModel()) {
		return;
	}

	if (env.conf.parsoid.dumpFlags && env.conf.parsoid.dumpFlags.has("dom:pre-linting")) {
		DU.dumpDOM(body, 'DOM: before linting');
	}

	findLints(body, env);
	postProcessLints(env.lintLogger.buffer);
}

if (typeof module === "object") {
	module.exports.linter = linter;
}
