'use strict';

const { WTUtils } = require('../../../utils/WTUtils.js');

class AddExtLinkClasses {
	/**
	 * Add class info to ExtLink information.
	 * Currently positions the class immediately after the rel attribute
	 * to keep tests stable.
	 */
	run(body, env, options) {
		var extLinks = body.querySelectorAll('a[rel~="mw:ExtLink"]');
		extLinks.forEach((a) => {
			var classInfoText = 'external autonumber';
			if (a.firstChild) {
				classInfoText = 'external text';
				// The "external free" class is reserved for links which
				// are syntactically unbracketed; see commit
				// 65fcb7a94528ea56d461b3c7b9cb4d4fe4e99211 in core.
				if (WTUtils.usesURLLinkSyntax(a)) {
					classInfoText = 'external free';
				} else if (WTUtils.usesMagicLinkSyntax(a)) {
					// PHP uses specific suffixes for RFC/PMID/ISBN (the last of
					// which is an internal link, not an mw:ExtLink), but we'll
					// keep it simple since magic links are deprecated.
					classInfoText = 'external mw-magiclink';
				}
			}

			a.setAttribute('class', classInfoText);
		});
	}
}

if (typeof module === 'object') {
	module.exports.AddExtLinkClasses = AddExtLinkClasses;
}
