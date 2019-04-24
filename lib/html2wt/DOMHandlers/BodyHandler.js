'use strict';

const DOMHandler = require('./DOMHandler.js');

class BodyHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		yield state.serializeChildren(node);
	}
	firstChild() {
		return { min: 0, max: 1 };
	}
	lastChild() {
		return { min: 0, max: 1 };
	}
}

module.exports = BodyHandler;
