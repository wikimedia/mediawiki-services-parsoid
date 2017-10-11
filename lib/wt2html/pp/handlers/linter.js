/*
 * DOM pass that walks the DOM tree and places a call to logger
 * with logtype 'lint/*' to log the following scenarios:
 *
 * 1. Treebuilder fixups
 * 2. Fostered content
 * 3. Ignored table attributes
 * 4. Multi-template blocks
 * 5. Mixed content in template markup
 * 6. Obsolete HTML tags
 * 7. Self-closed HTML tags
 */

'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var Util = require('../../../utils/Util.js').Util;
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

/*
 * Log Transclusion with more than one parts
 * Ex - {{table-start}}
 *      {{cell|unused value|key=used value}}
 *      |-
 *      {{cell|unused value|key=used value}}
 *      |-
 *      |<math>1+1</math>
 *      |}
 * https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec#Transclusion_content
 */
function logTransclusions(env, node, dp, tplInfo) {
	var parts = DU.getDataMw(node).parts;
	if (!Array.isArray(parts) || parts.length < 2) { return; }

	var type = 'multi-template';
	parts.forEach(function(a) {
		if (typeof a === 'string') {
			type = 'mixed-content';
		}
	});

	env.log('lint/' + type, { dsr: tplInfo.dsr });
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

/*
 * Log Treebuilder fixups marked by dom.markTreeBuilderFixup.js
 * It handles the following scenarios:
 *
 * 1. Unclosed end tags
 * 2. Unclosed start tags
 * 3. Stripped tags
 */
function logTreeBuilderFixup(env, c, dp, tplInfo) {
	// This might have been processed as part of
	// misnested-tag category identification.
	if ((dp.tmp || {}).linted) {
		return;
	}

	var cNodeName = c.nodeName.toLowerCase();
	var dsr = dp.dsr;
	var lintObj;
	var templateInfo;

	if (tplInfo) {
		dsr = tplInfo.dsr;
		templateInfo = findEnclosingTemplateName(env, tplInfo);
	} else if (dp.tmp.origDSR) {
		// During DSR computation, stripped meta tags
		// surrender their width to its previous sibling.
		// We record the original DSR in the tmp attribute
		// for that reason.
		dsr = dp.tmp.origDSR;
	}

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
	// 3. c is not a HTML element (unless they are i/b quotes)
	//
	// 4. c doesn't have DSR info and doesn't come from a template either
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
			} else {
				var adjNode = getNextMatchingNode(c, c);
				if (adjNode) {
					var adjDp = DU.getDataParsoid(adjNode);
					if (!adjDp.tmp) {
						adjDp.tmp = {};
					}
					adjDp.tmp.linted = true;
					env.log('lint/misnested-tag', lintObj);
				} else if (DU.hasLiteralHTMLMarker(dp)) {
					env.log('lint/missing-end-tag', lintObj);
				}
			}
		}

		if (DU.hasLiteralHTMLMarker(dp) &&
			dp.autoInsertedStart === true &&
			(tplInfo ||  dsr[3] > 0)) {
			lintObj = {
				dsr: dsr,
				templateInfo: templateInfo,
			};
			env.log('lint/missing-start-tag', lintObj);
		}
	}
}

/*
 * Log ignored table attributes.
 * This handles cases like:
 *
 * {|
 * |- foo
 * | bar
 * |}
 *
 * Here foo gets ignored and is found in the data-parsoid of <tr> tags.
 */

/* ----------------------------------------------
 * Comment out this whole thing to satisfy eslint
 *
function logIgnoredTableAttr(env, node, dp, tplInfo) {
	var dsr;
	var templateInfo;
	if (!node.nodeName === 'TABLE') {
		return;
	}

	var tbody = DU.firstNonSepChildNode(node);
	var c = tbody.firstChild;
	while (c) {
		if (c.nodeName === 'TR') {
			dp = DU.getDataParsoid(c);
			if (dp.sa) {
				// Discard attributes that are only whitespace and comments
				for (var key in dp.sa) {
					var re = /^\s*$|^<!--([^-]|-(?!->))*-->([ \t]|<!--([^-]|-(?!->))*-->)*$/;
					if (!re.test(key) || !re.test(dp.sa[key])) {
						// FIXME: This is incorrect.
						// We need to check if the key is absent in dp.a / in the node's attribute
						if (tplInfo) {
							dsr = tplInfo.dsr;
							templateInfo = findEnclosingTemplateName(env, tplInfo);
						} else {
							dsr = dp.dsr;
						}
						var lintObj = { dsr: dsr, templateInfo: templateInfo };
						env.log('lint/ignored-table-attr', lintObj);
					}
				}
			}
		}
		c = c.nextSibling;
	}
}
*/

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
	while (maybeTable && !DU.hasNodeName(maybeTable, 'table')) {
		if (tplInfo && maybeTable === tplInfo.last) {
			tplInfo.clear = true;
		}
		maybeTable = maybeTable.nextSibling;
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

	var dsr;
	var templateInfo;
	if (tplInfo) {
		dsr = tplInfo.dsr;
		templateInfo = findEnclosingTemplateName(env, tplInfo);
	} else {
		dsr = DU.getDataParsoid(maybeTable).dsr;
	}
	var lintObj = { dsr: dsr, templateInfo: templateInfo };
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

	if (!(dp.autoInsertedStart && dp.autoInsertedEnd) && obsoleteTagsRE.test(c.nodeName)) {
		var templateInfo;
		if (tplInfo) {
			templateInfo = findEnclosingTemplateName(env, tplInfo);
		}
		var lintObj = {
			dsr: tplInfo ? tplInfo.dsr : dp.dsr,
			templateInfo: templateInfo,
			params: { name: c.nodeName.toLowerCase() },
		};
		env.log('lint/obsolete-tag', lintObj);
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
			var templateInfo;
			if (tplInfo) {
				templateInfo = findEnclosingTemplateName(env, tplInfo);
			}
			env.log('lint/bogus-image-options', {
				dsr: tplInfo ? tplInfo.dsr : dp.dsr,
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
	var templateInfo;
	if (c.nodeName === 'TABLE') {
		var prev = DU.previousNonSepSibling(c);
		if (prev && prev.nodeName === 'TABLE' && DU.getDataParsoid(prev).autoInsertedEnd) {
			var dsr;
			if (tplInfo) {
				templateInfo = findEnclosingTemplateName(env, tplInfo);
				dsr = tplInfo.dsr;
			} else {
				// Identify the dsr-span of the opening tag
				// of the table that needs to be deleted
				dsr = Util.clone(dp.dsr);
				if (dsr[2]) {
					dsr[1] = dsr[0] + dsr[2];
					dsr[2] = 0;
					dsr[3] = 0;
				}
			}
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
	var findP = function(e) { return e.nodeName === 'P'; };
	if (!DU.isBlockNode(node) && DU.isBlockNode(node.parentNode)) {
		if (hasNoWrapCSS(node)) {
			var p = findMatchingChild(node, findP);
			if (p) {
				var dsr, templateInfo;
				if (tplInfo) {
					templateInfo = findEnclosingTemplateName(env, tplInfo);
					dsr = tplInfo.dsr;
				} else {
					dsr = dp.dsr;
				}
				var lintObj = {
					dsr: dsr,
					templateInfo: templateInfo,
					params: { root: node.parentNode.nodeName, child: node.nodeName },
				};
				env.log('lint/pwrap-bug-workaround', lintObj);
			}
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
	var dsr, templateInfo;
	if (tplInfo) {
		templateInfo = findEnclosingTemplateName(env, tplInfo);
		dsr = tplInfo.dsr;
	}
	var n = nowrapNodes.length - 1;
	nowrapNodes.forEach(function(o, i) {
		if (o.tidybug && i < n) {
			if (!tplInfo) {
				dsr = DU.getDataParsoid(o.node).dsr;
			}
			if (!nowrapNodes[i + 1].hasLeadingWS) {
				var lintObj = {
					dsr: dsr,
					templateInfo: templateInfo,
					params: {
						node: o.node.nodeName,
						sibling: o.node.nextSibling.nodeName,
					},
				};

				env.log('lint/tidy-whitespace-bug', lintObj);
			}
		}
	});

	markProcessedNodes();
}

function logWikitextFixups(node, env, atTopLevel, tplInfo) {
	// For now, don't run linter in subpipelines.
	// Only on the final DOM for the top-level page.
	if (!atTopLevel || !DU.isElt(node)) {
		return true;
	}

	// Skip linting if we cannot lint it
	if (!env.page.hasLintableContentModel()) {
		return true;
	}

	var dp = DU.getDataParsoid(node);

	if (tplInfo && tplInfo.first === node) {
		// Log transclusions with more than one part
		logTransclusions(env, node, dp, tplInfo);
	}

	logTreeBuilderFixup(env, node, dp, tplInfo);
	// Turning this off for now since
	// (a) this needs fixing (b) not exposed in linter extension output yet
	// (c) this is source of error logspam in kibana
	// logIgnoredTableAttr(env, node, dp, tplInfo);
	logDeletableTables(env, node, dp, tplInfo); // For T161341
	logBadPWrapping(env, node, dp, tplInfo);    // For T161306
	logObsoleteHTMLTags(env, node, dp, tplInfo);
	logBogusMediaOptions(env, node, dp, tplInfo);
	logTidyWhitespaceBug(env, node, dp, tplInfo);

	// Log fostered content, but skip rendering-transparent nodes
	//
	// FIXME: Create a separate emitsRenderingTransparentHTML helper
	// and use it everywhere where this helper is being used as a proxy.
	if (dp.fostered && !DU.emitsSolTransparentSingleLineWT(env, node, true)) {
		return logFosteredContent(env, node, dp, tplInfo);
	} else {
		return true;
	}
}

if (typeof module === "object") {
	module.exports.logWikitextFixups = logWikitextFixups;
}
