'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { WTUtils } = require('../../utils/WTUtils.js');

const DOMHandler = require('./DOMHandler.js');

class DDHandler extends DOMHandler {
	constructor(stx) {
		super(stx !== 'row');
		this.stx = stx;
	}
	*handleG(node, state, wrapperUnmodified) {
		var firstChildElement = DOMUtils.firstNonSepChild(node);
		var chunk = (this.stx === 'row') ? ':' : this.getListBullets(state, node);
		if (!DOMUtils.isList(firstChildElement) ||
				WTUtils.isLiteralHTMLNode(firstChildElement)) {
			state.emitChunk(chunk, node);
		}
		var liHandler = (state, text, opts) =>
			state.serializer.wteHandlers.liHandler(node, state, text, opts);
		state.singleLineContext.enforce();
		yield state.serializeChildren(node, liHandler);
		state.singleLineContext.pop();
	}
	before(node, othernode) {
		if (this.stx === 'row') {
			return { min: 0, max: 0 };
		} else {
			return { min: 1, max: 2 };
		}
	}
	after(...args) {
		return this.wtListEOL(...args);
	}
	firstChild(node, otherNode) {
		if (!DOMUtils.isList(otherNode)) {
			return { min: 0, max: 0 };
		} else {
			return {};
		}
	}
}

module.exports = DDHandler;
