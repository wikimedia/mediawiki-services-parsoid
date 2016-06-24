/**
 * Template encapsulation happens in three steps.
 *
 * 1. findWrappableTemplateRanges
 *
 *    Locate start and end metas. Walk upwards towards the root from both and
 *    find a common ancestor A. The subtree rooted at A is now effectively the
 *    scope of the dom template ouput.
 *
 * 2. findTopLevelNonOverlappingRanges
 *
 *    Mark all nodes in a range and walk up to root from each range start to
 *    determine overlaps, nesting. Merge overlapping and nested ranges to find
 *    the subset of top-level non-overlapping ranges which will be wrapped as
 *    individual units.
 *
 *    range.startElem, range.endElem are the start/end meta tags for a transclusion
 *    range.start, range.end are the start/end DOM nodes after the range is
 *    expanded, merged with other ranges, etc. In the simple cases, they will
 *    be identical to startElem, endElem.
 *
 * 3. encapsulateTemplates
 *
 *    For each non-overlapping range,
 *    - compute a data-mw according to the DOM spec
 *    - replace the start / end meta markers with transclusion type and data-mw
 *      on the first DOM node
 *    - add about ids on all top-level nodes of the range
 *
 * This is a simple high-level overview of the 3 steps to help understand this
 * code.
 *
 * FIXME: At some point, more of the details should be extracted and documented
 * in pseudo-code as an algorithm.
 */
'use strict';

var DU = require('../../../utils/DOMUtils.js').DOMUtils;
var JSUtils = require('../../../utils/jsutils.js').JSUtils;
var Util = require('../../../utils/Util.js').Util;

var lastItem = JSUtils.lastItem;


function expandRangeToAvoidSpanWrapping(range, startsWithText) {
	// SSS FIXME: Later on, if safe, we could consider expanding the
	// range unconditionally rather than only if a span is required.

	var mightAddSpan = startsWithText;
	if (startsWithText === undefined) {
		var n = range.start;
		if (DU.isTplMarkerMeta(n)) {
			n = n.nextSibling;
		}
		mightAddSpan = DU.isText(n);
	}

	var expandable = false;
	if (mightAddSpan) {
		// See if we can expand the range to the parent node.
		// Eliminates useless spanning of wikitext of the form: {{echo|foo}}
		// where the the entire template content is contained in a paragraph.
		var contentParent = range.start.parentNode;
		expandable = true
			&& contentParent.nodeName === 'P'
			&& !DU.isLiteralHTMLNode(contentParent)
			&& contentParent.firstChild === range.startElem
			&& contentParent.lastChild === range.endElem
			&& contentParent === range.end.parentNode;

		if (expandable) {
			range.start = contentParent;
			range.end = contentParent;
		}
	}

	return expandable;
}

function updateDSRForFirstTplNode(target, source) {
	var srcDP = DU.getDataParsoid(source);
	var tgtDP = DU.getDataParsoid(target);

	// Since TSRs on template content tokens are cleared by the
	// template handler, all computed dsr values for template content
	// is always inferred from top-level content values and is safe.
	// So, do not overwrite a bigger end-dsr value.
	if (srcDP.dsr && (tgtDP.dsr && tgtDP.dsr[1] > srcDP.dsr[1])) {
		tgtDP.dsr[0] = srcDP.dsr[0];
	} else {
		tgtDP.dsr = Util.clone(srcDP.dsr);
		tgtDP.src = srcDP.src;
	}
}

function getRangeEndDSR(range) {
	var endNode = range.end;
	if (DU.isElt(endNode)) {
		return (DU.getDataParsoid(endNode) || {}).dsr;
	} else {
		// In the rare scenario where the last element of a range is not an ELEMENT,
		// extrapolate based on DSR of first leftmost sibling that is an ELEMENT.
		// We don't try any harder than this for now.
		var offset = 0;
		var n = endNode.previousSibling;
		while (n && !DU.isElt(n)) {
			if (DU.isText(n)) {
				offset += n.data.length;
			} else {
				// A comment
				offset += DU.decodedCommentLength(n);
			}
			n = n.previousSibling;
		}

		var dsr = null;
		if (n) {
			dsr = (DU.getDataParsoid(n) || {}).dsr;
		}

		if (dsr && typeof (dsr[1]) === 'number') {
			var len = DU.isText(endNode) ? endNode.data.length :
				DU.decodedCommentLength(endNode);
			dsr = [dsr[1] + offset, dsr[1] + offset + len];
		}

		return dsr;
	}
}

/**
 * Find the common DOM ancestor of two DOM nodes
 */
function getDOMRange(env, doc, startElem, endMeta, endElem) {
	var range = {
		startElem: startElem,
		endElem: endMeta,
		id: Util.stripParsoidIdPrefix(startElem.getAttribute("about")),
		startOffset: DU.getDataParsoid(startElem).tsr[0],
		flipped: false,
	};

	// Find common ancestor of startElem and endElem
	var startAncestors = DU.pathToRoot(startElem);
	var elem = endElem;
	var parentNode = endElem.parentNode;
	while (parentNode && parentNode.nodeType !== doc.DOCUMENT_NODE) {
		var i = startAncestors.indexOf(parentNode);
		if (i === 0) {
			// widen the scope to include the full subtree
			range.root = startElem;
			range.start = startElem.firstChild;
			range.end = startElem.lastChild;
			break;
		} else if (i > 0) {
			range.root = parentNode;
			range.start = startAncestors[i - 1];
			range.end = elem;
			break;
		}
		elem = parentNode;
		parentNode = elem.parentNode;
	}

	// Detect empty content in unfosterable positions and
	// wrap them in spans.
	if (DU.hasNodeName(startElem, "meta")
		&& startElem.nextSibling === endElem
		&& !DU.isFosterablePosition(startElem)) {
		var emptySpan = doc.createElement('span');
		startElem.parentNode.insertBefore(emptySpan, endElem);
	}

	// Handle unwrappable content in fosterable positions
	// and expand template range, if required.
	if (DU.isFosterablePosition(range.start) && (
		!DU.isElt(range.start) ||
		// NOTE: These template marker meta tags are translated from comments
		// *after* the DOM has been built which is why they can show up in
		// fosterable positions in the DOM.
		(DU.isTplMarkerMeta(range.start) && DU.isTplMarkerMeta(range.start.nextSibling)) ||
		(DU.isTplMarkerMeta(range.start) && !DU.isElt(range.start.nextSibling)))) {
		var rangeStartParent = range.start.parentNode;

		// 1. If we are in a table in a foster-element position, then all non-element
		//    nodes will be white-space and comments. Skip over all of them and find
		//    the first table content node
		var newStart = range.start;
		while (newStart && !DU.isElt(newStart)) {
			newStart = newStart.nextSibling;
		}

		// 2. Push leading comments and whitespace into the element node
		//    as long as it is a tr/tbody -- pushing whitespace into the
		//    other (th/td/caption) can change display semantics.
		if (newStart && newStart.nodeName in {TBODY: 1, TR: 1}) {
			var insertPosition = newStart.firstChild;
			var n = range.start;
			while (n !== newStart) {
				var next = n.nextSibling;
				newStart.insertBefore(n, insertPosition);
				n = next;
			}
			range.start = newStart;
			// Update dsr to point to original start
			updateDSRForFirstTplNode(range.start, startElem);
		} else {
			range.start = rangeStartParent;
			range.end = rangeStartParent;
		}
	}

	// Ensure range.start is an element node since we want to
	// add/update the data-parsoid attribute to it.
	if (!DU.isElt(range.start) && !expandRangeToAvoidSpanWrapping(range, true)) {
		var span = doc.createElement('span');
		range.start.parentNode.insertBefore(span, range.start);
		span.appendChild(range.start);
		updateDSRForFirstTplNode(span, startElem);
		range.start = span;
	}

	if (range.start.nodeName === 'TABLE') {
		// If we have any fostered content, include it as well.
		while (DU.isElt(range.start.previousSibling) &&
				DU.getDataParsoid(range.start.previousSibling).fostered) {
			range.start = range.start.previousSibling;
		}
	}

	if (range.start === startElem && DU.isElt(range.start.nextSibling)) {
		// HACK!
		// The strip-double-tds pass has a HACK that requires DSR and src
		// information being set on this element node. So, this HACK here
		// is supporting that HACK there.
		//
		// (The parser test for T52603 will fail without this fix)
		updateDSRForFirstTplNode(range.start.nextSibling, startElem);
	}

	// Use the negative test since it doesn't mark the range as flipped
	// if range.start === range.end
	if (!DU.inSiblingOrder(range.start, range.end)) {
		// In foster-parenting situations, the end-meta tag (and hence range.end)
		// can show up before the range.start which would be the table itself.
		// So, we record this info for later analysis.
		range.flipped = true;
	}

	env.log("trace/tplwrap/findranges", function() {
			var msg = "";
			var dp1 = DU.getDataParsoid(range.start);
			var dp2 = DU.getDataParsoid(range.end);
			msg += "\n----------------------------------------------";
			msg += "\nFound range : " + range.id + "; flipped? " + range.flipped + "; offset: " + range.startOffset;
			msg += "\nstart-elem : " + range.startElem.outerHTML + "; DP: " + JSON.stringify(DU.getDataParsoid(range.startElem));
			msg += "\nend-elem : " + range.endElem.outerHTML + "; DP: " + JSON.stringify(DU.getDataParsoid(range.endElem));
			msg += "\nstart : [TAG_ID " + dp1.tmp.tagId + "]: " + range.start.outerHTML + "; DP: " + JSON.stringify(dp1);
			msg += "\nend : [TAG_ID " + dp2.tmp.tagId + "]: " + range.end.outerHTML + "; DP: " + JSON.stringify(dp2);
			msg += "\n----------------------------------------------";
			return msg;
		});

	return range;
}

function findTopLevelNonOverlappingRanges(document, env, docRoot, tplRanges) {
	function stripStartMeta(meta) {
		if (DU.hasNodeName(meta, 'meta')) {
			DU.deleteNode(meta);
		} else {
			// Remove mw:* from the typeof.
			var type = meta.getAttribute("typeof");
			type = type.replace(/(?:^|\s)mw:[^\/]*(\/[^\s]+|(?=$|\s))/g, '');
			meta.setAttribute("typeof", type);
		}
	}

	function findToplevelEnclosingRange(nestingInfo, startId) {
		// Walk up the implicit nesting tree to find the
		// top-level range within which rId is nested.
		// No cycles can exist since they have been suppressed.
		var visited = {};
		var rId = startId;
		while (nestingInfo.has(rId)) {
			if (visited[rId]) {
				throw new Error("Found a cycle in tpl-range nesting where there shouldn't have been one.");
			}
			visited[rId] = true;
			rId = nestingInfo.get(rId);
		}
		return rId;
	}

	function recordTemplateInfo(compoundTpls, compoundTplId, tpl, argInfo) {
		if (!compoundTpls[compoundTplId]) {
			compoundTpls[compoundTplId] = [];
		}

		// Record template args info along with any intervening wikitext
		// between templates that are part of the same compound structure.
		var tplArray = compoundTpls[compoundTplId];
		var dp = DU.getDataParsoid(tpl.startElem);
		var dsr = dp.dsr;

		if (tplArray.length > 0) {
			var prevTplInfo = lastItem(tplArray);
			if (prevTplInfo.dsr[1] < dsr[0]) {
				tplArray.push({ wt: env.page.src.substring(prevTplInfo.dsr[1], dsr[0]) });
			}
		}

		if (dp.unwrappedWT) {
			tplArray.push({ wt: dp.unwrappedWT });
		}

		// Get rid of src-offsets since they aren't needed anymore.
		argInfo.paramInfos.map(function(pi) { pi.srcOffsets = undefined;});
		tplArray.push({ dsr: dsr, args: argInfo.dict, paramInfos: argInfo.paramInfos });
	}

	// Nesting cycles with multiple ranges can show up because of foster
	// parenting scenarios if they are not detected and suppressed.
	function introducesCycle(start, end, nestingInfo) {
		var visited = {};
		visited[start] = true;
		var elt = nestingInfo.get(end);
		while (elt) {
			if (visited[elt]) {
				return true;
			}
			elt = nestingInfo.get(elt);
		}
		return false;
	}

	var n, r, ranges;
	var numRanges = tplRanges.length;

	// The `inSiblingOrder` check here is sufficient to determine overlaps
	// because the algorithm in `findWrappableTemplateRanges` will put the
	// start/end elements for intersecting ranges on the same plane and prev/
	// curr are in textual order (which hopefully translates to dom order).
	function rangesOverlap(prev, curr) {
		var prevEnd   = !prev.flipped ? prev.end : prev.start;
		var currStart = !curr.flipped ? curr.start : curr.end;
		return DU.inSiblingOrder(currStart, prevEnd);
	}

	// For each node, assign an attribute that is a record of all
	// tpl ranges it belongs to at the top-level.
	//
	// FIXME: Ideally we would have used a hash-table external to the
	// DOM, but we have no way of computing a hash-code on a dom-node
	// right now.  So, this is the next best solution (=hack) to use
	// node.data as hash-table storage.
	for (var i = 0; i < numRanges; i++) {
		r = tplRanges[i];
		n = !r.flipped ? r.start : r.end;
		var e = !r.flipped ? r.end : r.start;

		while (n) {
			if (DU.isElt(n)) {
				// Initialize tplRanges, if necessary.
				var dp = DU.getDataParsoid(n);
				ranges = dp.tmp.tplRanges;
				if (!ranges) {
					dp.tmp.tplRanges = ranges = {};
				}

				// Record 'r'
				ranges[r.id] = r;

				// Done
				if (n === e) {
					break;
				}
			}

			n = n.nextSibling;
		}
	}

	// In the first pass over `numRanges` below, `subsumedRanges` is used to
	// record purely the nested ranges.  However, in the second pass, we also
	// add the relationships between overlapping ranges so that
	// `findToplevelEnclosingRange` can use that information to add `argInfo`
	// to the right `compoundTpls`.  This scenario can come up when you have
	// three ranges, 1 intersecting with 2 but not 3, and 3 nested in 2.
	var subsumedRanges = new Map();

	// For each range r:(s, e), walk up from s --> docRoot and if any of
	// these nodes have tpl-ranges (besides r itself) assigned to them,
	// then r is nested in those other templates and can be ignored.
	for (i = 0; i < numRanges; i++) {
		r = tplRanges[i];
		n = r.start;

		while (n !== docRoot) {
			ranges = DU.getDataParsoid(n).tmp.tplRanges || null;
			if (ranges) {
				if (n !== r.start) {
					// console.warn(" -> nested; n_tpls: " + Object.keys(ranges));

					// 'r' is nested for sure
					// Record the outermost range in which 'r' is nested.
					var rangeIds = Object.keys(ranges);
					var findOutermostRange = function(prev, next) {
						return ranges[next].startOffset < ranges[prev].startOffset ? next : prev;
					};
					subsumedRanges.set(r.id, rangeIds.reduce(findOutermostRange, rangeIds[0]));
					break;
				} else {
					// n === r.start
					//
					// We have to make sure this is not an overlap scenario.
					// Find the ranges that r.start and r.end belong to and
					// compute their intersection. If this intersection has
					// another tpl range besides r itself, we have a winner!
					//
					// The code below does the above check efficiently.
					var sTpls = ranges;
					var eTpls = DU.getDataParsoid(r.end).tmp.tplRanges;
					var sKeys = Object.keys(sTpls);
					var foundNesting = false;

					for (var j = 0; j < sKeys.length; j++) {
						// - Don't record nesting cycles.
						// - Record the outermost range in which 'r' is nested in.
						var otherId = sKeys[j];
						var other = sTpls[otherId];
						if (otherId !== r.id
							&& eTpls[otherId]
							// When we have identical ranges, pick the range with
							// the larger offset to be subsumed.
							&& (r.start !== other.start || r.end !== other.end || other.startOffset < r.startOffset)
							&& !introducesCycle(r.id, otherId, subsumedRanges)) {
							foundNesting = true;
							if (!subsumedRanges.has(r.id)
								|| other.startOffset < sTpls[subsumedRanges.get(r.id)].startOffset) {
								subsumedRanges.set(r.id, otherId);
							}
						}
					}

					if (foundNesting) {
						// 'r' is nested
						// console.warn(" -> nested: sTpls: " + Object.keys(sTpls) +
						// "; eTpls: " + Object.keys(eTpls) +
						// "; set to: " + subsumedRanges.get(r.id));
						break;
					}
				}
			}

			// Move up
			n = n.parentNode;
		}
	}

	// Sort by start offset in source wikitext
	tplRanges.sort(function(r1, r2) { return r1.startOffset - r2.startOffset; });

	// Since the tpl ranges are sorted in textual order (by start offset),
	// it is sufficient to only look at the most recent template to see
	// if the current one overlaps with the previous one.
	//
	// This works because we've already identify nested ranges and can ignore them.

	var newRanges = [];
	var prev = null;
	var compoundTpls = {};

	for (i = 0; i < numRanges; i++) {
		var endTagToRemove = null;
		var startTagToStrip = null;

		r = tplRanges[i];

		// Extract argInfo
		var argInfo = DU.getDataParsoid(r.startElem).tmp.tplarginfo;
		if (argInfo) {
			argInfo = JSON.parse(argInfo);
		}

		env.log("trace/tplwrap/merge", function() {
			var msg = "";
			var dp1 = DU.getDataParsoid(r.start);
			var dp2 = DU.getDataParsoid(r.end);
			msg += "\n##############################################";
			msg += "\nrange " + r.id + "; r-start-elem: " + r.startElem.outerHTML + "; DP: " + JSON.stringify(DU.getDataParsoid(r.startElem));
			msg += "\nrange " + r.id + "; r-end-elem: " + r.endElem.outerHTML + "; DP: " + JSON.stringify(DU.getDataParsoid(r.endElem));
			msg += "\nrange " + r.id + "; r-start: [TAG_ID " + dp1.tmp.tagId + "]: " + r.start.outerHTML + "; DP: " + JSON.stringify(dp1);
			msg += "\nrange " + r.id + "; r-end: [TAG_ID " + dp2.tmp.tagId + "]: " + r.end.outerHTML + "; DP: " + JSON.stringify(dp2);
			msg += "\n----------------------------------------------";
			return msg;
		});

		var enclosingRangeId = findToplevelEnclosingRange(subsumedRanges, subsumedRanges.get(r.id));
		if (enclosingRangeId) {
			env.log("trace/tplwrap/merge", "--nested in ", enclosingRangeId, "--");

			// Nested -- ignore r
			startTagToStrip = r.startElem;
			endTagToRemove = r.endElem;
			if (argInfo) {
				// 'r' is nested in 'enclosingRange' at the top-level
				// So, enclosingRange gets r's argInfo
				recordTemplateInfo(compoundTpls, enclosingRangeId, r, argInfo);
			}
		} else if (prev && rangesOverlap(prev, r)) {
			// In the common case, in overlapping scenarios, r.start is
			// identical to prev.end. However, in fostered content scenarios,
			// there can true overlap of the ranges.
			env.log("trace/tplwrap/merge", "--overlapped--");

			// See comment above, where `subsumedRanges` is defined.
			subsumedRanges.set(r.id, prev.id);

			// Overlapping ranges.
			// r is the regular kind
			// Merge r with prev

			console.assert(!r.flipped,
				'Flipped range should have been enclosed.');

			startTagToStrip = r.startElem;
			endTagToRemove = prev.endElem;

			prev.end = r.end;
			prev.endElem = r.endElem;

			// Update compoundTplInfo
			if (argInfo) {
				recordTemplateInfo(compoundTpls, prev.id, r, argInfo);
			}
		} else {
			env.log("trace/tplwrap/merge", "--normal--");

			// Default -- no overlap
			// Emit the merged range
			newRanges.push(r);
			prev = r;

			// Update compoundTpls
			if (argInfo) {
				recordTemplateInfo(compoundTpls, r.id, r, argInfo);
			}
		}

		if (endTagToRemove) {
			// Remove start and end meta-tags
			// Not necessary to remove the start tag, but good to cleanup
			DU.deleteNode(endTagToRemove);
			stripStartMeta(startTagToStrip);
		}
	}

	return { ranges: newRanges, tplArrays: compoundTpls };
}

function findFirstTemplatedNode(range) {
	var firstNode = range.start;

	// Skip tpl marker meta
	if (DU.isTplMarkerMeta(firstNode)) {
		firstNode = firstNode.nextSibling;
	}

	// Walk past fostered nodes since they came from within a table
	// Note that this is not foolproof because in some scenarios,
	// fostered content is not marked up. Ex: when a table is templated,
	// and content from the table is fostered.
	var dp = DU.getDataParsoid(firstNode);
	while (dp && dp.fostered) {
		firstNode = firstNode.nextSibling;
		dp = DU.getDataParsoid(firstNode);
	}

	// FIXME: It is harder to use META as a node name since this is a generic
	// placeholder for a whole bunch of things each of which has its own
	// newline constraint requirements. So, for now, I am skipping that
	// can of worms to prevent confusing the serializer with an overloaded
	// tag name.
	if (firstNode.nodeName === 'META') { return undefined; }

	return dp.stx ? firstNode.nodeName + '_' + dp.stx : firstNode.nodeName;
}

function encapsulateTemplates(doc, env, tplRanges, tplArrays) {
	var numRanges = tplRanges.length;
	for (var i = 0; i < numRanges; i++) {
		var range = tplRanges[i];

		expandRangeToAvoidSpanWrapping(range);

		// If transcluded content ends up in the foster box, we wrap the whole
		// table+fb in metas, so `findTopLevelNonOverlappingRanges` should
		// only produce non-flipped ranges.
		console.assert(!range.flipped, 'Encapsulating a flipped range.');

		var n = range.start;
		var e = range.end;
		var startElem = range.startElem;
		var about = startElem.getAttribute('about');

		while (n) {
			var next = n.nextSibling;
			if (!DU.isElt(n)) {
				// Don't add span-wrappers in fosterable positions
				//
				// NOTE: there cannot be any non-IEW text in fosterable position
				// since the HTML tree builder would already have fostered it out.
				if (!DU.isFosterablePosition(n)) {
					var span = doc.createElement('span');
					span.setAttribute('about', about);
					// attach the new span to the DOM
					n.parentNode.insertBefore(span, n);
					// move the text node into the span
					span.appendChild(n);
					n = span;
				}
			} else {
				n.setAttribute('about', about);
			}

			if (n === e) {
				break;
			}

			n = next;
		}

		// SSS FIXME: is it a bug that tplArray can be null?
		// To be separately investigated.
		//
		// Encap. info for the range
		var encapInfo = {
			valid: false,
			target: range.start,
			tplArray: tplArrays[range.id],
			datamw: null,
			dp: null,
		};

		// Skip template-marker meta-tags.
		// Also, skip past comments/text nodes found in fosterable positions
		// which wouldn't have been span-wrapped in the while-loop above.
		while (DU.isTplMarkerMeta(encapInfo.target) || !DU.isElt(encapInfo.target)) {
			// Detect unwrappable template and bail out early.
			if (encapInfo.target === range.end ||
				(!DU.isElt(encapInfo.target) && !DU.isFosterablePosition(encapInfo.target))) {
				throw new Error("Cannot encapsulate transclusion. Start=" + startElem.outerHTML);
			}
			encapInfo.target = encapInfo.target.nextSibling;
		}
		encapInfo.dp = DU.getDataParsoid(encapInfo.target);

		// Update type-of (always even if tpl-encap below will fail).
		// This ensures that VE will still "edit-protect" this template
		// and not allow its content to be edited directly.
		if (startElem !== encapInfo.target) {
			var t1 = startElem.getAttribute("typeof");
			var t2 = encapInfo.target.getAttribute("typeof");
			encapInfo.target.setAttribute("typeof", t2 ? t1 + " " + t2 : t1);
		}

		/*
		console.log("startElem: " + startElem.outerHTML);
		console.log("endElem: " + range.endElem.outerHTML);
		console.log("range.start: " + range.start.outerHTML);
		console.log("range.end: " + range.end.outerHTML);
		*/

		/* ----------------------------------------------------------------
		 * We'll attempt to update dp1.dsr to reflect the entire range of
		 * the template.  This relies on a couple observations:
		 *
		 * 1. In the common case, dp2.dsr[1] will be > dp1.dsr[1]
		 *    If so, new range = dp1.dsr[0], dp2.dsr[1]
		 *
		 * 2. But, foster parenting can complicate this when range.end is a table
		 *    and range.start has been fostered out of the table (range.end).
		 *    But, we need to verify this assumption.
		 *
		 *    2a. If dp2.dsr[0] is smaller than dp1.dsr[0], this is a
		 *        confirmed case of range.start being fostered out of range.end.
		 *
		 *    2b. If dp2.dsr[0] is unknown, we rely on fostered flag on
		 *        range.start, if any.
		 * ---------------------------------------------------------------- */
		var dp1 = Util.clone(DU.getDataParsoid(range.start));
		var dp2DSR = getRangeEndDSR(range);

		if (dp1.dsr) {
			if (dp2DSR) {
				// Case 1. above
				if (dp2DSR[1] > dp1.dsr[1]) {
					dp1.dsr[1] = dp2DSR[1];
				}

				// Case 2. above
				var endDsr = dp2DSR[0];
				if (DU.hasNodeName(range.end, 'table') &&
					endDsr !== null &&
					(endDsr < dp1.dsr[0] || dp1.fostered)) {
					dp1.dsr[0] = endDsr;
				}
			}

			// encapsulation possible only if dp1.dsr is valid
			encapInfo.valid = dp1.dsr[0] !== null && dp1.dsr[1] !== null;
		}

		var tplArray = encapInfo.tplArray;
		if (encapInfo.valid && tplArray) {
			// Find transclusion info from the array (skip past a wikitext element)
			var firstTplInfo = tplArray[0].wt ? tplArray[1] : tplArray[0];

			// Add any leading wikitext
			if (firstTplInfo.dsr[0] > dp1.dsr[0]) {
				// This gap in dsr (between the final encapsulated content, and the
				// content that actually came from a template) is indicative of this
				// being a mixed-template-content-block and/or multi-template-content-block
				// scenario.
				//
				// In this case, record the name of the first node in the encapsulated
				// content. During html -> wt serialization, newline constraints for
				// this entire block has to be determined relative to this node.
				encapInfo.dp.firstWikitextNode = findFirstTemplatedNode(range);
				tplArray = [{ wt: env.page.src.substring(dp1.dsr[0], firstTplInfo.dsr[0]) }].concat(tplArray);
			}

			// Add any trailing wikitext
			var lastTplInfo = lastItem(tplArray);
			if (lastTplInfo.dsr[1] < dp1.dsr[1]) {
				tplArray.push({ wt: env.page.src.substring(lastTplInfo.dsr[1], dp1.dsr[1]) });
			}

			// Extract the key orders for the templates
			var paramInfoArrays = [];
			/* jshint loopfunc: true */
			// yes, this function is in a loop
			tplArray.forEach(function(a) {
				if (a.paramInfos) {
					paramInfoArrays.push(a.paramInfos);
				}
			});

			// Map the array of { dsr: .. , args: .. } objects to just the args property
			/* jshint loopfunc: true */
			// yes, this function is in a loop
			var infoIndex = 0;
			tplArray = tplArray.map(function(a) {
				if (a.wt) {
					return a.wt;
				} else {
					// Remember the position of the transclusion relative
					// to other transclusions. Should match the index of
					// the corresponding private metadata in paramInfoArrays
					// above.
					if (a.args) {
						a.args.i = infoIndex;
					}
					infoIndex++;
					return {template: a.args};
				}
			});

			// Set up dsr[0], dsr[1], and data-mw on the target node
			encapInfo.datamw = { parts: tplArray };
			DU.setDataMw(encapInfo.target, encapInfo.datamw);
			encapInfo.dp.pi = paramInfoArrays;

			// Special case when mixed-attribute-and-content templates are
			// involved. This information is reliable and comes from the
			// AttributeExpander and gets around the problem of unmarked
			// fostered content that findFirstTemplatedNode runs into.
			var firstWikitextNode = DU.getDataParsoid(range.startElem).firstWikitextNode;
			if (!encapInfo.dp.firstWikitextNode && firstWikitextNode) {
				encapInfo.dp.firstWikitextNode = firstWikitextNode;
			}
		} else if (!encapInfo.valid) {
			var errors = [ "Do not have necessary info. to encapsulate Tpl: " + i ];
			errors.push("Start Elt : " + startElem.outerHTML);
			errors.push("End Elt   : " + range.endElem.outerHTML);
			errors.push("Start DSR : " + JSON.stringify(dp1 || {}));
			errors.push("End   DSR : " + JSON.stringify(dp2DSR || []));
			env.log("error", errors.join("\n"));
		} else if (!(/(^|\s)mw:Param(\s|$)/).test(startElem.getAttribute("typeof"))) {
			env.log("error", "Missing data-mw arginfo for: " + startElem.outerHTML);
		}

		// Make DSR range zero-width for fostered templates after
		// setting up data-mw. However, since template encapsulation
		// sometimes captures both fostered content as well as the table
		// from which it was fostered from, in those scenarios, we should
		// leave DSR info untouched.
		//
		// SSS FIXME:
		// 1. Should we remove the fostered flag from the entire
		//    encapsulated block if we dont set dsr width range to zero
		//    since only part of the block is fostered, not the entire
		//    encapsulated block?
		//
		// 2. In both cases, should we mark these uneditable by adding
		//    mw:Placeholder to the typeof?
		if (dp1.fostered) {
			encapInfo.datamw = DU.getDataMw(encapInfo.target);
			if (!encapInfo.datamw || !encapInfo.datamw.parts || encapInfo.datamw.parts.length === 1) {
				dp1.dsr[1] = dp1.dsr[0];
			}
		}

		// Update DSR after fostering-related fixes are done.
		if (encapInfo.valid) {
			if (!encapInfo.dp) {
				// This wouldn't have been initialized if tplArray was null
				encapInfo.dp = DU.getDataParsoid(encapInfo.target);
			}
			// encapInfo.dp points to DU.getDataParsoid(encapInfo.target)
			// and all updates below update properties in that object tree.
			if (!encapInfo.dp.dsr) {
				encapInfo.dp.dsr = dp1.dsr;
			} else {
				encapInfo.dp.dsr[0] = dp1.dsr[0];
				encapInfo.dp.dsr[1] = dp1.dsr[1];
			}
			encapInfo.dp.src = env.page.src.substring(encapInfo.dp.dsr[0], encapInfo.dp.dsr[1]);
		}

		// Remove startElem (=range.startElem) if a meta.  If a meta,
		// it is guaranteed to be a marker meta added to mark the start
		// of the template.
		if (DU.isTplMarkerMeta(startElem)) {
			DU.deleteNode(startElem);
		}

		DU.deleteNode(range.endElem);
	}
}

/**
 * Recursive worker
 */
function findWrappableTemplateRanges(doc, env, root, tpls) {
	var tplRanges = [];
	var elem = root.firstChild;
	var about;
	var aboutRef;

	while (elem) {
		// get the next sibling before doing anything since
		// we may delete elem as part of encapsulation
		var nextSibling = elem.nextSibling;

		if (DU.isElt(elem)) {
			var type = elem.getAttribute('typeof');
			var metaMatch = type ? type.match(DU.TPL_META_TYPE_REGEXP) : null;

			// Ignore templates without tsr.
			//
			// These are definitely nested in other templates / extensions
			// and need not be wrapped themselves since they
			// can never be edited directly.
			//
			// NOTE: We are only testing for tsr presence on the start-elem
			// because wikitext errors can lead to parse failures and no tsr
			// on end-meta-tags.
			//
			// Ex: "<ref>{{echo|bar}}<!--bad-></ref>"
			if (metaMatch && (DU.getDataParsoid(elem).tsr || /\/End(?=$|\s)/.test(type))) {
				var metaType = metaMatch[1];

				about = elem.getAttribute('about');
				aboutRef = tpls[about];
				// Is this a start marker?
				if (!/\/End(?=$|\s)/.test(metaType)) {
					if (aboutRef) {
						aboutRef.start = elem;
						// content or end marker existed already
						if (aboutRef.end) {
							// End marker was foster-parented.
							// Found actual start tag.
							env.log("warning/template", 'end marker was foster-parented for', about);
							tplRanges.push(getDOMRange(env, doc, elem, aboutRef.end, aboutRef.end));
						} else {
							// should not happen!
							env.log("warning/template", 'start found after content for', about);
						}
					} else {
						tpls[about] = { start: elem };
					}
				} else {
					// elem is the end-meta tag
					if (aboutRef) {
						/* ------------------------------------------------------------
						 * Special case: In some cases, the entire template content can
						 * get fostered out of a table, not just the start/end marker.
						 *
						 * Simplest example:
						 *
						 *   {|
						 *   {{echo|foo}}
						 *   |}
						 *
						 * More complex example:
						 *
						 *   {|
						 *   {{echo|
						 *   a
						 *    b
						 *
						 *     c
						 *   }}
						 *   |}
						 *
						 * Since meta-tags dont normally get fostered out, this scenario
						 * only arises when the entire content including meta-tags was
						 * wrapped in p-tags.  So, we look to see if:
						 * 1. the end-meta-tag's parent has a table sibling,
						 * 2. the DSR of the start-meta-tag's parent is nested inside
						 *    that table's DSR
						 * If so, we recognize this as a adoption scenario and fix up
						 * DSR of start-meta-tag's parent to include the table's DSR.
						 * ------------------------------------------------------------*/
						var sm  = aboutRef.start;
						var em  = elem;
						var ee  = em;
						var tbl = em.parentNode.nextSibling;

						// Dont get distracted by a newline node -- skip over it
						// Unsure why it shows up occasionally
						if (tbl && DU.isText(tbl) && tbl.data.match(/^\n$/)) {
							tbl = tbl.nextSibling;
						}

						var dp = DU.getDataParsoid(sm.parentNode);
						if (tbl &&
							DU.hasNodeName(tbl, 'table') &&
							dp.fostered) {
							var tblDP = DU.getDataParsoid(tbl);
							if (dp.tsr && dp.tsr[0] !== null && tblDP.dsr[0] === null) {
								tblDP.dsr[0] = dp.tsr[0];
							}
							tbl.setAttribute('about', about); // set about on elem
							ee = tbl;
						}
						tplRanges.push(getDOMRange(env, doc, sm, em, ee));
					} else {
						tpls[about] = { end: elem };
					}
				}
			} else {
				tplRanges = tplRanges.concat(findWrappableTemplateRanges(doc, env, elem, tpls));
			}
		}

		elem = nextSibling;
	}

	return tplRanges;
}

function wrapTemplatesInTree(document, env, node) {
	var tplRanges = findWrappableTemplateRanges(document, env, node, {});
	if (tplRanges.length > 0) {
		tplRanges = findTopLevelNonOverlappingRanges(document, env, node, tplRanges);
		encapsulateTemplates(document, env, tplRanges.ranges, tplRanges.tplArrays);
	}
}

/**
 * Encapsulate template-affected DOM structures by wrapping text nodes into
 * spans and adding RDFa attributes to all subtree roots according to
 * http://www.mediawiki.org/wiki/Parsoid/RDFa_vocabulary#Template_content
 */
function wrapTemplates(body, env, options) {
	var psd = env.conf.parsoid;

	if (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:pre-encap") !== -1)) {
		DU.dumpDOM(body, 'DOM: pre-encapsulation');
	}

	wrapTemplatesInTree(body.ownerDocument, env, body);

	if (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:post-encap") !== -1)) {
		DU.dumpDOM(body, 'DOM: post-encapsulation');
	}
}

if (typeof module === "object") {
	module.exports.wrapTemplates = wrapTemplates;
}
