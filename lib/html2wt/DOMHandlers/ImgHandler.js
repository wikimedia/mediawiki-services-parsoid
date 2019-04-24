'use strict';

const DOMHandler = require('./DOMHandler.js');

class ImgHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		if (node.getAttribute('rel') === 'mw:externalImage') {
			state.serializer.emitWikitext(node.getAttribute('src') || '', node);
		} else {
			yield state.serializer.figureHandler(node);
		}
	}
}

module.exports = ImgHandler;
