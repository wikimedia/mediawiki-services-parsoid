'use strict';

const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');

const DOMHandler = require('./DOMHandler.js');

class HRHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) { // eslint-disable-line require-yield
		state.emitChunk('-'.repeat(4 + (DOMDataUtils.getDataParsoid(node).extra_dashes || 0)), node);
	}
	before() {
		return { min: 1, max: 2 };
	}
	// XXX: Add a newline by default if followed by new/modified content
	after() {
		return { min: 0, max: 2 };
	}
}

module.exports = HRHandler;
