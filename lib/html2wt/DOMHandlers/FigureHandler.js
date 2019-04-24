'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { WTUtils } = require('../../utils/WTUtils.js');

const DOMHandler = require('./DOMHandler.js');

class FigureHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		yield state.serializer.figureHandler(node);
	}
	before(node) {
		if (
			WTUtils.isNewElt(node) &&
			node.parentNode &&
			DOMUtils.isBody(node.parentNode)
		) {
			return { min: 1 };
		}
		return {};
	}
	after(node) {
		if (
			WTUtils.isNewElt(node) &&
			node.parentNode &&
			DOMUtils.isBody(node.parentNode)
		) {
			return { min: 1 };
		}
		return {};
	}
}

module.exports = FigureHandler;
