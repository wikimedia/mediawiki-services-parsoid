/**
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var Consts = require('../config/WikitextConstants.js').WikitextConstants;

var TokenUtils = {
	/**
	 * Determine if a tag is block-level or not.
	 *
	 * `<video>` is removed from block tags, since it can be phrasing content.
	 * This is necessary for it to render inline.
	 *
	 * @param name
	 */
	isBlockTag: function(name) {
		name = name.toUpperCase();
		return name !== 'VIDEO' && Consts.HTML.HTML4BlockTags.has(name);
	},

	isDOMFragmentType: function(typeOf) {
		return /(?:^|\s)mw:DOMFragment(\/sealed\/\w+)?(?=$|\s)/.test(typeOf);
	},

	/** @property {RegExp} */
	solTransparentLinkRegexp: /(?:^|\s)mw:PageProp\/(?:Category|redirect|Language)(?=$|\s)/,
};

if (typeof module === "object") {
	module.exports.TokenUtils = TokenUtils;
}
