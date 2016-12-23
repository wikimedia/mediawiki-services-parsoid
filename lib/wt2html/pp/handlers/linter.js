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

/*
 * Log Treebuilder fixups marked by dom.markTreeBuilderFixup.js
 * It handles the following scenarios:
 *
 * 1. Unclosed end tags
 * 2. Unclosed start tags
 * 3. Stripped tags
 */
function logTreeBuilderFixup(env, c, dp, tplInfo) {
	var cNodeName = c.nodeName.toLowerCase();
	var dsr = dp.dsr;
	var lintObj;
	var templateInfo;

	if (tplInfo) {
		dsr = tplInfo.dsr;
		templateInfo = {
			name: DU.findEnclosingTemplateName(tplInfo),
		};
	}

	if (DU.hasNodeName(c, 'meta')) {
		var type = c.getAttribute('typeof');
		if (type === 'mw:Placeholder/StrippedTag') {
			lintObj = { dsr: dsr, templateInfo: templateInfo };
			env.log('lint/stripped-tag', lintObj);
		}
	}

	// Dont bother linting for auto-inserted start/end or self-closing-tag if:
	// 1. c is a void element
	//    Void elements won't have auto-inserted start/end tags
	//    and self-closing versions are valid for them.
	//
	// 2. c is tbody (FIXME: don't remember why we have this exception)
	//
	// 3. c is not a HTML element
	//
	// 4. c doesn't have DSR info and doesn't come from a template either
	if (!Util.isVoidElement(cNodeName) &&
		cNodeName !== 'tbody' &&
		DU.hasLiteralHTMLMarker(dp) &&
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
			env.log('lint/missing-end-tag', lintObj);
		}

		if (dp.autoInsertedStart === true && (tplInfo ||  dsr[3] > 0)) {
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
function logIgnoredTableAttr(env, c, dp, tplInfo) {
	var dsr;
	var templateInfo;
	if (DU.hasNodeName(c, "table")) {
		var fc = c.firstChild;
		while (fc) {
			if (DU.hasNodeName(fc, "tbody")) {
				var trfc = fc.firstChild;
				while (trfc) {
					if (DU.hasNodeName(trfc, "tr")) {
						dp = DU.getDataParsoid(trfc);
						if (dp.sa) {
							var wc = false;
							// Discard attributes that are only whitespace and comments
							for (var key in dp.sa) {
								var re = /^\s*$|^<!--([^-]|-(?!->))*-->([ \t]|<!--([^-]|-(?!->))*-->)*$/;
								if ((!re.test(key) || !re.test(dp.sa[key]))) {
									wc = true;
									break;
								}
							}

							if (wc) {
								if (tplInfo) {
									dsr = tplInfo.dsr;
									templateInfo = { name: DU.findEnclosingTemplateName(tplInfo) };
								} else {
									dsr = dp.dsr;
								}
								var lintObj = { dsr: dsr, templateInfo: templateInfo };
								env.log('lint/ignored-table-attr', lintObj);
							}
						}
					}
					trfc = trfc.nextSibling;
				}
			}
			fc = fc.nextSibling;
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
	var nextSibling = node.nextSibling;
	while (nextSibling && !DU.hasNodeName(nextSibling, 'table')) {
		if (tplInfo && nextSibling === tplInfo.last) {
			tplInfo.clear = true;
		}
		nextSibling = nextSibling.nextSibling;
	}
	var dsr;
	var templateInfo;
	if (tplInfo) {
		dsr = tplInfo.dsr;
		templateInfo = { name: DU.findEnclosingTemplateName(tplInfo) };
	} else {
		dsr = DU.getDataParsoid(nextSibling).dsr;
	}
	var lintObj = { dsr: dsr, templateInfo: templateInfo };
	env.log('lint/fostered', lintObj);
	return nextSibling;
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
			templateInfo = { name: DU.findEnclosingTemplateName(tplInfo) };
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
 * Log bogus (=unrecognized) image options
 * See - https://www.mediawiki.org/wiki/Help:Images#Syntax
 */
function logBogusImageOptions(env, c, dp, tplInfo) {
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
				templateInfo = { name: DU.findEnclosingTemplateName(tplInfo) };
			}
			env.log('lint/bogus-image-options', {
				dsr: tplInfo ? tplInfo.dsr : dp.dsr,
				templateInfo: templateInfo,
				params: { items: items },
			});
		}
	}
}

function logWikitextFixups(node, env, atTopLevel, tplInfo) {
	// For now, don't run linter in subpipelines.
	// Only on the final DOM for the top-level page.
	if (!atTopLevel || !DU.isElt(node)) {
		return true;
	}

	var dp = DU.getDataParsoid(node);

	if (tplInfo && tplInfo.first === node) {
		// Log transclusions with more than one part
		logTransclusions(env, node, dp, tplInfo);
	}

	// Log Tree Builder fixups
	logTreeBuilderFixup(env, node, dp, tplInfo);

	// Log Ignored Table Attributes
	logIgnoredTableAttr(env, node, dp, tplInfo);

	// Log obsolete HTML tags
	logObsoleteHTMLTags(env, node, dp, tplInfo);

	// Log bogus image options
	logBogusImageOptions(env, node, dp, tplInfo);

	if (dp.fostered) {
		// Log Fostered content
		return logFosteredContent(env, node, dp, tplInfo);
	} else {
		return true;
	}
}

if (typeof module === "object") {
	module.exports.logWikitextFixups = logWikitextFixups;
}
