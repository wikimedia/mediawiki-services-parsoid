/* Perform post-processing steps on an already-built HTML DOM. */

var events = require('events'),
	Util = require('./mediawiki.Util.js').Util;

// Quick HACK: define Node constants
// https://developer.mozilla.org/en/nodeType
var Node = {
	ELEMENT_NODE: 1,
	TEXT_NODE: 3,
	COMMENT_NODE: 8,
    DOCUMENT_NODE: 9
};

// Does 'n1' occur before 'n2 in their parent's children list?
function inSiblingOrder(n1, n2) {
	while (n1 && n1 !== n2) {
		n1 = n1.nextSibling;
	}
	return n1 !== null;
}

// Is 'n1' an ancestor of 'n2' in the DOM?
function isAncestorOf(n1, n2) {
	while (n2 && n2 !== n1) {
		n2 = n2.parentNode;
	}
	return n2 !== null;
}

function deleteNode(n) {
	n.parentNode.removeChild(n);
}

function minimizeInlineTags(root, rewriteable_nodes) {
	var rewriteable_node_map = null;

	function tail(a) {
		return a[a.length-1];
	}

	function remove_all_children(node) {
		while (node.hasChildNodes()) {
			node.removeChild(node.firstChild);
		}
	}

	function add_children(node, children) {
		for (var i = 0, n = children.length; i < n; i++) {
			node.appendChild(children[i]);
		}
	}

	function init() {
		rewriteable_node_map = {};
		for (var i = 0, n = rewriteable_nodes.length; i < n; i++) {
			rewriteable_node_map[rewriteable_nodes[i].toLowerCase()] = true;
		}
	}

	function is_rewriteable_node(node_name) {
		return rewriteable_node_map[node_name];
	}

	// Main routine
	function rewrite(node) {
		var children = node.childNodes;
		var n = children.length;

		// If we have a single node, no restructuring is possible at this level
		// Descend ...
		if (n === 1) {
			var sole_node = children[0];
			if (sole_node.nodeType === Node.ELEMENT_NODE) {
				rewrite(sole_node);
			}
			return;
		}

		// * Collect longest linear paths for all children
		// * Process subtrees attached to the end of those paths
		// * Restructure the list of linear paths (and reattach processed subtrees at the tips).

		var P = [];
		for (var i = 0; i < n; i++) {
			var s = children[i];
			if (s.nodeType === Node.ELEMENT_NODE) {
				var p = longest_linear_path(s);
				if (p.length === 0) {
					rewrite(s);
					// console.log("Pushed EMPTY with orig_parent: " + node.nodeName);
					P.push({path: [], orig_parent: node, children: [s]});
				} else {
					var p_tail = tail(p);

					// console.log("llp: " + p);

					// process subtree (depth-first)
					rewrite(p_tail);

					// collect the restructured p_tail subtree (children)
					var child_nodes  = p_tail.childNodes;
					var new_children = [];
					for (var j = 0, n2 = child_nodes.length; j < n2; j++) {
						new_children.push(child_nodes[j]);
					}

					// console.log("Pushed: " + p + ", tail: " + p_tail.nodeName + "; new_children: " + new_children.length);
					P.push({path: p, orig_parent: p_tail, children: new_children});
				}
			} else {
				// console.log("Pushed EMPTY with subtree: " + s);
				P.push({path: [], orig_parent: node, children: [s]});
			}
		}

		// Rewrite paths in 'P'
		if (P.length > 0) {
			rewrite_paths(node, P);
		}
	}

	function longest_linear_path(node) {
		var children, path = [];
		while (node.nodeType === Node.ELEMENT_NODE) {
			path.push(node);
			children = node.childNodes;
			if ((children.length === 0) || (children.length > 1)) {
				return path;
			}
			node = children[0];
		}

		return path;
	}

	function rewrite_paths(parent_node, P) {
		// 1. Split P into maximal sublists where each sublist has a non-null path intersection.
		// 2. Process each sublist separately and accumulate the result.
		//
		// lcs = longest common sublist

		remove_all_children(parent_node);

		var sublists = split_into_disjoint_sublists(P);
		// console.log("# sublists: " + sublists.length + ", parent_node: " + parent_node.nodeName);
		for (var i = 0, num_sublists = sublists.length; i < num_sublists; i++) {
			var s   = sublists[i];
			var lcs = s.lcs;

			if (lcs.length > 0) {
				// Connect up LCS
				// console.log("LCS: " + lcs);
				var prev = lcs[0];
				for (var k = 1, lcs_len = lcs.length; k < lcs_len; k++) {
					var curr = lcs[k];
					// SSS FIXME: this add/remove can be optimized
					// console.log("adding " + curr.nodeName + " to " + prev.nodeName);
					remove_all_children(prev);
					prev.appendChild(curr);
					prev = curr;
				}

				// Lastly, attach lcs to the incoming parent
				parent_node.appendChild(lcs[0]);
			}

			var paths     = s.paths;
			var num_paths = paths.length;
			// console.log("sublist: lcs: " + lcs + ", #paths: " + num_paths);
			if (num_paths === 1) {
				// Nothing more to do!  Stitch things up
				// two possible scenarios:
				// (a) we have an empty path    ==> attach the children to parent_node
				// (b) we have a non-empty path ==> attach the children to the end of the path
				var p        = paths[0].path;
				var children = paths[0].children;
				if (p.length > 0) {
					var p_tail = tail(p);
					remove_all_children(p_tail);
					add_children(p_tail, children);
				} else {
					add_children(parent_node, children);
				}
			} else {
				// Process the sublist
				rewrite_paths(tail(lcs), strip_lcs(paths, lcs));
			}

			// console.log("done with this sublist");
		}
		// console.log("--done all sublists--");
	}

	function common_path(old, new_path) {
		var hash = {};
		for (var i = 0, n = new_path.length; i < n; i++) {
			var e = new_path[i].nodeName.toLowerCase();
			if (is_rewriteable_node(e)) {
				hash[e] = new_path[i];
			}
		}

		var cp = [];
		for (i = 0, n = old.length; i < n; i++) {
			var hit = hash[old[i].nodeName.toLowerCase()];
			// Add old path element always.  This effectively picks elements from the leftmost path.
			if (hit) {
				cp.push(old[i]);
			}
		}

		// console.log("CP: " + old + "||" + new_path + "=" + cp);
		return cp;
	}

	// For each 'p' in 'paths', eliminate 'lcs' from 'p'
	function strip_lcs(paths, lcs) {
		// SSS FIXME: Implicit assumption: there are no duplicate elements in lcs or path!
		// Ex: <b><i><b>BIB</b></i></b> will
		// Fix this to be more robust

		var lcs_map = {};
		for (var i = 0, n = lcs.length; i < n; i++) {
			lcs_map[lcs[i]] = true;
		}

		for (i = 0, n = paths.length; i < n; i++) {
			var p = paths[i].path;
			for (var j = 0, l = p.length; j < l; j++) {
				// remove matching element
				if (lcs_map[p[j]]) {
					p.splice(j, 1);
					l--;
					j--;
				}
			}
		}

		return paths;
	}

	// Split 'P' into sublists where each sublist has the property that
	// the elements of the sublist have an intersection that is non-zero
	// Ex: [BIUS, SB, BUS, IU, I, U, US, B, I] will get split into 5 sublists
	// - (lcs: BS, paths: [BIUS, SB, BUS])
	// - (lcs: I,  paths: [IU, I])
	// - (lcs: U,  paths: [U, US])
	// - (lcs: B,  paths: [B])
	// - (lcs: I,  paths: [I])
	function split_into_disjoint_sublists(P) {
		var p    = P.shift();
		var lcs  = p.path;
		var curr = [p];

		for (var i = 0, n = P.length; i < n; i++) {
			p = P.shift();
			var new_lcs = common_path(lcs, p.path);
			if (new_lcs.length === 0) {
				P.unshift(p);
				return [{lcs: lcs, paths: curr}].concat(split_into_disjoint_sublists(P));
			}
			lcs = new_lcs;
			curr.push(p);
		}

		return [{lcs: lcs, paths: curr}];
	}

	// Init
	init();

	// Kick it off
	try {
		rewrite(root);
	} catch (e) {
		console.error(e.stack);
	}
}

function normalizeDocument(document) {
	minimizeInlineTags(document.body, ['b','u','i','s']);
}

/* ------------------------------------------------------------------------
 * If templates dont close their table tags properly or if our parser cannot
 * correctly parse certain templates, we still want to be able to round-trip
 * that content correctly.
 *
 * Ex: The Navbox template creates a <td> tag by constructing the tag string
 * using multiple parser functions -- so, the tokenizer never sees the td tag.
 * As a result, the template generated td tag is parsed as a series of strings.
 * In effect, this leads to an unbalanced </td> tag from the Navbox template.
 *
 * So, when the output of the Navbox template is itself inserted into a table,
 * the unbalanced tag output from Navbox ends up closing the container table.
 *
 * To counteract this and still enable us to roundtrip content from these
 * templates, we are going to patch the DOM so that the entire outer table is
 * wrapped as an atomic object for the purposes of visual editing (protected
 * and uneditable) and round-tripping (roundtrips as an atomic object without
 * regards to the embedded unbalanced/badly-parsed content).
 *
 * The algorithm in brief is reasonably simple.
 * - We walk the DOM bottom-up, right-to-left.
 *
 * - Whenever we encounter a <meta data-etag="table" typeof="mw:EndTag" />,
 *   i.e. a marker meta tag for a </table> tag, we walk backwards (skipping
 *   template-generated content in blocks) till we find another table/tr/td
 *   opening or closing tag.  Such a tag tells us that we have hit the
 *   end of a table (normal/common case when tags are well-balanced), or
 *   that we have hit an unstripped table tag.  We then expand the range of
 *   the farthest template till it wraps the table-end-tag marker we started
 *   off with.  This effectively lets us pretend that all intermediate
 *   content was generated by a single template and protects it as a single
 *   block.
 *
 * - The template encapsulation code pass later on further expands the range
 *   of the template so it spans an entire dom subtree (which in most cases
 *   means the outermost table will protected).  This is no different from
 *   how it handles all other templates.
 * ------------------------------------------------------------------------ */
function patchUpDOM(node, env, tplIdToSkip) {

	function collectTplsTillFarthestBadTemplate(node, tpls) {
		var currTpl = tpls.length > 0 ? tpls.last() : null;
		var openTplId = currTpl ? currTpl.tplId : null;

		while (node !== null) {
			var nodeName = node.nodeName.toLowerCase();
			if (nodeName === "meta") {
				var t = node.getAttribute("typeof");
				if (t.match(/\bmw:Object(\/[^\s]+)*\b/)) {
					if (openTplId) {
						// We have an open template -- this tag should the opening tag
						// of the same open template since template wrapper meta tags
						// are currently not nested.  But, in the future we might nest
						// them.  So, dont make the assumption.
						if (node.getAttribute("about") === openTplId) {
							// console.warn("---> TPL <start>: " + openTplId);
							openTplId = null;
							currTpl.tplId = null;
							currTpl.start = node;
						}
					} else if (t.match(/End/)) { // we are guaranteed to match this
						openTplId = node.getAttribute("about");
						currTpl = { end: node, tplId: openTplId };
						tpls.push(currTpl);
						// console.warn("---> TPL <end>: " + openTplId);
					} else {
						// error??
					}
				}
			}

			if (!openTplId) {
				// We hit an unstripped td/tr/table open/end tag!
				// We can stop now.
				if (nodeName === 'tr' || nodeName === 'td' || nodeName === 'table') {
					// console.warn("-----DONE-----");
					// done!
					return true;
				}
			}

			if (node.lastChild) {
				// Descend down n's DOM subtree -- if we get true, we are done!
				if (collectTplsTillFarthestBadTemplate(node.lastChild, tpls)) {
					return true;
				}
			}

			// Move left
			node = node.previousSibling;
		}

		// not done
		return false;
	}

	// special case for top-level
	if (node.nodeName.toLowerCase() === "#document") {
		node = node.body;
	}

	var c = node.lastChild;
	while (c) {
		var nodeName = c.nodeName.toLowerCase();
		if (tplIdToSkip && nodeName === "meta") {
			var t = c.getAttribute("typeof");
			if (t.match(/\bmw:Object(\/[^\s]+)*\b/)) {
				// Check if we hit the opening tag of the tpl/extension we are ignoring
				if (c.getAttribute("about") === tplIdToSkip) {
					tplIdToSkip = null;
				}
			}
		} else if (nodeName === "meta" &&
			c.getAttribute("typeof") === "mw:EndTag" &&
			c.getAttribute("data-etag") === "table")
		{
			// console.warn("---- found table etag: " + c.outerHTML);
			// Find all templates from here till the farthest template
			// that is the source of all trouble
			var allTpls = [];
			collectTplsTillFarthestBadTemplate(c.previousSibling, allTpls);

			var farthestTpl = allTpls.pop();
			if (farthestTpl) {
				// Move that template's end-tag after c
				c.parentNode.insertBefore(farthestTpl.end, c.nextSibling);

				// Update TSR
				var dpSrc = farthestTpl.end.getAttribute("data-parsoid");

				if (dpSrc === null || dpSrc === "") {
					// TODO: Figure out why there is no data-parsoid here!
					console.error( "XXX Error in patchUpDOM: no data-parsoid found! " +
							env.pageName );
					dpSrc = '{}';
				}

				var tplDP = JSON.parse(dpSrc);
				tplDP.tsr = JSON.parse(c.getAttribute("data-parsoid")).tsr;
				farthestTpl.end.setAttribute("data-parsoid", JSON.stringify(tplDP));

				// Skip all nodes till we find the opening id of this template
				// FIXME: Ugh!  Duplicate tree traversal
				tplIdToSkip = farthestTpl.tplId;

				// FIXME: Should we strip away all the intermediate template
				// wrapper tags?  I thought we might have to, but looks like all
				// works even without stripping.
			}
		} else if (c.nodeType === Node.ELEMENT_NODE) {
			// Look at c's subtree
			patchUpDOM(c, env, tplIdToSkip);
		}

		c = c.previousSibling;
	}
}

/**
 * Remove trailing newlines from paragraph content (and move them to
 * inter-element whitespace)
 */
function removeTrailingNewlinesFromParagraphs( document ) {
	var cnodes = document.body.childNodes;
	for (var i = 0; i < cnodes.length; i++) {
		var cnode = cnodes[i];
		if (cnode.nodeName.toLowerCase() === 'p') {
			//var firstChild = cnode.firstChild,
			//	leadingNewLines = firstChild.data.match(/[\r\n]+/);
			//if ( leadingNewLines ) {
			//	// don't include newlines in the paragraph
			//	cnode.insertBefore(
			//			document.createTextNode( leadingNewLines[0] ),
			//			firstChild
			//			);
			//	firstChild.data = firstChild.data.substr( leadingNewLines[0].length );
			//}

			var lastChild = cnode.lastChild;
			// Verify lastChild is not null since we can have empty p-nodes
			if ( lastChild && lastChild.nodeType === Node.TEXT_NODE ) {
				var trailingNewlines = lastChild.data.match(/[\r\n]+$/);
				if ( trailingNewlines ) {
					lastChild.data = lastChild.data.substr( 0,
							lastChild.data.length - trailingNewlines[0].length );
					var newText = document.createTextNode( trailingNewlines[0] );
					if ( cnode.nextSibling ) {
						cnode.parentNode.insertBefore( newText, cnode.nextSibling );
					} else {
						cnode.parentNode.appendChild( newText );
					}
				}
			}
		}
	}
}

/**
 * Find the common DOM ancestor of two DOM nodes
 */
function getDOMRange( doc, startElem, endElem ) {
	// Detect empty content
	if (startElem.nextSibling === endElem) {
		var emptySpan = doc.createElement('span');
		startElem.parentNode.insertBefore(emptySpan, endElem);
	}

	var startAncestors = [],
		elem = startElem;
	// build ancestor list -- path to root
	while (elem) {
		startAncestors.push( elem );
		elem = elem.parentNode;
	}

	// now find common ancestor
	elem = endElem;
	var parentNode = endElem.parentNode,
	    firstSibling, lastSibling;
	var res = null;
	while (parentNode && parentNode.nodeType !== Node.DOCUMENT_NODE) {
		var i = startAncestors.indexOf( parentNode );
		if (i === 0) {
			res = {
				'root': startElem,
				// widen the scope to include the full subtree
				startElem: startElem,
				endElem: endElem,
				start: startElem.firstChild,
				end: startElem.lastChild
			};
			break;
		} else if ( i > 0) {
			res = {
				'root': parentNode,
				startElem: startElem,
				endElem: endElem,
				start: startAncestors[i - 1],
				end: elem
			};
			break;
		}
		elem = parentNode;
		parentNode = elem.parentNode;
	}

	var updateDP = false;
	var tcStart = res.start;

	// Skip meta-tags
	if (tcStart === startElem && startElem.nodeName.toLowerCase() === "meta") {
		tcStart = tcStart.nextSibling;
		res.start = tcStart;
		updateDP = true;
	}

	// Ensure range.start is an element node since we want to
	// add/update the data-parsoid attribute to it.
	if (tcStart.nodeType === Node.COMMENT_NODE || tcStart.nodeType === Node.TEXT_NODE) {
		// See if we can go up one level
		//
		// Eliminates useless spanning of wikitext of the form: {{echo|foo}}
		// where the the entire template content is contained in a paragraph
		var skipSpan = false;
		var tcStartPar = tcStart.parentNode;
		if (tcStartPar.firstChild === startElem &&
			tcStartPar.lastChild === endElem &&
			res.end.parentNode === tcStartPar)
		{
			var dcpObj = tcStartPar.getAttribute("data-parsoid");
			if ((tcStartPar.nodeName.toLowerCase() === 'p') &&
				(!dcpObj || JSON.parse(dcpObj).stx !== "html")) {
				tcStart = tcStartPar;
				res.end = tcStartPar;
				skipSpan = true;
			}
		}

		if (!skipSpan) {
			// wrap tcStart in a span.
			var span = doc.createElement('span');
			tcStart.parentNode.insertBefore(span, tcStart);
			span.appendChild(tcStart);
			tcStart = span;
		}
		res.start = tcStart;
		updateDP = true;
	}

	if (updateDP) {
		var done = false;
		var tcDP = tcStart.getAttribute("data-parsoid");
		var seDP = startElem.getAttribute("data-parsoid");
		if (tcDP && seDP) {
			var tcDPObj = JSON.parse(tcDP);
			var seDPObj = JSON.parse(seDP);
			// Since TSRs on template content tokens are cleared by the
			// template handler, all computed dsr values for template content
			// is always inferred from top-level content values and is safe.
			// So, do not overwrite a bigger end-dsr value.
			if (tcDPObj.dsr && seDPObj.dsr && tcDPObj.dsr[1] > seDPObj.dsr[1]) {
				tcDPObj.dsr[0] = seDPObj.dsr[0];
				tcStart.setAttribute("data-parsoid", JSON.stringify(tcDPObj));
				done = true;
			}
		}

		if (!done) {
			tcStart.setAttribute("data-parsoid", startElem.getAttribute("data-parsoid"));
		}
	}

	return res;
}

/**
 * TODO: split in common ancestor algo, sibling splicing and -annotation /
 * wrapping
 */
function encapsulateTemplates( env, doc, tplRanges) {
	function stripStartMeta(meta) {
		if (meta.nodeName.toLowerCase() === 'meta') {
			deleteNode(meta);
		} else {
			// Remove mw:Object/* from the typeof
			var type = meta.getAttribute("typeof");
			type = type.replace(/\bmw:Object?(\/[^\s]+|\b)/, '');
			meta.setAttribute("typeof", type);
		}
	}

	// 1. Merge overlapping template ranges
	var newRanges = [];
	var i, numRanges = tplRanges.length;

	// Since the DOM is walked in-order left-to-right to build the list
	// of templates (findWrappableTemplateRanges) it is sufficient to
	// only look at the most recent template to see if the current one
	// overlaps with it.
	//
	// However, if <prev.start, prev.end> (can have a wider DOM range
	// than the template meta-tags) completely nests the content of
	// <r.start, r.end>, we have to handle this scenario specially.
	// We strip r's meta-tags and skip it completely.
	var prev = null;
	for (i = 0; i < numRanges; i++) {
		var endTagToRemove = null,
			startTagToStrip = null,
			r = tplRanges[i];
		if (prev && prev.end === r.start) {
			// Found overlap!  merge prev and r
			if (inSiblingOrder(r.start, r.end)) {
				// Because of foster-parenting, in some situations,
				// 'r.start' can occur after 'r.end'.  In those siutations,
				// the ranges are already merged and no fixup should be done.
				endTagToRemove = prev.endElem;
				prev.end = r.end;
				prev.endElem = r.endElem;
			} else {
				endTagToRemove = r.endElem;
			}

			startTagToStrip = r.startElem;
		} else if (prev && isAncestorOf(prev.end, r.start)) {
			// Range 'r' is nested inside of range 'prev'
			// Skip 'r' completely.
			startTagToStrip = r.startElem;
			endTagToRemove = r.endElem;
		} else {
			// Default case -- no overlap or nesting
			newRanges.push(r);
			prev = r;
		}

		if (endTagToRemove) {
			// Remove start and end meta-tags
			// Not necessary to remove the start tag, but good to cleanup
			deleteNode(endTagToRemove);
			stripStartMeta(startTagToStrip);
		}
	}

	// 2. Wrap templates
	numRanges = newRanges.length;
	for (i = 0; i < numRanges; i++) {
		var span,
			range = newRanges[i],
			startElem = range.startElem,
			n = range.start,
			about = startElem.getAttribute('about');
		//console.log ( 'HTML of template-affected subtrees: ' );
		while (n) {
			if ( n.nodeType === Node.TEXT_NODE || n.nodeType === Node.COMMENT_NODE ) {
				span = doc.createElement( 'span' );
				span.setAttribute( 'about', about );
				// attach the new span to the DOM
				n.parentNode.insertBefore( span, n );
				// move the text node into the span
				span.appendChild( n );
				n = span;
			} else if (n.nodeType === Node.ELEMENT_NODE) {
				n.setAttribute( 'about', about );
			}

			//console.log ( str.replace(/(^|\n)/g, "$1 " ) );
			if ( n === range.end ) {
				break;
			}

			n = n.nextSibling;
		}

		// update type-of
		var tcStart = range.start;
		var tcEnd = range.end;
		if (startElem !== tcStart) {
			var t1 = startElem.getAttribute("typeof");
			var t2 = tcStart.getAttribute("typeof");
			tcStart.setAttribute("typeof", t1 ? t1 + " " + t2 : t2);
		}

/*
		console.log("startElem: " + startElem.outerHTML);
		console.log("endElem: " + range.endElem.outerHTML);
		console.log("tcStart: " + tcStart.outerHTML);
		console.log("tcEnd: " + tcEnd.outerHTML);
*/

		// Update dsr and compute src based on dsr.  Not possible always.
		var dp1 = tcStart.getAttribute("data-parsoid");
		var dp2 = tcEnd.getAttribute("data-parsoid");
		var done = false;
		if (dp1) {
			// SSS FIXME: Maybe worth making tsr/dsr top-level attrs
			// during the tree-building pass.
			dp1 = JSON.parse(dp1);
			if (dp1.dsr && dp2) {
				dp2 = JSON.parse(dp2);
				// if range.end (tcEnd) is an ancestor of endElem,
				// and range.end content is produced by template,
				// we cannot use it.
				if (dp2.dsr && dp2.dsr[1] > dp1.dsr[1]) {
					dp1.dsr[1] = dp2.dsr[1];
				}
				if (dp1.dsr[0] !== null && dp1.dsr[1] !== null) {
					dp1.src = env.text.substr(dp1.dsr[0], dp1.dsr[1]-dp1.dsr[0]);
					tcStart.setAttribute("data-parsoid", JSON.stringify(dp1));
					done = true;
				}
			}
		}

/*
		if (!done) {
			console.warn("Do not have necessary info. for comput DSR for node");
			console.warn("------ START: ------");
			console.warn(tcStart.outerHTML);
			console.warn("------ END: ------");
			console.warn(tcEnd.outerHTML);
		}

		// Compute 'src' value by ascending up the tree
		// * from startElem -> tcStart
		// * from endElem --> tcEnd
		if (!done) {
			var dsr = JSON.parse(startElem.getAttribute("data-parsoid")).dsr;
			var src = [env.text.substr(dsr[0], dsr[1])];
			while (!done) {
			}
		}
***/

		// remove start/end
		if (startElem.nodeName.toLowerCase() === "meta")  {
			deleteNode(startElem);
		}

		deleteNode(range.endElem);
	}
}

function findTableSibling( elem, about ) {
	var tableNode = null;
	elem = elem.nextSibling;
	while (elem &&
			(elem.nodeName.toLowerCase() !== 'table' ||
			 elem.getAttribute('about') !== about))
	{
		elem = elem.nextSibling;
	}

	//if (elem) console.log( 'tableNode found' + elem.outerHTML );
	return elem;
}

/**
 * Recursive worker
 */
function findWrappableTemplateRanges( root, tpls, doc ) {
	var tplRanges = [];
	var elem = root.firstChild;
	while (elem) {
		// get the next sibling before doing anything since
		// we may delete elem as part of encapsulation
		var nextSibling = elem.nextSibling;

		if ( elem.nodeType === Node.ELEMENT_NODE ) {
			var type = elem.getAttribute( 'typeof' ),
				match = type ? type.match( /\b(mw:Object?(?:\/[^\s]+|\b))/ ) : null;
			if ( match ) {
				var tm = match[1],
					about = elem.getAttribute('about'),
					aboutRef = tpls[about];
				// Is this a start marker?
				if (!tm.match(/\/End\b/)) {
					if ( aboutRef ) {
						aboutRef.start = elem;
						// content or end marker existed already
						if ( aboutRef.end ) {
							// End marker was foster-parented. Found actual
							// start tag.
							console.warn( 'end marker was foster-parented' );
							tplRanges.push(getDOMRange( doc, elem, aboutRef.end ));
						} else {
							// should not happen!
							console.warn( 'start found after content' );
						}
					} else {
						tpls[about] = { start: elem };
					}
				} else {
					// check if followed by table node
					var tableNode = findTableSibling( elem, about );

					if ( tableNode ) {
						// found following table content, the end marker
						// was foster-parented. Extend the DOM range to
						// include the table.
						// TODO: implement
						console.warn( 'foster-parented content following!' );
						aboutRef.end = tableNode;
						if ( aboutRef && aboutRef.start ) {
							tplRanges.push(getDOMRange( doc, aboutRef.start, tableNode ));
						} else {
							console.warn( 'found foster-parented end marker followed ' +
									'by table, but no start marker!');
						}
					} else if ( aboutRef ) {
						// no foster-parenting involved, plain start/end pair.
						// Walk up the DOM to find common parent with start tag.
						aboutRef.end = elem;

						tplRanges.push(getDOMRange(doc, aboutRef.start, aboutRef.end));
					} else {
						tpls[about] = { end: elem };
					}
				}
			} else {
				// recurse down the tree
				tplRanges = tplRanges.concat(findWrappableTemplateRanges( elem, tpls, doc ));
			}
		}

		elem = nextSibling;
	}

	return tplRanges;
}

// node  -- node to process
// [s,e) -- if defined, start/end position of wikitext source that generated
//          node's subtree
function computeNodeDSR(node, s, e, traceDSR) {

	var WT_TagWidths = {
		"body"  : [0,0],
		"html"  : [0,0],
		"head"  : [0,0],
		"p"     : [0,0],
		"ol"    : [0,0],
		"ul"    : [0,0],
		"dl"    : [0,0],
		"meta"  : [0,0],
		"tbody" : [0,0],
		"pre"   : [1,0],
		"li"    : [1,0],
		"dt"    : [1,0],
		"dd"    : [1,0],
		"h1"    : [1,1],
		"h2"    : [2,2],
		"h3"    : [3,3],
		"h4"    : [4,4],
		"h5"    : [5,5],
		"h6"    : [6,6],
		"hr"    : [4,0]
		// span, figure, caption, figcaption, br, table, th, td, tr, a, i, b
	};

	// No undefined values here onwards.
	// NOTE: Never use !s, !e, !cs, !ce for testing for non-null
	// because any of them could be zero.
	if (s === undefined) {
		s = null;
	}

	if (e === undefined) {
		e = null;
	}

	if (traceDSR) console.warn("-- Received " + s + ", " + e + " for " + node.nodeName + " --");
	var children = node.childNodes;
	var cs, ce = e, savedEndTagWidth = null;
	for (var n = children.length, i = n-1; i >= 0; i--) {
		cs = null;

		var child = children[i],
		    cType = child.nodeType,
			endTagWidth = null;
		if (cType === Node.TEXT_NODE) {
			if (traceDSR) console.warn("-- Processing <child " + i + ">; text: " + child.data + " with [" + cs + "," + ce + "]");
			if (ce) {
				cs = ce - child.data.length;
			}
		} else if (cType === Node.COMMENT_NODE) {
			if (traceDSR) console.warn("-- Processing <child " + i + ">; comment: " + child.data + " with [" + cs + "," + ce + "]");
			if (ce) {
				cs = ce - child.data.length - 7; // 7 chars for "<!--" and "-->"
			}
		} else if (cType === Node.ELEMENT_NODE) {
			if (traceDSR) console.warn("-- Processing <child " + i + ">; elt: " + child.nodeName + " with [" + cs + "," + ce + "]");
			var cTypeOf = null,
				dpStr = child.getAttribute("data-parsoid"),
				dpObj = dpStr ? JSON.parse(dpStr) : {},
				oldCE = dpObj.tsr ? dpObj.tsr[1] : null,
				propagateRight = false;

			if (child.nodeName.toLowerCase() === "meta") {
				// Unless they have been foster-parented meta tags
				// of type mw:EndTag and mw:Object/* have valid tsr info.
				cTypeOf = child.getAttribute("typeof");
				if (cTypeOf === "mw:EndTag" || cTypeOf === "mw:TSRMarker") {
					// TSR info will be absent if the tsr-marker came
					// from a template since template tokens have all
					// their tsr info. stripped.
					if (dpObj.tsr) {
						endTagWidth = dpObj.tsr[1] - dpObj.tsr[0];
						cs = dpObj.tsr[1];
						ce = dpObj.tsr[1];
						propagateRight = true;
					}
					node.removeChild(child); // No use for this marker tag after this
				} else if (cTypeOf.match(/\bmw:Object\//) && dpObj.tsr) {
					// If this is a opening meta-marker tags (for templates, extensions),
					// we have a new valid 'cs'.  This marker also effectively resets tsr
					// back to the top-level wikitext source range from nested template
					// source range.
					cs = dpObj.tsr[0];
					ce = dpObj.tsr[1];
					propagateRight = true;
				}
			} else {
				// Non-meta tags
				if (dpObj.tsr) {
					if (traceDSR) console.warn("TSR: " + JSON.stringify(dpObj.tsr));
					cs = dpObj.tsr[0];
					if (!ce || dpObj.tsr[1] > ce) {
						ce = dpObj.tsr[1];
						propagateRight = true;
					}
				} else if (s && child.previousSibling === null) {
					cs = s;
				}

				// Process DOM subtree rooted at child.
				// We dont know the start/end ranges for the child node
				var newDsr, nodeName = child.nodeName.toLowerCase(),
					ccs = null, cce = null,
					wtTagWidth;
				if (dpObj.stx === "html") {
					if (dpObj.tsr) {
						// For HTML tags, tsr info covers the length of the tag
						ccs = dpObj.tsr[1];
						cce = ce !== null && savedEndTagWidth !== null ? ce - savedEndTagWidth : null;
					}
				} else {
					wtTagWidth = WT_TagWidths[nodeName];
					if (wtTagWidth) {
						ccs = cs !== null ? cs + wtTagWidth[0] : null;
						cce = ce !== null ? ce - wtTagWidth[1] : null;
					} else if (savedEndTagWidth !== null) {
						cce = ce - savedEndTagWidth;
					}
				}
				newDsr = computeNodeDSR(child, ccs, cce, traceDSR);

				if (newDsr[0] !== null && cs === null && wtTagWidth) {
					cs = newDsr[0] - wtTagWidth[0];
				}

				// Max(child-dom-tree dsr[1], current dsr[1])
				if (newDsr[1] !== null && (ce === null || newDsr[1] > ce)) {
					ce = newDsr[1];
				}
			}

			if (cs !== null || ce !== null) {
				if (traceDSR) console.warn("-- UPDATING; " + child.nodeName + " with [" + cs + "," + ce + "]; typeof: " + cTypeOf);
				dpObj.dsr = [cs, ce];
			}

			// Propagate any required changes to the right
			if (ce !== null && (propagateRight || oldCE !== ce || e === null)) {
				var sibling = child.nextSibling;
				var newCE = ce;
				while (sibling && newCE !== null) {
					var nType = sibling.nodeType;
					if (nType === Node.TEXT_NODE) {
						newCE = newCE + sibling.data.length;
					} else if (nType === Node.COMMENT_NODE) {
						newCE = newCE + sibling.data.length + 7;
					} else if (nType === Node.ELEMENT_NODE) {
						var str = sibling.getAttribute("data-parsoid");
						var ndpObj = str ? JSON.parse(str) : {};
						if (ndpObj.dsr && ndpObj.dsr[0] === newCE && e) {
							break;
						}

						if (!ndpObj.dsr) {
							ndpObj.dsr = [null, null];
						}

						if (ndpObj.dsr[0] !== newCE) {
							// Update and move right
							if (traceDSR) console.warn("CHANGING ce.start of " + n.nodeName + " from " + ndpObj.dsr[0] + " to " + newCE);
							ndpObj.dsr[0] = newCE;
							sibling.setAttribute("data-parsoid", JSON.stringify(ndpObj));
						}
						newCE = ndpObj.dsr[1];
					} else {
						break;
					}
					sibling = sibling.nextSibling;
				}

				// We hit the end successfully
				if (!n) {
					e = newCE;
				}
			}

			if (Object.keys(dpObj).length > 0) {
				child.setAttribute("data-parsoid", JSON.stringify(dpObj));
			}
		}

		// ce for next child = cs of current child
		ce = cs;
		// end-tag width from marker meta tag
		savedEndTagWidth = endTagWidth;
	}

	// Detect errors
	if (s && cs && cs !== s) {
		// SSS TODO FIXME: MarkTraceur commented this out because it was crashing the roundtrip tests. Make it work!
		if (traceDSR) console.warn("*********** ERROR: cs/s mismatch for node: " + node.nodeName + " s: " + s + "; cs: " + cs + " ************");
	}

	if (cs === undefined || cs === null) {
		cs = s;
	}

	if (traceDSR) console.warn("For " + node.nodeName + ", returning: " + cs + ", " + e);
	return [cs, e];
}

function computeDocDSR(root, env) {
	if (env.debug || (env.dumpFlags && (env.dumpFlags.indexOf("dom:pre-dsr") !== -1))) {
		console.warn("------ DOM: pre-DSR -------");
		console.warn(root.outerHTML);
		console.warn("----------------------------");
	}

	var traceDSR = env.debug || (env.traceFlags && (env.traceFlags.indexOf("dsr") !== -1));
	if (traceDSR) console.warn("------- tracing DSR computation -------");

	// The actual computation buried in trace/debug stmts.
	computeNodeDSR(root, 0, env.text.length, traceDSR);

	if (traceDSR) console.warn("------- done tracing DSR computation -------");

	if (env.debug || (env.dumpFlags && (env.dumpFlags.indexOf("dom:post-dsr") !== -1))) {
		console.warn("------ DOM: post-DSR -------");
		console.warn(root.outerHTML);
		console.warn("----------------------------");
	}
}

/**
 * Encapsulate template-affected DOM structures by wrapping text nodes into
 * spans and adding RDFa attributes to all subtree roots according to
 * http://www.mediawiki.org/wiki/Parsoid/RDFa_vocabulary#Template_content
 */
function encapsulateTemplateOutput( document, env ) {
	// walk through document and look for tags with typeof="mw:Object*"
	var tpls = {};
	if (env.debug || (env.dumpFlags && (env.dumpFlags.indexOf("dom:pre-encap") !== -1))) {
		console.warn("------ DOM: pre-encapsulation -------");
		console.warn(document.outerHTML);
		console.warn("----------------------------");
	}
	var tplRanges = findWrappableTemplateRanges( document.body, tpls, document );
	if (tplRanges.length > 0) {
		encapsulateTemplates(env, document, tplRanges);
	}
}

function DOMPostProcessor(env, options) {
	this.env = env;
	this.processors = [
		patchUpDOM,
		removeTrailingNewlinesFromParagraphs,
		normalizeDocument,
		computeDocDSR,
		encapsulateTemplateOutput
	];
}

// Inherit from EventEmitter
DOMPostProcessor.prototype = new events.EventEmitter();
DOMPostProcessor.prototype.constructor = DOMPostProcessor;

DOMPostProcessor.prototype.doPostProcess = function ( document ) {
	var env = this.env;
	if (env.debug || (env.dumpFlags && (env.dumpFlags.indexOf("dom:post-builder") !== -1))) {
		console.warn("---- DOM: after tree builder ----");
		console.warn(document.outerHTML);
		console.warn("--------------------------------");
	}

	for (var i = 0; i < this.processors.length; i++) {
		try {
			this.processors[i](document, this.env);
		} catch ( e ) {
			console.error(e.stack);
		}
	}
	this.emit( 'document', document );
};


/**
 * Register for the 'document' event, normally emitted from the HTML5 tree
 * builder.
 */
DOMPostProcessor.prototype.addListenersOn = function ( emitter ) {
	emitter.addListener( 'document', this.doPostProcess.bind( this ) );
};

if (typeof module === "object") {
	module.exports.DOMPostProcessor = DOMPostProcessor;
}
