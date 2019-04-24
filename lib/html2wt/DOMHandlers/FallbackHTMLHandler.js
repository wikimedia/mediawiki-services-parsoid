'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { TokenUtils } = require('../../utils/TokenUtils.js');
const { WTSUtils } = require('../WTSUtils.js');

const DOMHandler = require('./DOMHandler.js');

const Promise = require('../../utils/promise.js');

/**
 * Used as a fallback in other tag handles.
 */
class FallbackHTMLHandler extends DOMHandler {
	constructor() {
		super(false);
	}

	*handleG(...args) {
		yield FallbackHTMLHandler.handler(...args);
	}

	/**
	 * Just the handler for the handle defined above.
	 * It's also used as a fallback in some of the other tag handles.
	 */
	static *handlerG(node, state, wrapperUnmodified) {
		var serializer = state.serializer;

		// Wikitext supports the following list syntax:
		//
		//    * <li class="a"> hello world
		//
		// The "LI Hack" gives support for this syntax, and we need to
		// specially reconstruct the above from a single <li> tag.
		serializer._handleLIHackIfApplicable(node);

		var tag = yield serializer._serializeHTMLTag(node, wrapperUnmodified);
		WTSUtils.emitStartTag(tag, node, state);

		if (node.hasChildNodes()) {
			var inPHPBlock = state.inPHPBlock;
			if (TokenUtils.tagOpensBlockScope(node.nodeName.toLowerCase())) {
				state.inPHPBlock = true;
			}

			// TODO(arlolra): As of 1.3.0, html pre is considered an extension
			// and wrapped in encapsulation.  When that version is no longer
			// accepted for serialization, we can remove this backwards
			// compatibility code.
			if (node.nodeName === 'PRE') {
				// Handle html-pres specially
				// 1. If the node has a leading newline, add one like it (logic copied from VE)
				// 2. If not, and it has a data-parsoid strippedNL flag, add it back.
				// This patched DOM will serialize html-pres correctly.

				var lostLine = '';
				var fc = node.firstChild;
				if (fc && DOMUtils.isText(fc)) {
					var m = fc.nodeValue.match(/^\n/);
					lostLine = m && m[0] || '';
				}

				if (!lostLine && DOMDataUtils.getDataParsoid(node).strippedNL) {
					lostLine = '\n';
				}

				state.emitChunk(lostLine, node);
			}

			yield state.serializeChildren(node);
			state.inPHPBlock = inPHPBlock;
		}

		var endTag = yield serializer._serializeHTMLEndTag(node, wrapperUnmodified);
		WTSUtils.emitEndTag(endTag, node, state);
	}
}

FallbackHTMLHandler.handler = Promise.async(FallbackHTMLHandler.handlerG);

module.exports = FallbackHTMLHandler;
