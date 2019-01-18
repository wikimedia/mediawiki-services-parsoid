'use strict';

const { WTUtils } = require('../../../utils/WTUtils.js');

class AddExtLinkClasses {
	/**
	 * Adds a new attribute name and value immediately after an
	 * attribute specified in afterName. If afterName is not found
	 * the new attribute is appended to the end of the list.
	 */
	insertAfter(node, afterName, newName, newVal) {
		// ensure existing attribute of newName doesn't interfere
		// with desired positioning
		node.removeAttribute(newName);
		// make a JS array from the DOM NamedNodeList
		var attributes = Array.from(node.attributes);
		// attempt to find the afterName
		var where = 0;
		for (; where < attributes.length; where++) {
			if (attributes[where].name === afterName) {
				break;
			}
		}
		// if we found the afterName key, then removing them from the DOM
		var i;
		for (i = where + 1; i < attributes.length; i++) {
			node.removeAttribute(attributes[i].name);
		}
		// add the new attribute
		node.setAttribute(newName, newVal);

		// add back all stored attributes that were temporarily removed
		for (i = where + 1; i < attributes.length; i++) {
			node.setAttribute(attributes[i].name, attributes[i].value);
		}
	}

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

			this.insertAfter(a, 'rel', 'class', classInfoText);
		});
	}
}

if (typeof module === 'object') {
	module.exports.AddExtLinkClasses = AddExtLinkClasses;
}
