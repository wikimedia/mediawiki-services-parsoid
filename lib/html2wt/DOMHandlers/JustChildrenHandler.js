'use strict';

const DOMHandler = require('./DOMHandler.js');

// Just serialize the children, ignore the (implicit) tag
class JustChildrenHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		yield state.serializeChildren(node);
	}
}

module.exports = JustChildrenHandler;
