'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { WTUtils } = require('../../utils/WTUtils.js');
const { WTSUtils } = require('../WTSUtils.js');

const DOMHandler = require('./DOMHandler.js');

class TableHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		var dp = DOMDataUtils.getDataParsoid(node);
		var wt = dp.startTagSrc || "{|";
		var indentTable = node.parentNode.nodeName === 'DD' &&
				DOMUtils.previousNonSepSibling(node) === null;
		if (indentTable) {
			state.singleLineContext.disable();
		}
		state.emitChunk(
			yield this.serializeTableTag(wt, '', state, node, wrapperUnmodified),
			node
		);
		if (!WTUtils.isLiteralHTMLNode(node)) {
			state.wikiTableNesting++;
		}
		yield state.serializeChildren(node);
		if (!WTUtils.isLiteralHTMLNode(node)) {
			state.wikiTableNesting--;
		}
		if (!state.sep.constraints) {
			// Special case hack for "{|\n|}" since state.sep is
			// cleared in SSP.emitSep after a separator is emitted.
			// However, for {|\n|}, the <table> tag has no element
			// children which means lastchild -> parent constraint
			// is never computed and set here.
			state.sep.constraints = { min: 1, max: 2 };
		}
		WTSUtils.emitEndTag(dp.endTagSrc || "|}", node, state);
		if (indentTable) {
			state.singleLineContext.pop();
		}
	}
	before(node, otherNode) {
		// Handle special table indentation case!
		if (node.parentNode === otherNode &&
				otherNode.nodeName === 'DD') {
			return { min: 0, max: 2 };
		} else {
			return { min: 1, max: 2 };
		}
	}
	after(node, otherNode) {
		if ((WTUtils.isNewElt(node) || WTUtils.isNewElt(otherNode)) && !DOMUtils.isBody(otherNode)) {
			return { min: 1, max: 2 };
		} else {
			return { min: 0, max: 2 };
		}
	}
	firstChild(node, otherNode) {
		return { min: 1, max: this.maxNLsInTable(node, otherNode) };
	}
	lastChild(node, otherNode) {
		return { min: 1, max: this.maxNLsInTable(node, otherNode) };
	}
}

module.exports = TableHandler;
