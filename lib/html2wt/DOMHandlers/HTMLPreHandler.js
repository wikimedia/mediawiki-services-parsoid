'use strict';

const DOMHandler = require('./DOMHandler.js');
const FallbackHTMLHandler = require('./FallbackHTMLHandler.js');

class HTMLPreHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(...args) {
		yield FallbackHTMLHandler.handler(...args);
	}
	firstChild() {
		return { max: Number.MAX_VALUE };
	}
	lastChild() {
		return { max: Number.MAX_VALUE };
	}
}

module.exports = HTMLPreHandler;
