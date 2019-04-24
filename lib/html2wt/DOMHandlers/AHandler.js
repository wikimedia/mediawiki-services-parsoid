'use strict';

const DOMHandler = require('./DOMHandler.js');

class AHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		yield state.serializer.linkHandler(node);
	}
	// TODO: Implement link tail escaping with nowiki in DOM handler!
}

module.exports = AHandler;
