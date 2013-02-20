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

var Util = require('./mediawiki.Util.js').Util;

var WikitextConstants = {
	// Valid image options:
	// * Prefix options are of the form "alt=foo"
	// * Simple options are of the form "center"
	//
	// See http://en.wikipedia.org/wiki/Wikipedia:Extended_image_syntax
	// for more information about how they are used.
	Image: {
		PrefixOptions: {
			'img_link'      : 'link',
			'img_alt'       : 'alt',
			'img_page'      : 'page',
			'img_upright'   : 'upright',
			'img_width'     : 'width',
			'img_class'     : 'class'
		},
		PrefixOptionsReverseMap: {
			/* filled in below, based on PrefixOptions */
		},
		SimpleOptions: {
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
			'img_border'    : 'format',
			'img_frameless' : 'format',
			'img_framed'    : 'format',
			'img_thumbnail' : 'format'
		}
	},

	Sanitizer: {
		// List of whitelisted tags that can be used as raw HTML in wikitext.
		// All other html/html-like tags will be spit out as text.
		TagWhiteList: [
			// In case you were wondering, explicit <a .. > HTML is NOT allowed in wikitext.
			// That is why the <a> tag is missing from the white-list.
			'abbr',
			'b', 'bdi', 'big', 'blockquote', 'br',
			'caption', 'center', 'cite', 'code',
			'dd', 'del', 'dfn', 'div', 'dl', 'dt',
			'em',
			'font',
			'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
			'i', 'ins',
			'kbd',
			'li',
			'ol',
			'p', 'pre',
			'rb', 'rp', 'rt', 'ruby',
			's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
			'table', 'td', 'th', 'tr', 'tt',
			'u', 'ul'
		]
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
Util.deepFreeze(WikitextConstants);
Util.deepFreeze(Node);

if (typeof module === "object") {
	module.exports.WikitextConstants = WikitextConstants;
	module.exports.Node = Node;
}
