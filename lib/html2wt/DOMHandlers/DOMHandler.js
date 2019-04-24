'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { Util } = require('../../utils/Util.js');
const { WTUtils } = require('../../utils/WTUtils.js');
const { WTSUtils } = require('./../WTSUtils.js');

const Promise = require('../../utils/promise.js');

class DOMHandler {
	constructor(forceSOL) {
		this.forceSOL = forceSOL;
		this.handle = Promise.async(this.handleG);
		this.serializeTableTag = Promise.async(this.serializeTableTagG);
		this.serializeTableElement = Promise.async(this.serializeTableElementG);
	}
	*handleG(node, state, wrapperUnmodified) {  // eslint-disable-line require-yield
		throw new Error('Not implemented.');
	}
	before(node, otherNode, state) {
		return {};
	}
	after(node, otherNode, state) {
		return {};
	}
	firstChild(node, otherNode, state) {
		return {};
	}
	lastChild(node, otherNode, state) {
		return {};
	}

	wtListEOL(node, otherNode) {
		if (!DOMUtils.isElt(otherNode) || DOMUtils.isBody(otherNode)) {
			return { min: 0, max: 2 };
		}

		if (WTUtils.isFirstEncapsulationWrapperNode(otherNode)) {
			return { min: DOMUtils.isList(node) ? 1 : 0, max: 2 };
		}

		var nextSibling = DOMUtils.nextNonSepSibling(node);
		var dp = DOMDataUtils.getDataParsoid(otherNode);
		if (nextSibling === otherNode && dp.stx === 'html' || dp.src !== undefined) {
			return { min: 0, max: 2 };
		} else if (nextSibling === otherNode && DOMUtils.isListOrListItem(otherNode)) {
			if (DOMUtils.isList(node) && otherNode.nodeName === node.nodeName) {
				// Adjacent lists of same type need extra newline
				return { min: 2, max: 2 };
			} else if (DOMUtils.isListItem(node) || node.parentNode.nodeName in { LI: 1, DD: 1 }) {
				// Top-level list
				return { min: 1, max: 1 };
			} else {
				return { min: 1, max: 2 };
			}
		} else if (DOMUtils.isList(otherNode) ||
				(DOMUtils.isElt(otherNode) && dp.stx === 'html')) {
			// last child in ul/ol (the list element is our parent), defer
			// separator constraints to the list.
			return {};
		// A list in a block node (<div>, <td>, etc) doesn't need a trailing empty line
		// if it is the last non-separator child (ex: <div>..</ul></div>)
		} else if (DOMUtils.isBlockNode(node.parentNode) && DOMUtils.lastNonSepChild(node.parentNode) === node) {
			return { min: 1, max: 2 };
		} else if (DOMUtils.isFormattingElt(otherNode)) {
			return { min: 1, max: 1 };
		} else {
			return { min: 2, max: 2 };
		}
	}

	/**
	 * List helper: DOM-based list bullet construction.
	 */
	getListBullets(state, node) {
		var parentTypes = {
			ul: '*',
			ol: '#',
		};
		var listTypes = {
			ul: '',
			ol: '',
			dl: '',
			li: '',
			dt: ';',
			dd: ':',
		};

		// For new elements, for prettier wikitext serialization,
		// emit a space after the last bullet (if required)
		var space = this.getLeadingSpace(state, node, ' ');

		var dp, nodeName, parentName;
		var res = '';
		while (node) {
			nodeName = node.nodeName.toLowerCase();
			dp = DOMDataUtils.getDataParsoid(node);

			if (dp.stx !== 'html' && nodeName in listTypes) {
				if (nodeName === 'li') {
					var parentNode = node.parentNode;
					while (parentNode && !(parentNode.nodeName.toLowerCase() in parentTypes)) {
						parentNode = parentNode.parentNode;
					}

					if (parentNode) {
						parentName = parentNode.nodeName.toLowerCase();
						res = parentTypes[parentName] + res;
					} else {
						state.env.log("error/html2wt", "Input DOM is not well-formed.",
							"Top-level <li> found that is not nested in <ol>/<ul>\n LI-node:",
							node.outerHTML);
					}
				} else {
					res = listTypes[nodeName] + res;
				}
			} else if (dp.stx !== 'html' || !dp.autoInsertedStart || !dp.autoInsertedEnd) {
				break;
			}

			node = node.parentNode;
		}

		// Don't emit a space if we aren't returning any bullets.
		return res.length ? res + space : '';
	}

	getLeadingSpace(state, node, newEltDefault) {
		let space = '';
		const fc = DOMUtils.firstNonDeletedChild(node);
		if (WTUtils.isNewElt(node)) {
			if (fc && (!DOMUtils.isText(fc) || !fc.nodeValue.match(/^\s/))) {
				space = newEltDefault;
			}
		} else if (state.useWhitespaceHeuristics && state.selserMode && (!fc || !DOMUtils.isElt(fc))) {
			const dsr = DOMDataUtils.getDataParsoid(node).dsr;
			if (Util.isValidDSR(dsr, true)) {
				const offset = dsr[0] + dsr[2];
				space = offset < (dsr[1] - dsr[3]) ? state.getOrigSrc(offset, offset + 1) : '';
				if (!/[ \t]/.test(space)) {
					space = '';
				}
			}
		}
		return space;
	}

	maxNLsInTable(node, origNode) {
		return WTUtils.isNewElt(node) || WTUtils.isNewElt(origNode) ? 1 : 2;
	}

	*serializeTableElementG(symbol, endSymbol, state, node) {
		var token = WTSUtils.mkTagTk(node);
		var sAttribs = yield state.serializer._serializeAttributes(node, token);
		if (sAttribs.length > 0) {
			// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the
			// '' string is a falsy value and we want to treat it as a
			// truthy value.
			return symbol + ' ' + sAttribs +
				(endSymbol !== null ? endSymbol : ' |');
		} else {
			return symbol + (endSymbol || '');
		}
	}

	*serializeTableTagG(symbol, endSymbol, state, node, wrapperUnmodified) {
		if (wrapperUnmodified) {
			var dsr = DOMDataUtils.getDataParsoid(node).dsr;
			return state.getOrigSrc(dsr[0], dsr[0] + dsr[2]);
		} else {
			return (yield this.serializeTableElement(symbol, endSymbol, state, node));
		}
	}

	stxInfoValidForTableCell(state, node) {
		// If row syntax is not set, nothing to worry about
		if (DOMDataUtils.getDataParsoid(node).stx !== 'row') {
			return true;
		}

		// If we have an identical previous sibling, nothing to worry about
		var prev = DOMUtils.previousNonDeletedSibling(node);
		return prev !== null && prev.nodeName === node.nodeName;
	}

	getTrailingSpace(state, node, newEltDefault) {
		let space = '';
		const lc = DOMUtils.lastNonDeletedChild(node);
		if (WTUtils.isNewElt(node)) {
			if (lc && (!DOMUtils.isText(lc) || !lc.nodeValue.match(/\s$/))) {
				space = newEltDefault;
			}
		} else if (state.useWhitespaceHeuristics && state.selserMode && (!lc || !DOMUtils.isElt(lc))) {
			const dsr = DOMDataUtils.getDataParsoid(node).dsr;
			if (Util.isValidDSR(dsr, true)) {
				const offset = dsr[1] - dsr[3] - 1;
				// The > instead of >= is to deal with an edge case
				// = = where that single space is captured by the
				// getLeadingSpace case above
				space = offset > (dsr[0] + dsr[2]) ? state.getOrigSrc(offset, offset + 1) : '';
				if (!/[ \t]/.test(space)) {
					space = '';
				}
			}
		}

		return space;
	}

	isBuilderInsertedElt(node) {
		if (!DOMUtils.isElt(node)) { return false; }
		var dp = DOMDataUtils.getDataParsoid(node);
		return dp && dp.autoInsertedStart && dp.autoInsertedEnd;
	}

	// Uneditable forms wrapped with mw:Placeholder tags OR unedited nowikis
	// N.B. We no longer emit self-closed nowikis as placeholders, so remove this
	// once all our stored content is updated.
	emitPlaceholderSrc(node, state) {
		var dp = DOMDataUtils.getDataParsoid(node);
		if (/<nowiki\s*\/>/.test(dp.src)) {
			state.hasSelfClosingNowikis = true;
		}
		// FIXME: Should this also check for tabs and plain space
		// chars interspersed with newlines?
		if (dp.src.match(/^\n+$/)) {
			state.appendSep(dp.src);
		} else {
			state.serializer.emitWikitext(dp.src, node);
		}
	}
}

module.exports = DOMHandler;
