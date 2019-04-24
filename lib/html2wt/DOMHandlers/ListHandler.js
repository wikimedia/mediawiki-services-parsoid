'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { WTUtils } = require('../../utils/WTUtils.js');

const DOMHandler = require('./DOMHandler.js');

class ListHandler extends DOMHandler {
	constructor(firstChildNames) {
		super(true);
		this.firstChildNames = firstChildNames;
	}
	*handleG(node, state, wrapperUnmodified) {
		// Disable single-line context here so that separators aren't
		// suppressed between nested list elements.
		state.singleLineContext.disable();

		var firstChildElt = DOMUtils.firstNonSepChild(node);

		// Skip builder-inserted wrappers
		// Ex: <ul><s auto-inserted-start-and-end-><li>..</li><li>..</li></s>...</ul>
		// output from: <s>\n*a\n*b\n*c</s>
		while (firstChildElt && this.isBuilderInsertedElt(firstChildElt)) {
			firstChildElt = DOMUtils.firstNonSepChild(firstChildElt);
		}

		if (!firstChildElt || !(firstChildElt.nodeName in this.firstChildNames) ||
				WTUtils.isLiteralHTMLNode(firstChildElt)) {
			state.emitChunk(this.getListBullets(state, node), node);
		}

		var liHandler = (state, text, opts) =>
			state.serializer.wteHandlers.liHandler(node, state, text, opts);
		yield state.serializeChildren(node, liHandler);
		state.singleLineContext.pop();
	}
	before(node, otherNode) {
		if (DOMUtils.isBody(otherNode)) {
			return { min: 0, max: 0 };
		}

		// node is in a list & otherNode has the same list parent
		// => exactly 1 newline
		if (DOMUtils.isListItem(node.parentNode) && otherNode.parentNode === node.parentNode) {
			return { min: 1, max: 1 };
		}

		// A list in a block node (<div>, <td>, etc) doesn't need a leading empty line
		// if it is the first non-separator child (ex: <div><ul>...</div>)
		if (DOMUtils.isBlockNode(node.parentNode) && DOMUtils.firstNonSepChild(node.parentNode) === node) {
			return { min: 1, max: 2 };
		} else if (DOMUtils.isFormattingElt(otherNode)) {
			return { min: 1, max: 1 };
		} else {
			return { min: 2, max: 2 };
		}
	}
	after(...args) {
		return this.wtListEOL(...args);
	}
}

module.exports = ListHandler;
