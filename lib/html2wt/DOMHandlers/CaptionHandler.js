'use strict';

const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { WTSUtils } = require('../WTSUtils.js');

const DOMHandler = require('./DOMHandler.js');

class CaptionHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		var dp = DOMDataUtils.getDataParsoid(node);
		// Serialize the tag itself
		var tableTag = yield this.serializeTableTag(
			dp.startTagSrc || '|+', null, state, node,
			wrapperUnmodified
		);
		WTSUtils.emitStartTag(tableTag, node, state);
		yield state.serializeChildren(node);
	}
	before(node, otherNode) {
		return otherNode.nodeName !== 'TABLE'
			? { min: 1, max: this.maxNLsInTable(node, otherNode) }
			: { min: 0, max: this.maxNLsInTable(node, otherNode) };
	}
	after(node, otherNode) {
		return { min: 1, max: this.maxNLsInTable(node, otherNode) };
	}
}

module.exports = CaptionHandler;
