/* -------------------------------------------------------------------
 * The WikitextConstant structure holds "global constants" that 
 * capture properties about wikitext markup.
 * 
 * Ex: Valid options for wikitext image markup
 *
 * This structure, over time, can come to serve as useful documentation
 * about Wikitext itself.  For now, this is barebones and sparse.
 * ------------------------------------------------------------------- */

var WikitextConstants = {
	// Valid image options:
	// * Prefix options are of the form "alt=foo"
	// * Simple options are of the form "center"
	//
	// See http://en.wikipedia.org/wiki/Wikipedia:Extended_image_syntax
	// for more information about how they are used.
	Image: {
		PrefixOptions: {
			'link'     : 'link',
			'alt'      : 'alt',
			'page'     : 'page',
			'thumbnail': 'thumbnail',
			'thumb'    : 'thumb',
			'upright'  : 'aspect'
		},
		SimpleOptions: {
			// halign
			'left'  : 'halign',
			'right' : 'halign',
			'center': 'halign',
			'float' : 'halign',
			'none'  : 'halign',

			// valign
			'baseline'   : 'valign',
			'sub'        : 'valign',
			'super'      : 'valign',
			'top'        : 'valign',
			'text-top'   : 'valign',
			'middle'     : 'valign',
			'bottom'     : 'valign',
			'text-bottom': 'valign',

			// format
			'border'   : 'format',
			'frameless': 'format',
			'frame'    : 'format',
			'thumbnail': 'format',
			'thumb'    : 'format'
		}
	},

	Sanitizer: {
		// List of whitelisted tags that can be used as raw HTML in wikitext.
		// All other html/html-like tags will be spit out as text.
		TagWhiteList: [
			// In case you were wondering, explicit <a .. > HTML is NOT allowed in wikitext.
			// That is why the <a> tag is missing from the white-list.
			'abbr',
			// 'body', // SSS FIXME: Required? -- not present in php sanitizer
			'b', 'bdi', 'big', 'blockquote', 'br',
			'caption', 'center', 'cite', 'code',
			'dd', 'del', 'dfn', 'div', 'dl', 'dt',
			'em',
			'font',
			'gallery', // SSS FIXME: comes from an extension? -- not present in php sanitizer
			// 'head', 'html', // SSS FIXME: Required? -- not present in php sanitizer
			'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
			'i', 'ins',
			'kbd',
			'li',
			// 'meta', // SSS FIXME:Required? -- not present in php sanitizer
			'ol',
			'p', 'pre',
			'ref', // SSS FIXME: comes from an extension? -- not present in php sanitizer
			'rb', 'rp', 'rt', 'ruby',
			's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
			'tag', // SSS FIXME: comes from an extension? -- not present in php sanitizer
			'table', 'td', 'th', 'tr', 'tt',
			'u', 'ul'
		]
	}
};

if (typeof module == "object") {
	module.exports.WikitextConstants = WikitextConstants;
}
