'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { WTSUtils } = require('../WTSUtils.js');

const DOMHandler = require('./DOMHandler.js');

class TDHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		var dp = DOMDataUtils.getDataParsoid(node);
		var usableDP = this.stxInfoValidForTableCell(state, node);
		var attrSepSrc = usableDP ? (dp.attrSepSrc || null) : null;
		var startTagSrc = usableDP ? dp.startTagSrc : '';
		if (!startTagSrc) {
			startTagSrc = (usableDP && dp.stx === 'row') ? '||' : '|';
		}

		// T149209: Special case to deal with scenarios
		// where the previous sibling put us in a SOL state
		// (or will put in a SOL state when the separator is emitted)
		if (state.onSOL || state.sep.constraints.min > 0) {
			startTagSrc = startTagSrc.replace(/\|\|/, '|')
				.replace(/{{!}}{{!}}/, '{{!}}');
		}

		// If the HTML for the first td is not enclosed in a tr-tag,
		// we start a new line.  If not, tr will have taken care of it.
		var tdTag = yield this.serializeTableTag(
			startTagSrc, attrSepSrc,
			state, node, wrapperUnmodified
		);
		var inWideTD = /\|\||^{{!}}{{!}}/.test(tdTag);
		const leadingSpace = this.getLeadingSpace(state, node, '');
		WTSUtils.emitStartTag(tdTag + leadingSpace, node, state);
		var tdHandler = (state, text, opts) =>
			state.serializer.wteHandlers.tdHandler(node, inWideTD, state, text, opts);

		var nextTd = DOMUtils.nextNonSepSibling(node);
		var nextUsesRowSyntax = DOMUtils.isElt(nextTd) && DOMDataUtils.getDataParsoid(nextTd).stx === 'row';

		// For empty cells, emit a single whitespace to make wikitext
		// more readable as well as to eliminate potential misparses.
		if (nextUsesRowSyntax && !DOMUtils.firstNonDeletedChild(node)) {
			state.serializer.emitWikitext(" ", node);
			return;
		}

		yield state.serializeChildren(node, tdHandler);

		if (nextUsesRowSyntax && !/\s$/.test(state.currLine.text)) {
			const trailingSpace = this.getTrailingSpace(state, node, '');
			if (trailingSpace) {
				state.appendSep(trailingSpace);
			}
		}
	}
	before(node, otherNode, state) {
		if (otherNode.nodeName === 'TD' &&
			DOMDataUtils.getDataParsoid(node).stx === 'row') {
			// force single line
			return { min: 0, max: this.maxNLsInTable(node, otherNode) };
		} else {
			return { min: 1, max: this.maxNLsInTable(node, otherNode) };
		}
	}
	after(node, otherNode) {
		return { min: 0, max: this.maxNLsInTable(node, otherNode) };
	}
}

module.exports = TDHandler;
