'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { WTSUtils } = require('../WTSUtils.js');

const DOMHandler = require('./DOMHandler.js');

class TRHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		var dp = DOMDataUtils.getDataParsoid(node);

		if (this.trWikitextNeeded(node, dp)) {
			WTSUtils.emitStartTag(
				yield this.serializeTableTag(
					dp.startTagSrc || "|-", '', state,
					node, wrapperUnmodified
				),
				node, state
			);
		}

		yield state.serializeChildren(node);
	}
	before(node, otherNode) {
		if (this.trWikitextNeeded(node, DOMDataUtils.getDataParsoid(node))) {
			return { min: 1, max: this.maxNLsInTable(node, otherNode) };
		} else {
			return { min: 0, max: this.maxNLsInTable(node, otherNode) };
		}
	}
	after(node, otherNode) {
		return { min: 0, max: this.maxNLsInTable(node, otherNode) };
	}

	trWikitextNeeded(node, dp) {
		// If the token has 'startTagSrc' set, it means that the tr
		// was present in the source wikitext and we emit it -- if not,
		// we ignore it.
		// ignore comments and ws
		if (dp.startTagSrc || DOMUtils.previousNonSepSibling(node)) {
			return true;
		} else {
			// If parent has a thead/tbody previous sibling, then
			// we need the |- separation. But, a caption preceded
			// this node's parent, all is good.
			var parentSibling = DOMUtils.previousNonSepSibling(node.parentNode);

			// thead/tbody/tfoot is always present around tr tags in the DOM.
			return parentSibling && parentSibling.nodeName !== 'CAPTION';
		}
	}
}

module.exports = TRHandler;
