"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	dumpDOM = require('./dom.dumper.js').dumpDOM,
	Util = require('./mediawiki.Util.js').Util;

/**
 * Find the common DOM ancestor of two DOM nodes
 */
function getDOMRange( env, doc, startElem, endMeta, endElem ) {
	var startElemIsMeta = DU.hasNodeName(startElem, "meta");

	// Detect empty content
	if (startElemIsMeta && startElem.nextSibling === endElem) {
		// Adding spans in a fosterable position will result
		// in breaking skipOverEncapsulatedContent in rt.
		// If the metas are in a fosterable position and
		// content is empty, it's usually an indication that
		// the content was fostered out anyways and spans aren't
		// necessary. A {{blank}} template in a fosterable
		// position probably won't be handled properly though.
		if ( !DU.isFosterablePosition( endElem ) ) {
			var emptySpan = doc.createElement('span');
			startElem.parentNode.insertBefore(emptySpan, endElem);
		}
	}

	var startAncestors = DU.pathToRoot(startElem);

	// now find common ancestor
	var elem = endElem;
	var parentNode = endElem.parentNode;
	var range = null;
	while (parentNode && parentNode.nodeType !== doc.DOCUMENT_NODE) {
		var i = startAncestors.indexOf( parentNode );
		var tsr0 = DU.getDataParsoid( startElem ).tsr[0];
		if (i === 0) {
			// widen the scope to include the full subtree
			range = {
				'root': startElem,
				startElem: startElem,
				endElem: endMeta,
				start: startElem.firstChild,
				end: startElem.lastChild,
				id: env.stripIdPrefix(startElem.getAttribute("about")),
				startOffset: tsr0
			};
			break;
		} else if ( i > 0) {
			range = {
				'root': parentNode,
				startElem: startElem,
				endElem: endMeta,
				start: startAncestors[i - 1],
				end: elem,
				id: env.stripIdPrefix(startElem.getAttribute("about")),
				startOffset: tsr0
			};
			break;
		}
		elem = parentNode;
		parentNode = elem.parentNode;
	}

	var updateDP = false;
	var tcStart = range.start;

	// Skip meta-tags
	if (startElemIsMeta && tcStart === startElem) {
		tcStart = tcStart.nextSibling;
		range.start = tcStart;
		updateDP = true;
	}

	// Ensure range.start is an element node since we want to
	// add/update the data-parsoid attribute to it.
	if (tcStart.nodeType === doc.COMMENT_NODE || tcStart.nodeType === doc.TEXT_NODE) {
		var skipSpan = false,
			tcStartParent = tcStart.parentNode;

		if (DU.isFosterablePosition(tcStart)) {
			skipSpan = true;

			// 1. If we are in a table in a foster-element position, then all non-element
			//    nodes will be white-space and comments. Skip over all of them and find
			//    the first table node
			var newStart = tcStart;
			while (newStart && !DU.isElt(newStart)) {
				newStart = newStart.nextSibling;
			}

			// 2. Push leading comments and whitespace into the element node
			//    as long as it is a tr/tbody -- pushing whitespace into the
			//    other (th/td/caption) can change display semantics.
			if (newStart && newStart.nodeName in {TBODY:1, TR:1}) {
				var insertPosition = newStart.firstChild;
				var n = tcStart;
				while (n !== newStart) {
					var next = n.nextSibling;
					newStart.insertBefore(n, insertPosition);
					n = next;
				}
				tcStart = newStart;

				// Update dsr to point to original start
				updateDP = true;
			} else {
				tcStart = tcStartParent;

				// Dont update dsr to original start
				// since we've encapsulated a wider DOM range
				updateDP = false;
			}
		} else {
			// See if we can go up one level
			//
			// Eliminates useless spanning of wikitext of the form: {{echo|foo}}
			// where the the entire template content is contained in a paragraph
			if (tcStartParent.firstChild === startElem &&
				tcStartParent.lastChild === endElem &&
				tcStartParent === range.end.parentNode)
			{
				if (DU.hasNodeName(tcStartParent, 'p') && !DU.isLiteralHTMLNode(tcStartParent)) {
					tcStart = tcStartParent;
					range.end = tcStartParent;
					skipSpan = true;
				}
			}

			updateDP = true;
		}

		if (!skipSpan) {
			// wrap tcStart in a span.
			var span = doc.createElement('span');
			tcStart.parentNode.insertBefore(span, tcStart);
			span.appendChild(tcStart);
			tcStart = span;
		}
		range.start = tcStart;
	}

	if (updateDP) {
		var done = false;

		var tcDP = DU.getDataParsoid( tcStart );
		var seDP = DU.getDataParsoid( startElem );

		// Since TSRs on template content tokens are cleared by the
		// template handler, all computed dsr values for template content
		// is always inferred from top-level content values and is safe.
		// So, do not overwrite a bigger end-dsr value.
		if (seDP.dsr && (tcDP.dsr && tcDP.dsr[1] > seDP.dsr[1])) {
			tcDP.dsr[0] = seDP.dsr[0];
			done = true;
		}

		if (!done) {
			tcDP.dsr = Util.clone( seDP.dsr );
			tcDP.src = seDP.src;
		}
	}

	if (!DU.inSiblingOrder(range.start, range.end)) {
		// In foster-parenting situations, the end-meta tag (and hence r.end)
		// can show up before the r.start which would be the table itself.
		// So, we record this info for later analysis
		range.flipped = true;
	}

	return range;
}

function findTopLevelNonOverlappingRanges(document, env, docRoot, tplRanges) {
	function stripStartMeta(meta) {
		if (DU.hasNodeName(meta, 'meta')) {
			DU.deleteNode(meta);
		} else {
			// Remove mw:* from the typeof
			var type = meta.getAttribute("typeof");
			type = type.replace(/(?:^|\s)mw:[^\/]*(\/[^\s]+|(?=$|\s))/g, '');
			meta.setAttribute("typeof", type);
		}
	}

	function findToplevelEnclosingRange(nestingInfo, startId) {
		// Walk up the implicit nesting tree to the find the
		// top-level range within which rId is nested.
		//
		// Detect cycles and return the smallest id for all
		// elements in the cycle.
		//
		// Cycles can show up because of > 2 identical ranges (some of which
		// might be flipped ranges because of foster parenting scenarios)

		function findCycle(start, edges) {
			var visited = {},
				elt = start;
			while (!visited[elt]) {
				visited[elt] = true;
				elt = edges[elt];
			}
			return Object.keys(visited);
		}

		var visitedIds = {},
			rId = startId;
		while (nestingInfo[rId]) {
			if (visitedIds[rId]) {
				// We have a cycle -- find members of the cycle and return
				// the smallest id in the cycle.
				//
				// NOTE: Cannot use members of visitedIds to detect cycles
				// since it can contain elements outside the cycle.
				var cycle = findCycle(rId, nestingInfo),
					minId = Math.min.apply(null, cycle);
				// minId is a number, rId, startId are strings
				minId = minId.toString();

				// console.warn("Found cycle: " + JSON.stringify(cycle) + "; Min id: " + minId);

				// The smallest element will contain all the other elements.
				// So, minId itself should return null
				return (minId === startId) ? null : minId;
			}
			visitedIds[rId] = true;
			rId = nestingInfo[rId];
		}
		return rId;
	}

	function recordTemplateInfo(compoundTpls, compoundTplId, tpl, argInfo) {
		// Record template args info alongwith any intervening wikitext
		// between templates part of the same compound structure
		var tplArray = compoundTpls[compoundTplId],
			dsr = DU.getDataParsoid(tpl.startElem).dsr;

		if (tplArray.length > 0) {
			var prevTplInfo = tplArray[tplArray.length-1];
			if (prevTplInfo.dsr[1] < dsr[0]) {
				tplArray.push({ wt: env.page.src.substring(prevTplInfo.dsr[1], dsr[0]) });
			}
		}
		tplArray.push({ dsr: dsr, args: argInfo.dict, paramInfos: argInfo.paramInfos });
	}

	var i, r, n, e, data;
	var numRanges = tplRanges.length;

	// For each node, assign an attribute that is a record of all
	// tpl ranges it belongs to at the top-level
	//
	// FIXME: Ideally we would have used a hash-table external to the
	// DOM, but we have no way of computing a hash-code on a dom-node
	// right now.  So, this is the next best solution (=hack) to use
	// node.data as hash-table storage.
	for (i = 0; i < numRanges; i++) {
		r = tplRanges[i];
		n = !r.flipped ? r.start : r.end;
		e = !r.flipped ? r.end : r.start;

		while (n) {
			if (DU.isElt(n)) {
				// Initialize n.data.tmp_tplRanges, if necessary
				data = DU.getNodeData( n );

				// Use a "_tmp" prefix on tplRanges so that it doesn't
				// get serialized out as a data-attribute by utility
				// methods on the DOM -- the prefix will be a signal
				// to the method to not serialize it.  This data on the
				// DOM nodes is purely temporary and doesn't need to
				// persist beyond this pass.
				var tpls = data.tmp_tplRanges;
				if (!tpls) {
					tpls = {};
					data.tmp_tplRanges = tpls;
				}

				// Record 'r'
				tpls[r.id] = true;

				// Done
				if (n === e) {
					break;
				}
			}

			n = n.nextSibling;
		}
	}

	// For each range r:(s, e), walk up from s --> docRoot and if if any of
	// these nodes have tpl-ranges (besides r itself) assigned to them,
	// then r is nested in those other templates and can be ignored.
	var nestedRangesMap = {};
	for (i = 0; i < numRanges; i++) {
		r = tplRanges[i];
		n = r.start;

		// console.warn("Range: " + r.id);

		while (n !== docRoot) {
			data = DU.getNodeData( n );
			if ( data && data.tmp_tplRanges ) {
				if (n !== r.start) {
					// console.warn("1. nested; n_tpls: " + Object.keys(n.data.tmp_tplRanges));

					// 'r' is nested for sure
					// Record a range in which 'r' is nested in.
					nestedRangesMap[r.id] = Object.keys( data.tmp_tplRanges )[0];
					break;
				} else {
					// n === r.start
					//
					// We have to make sure this is not an overlap scenario.
					// Find the ranges that r.start and r.end belong to and
					// compute their intersection.  If this intersection has
					// another tpl range besides r itself, we have a winner!
					//
					// Array A - B functionality that Ruby has would have simplified
					// this code!
					//
					// The code below does the above check efficiently.
					var s_tpls = DU.getNodeData( r.start ).tmp_tplRanges,
						e_tpls = DU.getNodeData( r.end ).tmp_tplRanges,
						s_keys = Object.keys(s_tpls),
						foundIntersection = false;

					for (var j = 0; j < s_keys.length; j++) {
						var other = s_keys[j];
						if (other !== r.id && e_tpls[other]) {
							foundIntersection = true;
							// Record a range in which 'r' is nested in.
							nestedRangesMap[r.id] = other;
							break;
						}
					}

					if (foundIntersection) {
						// 'r' is nested
						// console.warn("2. nested: s_tpls: " + Object.keys(s_tpls) + "; e_tpls: " + Object.keys(e_tpls));
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
	// This works because we've already identify nested ranges and can
	// ignore them.

	var newRanges = [],
		prev = null,
		compoundTpls = {},
		merged;

	for (i = 0; i < numRanges; i++) {
		var endTagToRemove = null,
			startTagToStrip = null;

		merged = false;
		r = tplRanges[i];

		// Extract argInfo and clear it
		var argInfo = r.startElem.getAttribute("data-mw-arginfo");
		if (argInfo) {
			argInfo = JSON.parse(argInfo);
			r.startElem.removeAttribute("data-mw-arginfo");
		}

		/*
		console.warn("##############################################");
		console.warn("range " + r.id + "; r-start-elem: " + r.startElem.outerHTML + "; DP: " + JSON.stringify(DU.getDataParsoid(r.startElem)));
		console.warn("range " + r.id + "; r-end-elem: " + r.endElem.outerHTML + "; DP: " + JSON.stringify(DU.getDataParsoid(r.endElem)));
		console.warn("-----------------------------");
		*/

		var enclosingRangeId = null;
		if (nestedRangesMap[r.id]) {
			// console.warn("--possibly nested--");
			enclosingRangeId = findToplevelEnclosingRange(nestedRangesMap, r.id);
		}

		if (nestedRangesMap[r.id] && enclosingRangeId) {
			// console.warn("--nested in " + enclosingRangeId + "--");
			// Nested -- ignore r
			startTagToStrip = r.startElem;
			endTagToRemove = r.endElem;
			if (argInfo) {
				// 'r' is nested in 'enclosingRange' at the top-level
				// So, enclosingRange gets r's argInfo
				if (!compoundTpls[enclosingRangeId]) {
					compoundTpls[enclosingRangeId] = [];
				}
				recordTemplateInfo(compoundTpls, enclosingRangeId, r, argInfo);
			}
		} else if (prev && !r.flipped && r.start === prev.end) {
			// console.warn("--overlapped--");

			// Overlapping ranges.
			// r is the regular kind
			// Merge r with prev
			//
			// SSS FIXME: What if r is the flipped kind?
			// Does that require special treatment?

			startTagToStrip = r.startElem;
			endTagToRemove = prev.endElem;

			prev.end = r.end;
			prev.endElem = r.endElem;

			// Update compoundTplInfo
			if (argInfo) {
				recordTemplateInfo(compoundTpls, prev.id, r, argInfo);
			}
		} else {
			// console.warn("--normal--");

			// Default -- no overlap
			// Emit the merged range
			newRanges.push(r);
			prev = r;

			// Update compoundTpls
			if (argInfo) {
				if (!compoundTpls[r.id]) {
					compoundTpls[r.id] = [];
				}
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

function encapsulateTemplates( doc, env, tplRanges, tplArrays) {
	var i, numRanges = tplRanges.length;
	for (i = 0; i < numRanges; i++) {
		var span,
			range = tplRanges[i],
			n = !range.flipped ? range.start : range.end,
			e = !range.flipped ? range.end : range.start,
			startElem = range.startElem,
			about = startElem.getAttribute('about');

		while (n) {
			var next = n.nextSibling;

			if ( n.nodeType === n.TEXT_NODE || n.nodeType === n.COMMENT_NODE ) {
				// Dont add span-wrappers in fosterable positions
				//
				// NOTE: there cannot be any non-IEW text in fosterable position
				// since the HTML tree builder would already have fostered it out.
				if (!DU.isFosterablePosition(n)) {
					span = doc.createElement( 'span' );
					span.setAttribute( 'about', about );
					// attach the new span to the DOM
					n.parentNode.insertBefore( span, n );
					// move the text node into the span
					span.appendChild( n );
					n = span;
				}
			} else if (DU.isElt(n)) {
				n.setAttribute( 'about', about );
			}

			if ( n === e ) {
				break;
			}

			n = next;
		}

		// update type-of
		var tcStart = range.start;
		var tcEnd = range.end;
		if (startElem !== tcStart) {
			var t1 = startElem.getAttribute("typeof"),
				t2 = tcStart.getAttribute("typeof");
			tcStart.setAttribute("typeof", t2 ? t1 + " " + t2 : t1);
		}

/*
		console.log("startElem: " + startElem.outerHTML);
		console.log("endElem: " + range.endElem.outerHTML);
		console.log("tcStart: " + tcStart.outerHTML);
		console.log("tcEnd: " + tcEnd.outerHTML);
*/

		/* ----------------------------------------------------------------
		 * We'll attempt to update dp1.dsr to reflect the entire range of
		 * the template.  This relies on a couple observations:
		 *
		 * 1. In the common case, dp2.dsr[1] will be > dp1.dsr[1]
		 *    If so, new range = dp1.dsr[0], dp2.dsr[1]
		 *
		 * 2. But, foster parenting can complicate this when tcEnd is a table
		 *    and tcStart has been fostered out of the table (tcEnd).
		 *    But, we need to verify this assumption.
		 *
		 *    2a. If dp2.dsr[0] is smaller than dp1.dsr[0], this is a
		 *        confirmed case of tcStart being fostered out of tcEnd.
		 *
		 *    2b. If dp2.dsr[0] is unknown, we rely on fostered flag on
		 *        tcStart, if any.
		 * ---------------------------------------------------------------- */
		var dp1 = DU.getDataParsoid( tcStart ),
			dp2 = DU.getDataParsoid( tcEnd ),
			done = false;
		/*
		console.warn("dp1: " + JSON.stringify(dp1));
		console.warn("dp2: " + JSON.stringify(dp2));
		*/
		if (dp1.dsr) {
			if (dp2.dsr) {
				// Case 1. above
				if (dp2.dsr[1] > dp1.dsr[1]) {
					dp1.dsr[1] = dp2.dsr[1];
				}

				// Case 2. above
				var endDsr = dp2.dsr[0];
				if (DU.hasNodeName(tcEnd, 'table') &&
					endDsr !== null &&
					(endDsr < dp1.dsr[0] || dp1.fostered))
				{
					dp1.dsr[0] = endDsr;
				}
			}


			// Check if now have a useable range on dp1
			if (dp1.dsr[0] !== null && dp1.dsr[1] !== null) {
				dp1.src = env.page.src.substring( dp1.dsr[0], dp1.dsr[1] );
				done = true;
			}
		}

		if (done) {
			var tplArray = tplArrays[range.id];
			if (tplArray) {
				// Add any leading wikitext
				var firstTplInfo = tplArray[0];
				if (firstTplInfo.dsr[0] > dp1.dsr[0]) {
					tplArray = [{ wt: env.page.src.substring(dp1.dsr[0], firstTplInfo.dsr[0]) }].concat(tplArray);
				}

				// Add any trailing wikitext
				var lastTplInfo = tplArray[tplArray.length-1];
				if (lastTplInfo.dsr[1] < dp1.dsr[1]) {
					tplArray.push({ wt: env.page.src.substring(lastTplInfo.dsr[1], dp1.dsr[1]) });
				}

				// Extract the key orders for the templates
				var paramInfoArrays = [];
				/* jshint loopfunc: true */ // yes, this function is in a loop
				tplArray.forEach(function(a) {
					if (a.paramInfos) {
						paramInfoArrays.push(a.paramInfos);
					}
				});

				// Map the array of { dsr: .. , args: .. } objects to just the args property
				/* jshint loopfunc: true */ // yes, this function is in a loop
				var infoIndex = 0;
				tplArray = tplArray.map(function(a) {
					if (a.wt) {
						return a.wt;
					} else {
						// Remember the position of the transclusion relative
						// to other transclusions. Should match the index of
						// the corresponding private metadata in paramInfoArrays
						// above.
						if (a.args) { // XXX: not sure why args can be undefined here
							a.args.i = infoIndex;
						}
						infoIndex++;
						return {template: a.args};
					}
				});

				// Output the data-mw obj.
				var datamw = { parts: tplArray };
				range.start.setAttribute("data-mw", JSON.stringify(datamw));
				DU.getDataParsoid( range.start ).pi = paramInfoArrays;
			}
		} else {

			var errors = [ "Do not have necessary info. to encapsulate Tpl: " + i ];
			errors.push( "Start Elt : " + startElem.outerHTML );
			errors.push( "End Elt   : " + range.endElem.innerHTML );
			errors.push( "Start DSR : " + JSON.stringify(dp1 || {}) );
			errors.push( "End   DSR : " + JSON.stringify(dp2 || {}) );
			env.log( "error", errors.join("\n"));
		}

		// Remove startElem (=range.startElem) if a meta.  If a meta,
		// it is guaranteed to be a marker meta added to mark the start
		// of the template.
		// However, tcStart (= range.start), even if a meta, need not be
		// a marker meta added for the template.
		if (DU.hasNodeName(startElem, "meta") &&
				/(?:^|\s)mw:(:?Transclusion|Param)(?=$|\s)/.test(startElem.getAttribute('typeof'))) {
			DU.deleteNode(startElem);
		}

		DU.deleteNode(range.endElem);
	}
}

function findTableSibling( elem, about ) {
	elem = elem.nextSibling;
	while (elem &&
			(!DU.hasNodeName(elem, 'table') ||
			 elem.getAttribute('about') !== about))
	{
		elem = elem.nextSibling;
	}

	//if (elem) console.log( 'tableNode found' + elem.innerHTML );
	return elem;
}

/**
 * Recursive worker
 */
function findWrappableTemplateRanges( doc, env, root, tpls ) {
	var tplRanges = [],
	    elem = root.firstChild,
		about, aboutRef;

	while (elem) {
		// get the next sibling before doing anything since
		// we may delete elem as part of encapsulation
		var nextSibling = elem.nextSibling;

		if ( DU.isElt(elem) ) {
			var type = elem.getAttribute( 'typeof' ),
				// SSS FIXME: This regexp differs from that in isTplMetaType
				metaMatch = type ? type.match( /(?:^|\s)(mw:(?:Transclusion|Param)(\/[^\s]+)?)(?=$|\s)/ ) : null;

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
			if (metaMatch && ( DU.getDataParsoid( elem ).tsr || /\/End(?=$|\s)/.test(type))) {
				var metaType = metaMatch[1];

				about = elem.getAttribute('about');
				aboutRef = tpls[about];
				// Is this a start marker?
				if (!/\/End(?=$|\s)/.test(metaType)) {
					if ( aboutRef ) {
						aboutRef.start = elem;
						// content or end marker existed already
						if ( aboutRef.end ) {
							// End marker was foster-parented.
							// Found actual start tag.
							env.log("error", 'end marker was foster-parented for', about);
							tplRanges.push(getDOMRange( env, doc, elem, aboutRef.end, aboutRef.end ));
						} else {
							// should not happen!
							env.log("error", 'start found after content for', about);
							//console.warn("aboutRef.start " + elem.outerHTML);
						}
					} else {
						tpls[about] = { start: elem };
					}
				} else {
					// elem is the end-meta tag
					// check if it is followed by a table node
					var tableNode = findTableSibling( elem, about );
					if ( tableNode ) {
						// found following table content, the end marker
						// was foster-parented. Extend the DOM range to
						// include the table.
						// TODO: implement
						env.log("error", 'foster-parented content following!');
						if ( aboutRef && aboutRef.start ) {
							tplRanges.push(getDOMRange( env, doc, aboutRef.start, elem, tableNode ));
						} else {
							env.log("error",'found foster-parented end marker followed',
									'by table, but no start marker!');
						}
					} else if ( aboutRef ) {
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
						var sm  = aboutRef.start,
						    em  = elem,
							ee  = em,
							tbl = em.parentNode.nextSibling;

						// Dont get distracted by a newline node -- skip over it
						// Unsure why it shows up occasionally
						if (tbl && DU.isText(tbl) && tbl.data.match(/^\n$/)) {
							tbl = tbl.nextSibling;
						}

						var dp = DU.getDataParsoid(sm.parentNode);
						if (tbl &&
							DU.hasNodeName(tbl, 'table') &&
							dp.fostered)
						{
							var tblDP = DU.getDataParsoid(tbl);
							if (dp.tsr && dp.tsr[0] !== null && tblDP.dsr[0] === null)
							{
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
				about = elem.getAttribute('about');
				tplRanges = tplRanges.concat(findWrappableTemplateRanges( doc, env, elem, tpls ));
			}
		}

		elem = nextSibling;
	}

	return tplRanges;
}

function wrapTemplatesInTree(document, env, node) {
	var tplRanges = findWrappableTemplateRanges( document, env, node, {} );
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
function wrapTemplates( document, env, options ) {
	var psd = env.conf.parsoid;

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:pre-encap") !== -1))) {
		console.warn("------ DOM: pre-encapsulation -------");
		dumpDOM( options, document );
		console.warn("----------------------------");
	}

	wrapTemplatesInTree(document, env, document.body);

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:post-encap") !== -1))) {
		console.warn("------ DOM: post-encapsulation -------");
		dumpDOM( options, document );
		console.warn("----------------------------");
	}
}

if (typeof module === "object") {
	module.exports.wrapTemplates = wrapTemplates;
	module.exports.wrapTemplatesInTree = wrapTemplatesInTree;
}
