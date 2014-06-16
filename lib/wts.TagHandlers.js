"use strict";
require('./core-upgrade.js');

var Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	WTSUtils = require('./wts.utils.js').WTSUtils;


function id(v) {
	return function() {
		return v;
	};
}

var genContentSpanTypes = {
	'mw:Nowiki':1,
	'mw:Image': 1,
	'mw:Image/Frameless': 1,
	'mw:Image/Frame': 1,
	'mw:Image/Thumb': 1,
	'mw:Entity': 1,
	'mw:DiffMarker': 1
};

function isRecognizedSpanWrapper(type) {
	return type &&
		type.split(/\s/).find(function(t) { return genContentSpanTypes[t] === 1; }) !== undefined;
}

function buildHeadingHandler(headingWT) {
	return {
		handle: function(node, state, cb) {
			// For new elements, for prettier wikitext serialization,
			// emit a space after the last '=' char.
			var space = '';
			if (DU.isNewElt(node)) {
				var fc = node.firstChild;
				if (fc && (!DU.isText(fc) || !fc.nodeValue.match(/^\s/))) {
					space = ' ';
				}
			}

			cb(headingWT + space, node);
			if (node.childNodes.length) {
				var headingHandler = state.serializer
					.wteHandlers.headingHandler.bind(state.serializer.wteHandlers, node);
				state.serializeChildren(node, cb, headingHandler);
			} else {
				// Deal with empty headings
				cb('<nowiki/>', node);
			}

			// For new elements, for prettier wikitext serialization,
			// emit a space before the first '=' char.
			space = '';
			if (DU.isNewElt(node)) {
				var lc = node.lastChild;
				if (lc && (!DU.isText(lc) || !lc.nodeValue.match(/\s$/))) {
					space = ' ';
				}
			}
			cb(space + headingWT, node);
		},
		sepnls: {
			before: function (node, otherNode) {
				if (DU.isNewElt(node) && DU.previousNonSepSibling(node)) {
					// Default to two preceding newlines for new content
					return {min:2, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: id({min:1, max:2})
		}
	};
}

/**
 * List helper: DOM-based list bullet construction
 */
function getListBullets(node) {
	var listTypes = {
		ul: '*',
		ol: '#',
		dl: '',
		li: '',
		dt: ';',
		dd: ':'
	}, res = '';

	// For new elements, for prettier wikitext serialization,
	// emit a space after the last bullet (if required)
	var space = '';
	if (DU.isNewElt(node)) {
		var fc = node.firstChild;
		if (fc && (!DU.isText(fc) || !fc.nodeValue.match(/^\s/))) {
			space = ' ';
		}
	}

	while (node) {
		var nodeName = node.nodeName.toLowerCase(),
			dp = DU.getDataParsoid( node );

		if (dp.stx !== 'html' && nodeName in listTypes) {
			res = listTypes[nodeName] + res;
		} else if (dp.stx !== 'html' || !dp.autoInsertedStart || !dp.autoInsertedEnd) {
			break;
		}

		node = node.parentNode;
	}

	return res + space;
}

/**
 * Bold/italic helper: Get a preceding quote/italic element or a '-char
 */
function getPrecedingQuoteElement (node, state) {
	if (!state.sep.lastSourceNode) {
		// A separator was emitted before some other non-empty wikitext
		// string, which means that we can't be directly preceded by quotes.
		return null;
	}

	var prev = DU.previousNonDeletedSibling(node);
	if (prev && DU.isText(prev) && prev.nodeValue.match(/'$/)) {
		return prev;
	}

	// Move up first until we have a sibling
	while (node && !DU.previousNonDeletedSibling(node)) {
		node = node.parentNode;
	}

	if (node) {
		node = node.previousSibling;
	}

	// Now move down the lastChilds to see if there are any italics / bolds
	while (node && DU.isElt(node)) {
		if (DU.isQuoteElt(node) && DU.isQuoteElt(node.lastChild)) {
			return state.sep.lastSourceNode === node ? node.lastChild : null;
		} else if (state.sep.lastSourceNode === node) {
			// If a separator was already emitted, or an outstanding separator
			// starts at another node that produced output, we are not
			// directly preceded by quotes in the wikitext.
			return null;
		}
		node = node.lastChild;
	}
	return null;
}

function quoteTextFollows(node, state) {
	var next = DU.nextNonDeletedSibling(node);
	return next && DU.isText(next) && next.nodeValue[0] === "'";
}

function wtEOL(node, otherNode) {
	if (DU.isElt(otherNode) &&
		(DU.getDataParsoid( otherNode ).stx === 'html' || DU.getDataParsoid( otherNode ).src))
	{
		return {min:0, max:2};
	} else {
		return {min:1, max:2};
	}
}

function wtListEOL(node, otherNode) {
	if (otherNode.nodeName === 'BODY' ||
		!DU.isElt(otherNode) ||
		DU.isFirstEncapsulationWrapperNode(otherNode))
	{
		return {min:0, max:2};
	}

	var nextSibling = DU.nextNonSepSibling(node);
	var dp = DU.getDataParsoid( otherNode );
	if ( nextSibling === otherNode && dp.stx === 'html' || dp.src ) {
		return {min:0, max:2};
	} else if (nextSibling === otherNode && DU.isListOrListItem(otherNode)) {
		if (DU.isList(node) && otherNode.nodeName === node.nodeName) {
			// Adjacent lists of same type need extra newline
			return {min: 2, max:2};
		} else if (DU.isListItem(node) || node.parentNode.nodeName in {LI:1, DD:1}) {
			// Top-level list
			return {min:1, max:1};
		} else {
			return {min:1, max:2};
		}
	} else if (DU.isList(otherNode) ||
			(DU.isElt(otherNode) && dp.stx === 'html'))
	{
		// last child in ul/ol (the list element is our parent), defer
		// separator constraints to the list.
		return {};
	} else {
		return {min:1, max:2};
	}
}
function buildListHandler(firstChildNames) {
	function isBuilderInsertedElt(node) {
		var dp = DU.getDataParsoid( node );
		return dp && dp.autoInsertedStart && dp.autoInsertedEnd;
	}

	return {
		handle: function (node, state, cb) {
			var firstChildElt = DU.firstNonSepChildNode(node);

			// Skip builder-inserted wrappers
			// Ex: <ul><s auto-inserted-start-and-end-><li>..</li><li>..</li></s>...</ul>
			// output from: <s>\n*a\n*b\n*c</s>
			while (firstChildElt && isBuilderInsertedElt(firstChildElt)) {
				firstChildElt = DU.firstNonSepChildNode(firstChildElt);
			}

			if (!firstChildElt || ! (firstChildElt.nodeName in firstChildNames)) {
				cb(getListBullets(node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler.bind(state.serializer.wteHandlers, node);
			state.serializeChildren(node, cb, liHandler);
		},
		sepnls: {
			before: function (node, otherNode) {
				// SSS FIXME: Thoughts about a fix (abandoned in this patch)
				//
				// Checking for otherNode.nodeName === 'BODY' and returning
				// {min:0, max:0} should eliminate the annoying leading newline
				// bug in parser tests, but it seems to cause other niggling issues
				// <ul> <li>foo</li></ul> serializes to " *foo" which is buggy.
				// So, we may need another constraint/flag/test in makeSeparator
				// about the node and its context so that leading pre-inducing WS
				// can be stripped

				if (otherNode.nodeName === 'BODY') {
					return {min:0, max:0};
				} else if (DU.isText(otherNode) && DU.isListItem(node.parentNode)) {
					// A list nested inside a list item
					// <li> foo <dl> .. </dl></li>
					return {min:1, max:1};
				} else {
					return {min:1, max:2};
				}
			},
			after: wtListEOL //id({min:1, max:2})
		}
	};
}

/* currentNode is being processed and line has information
 * about the wikitext line emitted so far. This function checks
 * if the DOM has a block node emitted on this line till currentNode */
function currWikitextLineHasBlockNode(line, currentNode) {
	var n = line.firstNode;
	while (n && n !== currentNode) {
		if (DU.isBlockNode(n)) {
			return true;
		}
		n = n.nextSibling;
	}
	return false;
}

function buildQuoteHandler(quotes) {
	return {
		handle: function(node, state, cb) {
			var q1 = getPrecedingQuoteElement(node, state);
			var q2 = quoteTextFollows(node, state);
			if (q1 && (q2 || DU.isElt(q1))) {
				WTSUtils.emitStartTag('<nowiki/>', node, state, cb);
			}
			WTSUtils.emitStartTag(quotes, node, state, cb);

			if (node.childNodes.length === 0) {
				// capture the end tag src to see if it is actually going to
				// be emitted (not always true if marked as autoInsertedEnd
				// and running in rtTestMode)
				var endTagSrc = '',
					captureEndTagSrcCB = function (src, _) {
						endTagSrc = src;
					};

				WTSUtils.emitEndTag(quotes, node, state, captureEndTagSrcCB);
				if (endTagSrc) {
					WTSUtils.emitStartTag('<nowiki/>', node, state, cb);
					cb(endTagSrc, node);
				}
			} else {
				state.serializeChildren(node, cb, state.serializer.wteHandlers.quoteHandler);
				WTSUtils.emitEndTag(quotes, node, state, cb);
			}

			if (q2) {
				WTSUtils.emitEndTag('<nowiki/>', node, state, cb);
			}
		}
	};
}

// Just serialize the children, ignore the (implicit) tag
var justChildren = {
	handle: function (node, state, cb) {
		state.serializeChildren(node, cb);
	}
};

var TagHandlers = {
	b: buildQuoteHandler("'''"),
	i: buildQuoteHandler("''"),

	dl: buildListHandler({DT:1, DD:1}),
	ul: buildListHandler({LI:1}),
	ol: buildListHandler({LI:1}),

	li: {
		handle: function (node, state, cb) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement)) {
				cb(getListBullets(node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler.bind(state.serializer.wteHandlers, node);
			state.serializeChildren(node, cb, liHandler);
		},
		sepnls: {
			before: function (node, otherNode) {
				if ((otherNode === node.parentNode && otherNode.nodeName in {UL:1, OL:1}) ||
					(DU.isElt(otherNode) && DU.getDataParsoid( otherNode ).stx === 'html'))
				{
					return {}; //{min:0, max:1};
				} else {
					return {min:1, max:2};
				}
			},
			after: wtListEOL,
			firstChild: function (node, otherNode) {
				if (!DU.isList(otherNode)) {
					return {min:0, max: 0};
				} else {
					return {};
				}
			}
		}
	},

	dt: {
		handle: function (node, state, cb) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement)) {
				cb(getListBullets(node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler.bind(state.serializer.wteHandlers, node);
			state.serializeChildren(node, cb, liHandler);
		},
		sepnls: {
			before: id({min:1, max:2}),
			after: function (node, otherNode) {
				if (otherNode.nodeName === 'DD' && DU.getDataParsoid( otherNode ).stx === 'row') {
					return {min:0, max:0};
				} else {
					return wtListEOL(node, otherNode);
				}
			},
			firstChild: function (node, otherNode) {
				if (!DU.isList(otherNode)) {
					return {min:0, max: 0};
				} else {
					return {};
				}
			}
		}
	},

	dd: {
		handle: function (node, state, cb) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement)) {
				// XXX: handle stx: row
				if ( DU.getDataParsoid( node ).stx === 'row' ) {
					cb(':', node);
				} else {
					cb(getListBullets(node), node);
				}
			}
			var liHandler = state.serializer.wteHandlers.liHandler.bind(state.serializer.wteHandlers, node);
			state.serializeChildren(node, cb, liHandler);
		},
		sepnls: {
			before: function(node, othernode) {
				// Handle single-line dt/dd
				if ( DU.getDataParsoid( node ).stx === 'row' ) {
					return {min:0, max:0};
				} else {
					return {min:1, max:2};
				}
			},
			after: wtListEOL,
			firstChild: function (node, otherNode) {
				if (!DU.isList(otherNode)) {
					return {min:0, max: 0};
				} else {
					return {};
				}
			}
		}
	},


	// XXX: handle options
	table: {
		handle: function (node, state, cb, wrapperUnmodified) {
			var dp = DU.getDataParsoid( node );
			var wt = dp.startTagSrc || "{|";
			cb(state.serializer._serializeTableTag(wt, '', state, node, wrapperUnmodified), node);
			if (!DU.isLiteralHTMLNode(node)) {
				state.wikiTableNesting++;
			}
			state.serializeChildren(node, cb);
			if (!DU.isLiteralHTMLNode(node)) {
				state.wikiTableNesting--;
			}
			if (!state.sep.constraints) {
				// Special case hack for "{|\n|}" since state.sep is cleared
				// in emitSep after a separator is emitted. However, for {|\n|},
				// the <table> tag has no element children which means lastchild -> parent
				// constraint is never computed and set here.
				state.sep.constraints = {a:{}, b:{}, min:1, max:2};
			}
			WTSUtils.emitEndTag( dp.endTagSrc || "|}", node, state, cb );
		},
		sepnls: {
			before: function(node, otherNode) {
				// Handle special table indentation case!
				if (node.parentNode === otherNode && otherNode.nodeName === 'DD') {
					return {min:0, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: function (node, otherNode) {
				if (DU.isNewElt(node) ||
						(DU.isElt(otherNode) && DU.isNewElt(otherNode)))
				{
					return {min:1, max:2};
				} else {
					return {min:0, max:2};
				}
			},
			firstChild: id({min:1, max:2}),
			lastChild: id({min:1, max:2})
		}
	},
	tbody: justChildren,
	thead: justChildren,
	tfoot: justChildren,
	tr: {
		handle: function (node, state, cb, wrapperUnmodified) {
			// If the token has 'startTagSrc' set, it means that the tr was present
			// in the source wikitext and we emit it -- if not, we ignore it.
			var dp = DU.getDataParsoid( node );
			// ignore comments and ws
			if (DU.previousNonSepSibling(node) || dp.startTagSrc) {
				var res = state.serializer._serializeTableTag(dp.startTagSrc || "|-", '', state,
							node, wrapperUnmodified );
				WTSUtils.emitStartTag(res, node, state, cb);
			}
			state.serializeChildren(node, cb);
		},
		sepnls: {
			before: function(node, othernode) {
				if ( !DU.previousNonDeletedSibling(node) && !DU.getDataParsoid( node ).startTagSrc ) {
					// first line
					return {min:0, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: function(node, othernode) {
				return {min:0, max:2};
			}
		}
	},
	th: {
		handle: function (node, state, cb, wrapperUnmodified) {
			var dp = DU.getDataParsoid( node ), res;
			if ( dp.stx_v === 'row' ) {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "!!",
							dp.attrSepSrc || null, state, node, wrapperUnmodified);
			} else {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "!", dp.attrSepSrc || null,
						state, node, wrapperUnmodified);
			}
			WTSUtils.emitStartTag(res, node, state, cb);
			state.serializeChildren(node, cb, state.serializer.wteHandlers.thHandler);
		},
		sepnls: {
			before: function(node, otherNode) {
				if ( DU.getDataParsoid( node ).stx_v === 'row' ) {
					// force single line
					return {min:0, max:2};
				} else {
					return {min:1, max:2};
				}
			},
			after: id({min: 0, max:2})
		}
	},
	td: {
		handle: function (node, state, cb, wrapperUnmodified) {
			var dp = DU.getDataParsoid( node ), res;
			if ( dp.stx_v === 'row' ) {
				res = state.serializer._serializeTableTag(dp.startTagSrc || "||",
						dp.attrSepSrc || null, state, node, wrapperUnmodified);
			} else {
				// If the HTML for the first td is not enclosed in a tr-tag,
				// we start a new line.  If not, tr will have taken care of it.
				res = state.serializer._serializeTableTag(dp.startTagSrc || "|",
						dp.attrSepSrc || null, state, node, wrapperUnmodified);

			}
			// FIXME: bad state hack!
			if(res.length > 1) {
				state.inWideTD = true;
			}
			WTSUtils.emitStartTag(res, node, state, cb);
			state.serializeChildren(node, cb,
				state.serializer.wteHandlers.tdHandler.bind(state.serializer.wteHandlers, node));
			// FIXME: bad state hack!
			state.inWideTD = undefined;
		},
		sepnls: {
			before: function(node, otherNode) {
				return DU.getDataParsoid( node ).stx_v === 'row' ?
					{min: 0, max:2} : {min:1, max:2};
			},
			//after: function(node, otherNode) {
			//	return otherNode.data.parsoid.stx_v === 'row' ?
			//		{min: 0, max:2} : {min:1, max:2};
			//}
			after: id({min: 0, max:2})
		}
	},
	caption: {
		handle: function (node, state, cb, wrapperUnmodified) {
			var dp = DU.getDataParsoid( node );
			// Serialize the tag itself
			var res = state.serializer._serializeTableTag(
					dp.startTagSrc || "|+", null, state, node, wrapperUnmodified);
			WTSUtils.emitStartTag(res, node, state, cb);
			state.serializeChildren(node, cb);
		},
		sepnls: {
			before: function(node, otherNode) {
				return otherNode.nodeName !== 'TABLE' ?
					{min: 1, max: 2} : {min:0, max: 2};
			},
			after: id({min: 1, max: 2})
		}
	},
	// Insert the text handler here too?
	'#text': { },
	p: {
		handle: function(node, state, cb) {
			// XXX: Handle single-line mode by switching to HTML handler!
			state.serializeChildren(node, cb, null);
		},
		sepnls: {
			before: function(node, otherNode, state) {

				var otherNodeName = otherNode.nodeName,
					tdOrBody = new Set(['TD', 'BODY']);
				if (node.parentNode === otherNode &&
					DU.isListItem(otherNode) || tdOrBody.has(otherNodeName))
				{
					if (tdOrBody.has(otherNodeName)) {
						return {min: 0, max: 1};
					} else {
						return {min: 0, max: 0};
					}
				} else if (
					otherNode === DU.previousNonDeletedSibling(node) &&
					// p-p transition
					(otherNodeName === 'P' && DU.getDataParsoid( otherNode ).stx !== 'html') ||
					// Treat text/p similar to p/p transition
					(
						DU.isText(otherNode) &&
						otherNode === DU.previousNonSepSibling(node) &&
						!currWikitextLineHasBlockNode(state.currLine, otherNode)
					)
				) {
					return {min: 2, max: 2};
				} else {
					return {min: 1, max: 2};
				}
			},
			after: function(node, otherNode) {
				if (!(node.lastChild && node.lastChild.nodeName === 'BR') &&
					otherNode.nodeName === 'P' && DU.getDataParsoid( otherNode ).stx !== 'html') /* || otherNode.nodeType === node.TEXT_NODE*/
				{
					return {min: 2, max: 2};
				} else {
					// When the other node is a block-node, we want it
					// to be on a different line from the implicit-wikitext-p-tag
					// because the p-wrapper in the parser will suppress a html-p-tag
					// if it sees the block tag on the same line as a text-node.
					return {min: DU.isBlockNode(otherNode) ? 1 : 0, max: 2};
				}
			}
		}
	},
	pre: {
		handle: function(node, state, cb) {
			// Handle indent pre

			// XXX: Use a pre escaper?
			state.inIndentPre = true;
			var content = state.serializeChildrenToString(node);

			// Strip (only the) trailing newline
			var trailingNL = content.match(/\n$/);
			content = content.replace(/\n$/, '');

			// Insert indentation
			content = ' ' + content.replace(/(\n(<!--(?:[^\-]|\-(?!\->))*\-\->)*)/g, '$1 ');

			// But skip "empty lines" (lines with 1+ comment and optional whitespace)
			// since empty-lines sail through all handlers without being affected.
			// See empty_line_with_comments production in pegTokenizer.pegjs.txt
			//
			// We could use 'split' to split content into lines and selectively add
			// indentation, but the code will get unnecessarily complex for questionable
			// benefits. So, going this route for now.
			content = content.replace(/(^|\n) ((?:[ \t]*<!--(?:[^\-]|\-(?!\->))*\-\->[ \t]*)+)(?=\n|$)/, '$1$2');

			cb(content, node);

			// Preserve separator source
			state.sep.src = trailingNL && trailingNL[0] || '';
			state.inIndentPre = false;
		},
		sepnls: {
			before: function(node, otherNode) {
				if ( DU.getDataParsoid( node ).stx === 'html' ) {
					return {};
				} else if (otherNode.nodeName === 'PRE' &&
					DU.getDataParsoid( otherNode ).stx !== 'html')
				{
					return {min:2};
				} else {
					return {min:1};
				}
			},
			after: function(node, otherNode) {
				if ( DU.getDataParsoid( node ).stx === 'html' ) {
					return {};
				} else if (otherNode.nodeName === 'PRE' &&
					DU.getDataParsoid( otherNode ).stx !== 'html')
				{
					return {min:2};
				} else {
					return {min:1};
				}
			},
			firstChild: function(node, otherNode) {
				if ( DU.getDataParsoid( node ).stx === 'html' ) {
					return { max: Number.MAX_VALUE };
				} else {
					return {};
				}
			},
			lastChild: function(node, otherNode) {
				if ( DU.getDataParsoid( node ).stx === 'html' ) {
					return { max: Number.MAX_VALUE };
				} else {
					return {};
				}
			}
		}
	},
	meta: {
		handle: function (node, state, cb) {
			var type = node.getAttribute('typeof'),
				content = node.getAttribute('content'),
				property = node.getAttribute('property'),
				dp = DU.getDataParsoid( node );

			// Check for property before type so that page properties with templated attrs
			// roundtrip properly.  Ex: {{DEFAULTSORT:{{echo|foo}} }}
			if ( property ) {
				var switchType = property.match( /^mw\:PageProp\/(.*)$/ );
				if ( switchType ) {
					var out = switchType[1];
					var cat = out.match(/^(?:category)?(.*)/);
					if ( cat && Util.magicMasqs.has(cat[1]) ) {
						if (dp.src) {
							// Use content so that VE modifications are preserved
							var contentInfo = state.serializer.serializedAttrVal(node, "content", {});
							out = dp.src.replace(/^([^:]+:)(.*)$/, "$1" + contentInfo.value + "}}");
						} else {
							var magicWord = cat[1].toUpperCase();
							state.env.log("error", cat[1] + ' is missing source. Rendering as ' + magicWord + ' magicword');
							out = "{{" + magicWord + ":" + content + "}}";
						}
					} else {
						out = state.env.conf.wiki.getMagicWordWT( switchType[1], dp.magicSrc ) || '';
					}
					cb(out, node);
				}
			} else if ( type ) {
				switch ( type ) {
					case 'mw:tag':
							 // we use this currently for nowiki and co
							 if ( content === 'nowiki' ) {
								 state.inNoWiki = true;
							 } else if ( content === '/nowiki' ) {
								 state.inNoWiki = false;
							 } else {
								state.env.log("error", JSON.stringify(node.outerHTML));
							 }
							 cb('<' + content + '>', node);
							 break;
					case 'mw:Includes/IncludeOnly':
							 cb(dp.src, node);
							 break;
					case 'mw:Includes/IncludeOnly/End':
							 // Just ignore.
							 break;
					case 'mw:Includes/NoInclude':
							 cb(dp.src || '<noinclude>', node);
							 break;
					case 'mw:Includes/NoInclude/End':
							 cb(dp.src || '</noinclude>', node);
							 break;
					case 'mw:Includes/OnlyInclude':
							 cb(dp.src || '<onlyinclude>', node);
							 break;
					case 'mw:Includes/OnlyInclude/End':
							 cb(dp.src || '</onlyinclude>', node);
							 break;
					case 'mw:DiffMarker':
					case 'mw:Separator':
							 // just ignore it
							 //cb('');
							 break;
					default:
							 state.serializer._htmlElementHandler(node, state, cb);
							 break;
				}
			} else {
				state.serializer._htmlElementHandler(node, state, cb);
			}
		},
		sepnls: {
			before: function(node, otherNode) {
				var type = node.getAttribute( 'typeof' ) || node.getAttribute( 'property' );
				if ( type && type.match( /mw:PageProp\/categorydefaultsort/ ) ) {
					if ( otherNode.nodeName === 'P' && DU.getDataParsoid( otherNode ).stx !== 'html' ) {
						// Since defaultsort is outside the p-tag, we need 2 newlines
						// to ensure that it go back into the p-tag when parsed.
						return { min: 2 };
					} else {
						return { min: 1 };
					}
				} else if (DU.isNewElt(node)) {
					return { min: 1 };
				} else {
					return {};
				}
			},
			after: function(node, otherNode) {
				// No diffs
				if (DU.isNewElt(node)) {
					return { min: 1 };
				} else {
					return {};
				}
			}
		}
	},
	span: {
		handle: function(node, state, cb) {
			var type = node.getAttribute('typeof');
			if (isRecognizedSpanWrapper(type)) {
				if (type === 'mw:Nowiki') {
					cb('<nowiki>', node);
					if (node.childNodes.length === 1 && node.firstChild.nodeName === 'PRE') {
						state.serializeChildren(node, cb);
					} else {
						var child = node.firstChild;
						while(child) {
							if (DU.isElt(child)) {
								/* jshint noempty: false */
								if (DU.isMarkerMeta(child, "mw:DiffMarker")) {
									// nothing to do
								} else if (child.nodeName === 'SPAN' &&
										child.getAttribute('typeof') === 'mw:Entity')
								{
									state.serializer._serializeNode(child, state, cb);
								} else {
									cb(child.outerHTML, node);
								}
							} else if (DU.isText(child)) {
								cb(child.nodeValue.replace(/<(\/?nowiki)>/g, '&lt;$1&gt;'), child);
							} else {
								state.serializer._serializeNode(child, state, cb);
							}
							child = child.nextSibling;
						}
					}
					WTSUtils.emitEndTag('</nowiki>', node, state, cb);
				} else if ( /(?:^|\s)mw\:Image(\/(Frame|Frameless|Thumb))?/.test(type) ) {
					state.serializer.figureHandler( node, state, cb );
				} else if ( /(?:^|\s)mw\:Entity/.test(type) && node.childNodes.length === 1 ) {
					// handle a new mw:Entity (not handled by selser) by
					// serializing its children
					if (DU.isText(node.firstChild)) {
						cb(Util.entityEncodeAll(node.firstChild.nodeValue),
						   node.firstChild);
					} else {
						state.serializeChildren(node, cb);
					}
				}

			} else {
				// Fall back to plain HTML serialization for spans created
				// by the editor
				state.serializer._htmlElementHandler(node, state, cb);
			}
		}
	},
	figure: {
		handle: function(node, state, cb) {
			return state.serializer.figureHandler(node, state, cb);
		},
		sepnls: {
			// TODO: Avoid code duplication
			before: function (node) {
				if (
					DU.isNewElt(node) &&
					node.parentNode &&
					node.parentNode.nodeName === 'BODY'
				) {
					return { min: 1 };
				}
				return {};
			},
			after: function (node) {
				if (
					DU.isNewElt(node) &&
					node.parentNode &&
					node.parentNode.nodeName === 'BODY'
				) {
					return { min: 1 };
				}
				return {};
			}
		}
	},
	img: {
		handle: function (node, state, cb) {
			if ( node.getAttribute('rel') === 'mw:externalImage' ) {
				state.serializer.emitWikitext(node.getAttribute('src') || '', state, cb, node);
			} else {
				return state.serializer.figureHandler(node, state, cb);
			}
		}
	},
	hr: {
		handle: function (node, state, cb) {
			cb(Util.charSequence("----", "-", DU.getDataParsoid( node ).extra_dashes), node);
		},
		sepnls: {
			before: id({min: 1, max: 2}),
			// XXX: Add a newline by default if followed by new/modified content
			after: id({min: 0, max: 2})
		}
	},
	h1: buildHeadingHandler("="),
	h2: buildHeadingHandler("=="),
	h3: buildHeadingHandler("==="),
	h4: buildHeadingHandler("===="),
	h5: buildHeadingHandler("====="),
	h6: buildHeadingHandler("======"),
	br: {
		handle: function(node, state, cb) {
			if (DU.getDataParsoid( node ).stx === 'html' || node.parentNode.nodeName !== 'P') {
				cb('<br>', node);
			} else {
				// Trigger separator
				if (state.sep.constraints && state.sep.constraints.min === 2 &&
						node.parentNode.childNodes.length === 1) {
					// p/br pair
					// Hackhack ;)

					// SSS FIXME: With the change I made, the above check can be simplified
					state.sep.constraints.min = 2;
					state.sep.constraints.max = 2;
					cb('', node);
				} else {
					cb('', node);
				}
			}
		},
		sepnls: {
			before: function (node, otherNode) {
				if (otherNode === node.parentNode && otherNode.nodeName === 'P') {
					return {min: 1, max: 2};
				} else {
					return {};
				}
			},
			after: function(node, otherNode) {
				// List items in wikitext dont like linebreaks.
				//
				// This seems like the wrong place to make this fix.
				// To handle this properly and more generically / robustly,
				// * we have to buffer output of list items,
				// * on encountering list item close, post-process the buffer
				//   to eliminate any newlines.
				if (DU.isListItem(node.parentNode)) {
					return {};
				} else {
					return id({min:1})();
				}
			}
		}

				/*,
		sepnls: {
			after: function (node, otherNode) {
				if (node.data.parsoid.stx !== 'html' || node.parentNode.nodeName === 'P') {
					// Wikitext-syntax br, force newline
					return {}; //{min:1};
				} else {
					// HTML-syntax br.
					return {};
				}
			}

		}*/
	},
	a:  {
		handle: function(node, state, cb) {
			return state.serializer.linkHandler(node, state, cb);
		}
		// TODO: Implement link tail escaping with nowiki in DOM handler!
	},
	link:  {
		handle: function(node, state, cb) {
			return state.serializer.linkHandler(node, state, cb);
		},
		sepnls: {
			before: function (node, otherNode) {
				var type = node.getAttribute('rel');
				if (/(?:^|\s)mw:(PageProp|WikiLink)\/(Category|redirect)(?=$|\s)/.test(type) &&
						DU.isNewElt(node) ) {
					// Fresh category link: Serialize on its own line
					return {min: 1};
				} else {
					return {};
				}
			},
			after: function (node, otherNode) {
				var type = node.getAttribute('rel');
				if (/(?:^|\s)mw:(PageProp|WikiLink)\/Category(?=$|\s)/.test(type) &&
						DU.isNewElt(node) &&
						otherNode.nodeName !== 'BODY')
				{
					// Fresh category link: Serialize on its own line
					return {min: 1};
				} else {
					return {};
				}
			}
		}
	},
	body: {
		handle: function(node, state, cb) {
			// Just serialize the children
			state.serializeChildren(node, cb);
		},
		sepnls: {
			firstChild: id({min:0, max:1}),
			lastChild: id({min:0, max:1})
		}
	},
	blockquote: {
		sepnls: {
			// Dirty trick: Suppress newline inside blockquote to avoid a
			// paragraph, at least for the first line.
			// TODO: Suppress paragraphs inside blockquotes in the paragraph
			// handler instead!
			firstChild: id({max:0})
		}
	}
};

if (typeof module === "object") {
	module.exports.TagHandlers = TagHandlers;
}
