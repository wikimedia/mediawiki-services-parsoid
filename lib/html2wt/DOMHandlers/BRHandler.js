'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');

const DOMHandler = require('./DOMHandler.js');
const PHandler = require('./PHandler.js');

class BRHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) { // eslint-disable-line require-yield
		if (state.singleLineContext.enforced() ||
			DOMDataUtils.getDataParsoid(node).stx === 'html' ||
			node.parentNode.nodeName !== 'P'
		) {
			// <br/> has special newline-based semantics in
			// parser-generated <p><br/>.. HTML
			state.emitChunk('<br />', node);
		}

		// If P_BR (or P_BR_P), dont emit anything for the <br> so that
		// constraints propagate to the next node that emits content.
	}
	before(node, otherNode, state) {
		if (state.singleLineContext.enforced() || !this.isPbr(node)) {
			return {};
		}

		var c = state.sep.constraints || { min: 0 };
		// <h2>..</h2><p><br/>..
		// <p>..</p><p><br/>..
		// In all cases, we need at least 3 newlines before
		// any content that follows the <br/>.
		// Whether we need 4 depends what comes after <br/>.
		// content or a </p>. The after handler deals with it.
		return { min: Math.max(3, c.min + 1), force: true };
	}
	// NOTE: There is an asymmetry in the before/after handlers.
	after(node, otherNode, state) {
		// Note that the before handler has already forced 1 additional
		// newline for all <p><br/> scenarios which simplifies the work
		// of the after handler.
		//
		// Nothing changes with constraints if we are not
		// in a P-P transition. <br/> has special newline-based
		// semantics only in a parser-generated <p><br/>.. HTML.

		if (state.singleLineContext.enforced() ||
			!PHandler.isPPTransition(DOMUtils.nextNonSepSibling(node.parentNode))
		) {
			return {};
		}

		var c = state.sep.constraints || { min: 0 };
		if (this.isPbrP(node)) {
			// The <br/> forces an additional newline when part of
			// a <p><br/></p>.
			//
			// Ex: <p><br/></p><p>..</p> => at least 4 newlines before
			// content of the *next* p-tag.
			return { min: Math.max(4, c.min + 1), force: true };
		} else if (this.isPbr(node)) {
			// Since the <br/> is followed by content, the newline
			// constraint isn't bumped.
			//
			// Ex: <p><br/>..<p><p>..</p> => at least 2 newlines after
			// content of *this* p-tag
			return { min: Math.max(2, c.min), force: true };
		}

		return {};
	}

	isPbr(br) {
		return DOMDataUtils.getDataParsoid(br).stx !== 'html' &&
			br.parentNode.nodeName === 'P' &&
			DOMUtils.firstNonSepChild(br.parentNode) === br;
	}

	isPbrP(br) {
		return this.isPbr(br) && DOMUtils.nextNonSepSibling(br) === null;
	}
}

module.exports = BRHandler;
