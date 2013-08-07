"use strict";
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
		PrefixOptions: JSUtils.safeHash({
			'img_link'      : 'link',
			'img_alt'       : 'alt',
			'img_page'      : 'page',
			'img_upright'   : 'upright',
			'img_width'     : 'width',
			'img_class'     : 'class',
			'img_manualthumb': 'manualthumb'
		}),
		/* filled in below, based on PrefixOptions */
		PrefixOptionsReverseMap: Object.create(null),
		SimpleOptions: JSUtils.safeHash({
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
		TagWhiteList: JSUtils.arrayToHash([
			// In case you were wondering, explicit <a .. > HTML is NOT allowed in wikitext.
			// That is why the <a> tag is missing from the white-list.
			'ABBR',
			'B', 'BDI', 'BDO', 'BIG', 'BLOCKQUOTE', 'BR',
			'CAPTION', 'CENTER', 'CITE', 'CODE',
			'DD', 'DEL', 'DFN', 'DIV', 'DL', 'DT',
			'EM',
			'FONT',
			'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR',
			'I', 'INS',
			'KBD',
			'LI',
			'OL',
			'P', 'PRE',
			'Q',
			'RB', 'RP', 'RT', 'RUBY',
			'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP',
			'TABLE', 'TD', 'TH', 'TR', 'TT',
			'U', 'UL', 'WBR'
		])
	},

	// These wikitext tags are composed with quote-chars
	WTQuoteTags: JSUtils.arrayToHash(['I', 'B']),

	// Whitespace in these elements does not lead to indent-pre
	PreSafeTags: JSUtils.arrayToHash(['BR', 'TABLE', 'TBODY', 'CAPTION', 'TR', 'TD', 'TH']),

	// In the PHP parser, these block tags open block-tag scope
	// See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	BlockScopeOpenTags: JSUtils.arrayToHash([
		'P', 'TABLE', 'TR',
		'UL', 'OL', 'LI', 'DL',
		'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
		'BLOCKQUOTE', 'PRE'
	]),

	// In the PHP parser, these block tags close block-tag scope
	// See doBlockLevels in the PHP parser (includes/parser/Parser.php)
	BlockScopeCloseTags: JSUtils.arrayToHash([
		'TD', 'TH'
	]),

	HTML: {
		// The list of HTML5 tags, mainly used for the identification of *non*-html tags.
		// Non-html tags terminate otherwise tag-eating productions in the tokenizer
		// to support potential extension tags.
		HTML5Tags: JSUtils.arrayToHash([
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
		OlderHTMLTags: JSUtils.arrayToHash([
			"STRIKE", "BIG", "CENTER", "FONT", "TT"
		]),

		// https://developer.mozilla.org/en-US/docs/HTML/Block-level_elements
		BlockTags: JSUtils.arrayToHash([
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
		FormattingTags: JSUtils.arrayToHash([
			'A', 'B', 'BIG', 'CODE', 'EM', 'FONT', 'I', 'NOBR',
			'S', 'SMALL', 'STRIKE', 'STRONG', 'TT', 'U'
		]),

		ListTags: JSUtils.arrayToHash(['UL', 'OL', 'DL']),

		ListItemTags: JSUtils.arrayToHash(['LI', 'DD', 'DT']),

		TableTags: JSUtils.arrayToHash([
			'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'CAPTION', 'TH', 'TR', 'TD'
		]),

		// See http://www.whatwg.org/specs/web-apps/current-work/#void-elements
		//
		// We are currently treating <source> as an extension tag since this is widely
		// used on wikipedias.  So, we dont want to treat this as a HTML tag => it cannot
		// be a void element
		VoidTags: JSUtils.arrayToHash([
			'AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG',
			'INPUT', 'KEYGEN', 'LINK', 'META', 'PARAM', /* 'SOURCE', */
			'TRACK', 'WBR'
		])
	}
};

// Fill in reverse map of prefix options.
Object.keys(WikitextConstants.Image.PrefixOptions).forEach(function(k) {
	var v = WikitextConstants.Image.PrefixOptions[k];
	WikitextConstants.Image.PrefixOptionsReverseMap[v] = k;
});

// Quick HACK: define Node constants locally and export it
// for use in other files.
//
// https://developer.mozilla.org/en/nodeType
var Node = {
	ELEMENT_NODE: 1,
	ATTRIBUTE_NODE: 2,
	TEXT_NODE: 3,
	CDATA_SECTION_NODE: 4,
	ENTITY_REFERENCE_NODE: 5,
	ENTITY_NODE: 6,
	PROCESSING_INSTRUCTION_NODE: 7,
	COMMENT_NODE: 8,
	DOCUMENT_NODE: 9,
	DOCUMENT_TYPE_NODE: 10,
	DOCUMENT_FRAGMENT_NODE: 11,
	NOTATION_NODE: 12
};

// Freeze constants to prevent accidental changes
JSUtils.deepFreeze(WikitextConstants);
JSUtils.deepFreeze(Node);

if (typeof module === "object") {
	module.exports.WikitextConstants = WikitextConstants;
	module.exports.Node = Node;
}
