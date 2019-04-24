'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { WTUtils } = require('../../utils/WTUtils.js');

const DOMHandler = require('./DOMHandler.js');

class HeadingHandler extends DOMHandler {
	constructor(headingWT) {
		super(true);
		this.headingWT = headingWT;
	}
	*handleG(node, state, wrapperUnmodified) {
		// For new elements, for prettier wikitext serialization,
		// emit a space after the last '=' char.
		let space = this.getLeadingSpace(state, node, ' ');
		state.emitChunk(this.headingWT + space, node);
		state.singleLineContext.enforce();

		if (node.hasChildNodes()) {
			yield state.serializeChildren(node, undefined, DOMUtils.firstNonDeletedChild(node));
		} else {
			// Deal with empty headings
			state.emitChunk('<nowiki/>', node);
		}

		// For new elements, for prettier wikitext serialization,
		// emit a space before the first '=' char.
		space = this.getTrailingSpace(state, node, ' ');
		state.emitChunk(space + this.headingWT, node); // Why emitChunk here??
		state.singleLineContext.pop();
	}
	before(node, otherNode) {
		if (WTUtils.isNewElt(node) && DOMUtils.previousNonSepSibling(node)) {
			// Default to two preceding newlines for new content
			return { min: 2, max: 2 };
		} else if (WTUtils.isNewElt(otherNode) &&
			DOMUtils.previousNonSepSibling(node) === otherNode) {
			// T72791: The previous node was newly inserted, separate
			// them for readability
			return { min: 2, max: 2 };
		} else {
			return { min: 1, max: 2 };
		}
	}
	after() {
		return { min: 1, max: 2 };
	}
}

module.exports = HeadingHandler;
