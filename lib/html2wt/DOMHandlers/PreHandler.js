'use strict';

const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { JSUtils } = require('../../utils/jsutils.js');
const { Util } = require('../../utils/Util.js');

const DOMHandler = require('./DOMHandler.js');

class PreHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		// Handle indent pre

		// XXX: Use a pre escaper?
		var content = yield state.serializeIndentPreChildrenToString(node);
		// Strip (only the) trailing newline
		var trailingNL = content.match(/\n$/);
		content = content.replace(/\n$/, '');

		// Insert indentation
		var solRE = JSUtils.rejoin(
			'(\\n(',
			// SSS FIXME: What happened to the includeonly seen
			// in wts.separators.js?
			Util.COMMENT_REGEXP,
			')*)',
			{ flags: 'g' }
		);
		content = ' ' + content.replace(solRE, '$1 ');

		// But skip "empty lines" (lines with 1+ comment and
		// optional whitespace) since empty-lines sail through all
		// handlers without being affected.
		//
		// See empty_line_with_comments rule in pegTokenizer.pegjs
		//
		// We could use 'split' to split content into lines and
		// selectively add indentation, but the code will get
		// unnecessarily complex for questionable benefits. So, going
		// this route for now.
		var emptyLinesRE = JSUtils.rejoin(
			// This space comes from what we inserted earlier
			/(^|\n) /,
			'((?:',
			/[ \t]*/,
			Util.COMMENT_REGEXP,
			/[ \t]*/,
			')+)',
			/(?=\n|$)/
		);
		content = content.replace(emptyLinesRE, '$1$2');

		state.emitChunk(content, node);

		// Preserve separator source
		state.appendSep((trailingNL && trailingNL[0]) || '');
	}
	before(node, otherNode) {
		if (otherNode.nodeName === 'PRE' &&
			DOMDataUtils.getDataParsoid(otherNode).stx !== 'html') {
			return { min: 2 };
		} else {
			return { min: 1 };
		}
	}
	after(node, otherNode) {
		if (otherNode.nodeName === 'PRE' &&
			DOMDataUtils.getDataParsoid(otherNode).stx !== 'html') {
			return { min: 2 };
		} else {
			return { min: 1 };
		}
	}
	firstChild() {
		return {};
	}
	lastChild() {
		return {};
	}
}

module.exports = PreHandler;
