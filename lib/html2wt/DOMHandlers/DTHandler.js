'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { WTUtils } = require('../../utils/WTUtils.js');

const DOMHandler = require('./DOMHandler.js');

class DTHandler extends DOMHandler {
	constructor() {
		super(true);
	}
	*handleG(node, state, wrapperUnmodified) {
		var firstChildElement = DOMUtils.firstNonSepChild(node);
		if (!DOMUtils.isList(firstChildElement) ||
				WTUtils.isLiteralHTMLNode(firstChildElement)) {
			state.emitChunk(this.getListBullets(state, node), node);
		}
		var liHandler = (state, text, opts) =>
			state.serializer.wteHandlers.liHandler(node, state, text, opts);
		state.singleLineContext.enforce();
		yield state.serializeChildren(node, liHandler);
		state.singleLineContext.pop();
	}
	before() {
		return { min: 1, max: 2 };
	}
	after(node, otherNode) {
		if (otherNode.nodeName === 'DD' &&
				DOMDataUtils.getDataParsoid(otherNode).stx === 'row') {
			return { min: 0, max: 0 };
		} else {
			return this.wtListEOL(node, otherNode);
		}
	}
	firstChild(node, otherNode) {
		if (!DOMUtils.isList(otherNode)) {
			return { min: 0, max: 0 };
		} else {
			return {};
		}
	}
}

module.exports = DTHandler;
