"use strict";
require('./core-upgrade');
/* -------------------------------------------------------------------
 * The WikitextConstant structure holds "global constants" that
 * capture properties about wikitext markup.
 *
 * Ex: Valid options for wikitext image markup
 *
 * This structure, over time, can come to serve as useful documentation
 * about Wikitext itself.  For now, this is barebones and sparse.
 * ------------------------------------------------------------------- */

var JSUtils = require('./jsutils').JSUtils;

var WikitextConstants = {
	// Valid image options:
	// * Prefix options are of the form "alt=foo"
	// * Simple options are of the form "center"
	//
	// See http://en.wikipedia.org/wiki/Wikipedia:Extended_image_syntax
	// for more information about how they are used.
	Image: {
		PrefixOptions: JSUtils.mapObject({
			'img_link'      : 'link',
			'img_alt'       : 'alt',
			'img_page'      : 'page',
			'img_lang'      : 'lang', // see bug 32987
			'img_upright'   : 'upright',
			'img_width'     : 'width',
			'img_class'     : 'class',
			'img_manualthumb': 'manualthumb'
		}),
		/* filled in below, based on PrefixOptions */
		PrefixOptionsReverseMap: new Map(),
		SimpleOptions: JSUtils.mapObject({
			// halign
			'img_left'   : 'halign',
			'img_right'  : 'halign',
			'img_center' : 'halign',
			'img_float'  : 'halign',
			'img_none'   : 'halign',

			// valign
			'img_baseline'    : 'valign',
			'img_sub'         : 'valign',
			'img_super'       : 'valign',
			'img_top'         : 'valign',
			'img_text_top'    : 'valign',
			'img_middle'      : 'valign',
			'img_bottom'      : 'valign',
			'img_text_bottom' : 'valign',

			// format
			// 'border' can be given in addition to *one of*
			// frameless, framed, or thumbnail
			'img_border'    : 'border',
			'img_frameless' : 'format',
			'img_framed'    : 'format',
			'img_thumbnail' : 'format',

			// Ha! Upright can be either one! Try parsing THAT!
			'img_upright'   : 'upright'
		})
	},

	Sanitizer: {
		// List of whitelisted tags that can be used as raw HTML in wikitext.
		// All other html/html-like tags will be spit out as text.
		TagWhiteList: JSUtils.arrayToSet([
			// In case you were wondering, explicit <a .. > HTML is NOT allowed in wikitext.
			// That is why the <a> tag is missing from the white-list.
			'ABBR',
			'B', 'BDI', 'BDO', 'BIG', 'BLOCKQUOTE', 'BR',
			'CAPTION', 'CENTER', 'CITE', 'CODE',
			'DATA', 'DD', 'DEL', 'DFN', 'DIV', 'DL', 'DT',
			'EM',
			'FONT',
			'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR',
			'I', 'INS',
			'KBD',
			'LI',
			'MARK',
			'OL',
			'P', 'PRE',
			'Q',
			'RB', 'RP', 'RT', 'RUBY',
			'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP',
			'TABLE', 'TD', 'TH', 'TIME', 'TR', 'TT',
			'U', 'UL', 'WBR'
		])
	},

	// These HTML tags have native wikitext representations.
	// All other HTML tags would have to be emitted as HTML tags in wikitext.
	HTMLTagsWithWTEquivalents: JSUtils.arrayToSet([
		"A", "B", "CAPTION", "DD", "DL", "DT",
		"FIGCAPTION", "FIGURE",
		"H1", "H2", "H3", "H4", "H5", "H6",
		"HR", "I", "IMG", "LI", "LINK", "META",
		"OL", "P", "PRE", "TABLE", "TD", "TH", "TR", "UL"
	]),

	// These wikitext tags are composed with quote-chars.
	WTQuoteTags: JSUtils.arrayToSet(['I', 'B']),

	// These wikitext tags accept whitespace on the line without triggering indent-pre.
	LeadingWSAcceptingTags: JSUtils.arrayToSet([
		'TABLE', 'TR', 'CAPTION', 'TH', 'TD'
	]),

	// Leading whitespace on new lines in these elements does not lead to indent-pre.
	// This only applies to immediate children (while skipping past zero-wikitext tags).
	// (Ex: content in table-cells induce indent pres)
	WeakIndentPreSuppressingTags: JSUtils.arrayToSet([
		'TABLE', 'TBODY', 'TR'
	]),

	// Leading whitespace on new lines in these elements does not lead to indent-pre
	// This applies to all nested content in these tags.
	// Ex: content in table-cells nested in blocktags do not induce indent pres
	//
	// These tags should match $openmatch regexp in doBlockLevels:
	// $openmatch = preg_match( '/(?:<table|<blockquote|<h1|<h2|<h3|<h4|<h5|<h6|<pre|<tr|<p|<ul|<ol|<dl|<li|<\\/tr|<\\/td|<\\/th)/iS', $t )
	//
	// PHP parser handling is line-based. Our handling is DOM-children based.
	// So, there might edge cases where behavior will be different.
	//
	// FIXME: <ref> extension tag is another such -- is it possible to fold them
	// into this setup so we can get rid of the 'noPre' hack in token transformers?
	StrongIndentPreSuppressingTags: JSUtils.arrayToSet([
		'BLOCKQUOTE', 'PRE',
		'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
		'UL', 'OL', 'DL', 'LI'
	]),

	// In the PHP parser, these block tags open block-tag scope
	// See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	BlockScopeOpenTags: JSUtils.arrayToSet([
		'BLOCKQUOTE', 'PRE',
		'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
		'UL', 'OL', 'LI', 'DL',
		'P', 'TABLE', 'TR'
	]),

	// In the PHP parser, these block tags close block-tag scope
	// See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	BlockScopeCloseTags: JSUtils.arrayToSet([
		'TD', 'TH'
	]),

	HTML: {
		// The list of HTML5 tags, mainly used for the identification of *non*-html tags.
		// Non-html tags terminate otherwise tag-eating productions in the tokenizer
		// to support potential extension tags.
		HTML5Tags: JSUtils.arrayToSet([
			"A", "ABBR", "ADDRESS", "AREA", "ARTICLE",
			"ASIDE", "AUDIO", "B", "BASE", "BDI", "BDO", "BLOCKQUOTE",
			"BODY", "BR", "BUTTON", "CANVAS", "CAPTION", "CITE", "CODE",
			"COL", "COLGROUP", "COMMAND", "DATA", "DATALIST", "DD", "DEL",
			"DETAILS", "DFN", "DIV", "DL", "DT", "EM", "EMBED", "FIELDSET",
			"FIGCAPTION", "FIGURE", "FOOTER", "FORM",
			"H1", "H2", "H3", "H4", "H5", "H6", "HEAD", "HEADER", "HGROUP",
			"HR", "HTML", "I", "IFRAME", "IMG", "INPUT", "INS", "KBD", "KEYGEN",
			"LABEL", "LEGEND", "LI", "LINK", "MAP", "MARK", "MENU", "META",
			"METER", "NAV", "NOSCRIPT", "OBJECT", "OL", "OPTGROUP", "OPTION",
			"OUTPUT", "P", "PARAM", "PRE", "PROGRESS", "Q", "RP", "RT",
			"RUBY", "S", "SAMP", "SCRIPT", "SECTION", "SELECT", "SMALL",
			// "SOURCE", Support the deprecated <source> alias for syntaxhighlight
			"SPAN", "STRONG", "STYLE", "SUB", "SUMMARY", "SUP",
			"TABLE", "TBODY", "TD", "TEXTAREA", "TFOOT", "TH", "THEAD", "TIME",
			"TITLE", "TR", "TRACK", "U", "UL", "VAR", "VIDEO", "WBR"
		]),

		// From http://www.w3.org/TR/html5-diff/#obsolete-elements
		// SSS FIXME: basefont is missing here, but looks like the PHP parser
		// does not support it anyway and treats it as plain text.  So, skipping
		// this one in Parsoid as well.
		OlderHTMLTags: JSUtils.arrayToSet([
			"STRIKE", "BIG", "CENTER", "FONT", "TT"
		]),

		// https://developer.mozilla.org/en-US/docs/HTML/Block-level_elements
		BlockTags: JSUtils.arrayToSet([
			'DIV', 'P',
			// tables
			'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'CAPTION', 'TH', 'TR', 'TD',
			// lists
			'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
			// HTML5 heading content
			'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HGROUP',
			// HTML5 sectioning content
			'ARTICLE', 'ASIDE', 'BODY', 'NAV', 'SECTION', 'FOOTER', 'HEADER',
			'FIGURE', 'FIGCAPTION', 'FIELDSET', 'DETAILS', 'BLOCKQUOTE',
			// other
			'HR', 'BUTTON', 'CANVAS', 'CENTER', 'COL', 'COLGROUP', 'EMBED',
			'MAP', 'OBJECT', 'PRE', 'PROGRESS', 'VIDEO'
		]),

		// See http://www.w3.org/html/wg/drafts/html/master/syntax.html#formatting
		FormattingTags: JSUtils.arrayToSet([
			'A', 'B', 'BIG', 'CODE', 'EM', 'FONT', 'I', 'NOBR',
			'S', 'SMALL', 'STRIKE', 'STRONG', 'TT', 'U'
		]),

		ListTags: JSUtils.arrayToSet(['UL', 'OL', 'DL']),

		ListItemTags: JSUtils.arrayToSet(['LI', 'DD', 'DT']),

		FosterablePosition: JSUtils.arrayToSet(['TABLE', 'TBODY', 'TR']),

		TableTags: JSUtils.arrayToSet([
			'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'CAPTION', 'TH', 'TR', 'TD'
		]),

		// See http://www.whatwg.org/specs/web-apps/current-work/#void-elements
		//
		// We are currently treating <source> as an extension tag since this is widely
		// used on wikipedias.  So, we dont want to treat this as a HTML tag => it cannot
		// be a void element
		VoidTags: JSUtils.arrayToSet([
			'AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG',
			'INPUT', 'KEYGEN', 'LINK', 'META', 'PARAM', /* 'SOURCE', */
			'TRACK', 'WBR'
		])
	},

	// Known wikitext tag widths -- these are known statically
	// but other widths are computed or updated based on actual wikitext usage
	WT_TagWidths: {
		"BODY"  : [0,0],
		"HTML"  : [0,0],
		"HEAD"  : [0,0],
		"P"     : [0,0],
		"META"  : [0,0],
		"TBODY" : [0,0],
		"PRE"   : [1,0],
		"OL"    : [0,0],
		"UL"    : [0,0],
		"DL"    : [0,0],
		"LI"    : [1,0],
		"DT"    : [1,0],
		"DD"    : [1,0],
		"H1"    : [1,1],
		"H2"    : [2,2],
		"H3"    : [3,3],
		"H4"    : [4,4],
		"H5"    : [5,5],
		"H6"    : [6,6],
		"HR"    : [4,0],
		"TABLE" : [2,2],
		"TR"    : [null,0],
		"TD"    : [null,0],
		"TH"    : [null,0],
		"B"     : [3,3],
		"I"     : [2,2],
		"BR"    : [0,0],
		"FIGURE": [2,2]
	},

	// HTML tags whose wikitext equivalents are zero-width.
	// This information is derived from WT_TagWidths and set below.
	ZeroWidthWikitextTags: null
};


// Fill in reverse map of prefix options.
WikitextConstants.Image.PrefixOptions.forEach(function(v, k) {
	WikitextConstants.Image.PrefixOptionsReverseMap.set(v, k);
});

// Derived information from 'WT_TagWidths'
var zeroWidthTags = [];
Object.keys(WikitextConstants.WT_TagWidths).forEach(function(tag) {
	// This special case can be fixed by maybe removing them WT_TagWidths.
	// They may no longer be necessary -- to be investigated in another patch.
	if (tag !== 'HTML' && tag !== 'HEAD' && tag !== 'BODY') {
		var widths = WikitextConstants.WT_TagWidths[tag];
		if (widths[0] === 0 && widths[1] === 0) {
			zeroWidthTags.push(tag);
		}
	}
});
WikitextConstants.ZeroWidthWikitextTags = JSUtils.arrayToSet(zeroWidthTags);

// Freeze constants to prevent accidental changes
JSUtils.deepFreeze(WikitextConstants);

if (typeof module === "object") {
	module.exports.WikitextConstants = WikitextConstants;
}
