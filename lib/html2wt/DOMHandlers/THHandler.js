'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { WTSUtils } = require('../WTSUtils.js');

const DOMHandler = require('./DOMHandler.js');

class THHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		var dp = DOMDataUtils.getDataParsoid(node);
		var usableDP = this.stxInfoValidForTableCell(state, node);
		var attrSepSrc = usableDP ? (dp.attrSepSrc || null) : null;
		var startTagSrc = usableDP ? dp.startTagSrc : '';
		if (!startTagSrc) {
			startTagSrc = (usableDP && dp.stx === 'row') ? '!!' : '!';
		}

		// T149209: Special case to deal with scenarios
		// where the previous sibling put us in a SOL state
		// (or will put in a SOL state when the separator is emitted)
		if (state.onSOL || state.sep.constraints.min > 0) {
			// You can use both "!!" and "||" for same-row headings (ugh!)
			startTagSrc = startTagSrc.replace(/!!/, '!')
				.replace(/\|\|/, '!')
				.replace(/{{!}}{{!}}/, '{{!}}');
		}

		const thTag = yield this.serializeTableTag(startTagSrc, attrSepSrc, state, node, wrapperUnmodified);
		const leadingSpace = this.getLeadingSpace(state, node, '');
		// If the HTML for the first th is not enclosed in a tr-tag,
		// we start a new line.  If not, tr will have taken care of it.
		WTSUtils.emitStartTag(thTag + leadingSpace,
			node,
			state
		);
		var thHandler = (state, text, opts) =>
			state.serializer.wteHandlers.thHandler(node, state, text, opts);

		var nextTh = DOMUtils.nextNonSepSibling(node);
		var nextUsesRowSyntax = DOMUtils.isElt(nextTh) && DOMDataUtils.getDataParsoid(nextTh).stx === 'row';

		// For empty cells, emit a single whitespace to make wikitext
		// more readable as well as to eliminate potential misparses.
		if (nextUsesRowSyntax && !DOMUtils.firstNonDeletedChild(node)) {
			state.serializer.emitWikitext(" ", node);
			return;
		}

		yield state.serializeChildren(node, thHandler);

		if (nextUsesRowSyntax && !/\s$/.test(state.currLine.text)) {
			const trailingSpace = this.getTrailingSpace(state, node, '');
			if (trailingSpace) {
				state.appendSep(trailingSpace);
			}
		}
	}
	before(node, otherNode, state) {
		if (otherNode.nodeName === 'TH' &&
			DOMDataUtils.getDataParsoid(node).stx === 'row') {
			// force single line
			return { min: 0, max: this.maxNLsInTable(node, otherNode) };
		} else {
			return { min: 1, max: this.maxNLsInTable(node, otherNode) };
		}
	}
	after(node, otherNode) {
		if (otherNode.nodeName === 'TD') {
			// Force a newline break
			return { min: 1, max: this.maxNLsInTable(node, otherNode) };
		} else {
			return { min: 0, max: this.maxNLsInTable(node, otherNode) };
		}
	}
}

module.exports = THHandler;
