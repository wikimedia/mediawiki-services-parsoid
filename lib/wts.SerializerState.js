"use strict";

require('./core-upgrade.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Util = require('./mediawiki.Util.js').Util,
	WTSUtils = require('./wts.utils.js').WTSUtils,
	JSUtils = require('./jsutils.js').JSUtils;

/* *********************************************************************
 * Here is what the state attributes mean:
 *
 * rtTesting
 *    Are we currently running round-trip tests?  If yes, then we know
 *    there won't be any edits and we more aggressively try to use original
 *    source and source flags during serialization since this is a test of
 *    Parsoid's efficacy in preserving information.
 *
 * sep
 *    Separator information:
 *    - constraints: min/max number of newlines
 *    - text: collected separator text from DOM text/comment nodes
 *    - lastSourceNode: -- to be documented --
 *
 * onSOL
 *    Is the serializer at the start of a new wikitext line?
 *
 * atStartOfOutput
 *    True when wts kicks off, false after the first char has been output
 *
 * inIndentPre
 *    Is the serializer currently handling indent-pre tags?
 *
 * inPHPBlock
 *    Is the serializer currently handling a tag that the PHP parser
 *    treats as a block tag?
 *
 * wteHandlerStack
 *    Stack of wikitext escaping handlers -- these handlers are responsible
 *    for smart escaping when the surrounding wikitext context is known.
 *
 * currLine
 *    This object is used by the wikitext escaping algorithm -- represents
 *    a "single line" of output wikitext as represented by a block node in
 *    the DOM.
 *
 *    - firstNode: first DOM node processed on this line
 *    - text: output so far from all (unescaped) text nodes on the current line
 *    - processed: has 'text' been analyzed already?
 *    - hasOpenHeadingChar: does the emitted text have an "=" char in sol posn?
 *    - hasOpenBrackets: does the line have open left brackets?
 * ********************************************************************* */

var initialState = {
	rtTesting: true,
	sep: {},
	onSOL: true,
	escapeText: false,
	atStartOfOutput: true, // SSS FIXME: Can this be done away with in some way?
	inIndentPre: false,
	inPHPBlock: false,
	wteHandlerStack: [],
	// XXX: replace with output buffering per line
	currLine: null
};

// Make sure the initialState is never modified
JSUtils.deepFreeze(initialState);

function SerializerState(serializer, options) {
	this.env = serializer.env;
	this.serializer = serializer;
	// Make sure options and initialState are cloned,
	// so we don't alter the initial state for later serializer runs.
	Util.extendProps(this, Util.clone(options), Util.clone(initialState));
	this.resetCurrLine(null);
}

var SSP = SerializerState.prototype;

SSP.resetCurrLine = function(node) {
	this.currLine = {
		text: '',
		firstNode: node,
		processed: false,
		hasOpenHeadingChar: false,
		hasOpenBrackets: false
	};
};

// Serialize the children of a DOM node, sharing the global serializer
// state. Typically called by a DOM-based handler to continue handling its
// children.
SSP.serializeChildren = function(node, chunkCB, wtEscaper) {
	try {
		// TODO gwicke: use nested WikitextSerializer instead?
		var oldSep = this.sep,
			children = node.childNodes,
			child = children[0],
			nextChild;

		// SSS FIXME: Unsure if this is the right thing always
		if (wtEscaper) {
			this.wteHandlerStack.push(wtEscaper);
		}

		while (child) {
			nextChild = this.serializer._serializeNode(child, this, chunkCB);
			if (nextChild === node) {
				// serialized all children
				break;
			} else if (nextChild === child) {
				// advance the child
				child = child.nextSibling;
			} else {
				//console.log('nextChild', nextChild && nextChild.outerHTML);
				child = nextChild;
			}
		}

		if (wtEscaper) {
			this.wteHandlerStack.pop();
		}
	} catch (e) {
		this.env.log("fatal", e);
	}
};

SSP.getOrigSrc = function(start, end) {
	return this.env.page.src.substring(start, end);
};

SSP.emitSep = function(sep, node, cb, debugPrefix) {
	cb(sep, node);

	// Reset separator state
	this.sep = {};
	if (sep && sep.match(/\n/)) {
		this.onSOL = true;
	}

	this.env.log(this.serializer.logType,
		"--->", debugPrefix,
		function() { return JSON.stringify(sep); });
};

SSP.emitSepAndOutput = function(res, node, cb, logPrefix) {
	// Emit separator first
	if (this.prevNodeUnmodified && this.currNodeUnmodified) {
		var origSep = this.getOrigSrc(
			DU.getDataParsoid( this.prevNode ).dsr[1],
			DU.getDataParsoid( node ).dsr[0]
		);
		if (WTSUtils.isValidSep(origSep)) {
			this.emitSep(origSep, node, cb, 'ORIG-SEP:');
		} else {
			this.serializer.emitSeparator(this, cb, node);
		}
	} else {
		this.serializer.emitSeparator(this, cb, node);
	}

	this.prevNode = node;

	if (this.onSOL) {
		this.resetCurrLine(node);
	}

	// Escape 'res' if necessary
	var origRes = res;
	if (this.escapeText) {
		res = this.serializer.wteHandlers.escapeWikiText(this, res, {
			node: node,
			isLastChild: DU.nextNonDeletedSibling(node) === null
		} );
		this.escapeText = false;
	}

	// Emitting text that has not been escaped
	if (DU.isText(node) && res === origRes) {
		this.currLine.text += res;
		this.currLine.processed = false;
	}

	// Output res
	this.env.log(this.serializer.logType, "--->", logPrefix, function() { return JSON.stringify(res); });
	cb(res, node);

	// Update state
	this.sep.lastSourceNode = node;
	this.sep.lastSourceSep = this.sep.src;

	if (!res.match(/^(\s|<!--(?:[^\-]|-(?!->))*-->)*$/)) {
		this.onSOL = false;
	}
};

/**
 * Serialize children to a string.
 * Does not affect the separator state.
 */
SSP.serializeChildrenToString = function(node, wtEscaper, onSOL) {
	// FIXME: Make sure that the separators emitted here conform to the
	// syntactic constraints of syntactic context.
	var bits = '',
		oldSep = this.sep,
		// appendToBits just ignores anything returned but
		// the source, but that is fine. Selser etc is handled in
		// the top level callback at a slightly coarser level.
		appendToBits = function(out) { bits += out; },
		self = this,
		cb = function(res, node) {
			self.emitSepAndOutput(res, node, appendToBits, "OUT(C):");
		};
	this.sep = {};
	if (onSOL !== undefined) {
		this.onSOL = onSOL;
	}
	this.serializeChildren(node, cb, wtEscaper);
	self.serializer.emitSeparator(this, appendToBits, node);
	// restore the separator state
	this.sep = oldSep;
	return bits;
};

SSP.serializeLinkChildrenToString = function(node, wtEscaper, onSOL) {
	this.inLink = true;
	var out = this.serializeChildrenToString(node, wtEscaper, onSOL);
	this.inLink = false;
	return out;
};

if (typeof module === "object") {
	module.exports.SerializerState = SerializerState;
}
