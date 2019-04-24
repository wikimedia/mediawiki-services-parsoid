'use strict';

const { WTUtils } = require('../../utils/WTUtils.js');

const DOMHandler = require('./DOMHandler.js');

class LinkHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		yield state.serializer.linkHandler(node);
	}
	before(node, otherNode) {
		// sol-transparent link nodes are the only thing on their line.
		// But, don't force separators wrt to its parent (body, p, list, td, etc.)
		if (otherNode !== node.parentNode &&
			WTUtils.isSolTransparentLink(node) && !WTUtils.isRedirectLink(node) &&
			!WTUtils.isEncapsulationWrapper(node)) {
			return { min: 1 };
		} else {
			return {};
		}
	}
	after(node, otherNode, state) {
		// sol-transparent link nodes are the only thing on their line
		// But, don't force separators wrt to its parent (body, p, list, td, etc.)
		if (otherNode !== node.parentNode &&
			WTUtils.isSolTransparentLink(node) && !WTUtils.isRedirectLink(node) &&
			!WTUtils.isEncapsulationWrapper(node)) {
			return { min: 1 };
		} else {
			return {};
		}
	}
}

module.exports = LinkHandler;
