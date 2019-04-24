'use strict';

const DOMHandler = require('./DOMHandler.js');

class MediaHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		yield state.serializer.figureHandler(node);
	}
}

module.exports = MediaHandler;
