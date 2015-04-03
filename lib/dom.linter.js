/*
* Dom pass that walks the dom tree and place a call to logger
* with logtype 'lint/*' to log following scenarios:
*
* 1. Tree Builder Fixups
* 2. Fostered Content
* 3. Ignored table attributes
* 4. Multi Templates
* 5. Mixed Content
* 6. Obsolete HTML Tags
*/

"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	Util = require('./mediawiki.Util.js').Util;

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

function logTransclusions(env, c) {

	var dmw = DU.getDataMw(c);
	if ( dmw ) {
		var dsr = DU.getDataParsoid(c).dsr;
		if (dmw.parts) {
			var parts = dmw.parts, lintObj;
			if (typeof parts[0] === 'string' || typeof parts[parts.length - 1] === 'string') {
				lintObj = {src: env.page.src, dsr: dsr };
				env.log('lint/mixed-content', lintObj);
			} else if (parts.length > 1) {
				var targets = [],
					t = null;
				dmw.parts.forEach(function(a) {
					if (a.template || a.extension) {
						targets.push(JSON.stringify(a.template.target));
					}
				});
				if (targets.length > 1) {
					lintObj = { src: targets, dsr: dsr };
					env.log('lint/multi-template', lintObj);
				}
			}
		}
	}
	return;
}

/*
* Log Tree Builder Fixups logs those cases which are marked by dom.markTreeBuilderFixup.js
* It handles following scenarios.
*
* 1. Unclosed End Tags
* 2. Unclosed Start Tags
* 3. Stripped Tags
*/
function logTreeBuilderFixup(env, c, dp, tmpl) {

	var cNodeName = c.nodeName.toLowerCase(),
		dsr = dp.dsr,
		lintObj, inTransclusion = false;

	if (tmpl) {
		dsr = tmpl.dsr;
		inTransclusion = true;
	}

	if (DU.hasNodeName(c, 'meta')) {
		var type = c.getAttribute('typeof');
		if (type === 'mw:Placeholder/StrippedTag') {
			lintObj = { src: env.page.src, dsr: dsr, inTransclusion: inTransclusion };
			env.log('lint/stripped-tag', lintObj);
		}
	}

	// Dont lint auto-inserted start/end if:
	// 1. c is a void element
	// 2. c is not self-closed
	// 3. c is not tbody
	if ( DU.isTplOrExtToplevelNode(c) ||
		(!Util.isVoidElement(cNodeName) &&
		!dp.selfClose &&
		cNodeName !== 'tbody' &&
		DU.hasLiteralHTMLMarker(dp) &&
		dsr) ) {

		if (dp.autoInsertedEnd === true && (tmpl || dsr[2]>0) ) {
			lintObj = { src: env.page.src, dsr: dsr,
						tip: 'Add End Tag to Fix this', inTransclusion: inTransclusion};
			env.log('lint/missing-end-tag', lintObj);
		}

		if (dp.autoInsertedStart === true && (tmpl ||  dsr[3]>0) ) {
			lintObj = { src: env.page.src, dsr: dsr,
						tip: 'Add Start Tag to Fix this', inTransclusion: inTransclusion};
			env.log('lint/missing-start-tag', lintObj);
		}
	}
}

/*
* Log Ignored Table Attributes.
* This handles cases like:
*
* {|
* |- foo
* | bar
* |}
*
* Here foo gets Ignored and is found in the data-parsoid of <tr> tags.
*/
function logIgnoredTableAttr(env, c, dp, tmpl) {
	var dsr, inTransclusion = false;
	if (DU.hasNodeName(c, "table")) {
		var fc = c.firstChild;
		while (fc) {
			if (DU.hasNodeName(fc,"tbody")) {
				var trfc = fc.firstChild;
				while (trfc) {
					if (DU.hasNodeName(trfc, "tr")) {
						dp = DU.getDataParsoid(trfc);
						if (dp.sa) {
							var wc = false;
							// Discard attributes that are only whitespace and comments
							for (var key in dp.sa) {
								var re = /^\s*$|^<!--([^-]|-(?!->))*-->([ \t]|<!--([^-]|-(?!->))*-->)*$/;
								if ((!re.test(key) || !re.test(dp.sa[key]) )) {
									wc = true;
									break;
								}
							}

							if (wc) {
								if ( tmpl ) {
								   dsr = tmpl.dsr;
								   inTransclusion = true;
								} else {
								   dsr = dp.dsr;
								}
								var lintObj = { src: env.page.src, dsr: dsr, inTransclusion: inTransclusion };
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
* Log Fostered Content marked by markFosteredContent.js
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
function logFosteredContent(env, c, dp, tmpl, nextSibling) {

	var dsr, inTransclusion = false;
	var fosteredSRC = c.innerHTML;
	while (nextSibling && !DU.hasNodeName(nextSibling,'table')) {
		fosteredSRC += nextSibling.innerHTML;
		if ( nextSibling === tmpl.last ) {
			tmpl.done = true;
		}
		nextSibling = nextSibling.nextSibling;
	}
	if (tmpl) {
		dsr = tmpl.dsr;
		inTransclusion = true;
	} else {
		dsr = DU.getDataParsoid(nextSibling).dsr;
	}
	var lintObj = { src: fosteredSRC, dsr: dsr, inTransclusion: inTransclusion };
	env.log('lint/fostered', lintObj);
	return nextSibling;
}

/*
*
* Log Obsolete HTML Tags like BIG, CENTER, FONT, STRIKE, and TT
* See - http://www.w3.org/TR/html5/obsolete.html#non-conforming-features
*
*/
function logObsoleteHTMLTags(env, c, dp, tmpl) {

	var dsr = dp.dsr, inTransclusion = false;
	var re = /^(BIG|CENTER|FONT|STRIKE|TT)$/;

	if (tmpl) {
		dsr = tmpl.dsr;
		inTransclusion = true;
	}

	if (re.test(c.nodeName)) {
		var lintObj = { src: env.page.src, dsr: dsr, inTransclusion: inTransclusion };
		env.log('lint/obsolete-tag', lintObj);
	}
}

/*
*
* Log Bogus Image Options, since with unrecognized image options
* See -	 https://www.mediawiki.org/wiki/Help:Images#Syntax
*
*/
function logBogusImageOptions(env, c, dp, tmpl) {

	if(DU.isGeneratedFigure(c)) {
		var optlist = dp.optList;
		optlist.forEach(function (item) {
			if (item.ck === "bogus") {
				var dsr, inTransclusion = false;
				if ( tmpl ) {
					dsr = tmpl.dsr;
					inTransclusion = true;
				} else {
					dsr = dp.dsr;
				}
				var lintObj = { src: env.page.src, dsr: dsr, inTransclusion: inTransclusion };
				env.log('lint/bogus-image-options', lintObj);
			}
		});
	}
}

function logWikitextFixups(node, env, options, atTopLevel, tmpl) {
	// For now, don't run linter in subpipelines.
	// Only on the final DOM for the top-level page.
	if (!atTopLevel) {
		return;
	}

	var c = node.firstChild;

	while (c) {
		var nextSibling = c.nextSibling,
			dp = DU.getDataParsoid(c);

		// Store info from the first node of an about id group.
		// Nested templates aren't an issue because we expand top-level
		// templates with the mediawiki api.
		if ( !tmpl && DU.isTplOrExtToplevelNode(c) ) {
			var about = c.getAttribute('about');
			tmpl = {
				last: DU.getAboutSiblings(c, about).last(),
				dsr: dp.dsr,
				done: false
			};

			// Log transclusions with more than one part
			logTransclusions(env, c);
		}

		if (DU.isElt(c)) {

			// Log Tree Builder fixups
			logTreeBuilderFixup(env, c, dp, tmpl);

			// Log Ignored Table Attributes
			logIgnoredTableAttr(env, c, dp, tmpl);

			// Log obsolete HTML tags
			logObsoleteHTMLTags(env, c, dp, tmpl);

			// Log bogus image options
			logBogusImageOptions(env, c, dp, tmpl);

			if (dp.fostered) {
				// Log Fostered content
				nextSibling = logFosteredContent(env, c, dp, tmpl, nextSibling);
			} else if (c.childNodes.length > 0) {
				// Process subtree
				logWikitextFixups(c, env, options, atTopLevel, tmpl);
			}
		}

		if ( tmpl && (c === tmpl.last || tmpl.done) ) {
			tmpl = null;
		}

		c = nextSibling;
	}
}

if (typeof module === "object") {
	module.exports.logWikitextFixups = logWikitextFixups;
}
