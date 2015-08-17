"use strict";
require('./core-upgrade');
/* -------------------------------------------------------------------
 * The WikitextConstant structure holds "global constants" that
 * capture properties about wikitext markup.
 *
 * Ex: Valid options for wikitext image markup
 *
 * This structure, over time, can come to serve as useful documentation
 * about Wikitext itself.
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
			'img_link':        'link',
			'img_alt':         'alt',
			'img_page':        'page',
			'img_lang':        'lang',  // see T34987
			'img_upright':     'upright',
			'img_width':       'width',
			'img_class':       'class',
			'img_manualthumb': 'manualthumb',
		}),
		/* filled in below, based on PrefixOptions */
		PrefixOptionsReverseMap: new Map(),
		SimpleOptions: JSUtils.mapObject({
			// halign
			'img_left':   'halign',
			'img_right':  'halign',
			'img_center': 'halign',
			'img_none':   'halign',

			// valign
			'img_baseline':    'valign',
			'img_sub':         'valign',
			'img_super':       'valign',
			'img_top':         'valign',
			'img_text_top':    'valign',
			'img_middle':      'valign',
			'img_bottom':      'valign',
			'img_text_bottom': 'valign',

			// format
			// 'border' can be given in addition to *one of*
			// frameless, framed, or thumbnail
			'img_border':    'border',
			'img_frameless': 'format',
			'img_framed':    'format',
			'img_thumbnail': 'format',

			// Ha! Upright can be either one! Try parsing THAT!
			'img_upright': 'upright',
		}),
	},

	Sanitizer: {
		// List of whitelisted tags that can be used as raw HTML in wikitext.
		// All other html/html-like tags will be spit out as text.
		TagWhiteList: new Set([
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
			'RB', 'RP', 'RT', 'RTC', 'RUBY',
			'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP',
			'TABLE', 'TD', 'TH', 'TIME', 'TR', 'TT',
			'U', 'UL',
			'VAR',
			'WBR',
		]),
	},

	// These HTML tags have native wikitext representations.
	// All other HTML tags would have to be emitted as HTML tags in wikitext.
	HTMLTagsWithWTEquivalents: new Set([
		"A", "B", "P", "PRE",
		"HR", "I", "IMG", "LINK", "META",
		"H1", "H2", "H3", "H4", "H5", "H6",
		"OL", "LI", "UL", "DD", "DL", "DT",
		"FIGCAPTION", "FIGURE",
		"TABLE", "TD", "TH", "TR", "CAPTION",
	]),

	// Thse HTML tags will be generated only if
	// the corresponding wikitext occurs in a SOL context.
	HTMLTagsRequiringSOLContext: new Set([
		"PRE",
		"H1", "H2", "H3", "H4", "H5", "H6",
		"OL", "LI", "UL", "DD", "DL", "DT",
	]),

	// These wikitext tags are composed with quote-chars.
	WTQuoteTags: new Set(['I', 'B']),

	// Leading whitespace on new lines in these elements does not lead to indent-pre.
	// This only applies to immediate children (while skipping past zero-wikitext tags).
	// (Ex: content in table-cells induce indent pres)
	WeakIndentPreSuppressingTags: new Set([
		'TABLE', 'TBODY', 'TR',
	]),

	// Leading whitespace on new lines in these elements does not lead to indent-pre
	// This applies to all nested content in these tags.
	// Ex: content in table-cells nested in blocktags do not induce indent pres
	//
	// These tags should match $openmatch regexp in doBlockLevels:
	// $openmatch = preg_match( '/(?:<table|<blockquote|<h1|<h2|<h3|<h4|<h5|<h6|<pre|<tr|<p|<ul|<ol|<dl|<li|<\\/tr|<\\/td|<\\/th)/iS', $t )
	//
	// PHP parser handling is line-based. Our handling is DOM-children based.
	// So, there might be edge cases where behavior will be different.
	//
	// FIXME: <ref> extension tag is another such -- is it possible to fold them
	// into this setup so we can get rid of the 'noPre' hack in token transformers?
	StrongIndentPreSuppressingTags: new Set([
		'BLOCKQUOTE', 'PRE', 'P',
		'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
		'UL', 'OL', 'DL', 'LI',
	]),

	// Leading whitespace on new lines changes wikitext
	// parsing for these tags (*#;:=)
	SolSpaceSensitiveTags: new Set([
		'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
		'UL', 'OL', 'LI', 'DL', 'DD', 'DT',
	]),

	// In the PHP parser, these block tags open block-tag scope
	// See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	BlockScopeOpenTags: new Set([
		'BLOCKQUOTE', 'PRE', 'P',
		'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
		'UL', 'OL', 'LI', 'DL',
		'TABLE', 'TR',
	]),

	// In the PHP parser, these block tags close block-tag scope
	// See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	BlockScopeCloseTags: new Set([
		'TD', 'TH',
	]),

	// Table tags that can be parents
	ParentTableTags: new Set([
		"TABLE", "TBODY", "THEAD", "TFOOT", "TR",
	]),

	// Table tags that can be children
	ChildTableTags: new Set([
		"TBODY", "THEAD", "TFOOT", "TR", "CAPTION", "TH", "TD",
	]),

	HTML: {
		// The list of HTML5 tags, mainly used for the identification of *non*-html tags.
		// Non-html tags terminate otherwise tag-eating rules in the tokenizer
		// to support potential extension tags.
		HTML5Tags: new Set([
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
			"OUTPUT", "P", "PARAM", "PRE", "PROGRESS", "Q", "RB", "RP", "RT",
			"RTC", "RUBY", "S", "SAMP", "SCRIPT", "SECTION", "SELECT", "SMALL",
			// "SOURCE", Support the deprecated <source> alias for syntaxhighlight
			"SPAN", "STRONG", "STYLE", "SUB", "SUMMARY", "SUP",
			"TABLE", "TBODY", "TD", "TEXTAREA", "TFOOT", "TH", "THEAD", "TIME",
			"TITLE", "TR", "TRACK", "U", "UL", "VAR", "VIDEO", "WBR",
		]),

		// From http://www.w3.org/TR/html5-diff/#obsolete-elements
		// SSS FIXME: basefont is missing here, but looks like the PHP parser
		// does not support it anyway and treats it as plain text.  So, skipping
		// this one in Parsoid as well.
		OlderHTMLTags: new Set([
			"STRIKE", "BIG", "CENTER", "FONT", "TT",
		]),

		// https://developer.mozilla.org/en-US/docs/HTML/Block-level_elements
		BlockTags: new Set([
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
			'MAP', 'OBJECT', 'PRE', 'PROGRESS', 'VIDEO',
		]),

		// See http://www.w3.org/html/wg/drafts/html/master/syntax.html#formatting
		FormattingTags: new Set([
			'A', 'B', 'BIG', 'CODE', 'EM', 'FONT', 'I', 'NOBR',
			'S', 'SMALL', 'STRIKE', 'STRONG', 'TT', 'U',
		]),

		ListTags: new Set(['UL', 'OL', 'DL']),

		ListItemTags: new Set(['LI', 'DD', 'DT']),

		FosterablePosition: new Set(['TABLE', 'TBODY', 'TR']),

		TableTags: new Set([
			'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'CAPTION', 'TH', 'TR', 'TD',
		]),

		// See http://www.whatwg.org/specs/web-apps/current-work/#void-elements
		//
		// We are currently treating <source> as an extension tag since this is widely
		// used on wikipedias.  So, we dont want to treat this as a HTML tag => it cannot
		// be a void element
		VoidTags: new Set([
			'AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG',
			'INPUT', 'KEYGEN', 'LINK', 'META', 'PARAM', /* 'SOURCE', */
			'TRACK', 'WBR',
		]),
	},

	// Known wikitext tag widths -- these are known statically
	// but other widths are computed or updated based on actual wikitext usage
	WtTagWidths: JSUtils.mapObject({
		"BODY":   [0, 0],
		"HTML":   [0, 0],
		"HEAD":   [0, 0],
		"P":      [0, 0],
		"META":   [0, 0],
		"TBODY":  [0, 0],
		"PRE":    [1, 0],
		"OL":     [0, 0],
		"UL":     [0, 0],
		"DL":     [0, 0],
		"LI":     [1, 0],
		"DT":     [1, 0],
		"DD":     [1, 0],
		"H1":     [1, 1],
		"H2":     [2, 2],
		"H3":     [3, 3],
		"H4":     [4, 4],
		"H5":     [5, 5],
		"H6":     [6, 6],
		"HR":     [4, 0],
		"TABLE":  [2, 2],
		"TR":     [null, 0],
		"TD":     [null, 0],
		"TH":     [null, 0],
		"B":      [3, 3],
		"I":      [2, 2],
		"BR":     [0, 0],
		"FIGURE": [2, 2],
	}),

	// HTML tags whose wikitext equivalents are zero-width.
	// This information is derived from WtTagWidths and set below.
	ZeroWidthWikitextTags: new Set(),
};

// Fill in reverse map of prefix options.
WikitextConstants.Image.PrefixOptions.forEach(function(v, k) {
	WikitextConstants.Image.PrefixOptionsReverseMap.set(v, k);
});

// Derived information from 'WtTagWidths'
WikitextConstants.WtTagWidths.forEach(function(widths, tag) {
	// This special case can be fixed by maybe removing them WtTagWidths.
	// They may no longer be necessary -- to be investigated in another patch.
	if (tag !== 'HTML' && tag !== 'HEAD' && tag !== 'BODY') {
		if (widths[0] === 0 && widths[1] === 0) {
			WikitextConstants.ZeroWidthWikitextTags.add(tag);
		}
	}
});

// Freeze constants to prevent accidental changes
JSUtils.deepFreeze(WikitextConstants);

if (typeof module === "object") {
	module.exports.WikitextConstants = WikitextConstants;
}
