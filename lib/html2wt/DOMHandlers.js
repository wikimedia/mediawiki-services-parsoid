/**
 * Definitions of what's loosely defined as the `domHandler` interface.
 *
 * FIXME: Solidify the interface in code.
 * ```
 *   var domHandler = {
 *     handle: Promise.async(function *(node, state, wrapperUnmodified) { ... }),
 *     sepnls: {
 *       before: (node, otherNode, state) => { min: 1, max: 2 },
 *       after: (node, otherNode, state) => { ... },
 *       firstChild: (node, otherNode, state) => { ... },
 *       lastChild: (node, otherNode, state) => { ... },
 *     },
 *   };
 * ```
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var Consts = require('../config/WikitextConstants.js').WikitextConstants;
var DU = require('../utils/DOMUtils.js').DOMUtils;
var JSUtils = require('../utils/jsutils.js').JSUtils;
var Promise = require('../utils/promise.js');
var Util = require('../utils/Util.js').Util;
var WTSUtils = require('./WTSUtils.js').WTSUtils;

// Forward declarations
var _htmlElementHandler;
var htmlElementHandler;

function id(v) {
	return function() { return v; };
}

var genContentSpanTypes = new Set([
	'mw:Nowiki',
	'mw:Image',
	'mw:Image/Frameless',
	'mw:Image/Frame',
	'mw:Image/Thumb',
	'mw:Video',
	'mw:Video/Frameless',
	'mw:Video/Frame',
	'mw:Video/Thumb',
	'mw:Audio',
	'mw:Audio/Frameless',
	'mw:Audio/Frame',
	'mw:Audio/Thumb',
	'mw:Entity',
	'mw:Placeholder',
]);

function isRecognizedSpanWrapper(type) {
	return type && type.split(/\s+/).find(function(t) {
		return genContentSpanTypes.has(t);
	}) !== undefined;
}

function getLeadingSpace(state, node, newEltDefault) {
	let space = '';
	const fc = DU.firstNonDeletedChild(node);
	if (DU.isNewElt(node)) {
		if (fc && (!DU.isText(fc) || !fc.nodeValue.match(/^\s/))) {
			space = newEltDefault;
		}
	} else if (state.useWhitespaceHeuristics && state.selserMode && (!fc || !DU.isElt(fc))) {
		const dsr = DU.getDataParsoid(node).dsr;
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

function getTrailingSpace(state, node, newEltDefault) {
	let space = '';
	const lc = DU.lastNonDeletedChild(node);
	if (DU.isNewElt(node)) {
		if (lc && (!DU.isText(lc) || !lc.nodeValue.match(/\s$/))) {
			space = newEltDefault;
		}
	} else if (state.useWhitespaceHeuristics && state.selserMode && (!lc || !DU.isElt(lc))) {
		const dsr = DU.getDataParsoid(node).dsr;
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

function buildHeadingHandler(headingWT) {
	return {
		forceSOL: true,
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			// For new elements, for prettier wikitext serialization,
			// emit a space after the last '=' char.
			let space = getLeadingSpace(state, node, ' ');
			state.emitChunk(headingWT + space, node);
			state.singleLineContext.enforce();

			if (node.hasChildNodes()) {
				yield state.serializeChildren(node, undefined, DU.firstNonDeletedChild(node));
			} else {
				// Deal with empty headings
				state.emitChunk('<nowiki/>', node);
			}

			// For new elements, for prettier wikitext serialization,
			// emit a space before the first '=' char.
			space = getTrailingSpace(state, node, ' ');
			state.emitChunk(space + headingWT, node); // Why emitChunk here??
			state.singleLineContext.pop();
		}),
		sepnls: {
			before: function(node, otherNode) {
				if (DU.isNewElt(node) && DU.previousNonSepSibling(node)) {
					// Default to two preceding newlines for new content
					return { min: 2, max: 2 };
				} else if (DU.isNewElt(otherNode) &&
					DU.previousNonSepSibling(node) === otherNode) {
					// T72791: The previous node was newly inserted, separate
					// them for readability
					return { min: 2, max: 2 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: id({ min: 1, max: 2 }),
		},
	};
}

/**
 * List helper: DOM-based list bullet construction.
 * @private
 */
function getListBullets(state, node) {
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
	var space = getLeadingSpace(state, node, ' ');

	var dp, nodeName, parentName;
	var res = '';
	while (node) {
		nodeName = node.nodeName.toLowerCase();
		dp = DU.getDataParsoid(node);

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

function wtListEOL(node, otherNode) {
	if (!DU.isElt(otherNode) || DU.isBody(otherNode)) {
		return { min: 0, max: 2 };
	}

	if (DU.isFirstEncapsulationWrapperNode(otherNode)) {
		return { min: DU.isList(node) ? 1 : 0, max: 2 };
	}

	var nextSibling = DU.nextNonSepSibling(node);
	var dp = DU.getDataParsoid(otherNode);
	if (nextSibling === otherNode && dp.stx === 'html' || dp.src !== undefined) {
		return { min: 0, max: 2 };
	} else if (nextSibling === otherNode && DU.isListOrListItem(otherNode)) {
		if (DU.isList(node) && otherNode.nodeName === node.nodeName) {
			// Adjacent lists of same type need extra newline
			return { min: 2, max: 2 };
		} else if (DU.isListItem(node) || node.parentNode.nodeName in { LI: 1, DD: 1 }) {
			// Top-level list
			return { min: 1, max: 1 };
		} else {
			return { min: 1, max: 2 };
		}
	} else if (DU.isList(otherNode) ||
			(DU.isElt(otherNode) && dp.stx === 'html')) {
		// last child in ul/ol (the list element is our parent), defer
		// separator constraints to the list.
		return {};
	// A list in a block node (<div>, <td>, etc) doesn't need a trailing empty line
	// if it is the last non-separator child (ex: <div>..</ul></div>)
	} else if (DU.isBlockNode(node.parentNode) && DU.lastNonSepChild(node.parentNode) === node) {
		return { min: 1, max: 2 };
	} else if (DU.isFormattingElt(otherNode)) {
		return { min: 1, max: 1 };
	} else {
		return { min: 2, max: 2 };
	}
}

// Normally we wait until hitting the deepest nested list element before
// emitting bullets. However, if one of those list elements is about-id
// marked, the tag handler will serialize content from data-mw parts or src.
// This is a problem when a list wasn't assigned the shared prefix of bullets.
// For example,
//
//   ** a
//   ** b
//
// Will assign bullets as,
//
// <ul><li-*>
//   <ul>
//     <li-*> a</li>   <!-- no shared prefix  -->
//     <li-**> b</li>  <!-- gets both bullets -->
//   </ul>
// </li></ul>
//
// For the b-li, getListsBullets will walk up and emit the two bullets it was
// assigned. If it was about-id marked, the parts would contain the two bullet
// start tag it was assigned. However, for the a-li, only one bullet is
// associated. When it's about-id marked, serializing the data-mw parts or
// src would miss the bullet assigned to the container li.
function isTplListWithoutSharedPrefix(node) {
	if (!DU.isEncapsulationWrapper(node)) {
		return false;
	}

	var typeOf = node.getAttribute("typeof") || '';

	if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
		// If the first part is a string, template ranges were expanded to
		// include this list element. That may be trouble. Otherwise,
		// containers aren't part of the template source and we should emit
		// them.
		var dataMw = DU.getDataMw(node);
		if (!dataMw.parts || typeof dataMw.parts[0] !== "string") {
			return true;
		}
		// Less than two bullets indicates that a shared prefix was not
		// assigned to this element. A safe indication that we should call
		// getListsBullets on the containing list element.
		return !/^[*#:;]{2,}$/.test(dataMw.parts[0]);
	} else if (/(?:^|\s)mw:(Extension|Param)/.test(typeOf)) {
		// Containers won't ever be part of the src here, so emit them.
		return true;
	} else {
		return false;
	}
}

function isBuilderInsertedElt(node) {
	var dp = DU.getDataParsoid(node);
	return dp && dp.autoInsertedStart && dp.autoInsertedEnd;
}

function buildListHandler(firstChildNames) {
	return {
		forceSOL: true,
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			// Disable single-line context here so that separators aren't
			// suppressed between nested list elements.
			state.singleLineContext.disable();

			var firstChildElt = DU.firstNonSepChild(node);

			// Skip builder-inserted wrappers
			// Ex: <ul><s auto-inserted-start-and-end-><li>..</li><li>..</li></s>...</ul>
			// output from: <s>\n*a\n*b\n*c</s>
			while (firstChildElt && isBuilderInsertedElt(firstChildElt)) {
				firstChildElt = DU.firstNonSepChild(firstChildElt);
			}

			if (!firstChildElt || !(firstChildElt.nodeName in firstChildNames) ||
					DU.isLiteralHTMLNode(firstChildElt)) {
				state.emitChunk(getListBullets(state, node), node);
			}

			var liHandler = state.serializer.wteHandlers.liHandler
					.bind(state.serializer.wteHandlers, node);
			yield state.serializeChildren(node, liHandler);
			state.singleLineContext.pop();
		}),
		sepnls: {
			before: function(node, otherNode) {
				if (DU.isBody(otherNode)) {
					return { min: 0, max: 0 };
				}

				// node is in a list & otherNode has the same list parent
				// => exactly 1 newline
				if (DU.isListItem(node.parentNode) && otherNode.parentNode === node.parentNode) {
					return { min: 1, max: 1 };
				}

				// A list in a block node (<div>, <td>, etc) doesn't need a leading empty line
				// if it is the first non-separator child (ex: <div><ul>...</div>)
				if (DU.isBlockNode(node.parentNode) && DU.firstNonSepChild(node.parentNode) === node) {
					return { min: 1, max: 2 };
				} else if (DU.isFormattingElt(otherNode)) {
					return { min: 1, max: 1 };
				} else {
					return { min: 2, max: 2 };
				}
			},
			after: wtListEOL,
		},
	};
}

function buildDDHandler(stx) {
	return {
		forceSOL: stx !== 'row',
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var firstChildElement = DU.firstNonSepChild(node);
			var chunk = (stx === 'row') ? ':' : getListBullets(state, node);
			if (!DU.isList(firstChildElement) ||
					DU.isLiteralHTMLNode(firstChildElement)) {
				state.emitChunk(chunk, node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler
					.bind(state.serializer.wteHandlers, node);
			state.singleLineContext.enforce();
			yield state.serializeChildren(node, liHandler);
			state.singleLineContext.pop();
		}),
		sepnls: {
			before: function(node, othernode) {
				if (stx === 'row') {
					return { min: 0, max: 0 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: wtListEOL,
			firstChild: function(node, otherNode) {
				if (!DU.isList(otherNode)) {
					return { min: 0, max: 0 };
				} else {
					return {};
				}
			},
		},
	};
}

// IMPORTANT: Do not start walking from line.firstNode forward. Always
// walk backward from node. This is because in selser mode, it looks like
// line.firstNode doesn't always correspond to the wikitext line that is
// being processed since the previous emitted node might have been an unmodified
// DOM node that generated multiple wikitext lines.
function currWikitextLineHasBlockNode(line, node, skipNode) {
	var parentNode = node.parentNode;
	if (!skipNode) {
		// If this node could break this wikitext line and emit
		// non-ws content on a new line, the P-tag will be on that new line
		// with text content that needs P-wrapping.
		if (/\n[^\s]/.test(node.textContent)) {
			return false;
		}
	}
	node = DU.previousNonDeletedSibling(node);
	while (!node || !DU.atTheTop(node)) {
		while (node) {
			// If we hit a block node that will render on the same line, we are done!
			if (DU.isBlockNodeWithVisibleWT(node)) {
				return true;
			}

			// If this node could break this wikitext line, we are done.
			// This is conservative because textContent could be looking at descendents
			// of 'node' that may not have been serialized yet. But this is safe.
			if (/\n/.test(node.textContent)) {
				return false;
			}

			node = DU.previousNonDeletedSibling(node);

			// Don't go past the current line in any case.
			if (line.firstNode && DU.isAncestorOf(node, line.firstNode)) {
				return false;
			}
		}
		node = parentNode;
		parentNode = node.parentNode;
	}

	return false;
}

function newWikitextLineMightHaveBlockNode(node) {
	node = DU.nextNonDeletedSibling(node);
	while (node) {
		if (DU.isText(node)) {
			// If this node will break this wikitext line, we are done!
			if (node.nodeValue.match(/\n/)) {
				return false;
			}
		} else if (DU.isElt(node)) {
			// These tags will always serialize onto a new line
			if (Consts.HTMLTagsRequiringSOLContext.has(node.nodeName) &&
					!DU.isLiteralHTMLNode(node)) {
				return false;
			}

			// We hit a block node that will render on the same line
			if (DU.isBlockNodeWithVisibleWT(node)) {
				return true;
			}

			// Go conservative
			return false;
		}

		node = DU.nextNonDeletedSibling(node);
	}
	return false;
}

function precedingQuoteEltRequiresEscape(node) {
	// * <i> and <b> siblings don't need a <nowiki/> separation
	//   as long as quote chars in text nodes are always
	//   properly escaped -- which they are right now.
	//
	// * Adjacent quote siblings need a <nowiki/> separation
	//   between them if either of them will individually
	//   generate a sequence of quotes 4 or longer. That can
	//   only happen when either prev or node is of the form:
	//   <i><b>...</b></i>
	//
	//   For new/edited DOMs, this can never happen because
	//   wts.minimizeQuoteTags.js does quote tag minimization.
	//
	//   For DOMs from existing wikitext, this can only happen
	//   because of auto-inserted end/start tags. (Ex: ''a''' b ''c''')
	var prev = DU.previousNonDeletedSibling(node);
	return prev && DU.isQuoteElt(prev) && (
		DU.isQuoteElt(DU.lastNonDeletedChild(prev)) ||
		DU.isQuoteElt(DU.firstNonDeletedChild(node)));
}

function buildQuoteHandler(quotes) {
	return {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			if (precedingQuoteEltRequiresEscape(node)) {
				WTSUtils.emitStartTag('<nowiki/>', node, state);
			}
			WTSUtils.emitStartTag(quotes, node, state);

			if (!node.hasChildNodes()) {
				// Empty nodes like <i></i> or <b></b> need
				// a <nowiki/> in place of the empty content so that
				// they parse back identically.
				if (WTSUtils.emitEndTag(quotes, node, state, true)) {
					WTSUtils.emitStartTag('<nowiki/>', node, state);
					WTSUtils.emitEndTag(quotes, node, state);
				}
			} else {
				yield state.serializeChildren(node);
				WTSUtils.emitEndTag(quotes, node, state);
			}
		}),
	};
}

var serializeTableElement = Promise.async(function *(symbol, endSymbol, state, node) {
	var token = DU.mkTagTk(node);
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
});

var serializeTableTag = Promise.async(function *(symbol, endSymbol, state, node, wrapperUnmodified) { // eslint-disable-line require-yield
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid(node).dsr;
		return state.getOrigSrc(dsr[0], dsr[0] + dsr[2]);
	} else {
		return (yield serializeTableElement(symbol, endSymbol, state, node));
	}
});

// Just serialize the children, ignore the (implicit) tag
var justChildren = {
	handle: Promise.async(function *(node, state, wrapperUnmodified) {
		yield state.serializeChildren(node);
	}),
};

function stxInfoValidForTableCell(state, node) {
	// If row syntax is not set, nothing to worry about
	if (DU.getDataParsoid(node).stx !== 'row') {
		return true;
	}

	// If we have an identical previous sibling, nothing to worry about
	var prev = DU.previousNonDeletedSibling(node);
	return prev !== null && prev.nodeName === node.nodeName;
}

// node is being serialized before/after a P-tag.
// While computing newline constraints, this function tests
// if node should be treated as a P-wrapped node
function treatAsPPTransition(node) {
	// Treat text/p similar to p/p transition
	// If an element, it should not be a:
	// * block node or literal HTML node
	// * template wrapper
	// * mw:Includes meta or a SOL-transparent link
	return DU.isText(node) || (
		!DU.isBody(node) &&
		!DU.isBlockNode(node) &&
		!DU.isLiteralHTMLNode(node) &&
		!DU.isEncapsulationWrapper(node) &&
		!DU.isSolTransparentLink(node) &&
		!(/^mw:Includes\//.test(node.getAttribute('typeof'))));
}

function isPPTransition(node) {
	return node &&
		((node.nodeName === 'P' && DU.getDataParsoid(node).stx !== 'html') ||
		treatAsPPTransition(node));

}

// Uneditable forms wrapped with mw:Placeholder tags OR unedited nowikis
// N.B. We no longer emit self-closed nowikis as placeholders, so remove this
// once all our stored content is updated.
function emitPlaceholderSrc(node, state) {
	var dp = DU.getDataParsoid(node);
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

function trWikitextNeeded(node, dp) {
	// If the token has 'startTagSrc' set, it means that the tr
	// was present in the source wikitext and we emit it -- if not,
	// we ignore it.
	// ignore comments and ws
	if (dp.startTagSrc || DU.previousNonSepSibling(node)) {
		return true;
	} else {
		// If parent has a thead/tbody previous sibling, then
		// we need the |- separation. But, a caption preceded
		// this node's parent, all is good.
		var parentSibling = DU.previousNonSepSibling(node.parentNode);

		// thead/tbody/tfoot is always present around tr tags in the DOM.
		return parentSibling && parentSibling.nodeName !== 'CAPTION';
	}
}

function maxNLsInTable(node, origNode) {
	return DU.isNewElt(node) || DU.isNewElt(origNode) ? 1 : 2;
}

function isPbr(br) {
	return DU.getDataParsoid(br).stx !== 'html' && br.parentNode.nodeName === 'P' && DU.firstNonSepChild(br.parentNode) === br;
}

function isPbrP(br) {
	return isPbr(br) && DU.nextNonSepSibling(br) === null;
}

/**
 * A map of `domHandler`s keyed on nodeNames.
 *
 * Includes specialized keys of the form: `nodeName + '_' + dp.stx`
 * @namespace
 */
var tagHandlers = JSUtils.mapObject({
	audio: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			yield state.serializer.figureHandler(node);
		}),
	},

	b: buildQuoteHandler("'''"),
	i: buildQuoteHandler("''"),

	dl: buildListHandler({ DT: 1, DD: 1 }),
	ul: buildListHandler({ LI: 1 }),
	ol: buildListHandler({ LI: 1 }),

	li: {
		forceSOL: true,
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var firstChildElement = DU.firstNonSepChild(node);
			if (!DU.isList(firstChildElement) ||
					DU.isLiteralHTMLNode(firstChildElement)) {
				state.emitChunk(getListBullets(state, node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler
					.bind(state.serializer.wteHandlers, node);
			state.singleLineContext.enforce();
			yield state.serializeChildren(node, liHandler);
			state.singleLineContext.pop();
		}),
		sepnls: {
			before: function(node, otherNode) {
				if ((otherNode === node.parentNode && otherNode.nodeName in { UL: 1, OL: 1 }) ||
					(DU.isElt(otherNode) && DU.getDataParsoid(otherNode).stx === 'html')) {
					return {};
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: wtListEOL,
			firstChild: function(node, otherNode) {
				if (!DU.isList(otherNode)) {
					return { min: 0, max: 0 };
				} else {
					return {};
				}
			},
		},
	},

	dt: {
		forceSOL: true,
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var firstChildElement = DU.firstNonSepChild(node);
			if (!DU.isList(firstChildElement) ||
					DU.isLiteralHTMLNode(firstChildElement)) {
				state.emitChunk(getListBullets(state, node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler
					.bind(state.serializer.wteHandlers, node);
			state.singleLineContext.enforce();
			yield state.serializeChildren(node, liHandler);
			state.singleLineContext.pop();
		}),
		sepnls: {
			before: id({ min: 1, max: 2 }),
			after: function(node, otherNode) {
				if (otherNode.nodeName === 'DD' &&
						DU.getDataParsoid(otherNode).stx === 'row') {
					return { min: 0, max: 0 };
				} else {
					return wtListEOL(node, otherNode);
				}
			},
			firstChild: function(node, otherNode) {
				if (!DU.isList(otherNode)) {
					return { min: 0, max: 0 };
				} else {
					return {};
				}
			},
		},
	},

	dd_row: buildDDHandler('row'), // single-line dt/dd
	dd: buildDDHandler(), // multi-line dt/dd

	// XXX: handle options
	table: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);
			var wt = dp.startTagSrc || "{|";
			var indentTable = node.parentNode.nodeName === 'DD' &&
					DU.previousNonSepSibling(node) === null;
			if (indentTable) {
				state.singleLineContext.disable();
			}
			state.emitChunk(
				yield serializeTableTag(wt, '', state, node, wrapperUnmodified),
				node
			);
			if (!DU.isLiteralHTMLNode(node)) {
				state.wikiTableNesting++;
			}
			yield state.serializeChildren(node);
			if (!DU.isLiteralHTMLNode(node)) {
				state.wikiTableNesting--;
			}
			if (!state.sep.constraints) {
				// Special case hack for "{|\n|}" since state.sep is
				// cleared in SSP.emitSep after a separator is emitted.
				// However, for {|\n|}, the <table> tag has no element
				// children which means lastchild -> parent constraint
				// is never computed and set here.
				state.sep.constraints = { a: {}, b: {}, min: 1, max: 2 };
			}
			WTSUtils.emitEndTag(dp.endTagSrc || "|}", node, state);
			if (indentTable) {
				state.singleLineContext.pop();
			}
		}),
		sepnls: {
			before: function(node, otherNode) {
				// Handle special table indentation case!
				if (node.parentNode === otherNode &&
						otherNode.nodeName === 'DD') {
					return { min: 0, max: 2 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: function(node, otherNode) {
				if ((DU.isNewElt(node) || DU.isNewElt(otherNode)) && !DU.isBody(otherNode)) {
					return { min: 1, max: 2 };
				} else {
					return { min: 0, max: 2 };
				}
			},
			firstChild: function(node, otherNode) {
				return { min: 1, max: maxNLsInTable(node, otherNode) };
			},
			lastChild: function(node, otherNode) {
				return { min: 1, max: maxNLsInTable(node, otherNode) };
			},
		},
	},
	tbody: justChildren,
	thead: justChildren,
	tfoot: justChildren,
	tr: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);

			if (trWikitextNeeded(node, dp)) {
				WTSUtils.emitStartTag(
					yield serializeTableTag(
						dp.startTagSrc || "|-", '', state,
						node, wrapperUnmodified
					),
					node, state
				);
			}

			yield state.serializeChildren(node);
		}),
		sepnls: {
			before: function(node, otherNode) {
				if (trWikitextNeeded(node, DU.getDataParsoid(node))) {
					return { min: 1, max: maxNLsInTable(node, otherNode) };
				} else {
					return { min: 0, max: maxNLsInTable(node, otherNode) };
				}
			},
			after: function(node, otherNode) {
				return { min: 0, max: maxNLsInTable(node, otherNode) };
			},
		},
	},
	th: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);
			var usableDP = stxInfoValidForTableCell(state, node);
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

			const thTag = yield serializeTableTag(startTagSrc, attrSepSrc, state, node, wrapperUnmodified);
			const leadingSpace = getLeadingSpace(state, node, '');
			// If the HTML for the first th is not enclosed in a tr-tag,
			// we start a new line.  If not, tr will have taken care of it.
			WTSUtils.emitStartTag(thTag + leadingSpace,
				node,
				state
			);
			var thHandler = state.serializer.wteHandlers.thHandler
				.bind(state.serializer.wteHandlers, node);

			var nextTh = DU.nextNonDeletedSibling(node);
			var nextUsesRowSyntax = nextTh && DU.getDataParsoid(nextTh).stx === 'row';

			// For empty cells, emit a single whitespace to make wikitext
			// more readable as well as to eliminate potential misparses.
			if (nextUsesRowSyntax && !DU.firstNonDeletedChild(node)) {
				state.serializer.emitWikitext(" ", node);
				return;
			}

			yield state.serializeChildren(node, thHandler);

			if (nextUsesRowSyntax && !/\s$/.test(state.currLine.text)) {
				const trailingSpace = getTrailingSpace(state, node, '');
				if (trailingSpace) {
					state.appendSep(trailingSpace);
				}
			}
		}),
		sepnls: {
			before: function(node, otherNode, state) {
				if (otherNode.nodeName === 'TH' &&
					DU.getDataParsoid(node).stx === 'row') {
					// force single line
					return { min: 0, max: maxNLsInTable(node, otherNode) };
				} else {
					return { min: 1, max: maxNLsInTable(node, otherNode) };
				}
			},
			after: function(node, otherNode) {
				if (otherNode.nodeName === 'TD') {
					// Force a newline break
					return { min: 1, max: maxNLsInTable(node, otherNode) };
				} else {
					return { min: 0, max: maxNLsInTable(node, otherNode) };
				}
			},
		},
	},
	td: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);
			var usableDP = stxInfoValidForTableCell(state, node);
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
			var tdTag = yield serializeTableTag(
				startTagSrc, attrSepSrc,
				state, node, wrapperUnmodified
			);
			var inWideTD = /\|\||^{{!}}{{!}}/.test(tdTag);
			const leadingSpace = getLeadingSpace(state, node, '');
			WTSUtils.emitStartTag(tdTag + leadingSpace, node, state);
			var tdHandler = state.serializer.wteHandlers.tdHandler
				.bind(state.serializer.wteHandlers, node, inWideTD);

			var nextTd = DU.nextNonDeletedSibling(node);
			var nextUsesRowSyntax = nextTd && DU.getDataParsoid(nextTd).stx === 'row';

			// For empty cells, emit a single whitespace to make wikitext
			// more readable as well as to eliminate potential misparses.
			if (nextUsesRowSyntax && !DU.firstNonDeletedChild(node)) {
				state.serializer.emitWikitext(" ", node);
				return;
			}

			yield state.serializeChildren(node, tdHandler);

			if (nextUsesRowSyntax && !/\s$/.test(state.currLine.text)) {
				const trailingSpace = getTrailingSpace(state, node, '');
				if (trailingSpace) {
					state.appendSep(trailingSpace);
				}
			}
		}),
		sepnls: {
			before: function(node, otherNode, state) {
				if (otherNode.nodeName === 'TD' &&
					DU.getDataParsoid(node).stx === 'row') {
					// force single line
					return { min: 0, max: maxNLsInTable(node, otherNode) };
				} else {
					return { min: 1, max: maxNLsInTable(node, otherNode) };
				}
			},
			after: function(node, otherNode) {
				return { min: 0, max: maxNLsInTable(node, otherNode) };
			},
		},
	},
	caption: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);
			// Serialize the tag itself
			var tableTag = yield serializeTableTag(
				dp.startTagSrc || '|+', null, state, node,
				wrapperUnmodified
			);
			WTSUtils.emitStartTag(tableTag, node, state);
			yield state.serializeChildren(node);
		}),
		sepnls: {
			before: function(node, otherNode) {
				return otherNode.nodeName !== 'TABLE' ?
					{ min: 1, max: maxNLsInTable(node, otherNode) } :
					{ min: 0, max: maxNLsInTable(node, otherNode) };
			},
			after: function(node, otherNode) {
				return { min: 1, max: maxNLsInTable(node, otherNode) };
			},
		},
	},
	// Insert the text handler here too?
	'#text': { },
	p: {

		// Counterintuitive but seems right.
		// Otherwise the generated wikitext will parse as an indent-pre
		// escapeWikitext nowiking will deal with leading space for content
		// inside the p-tag, but forceSOL suppresses whitespace before the p-tag.
		forceSOL: true,
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			// XXX: Handle single-line mode by switching to HTML handler!
			yield state.serializeChildren(node);
		}),
		sepnls: {
			before: function(node, otherNode, state) {
				var otherNodeName = otherNode.nodeName;
				var tableCellOrBody = new Set(['TD', 'TH', 'BODY']);
				if (node.parentNode === otherNode &&
					(DU.isListItem(otherNode) || tableCellOrBody.has(otherNodeName))) {
					if (tableCellOrBody.has(otherNodeName)) {
						return { min: 0, max: 1 };
					} else {
						return { min: 0, max: 0 };
					}
				} else if (
					otherNode === DU.previousNonDeletedSibling(node) &&
					// p-p transition
					(otherNodeName === 'P' && DU.getDataParsoid(otherNode).stx !== 'html') ||
					(
						treatAsPPTransition(otherNode) &&
						otherNode === DU.previousNonSepSibling(node) &&
						// A new wikitext line could start at this P-tag. We have to figure out
						// if 'node' needs a separation of 2 newlines from that P-tag. Examine
						// previous siblings of 'node' to see if we emitted a block tag
						// there => we can make do with 1 newline separator instead of 2
						// before the P-tag.
						!currWikitextLineHasBlockNode(state.currLine, otherNode)
					)
				) {
					return { min: 2, max: 2 };
				} else if (treatAsPPTransition(otherNode) ||
					(DU.isBlockNode(otherNode) && otherNode.nodeName !== 'BLOCKQUOTE' && node.parentNode === otherNode) ||
					// new p-node added after sol-transparent wikitext should always
					// get serialized onto a new wikitext line.
					(DU.emitsSolTransparentSingleLineWT(otherNode) && DU.isNewElt(node))
				) {
					if (!DU.hasAncestorOfName(otherNode, "FIGCAPTION")) {
						return { min: 1, max: 2 };
					} else {
						return { min: 0, max: 2 };
					}
				} else {
					return { min: 0, max: 2 };
				}
			},
			after: function(node, otherNode, state) {
				if (!(node.lastChild && node.lastChild.nodeName === 'BR')
					&& isPPTransition(otherNode)
					// A new wikitext line could start at this P-tag. We have to figure out
					// if 'node' needs a separation of 2 newlines from that P-tag. Examine
					// previous siblings of 'node' to see if we emitted a block tag
					// there => we can make do with 1 newline separator instead of 2
					// before the P-tag.
					&& !currWikitextLineHasBlockNode(state.currLine, node, true)
					// Since we are going to emit newlines before the other P-tag, we know it
					// is going to start a new wikitext line. We have to figure out if 'node'
					// needs a separation of 2 newlines from that P-tag. Examine following
					// siblings of 'node' to see if we might emit a block tag there => we can
					// make do with 1 newline separator instead of 2 before the P-tag.
					&& !newWikitextLineMightHaveBlockNode(otherNode)
				) {
					return { min: 2, max: 2 };
				} else if (DU.isBody(otherNode)) {
					return { min: 0, max: 2 };
				} else if (treatAsPPTransition(otherNode) ||
					(DU.isBlockNode(otherNode) && otherNode.nodeName !== 'BLOCKQUOTE' && node.parentNode === otherNode)) {
					if (!DU.hasAncestorOfName(otherNode, "FIGCAPTION")) {
						return { min: 1, max: 2 };
					} else {
						return { min: 0, max: 2 };
					}
				} else {
					return { min: 0, max: 2 };
				}
			},
		},
	},
	// Wikitext indent pre generated with leading space
	pre: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
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
		}),
		sepnls: {
			before: function(node, otherNode) {
				if (otherNode.nodeName === 'PRE' &&
					DU.getDataParsoid(otherNode).stx !== 'html') {
					return { min: 2 };
				} else {
					return { min: 1 };
				}
			},
			after: function(node, otherNode) {
				if (otherNode.nodeName === 'PRE' &&
					DU.getDataParsoid(otherNode).stx !== 'html') {
					return { min: 2 };
				} else {
					return { min: 1 };
				}
			},
			firstChild: id({}),
			lastChild: id({}),
		},
	},
	// HTML pre
	pre_html: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			yield _htmlElementHandler(node, state);
		}),
		sepnls: {
			before: id({}),
			after: id({}),
			firstChild: id({ max: Number.MAX_VALUE }),
			lastChild:  id({ max: Number.MAX_VALUE }),
		},
	},
	meta: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var type = node.getAttribute('typeof');
			var property = node.getAttribute('property');
			var dp = DU.getDataParsoid(node);
			var dmw = DU.getDataMw(node);

			if (dp.src !== undefined &&
					/(^|\s)mw:Placeholder(\/\w*)?$/.test(type)) {
				return emitPlaceholderSrc(node, state);
			}

			// Check for property before type so that page properties with
			// templated attrs roundtrip properly.
			// Ex: {{DEFAULTSORT:{{echo|foo}} }}
			if (property) {
				var switchType = property.match(/^mw\:PageProp\/(.*)$/);
				if (switchType) {
					var out = switchType[1];
					var cat = out.match(/^(?:category)?(.*)/);
					if (cat && Util.magicMasqs.has(cat[1])) {
						var contentInfo =
							yield state.serializer.serializedAttrVal(
								node, 'content', {}
							);
						if (DU.hasExpandedAttrsType(node)) {
							out = '{{' + contentInfo.value + '}}';
						} else if (dp.src !== undefined) {
							out = dp.src.replace(
								/^([^:]+:)(.*)$/,
								"$1" + contentInfo.value + "}}"
							);
						} else {
							var magicWord = cat[1].toUpperCase();
							state.env.log("warn", cat[1] +
								' is missing source. Rendering as ' +
								magicWord + ' magicword');
							out = "{{" + magicWord + ":" +
								contentInfo.value + "}}";
						}
					} else {
						out = state.env.conf.wiki.getMagicWordWT(
							switchType[1], dp.magicSrc) || '';
					}
					state.emitChunk(out, node);
				} else {
					yield _htmlElementHandler(node, state);
				}
			} else if (type) {
				switch (type) {
					case 'mw:Includes/IncludeOnly':
						// Remove the dp.src when older revisions of HTML expire in RESTBase
						state.emitChunk(dmw.src || dp.src || '', node);
						break;
					case 'mw:Includes/IncludeOnly/End':
						// Just ignore.
						break;
					case 'mw:Includes/NoInclude':
						state.emitChunk(dp.src || '<noinclude>', node);
						break;
					case 'mw:Includes/NoInclude/End':
						state.emitChunk(dp.src || '</noinclude>', node);
						break;
					case 'mw:Includes/OnlyInclude':
						state.emitChunk(dp.src || '<onlyinclude>', node);
						break;
					case 'mw:Includes/OnlyInclude/End':
						state.emitChunk(dp.src || '</onlyinclude>', node);
						break;
					case 'mw:DiffMarker/inserted':
					case 'mw:DiffMarker/deleted':
					case 'mw:DiffMarker/moved':
					case 'mw:Separator':
						// just ignore it
						break;
					default:
						yield _htmlElementHandler(node, state);
				}
			} else {
				yield _htmlElementHandler(node, state);
			}
		}),
		sepnls: {
			before: function(node, otherNode) {
				var type = node.getAttribute('typeof') || node.getAttribute('property');
				if (type && type.match(/mw:PageProp\/categorydefaultsort/)) {
					if (otherNode.nodeName === 'P' && DU.getDataParsoid(otherNode).stx !== 'html') {
						// Since defaultsort is outside the p-tag, we need 2 newlines
						// to ensure that it go back into the p-tag when parsed.
						return { min: 2 };
					} else {
						return { min: 1 };
					}
				} else if (DU.isNewElt(node) &&
					// Placeholder metas don't need to be serialized on their own line
					(node.nodeName !== "META" ||
					!/(^|\s)mw:Placeholder(\/|$)/.test(node.getAttribute("typeof")))) {
					return { min: 1 };
				} else {
					return {};
				}
			},
			after: function(node, otherNode) {
				// No diffs
				if (DU.isNewElt(node) &&
					// Placeholder metas don't need to be serialized on their own line
					(node.nodeName !== "META" ||
					!/(^|\s)mw:Placeholder(\/|$)/.test(node.getAttribute("typeof")))) {
					return { min: 1 };
				} else {
					return {};
				}
			},
		},
	},
	span: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var env = state.env;
			var dp = DU.getDataParsoid(node);
			var type = node.getAttribute('typeof');
			var contentSrc = node.textContent || node.innerHTML;
			if (isRecognizedSpanWrapper(type)) {
				if (type === 'mw:Nowiki') {
					var nativeExt = env.conf.wiki.extConfig.tags.get('nowiki');
					yield nativeExt.serialHandler.handle(node, state, wrapperUnmodified);
				} else if (/(?:^|\s)mw:(?:Image|Video|Audio)(\/(Frame|Frameless|Thumb))?/.test(type)) {
					// TODO: Remove when 1.5.0 content is deprecated,
					// since we no longer emit media in spans.  See the test,
					// "Serialize simple image with span wrapper"
					yield state.serializer.figureHandler(node);
				} else if (/(?:^|\s)mw\:Entity/.test(type) && DU.hasNChildren(node, 1)) {
					// handle a new mw:Entity (not handled by selser) by
					// serializing its children
					if (dp.src !== undefined && contentSrc === dp.srcContent) {
						state.serializer.emitWikitext(dp.src, node);
					} else if (DU.isText(node.firstChild)) {
						state.emitChunk(
							Util.entityEncodeAll(node.firstChild.nodeValue),
							node.firstChild);
					} else {
						yield state.serializeChildren(node);
					}
				} else if (/(^|\s)mw:Placeholder(\/\w*)?/.test(type)) {
					if (dp.src !== undefined) {
						return emitPlaceholderSrc(node, state);
					} else if (/(^|\s)mw:Placeholder(\s|$)/ &&
						DU.hasNChildren(node, 1) &&
						DU.isText(node.firstChild) &&
						// See the DisplaySpace hack in the urltext rule
						// in the tokenizer.
						/\u00a0+/.test(node.firstChild.nodeValue)
					) {
						state.emitChunk(
							' '.repeat(node.firstChild.nodeValue.length),
							node.firstChild);
					} else {
						yield _htmlElementHandler(node, state);
					}
				}
			} else {
				var kvs = DU.getAttributeKVArray(node).filter(function(kv) {
					return !/^data-parsoid/.test(kv.k) &&
						!(kv.k === 'id' && /^mw[\w-]{2,}$/.test(kv.v));
				});
				if (!state.rtTestMode && dp.misnested && dp.stx !== 'html' &&
						!kvs.length) {
					// Discard span wrappers added to flag misnested content.
					// Warn since selser should have reused source.
					env.log('warn', 'Serializing misnested content: ' + node.outerHTML);
					yield state.serializeChildren(node);
				} else {
					// Fall back to plain HTML serialization for spans created
					// by the editor.
					yield _htmlElementHandler(node, state);
				}
			}
		}),
	},
	figure: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			yield state.serializer.figureHandler(node);
		}),
		sepnls: {
			// TODO: Avoid code duplication
			before: function(node) {
				if (
					DU.isNewElt(node) &&
					node.parentNode &&
					DU.isBody(node.parentNode)
				) {
					return { min: 1 };
				}
				return {};
			},
			after: function(node) {
				if (
					DU.isNewElt(node) &&
					node.parentNode &&
					DU.isBody(node.parentNode)
				) {
					return { min: 1 };
				}
				return {};
			},
		},
	},
	'figure-inline': {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			yield state.serializer.figureHandler(node);
		}),
	},
	img: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			if (node.getAttribute('rel') === 'mw:externalImage') {
				state.serializer.emitWikitext(node.getAttribute('src') || '', node);
			} else {
				yield state.serializer.figureHandler(node);
			}
		}),
	},
	video: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			yield state.serializer.figureHandler(node);
		}),
	},
	hr: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) { // eslint-disable-line require-yield
			state.emitChunk('-'.repeat(4 + (DU.getDataParsoid(node).extra_dashes || 0)), node);
		}),
		sepnls: {
			before: id({ min: 1, max: 2 }),
			// XXX: Add a newline by default if followed by new/modified content
			after: id({ min: 0, max: 2 }),
		},
	},
	h1: buildHeadingHandler("="),
	h2: buildHeadingHandler("=="),
	h3: buildHeadingHandler("==="),
	h4: buildHeadingHandler("===="),
	h5: buildHeadingHandler("====="),
	h6: buildHeadingHandler("======"),
	br: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) { // eslint-disable-line require-yield
			if (state.singleLineContext.enforced() ||
				DU.getDataParsoid(node).stx === 'html' ||
				node.parentNode.nodeName !== 'P'
			) {
				// <br/> has special newline-based semantics in
				// parser-generated <p><br/>.. HTML
				state.emitChunk('<br />', node);
			}

			// If P_BR (or P_BR_P), dont emit anything for the <br> so that
			// constraints propagate to the next node that emits content.
		}),

		sepnls: {
			before: function(node, otherNode, state) {
				if (state.singleLineContext.enforced() || !isPbr(node)) {
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
			},
			// NOTE: There is an asymmetry in the before/after handlers.
			after: function(node, otherNode, state) {
				// Note that the before handler has already forced 1 additional
				// newline for all <p><br/> scenarios which simplifies the work
				// of the after handler.
				//
				// Nothing changes with constraints if we are not
				// in a P-P transition. <br/> has special newline-based
				// semantics only in a parser-generated <p><br/>.. HTML.

				if (state.singleLineContext.enforced() ||
					!isPPTransition(DU.nextNonSepSibling(node.parentNode))
				) {
					return {};
				}

				var c = state.sep.constraints || { min: 0 };
				if (isPbrP(node)) {
					// The <br/> forces an additional newline when part of
					// a <p><br/></p>.
					//
					// Ex: <p><br/></p><p>..</p> => at least 4 newlines before
					// content of the *next* p-tag.
					return { min: Math.max(4, c.min + 1), force: true };
				} else if (isPbr(node)) {
					// Since the <br/> is followed by content, the newline
					// constraint isn't bumped.
					//
					// Ex: <p><br/>..<p><p>..</p> => at least 2 newlines after
					// content of *this* p-tag
					return { min: Math.max(2, c.min), force: true };
				}

				return {};
			},
		},
	},
	a:  {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			yield state.serializer.linkHandler(node);
		}),
		// TODO: Implement link tail escaping with nowiki in DOM handler!
	},
	link:  {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			yield state.serializer.linkHandler(node);
		}),
		sepnls: {
			before: function(node, otherNode) {
				// sol-transparent link nodes are the only thing on their line.
				// But, don't force separators wrt to its parent (body, p, list, td, etc.)
				if (otherNode !== node.parentNode &&
					DU.isSolTransparentLink(node) && !DU.isRedirectLink(node) &&
					!DU.isEncapsulationWrapper(node)) {
					return { min: 1 };
				} else {
					return {};
				}
			},
			after: function(node, otherNode, state) {
				// sol-transparent link nodes are the only thing on their line
				// But, don't force separators wrt to its parent (body, p, list, td, etc.)
				if (otherNode !== node.parentNode &&
					DU.isSolTransparentLink(node) && !DU.isRedirectLink(node) &&
					!DU.isEncapsulationWrapper(node)) {
					return { min: 1 };
				} else {
					return {};
				}
			},
		},
	},
	body: {
		handle: justChildren.handle,
		sepnls: {
			firstChild: id({ min: 0, max: 1 }),
			lastChild: id({ min: 0, max: 1 }),
		},
	},
	div: {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			if (/\bmw-references-wrap\b/.test(node.classList)) {
				// FIXME: Leaky -- should be in Cite
				// Just serialize the children
				yield state.serializeChildren(node);
			} else {
				// Fall back to plain HTML serialization
				yield _htmlElementHandler(node, state);
			}
		}),
	},
});

var parentMap = {
	LI: { UL: 1, OL: 1 },
	DT: { DL: 1 },
	DD: { DL: 1 },
};

function parentBulletsHaveBeenEmitted(node) {
	if (DU.isLiteralHTMLNode(node)) {
		return true;
	} else if (DU.isList(node)) {
		return !DU.isListItem(node.parentNode);
	} else {
		console.assert(DU.isListItem(node));
		var parentNode = node.parentNode;
		// Skip builder-inserted wrappers
		while (isBuilderInsertedElt(parentNode)) {
			parentNode = parentNode.parentNode;
		}
		return !(parentNode.nodeName in parentMap[node.nodeName]);
	}
}

function handleListPrefix(node, state) {
	var bullets = '';
	if (DU.isListOrListItem(node) &&
			!parentBulletsHaveBeenEmitted(node) &&
			!DU.previousNonSepSibling(node) &&  // Maybe consider parentNode.
			isTplListWithoutSharedPrefix(node) &&
			// Nothing to do for definition list rows,
			// since we're emitting for the parent node.
			!(node.nodeName === 'DD' &&
				DU.getDataParsoid(node).stx === 'row')) {
		bullets = getListBullets(state, node.parentNode);
	}
	return bullets;
}

function ClientError(message) {
	Error.captureStackTrace(this, ClientError);
	this.name = 'Bad Request';
	this.message = message || 'Bad Request';
	this.httpStatus = 400;
	this.suppressLoggingStack = true;
}
ClientError.prototype = Error.prototype;

/**
 * Function returning `domHandler`s for nodes with encapsulated content.
 */
var _getEncapsulatedContentHandler = function() {
	return {
		handle: Promise.async(function *(node, state, wrapperUnmodified) {
			var env = state.env;
			var self = state.serializer;
			var dp = DU.getDataParsoid(node);
			var dataMw = DU.getDataMw(node);
			var typeOf = node.getAttribute('typeof') || '';
			var src;
			if (/(?:^|\s)(?:mw:Transclusion|mw:Param)(?=$|\s)/.test(typeOf)) {
				if (dataMw.parts) {
					src = yield self.serializeFromParts(state, node, dataMw.parts);
				} else if (dp.src !== undefined) {
					env.log("error", "data-mw missing in: " + node.outerHTML);
					src = dp.src;
				} else {
					throw new ClientError("Cannot serialize " + typeOf + " without data-mw.parts or data-parsoid.src");
				}
			} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
				if (!dataMw.name && dp.src === undefined) {
					// If there was no typeOf name, and no dp.src, try getting
					// the name out of the mw:Extension type. This will
					// generate an empty extension tag, but it's better than
					// just an error.
					var extGivenName = typeOf.replace(/(?:^|\s)mw:Extension\/([^\s]+)/, '$1');
					if (extGivenName) {
						env.log('error', 'no data-mw name for extension in: ', node.outerHTML);
						dataMw.name = extGivenName;
					}
				}
				if (dataMw.name) {
					var nativeExt = env.conf.wiki.extConfig.tags.get(dataMw.name.toLowerCase());
					if (nativeExt && nativeExt.serialHandler && nativeExt.serialHandler.handle) {
						src = yield nativeExt.serialHandler.handle(node, state, wrapperUnmodified);
					} else {
						src = yield self.defaultExtensionHandler(node, state);
					}
				} else if (dp.src !== undefined) {
					env.log('error', 'data-mw missing in: ' + node.outerHTML);
					src = dp.src;
				} else {
					throw new ClientError('Cannot serialize extension without data-mw.name or data-parsoid.src.');
				}
			} else if (/(?:^|\s)(?:mw:LanguageVariant)(?=$|\s)/.test(typeOf)) {
				return (yield state.serializer.languageVariantHandler(node));
			} else {
				throw new Error('Should never reach here');
			}
			state.singleLineContext.disable();
			// FIXME: https://phabricator.wikimedia.org/T184779
			if (dataMw.extPrefix || dataMw.extSuffix) {
				src = (dataMw.extPrefix || '') + src + (dataMw.extSuffix || '');
			}
			self.emitWikitext(handleListPrefix(node, state) + src, node);
			state.singleLineContext.pop();
			return DU.skipOverEncapsulatedContent(node);
		}),
		sepnls: {
			// XXX: This is questionable, as the template can expand
			// to newlines too. Which default should we pick for new
			// content? We don't really want to make separator
			// newlines in HTML significant for the semantics of the
			// template content.
			before: function(node, otherNode, state) {
				var env = state.env;
				var typeOf = node.getAttribute('typeof') || '';
				var dataMw = DU.getDataMw(node);
				var dp = DU.getDataParsoid(node);

				// Handle native extension constraints.
				if (/(?:^|\s)mw:Extension\//.test(typeOf) &&
						// Only apply to plain extension tags.
						!/(?:^|\s)mw:Transclusion(?:\s|$)/.test(typeOf)) {
					if (dataMw.name) {
						var nativeExt = env.conf.wiki.extConfig.tags.get(dataMw.name.toLowerCase());
						if (nativeExt && nativeExt.serialHandler && nativeExt.serialHandler.before) {
							var ret = nativeExt.serialHandler.before(node, otherNode, state);
							if (ret !== null) { return ret; }
						}
					}
				}

				// If this content came from a multi-part-template-block
				// use the first node in that block for determining
				// newline constraints.
				if (dp.firstWikitextNode) {
					var nodeName = dp.firstWikitextNode.toLowerCase();
					var h = tagHandlers.get(nodeName);
					if (!h && dp.stx === 'html' && nodeName !== 'a') {
						h = htmlElementHandler;
					}
					if (h && h.sepnls && h.sepnls.before) {
						return h.sepnls.before(node, otherNode, state);
					}
				}

				// default behavior
				return { min: 0, max: 2 };
			},
		},
	};
};

/**
 * Just the handle for the htmlElementHandler defined below.
 * It's used as a fallback in some of the tagHandlers above.
 * @private
 */
_htmlElementHandler = Promise.async(function *(node, state, wrapperUnmodified) {
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
		if (Util.tagOpensBlockScope(node.nodeName.toLowerCase())) {
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
			if (fc && DU.isText(fc)) {
				var m = fc.nodeValue.match(/^\n/);
				lostLine = m && m[0] || '';
			}

			if (!lostLine && DU.getDataParsoid(node).strippedNL) {
				lostLine = '\n';
			}

			state.emitChunk(lostLine, node);
		}

		yield state.serializeChildren(node);
		state.inPHPBlock = inPHPBlock;
	}

	var endTag = yield serializer._serializeHTMLEndTag(node, wrapperUnmodified);
	WTSUtils.emitEndTag(endTag, node, state);
});

/**
 * Used as a fallback in tagHandlers.
 * @namespace
 */
htmlElementHandler = { handle: _htmlElementHandler };


if (typeof module === "object") {
	module.exports.tagHandlers = tagHandlers;
	module.exports.htmlElementHandler = htmlElementHandler;
	module.exports._getEncapsulatedContentHandler =
			_getEncapsulatedContentHandler;
}
