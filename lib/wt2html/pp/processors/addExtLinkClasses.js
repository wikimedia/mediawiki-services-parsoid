'use strict';

var Util = require('../../../utils/Util.js').Util;

/**
 * adds a new attribute name and value immediately after an
 * attribute specified in afterName. If afterName is not found
 * the new attribute is appended to the end of the list.
 */
function insertAfter(node, afterName, newName, newVal) {
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
function addExtLinkClasses(env, document) {
	var extLinks = document.body.querySelectorAll('a[rel~="mw:ExtLink"]');
	extLinks.forEach(function(a) {
		var href = a.getAttribute('href');
		// Util.decodeEntities is required because href comes from
		// the DOM's a.getAttribute('href') and content comes from
		// the DOM's inner HTML.
		// Because of this entity normalizing that getAttribute
		// does, we are forced to compare normalize content by
		// decoding entities as well so that the
		// href === content check matches up
		var content = Util.decodeEntities(a.innerHTML);
		var classInfoText = (content === "") ? 'external autonumber' : 'external text';
		if (href === content) {
			classInfoText = 'external free';
		}

		insertAfter(a, 'rel', 'class', classInfoText);
	});
}

if (typeof module === 'object') {
	module.exports.addExtLinkClasses = addExtLinkClasses;
}
