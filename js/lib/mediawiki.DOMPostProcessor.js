"use strict";

/* Perform post-processing steps on an already-built HTML DOM. */

var events = require('events'),
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Node = require('./mediawiki.wikitext.constants.js').Node;

// Known wikitext tag widths
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
	"hr"    : [4,0],
	"table" : [2, 2],
	"tr"    : [2, 0],
	"b"     : [3, 3],
	"i"     : [2, 2],
	"td"    : [null, 0],
	"th"    : [null, 0],
	"br"    : [2,0] // non-html <br>s are inserted to replace 2 newlines in wikitext
	// span, figure, caption, figcaption, br, a, i, b
};

/* ------------- utility functions on DOM nodes/Node attributes ------------ */

// SSS FIXME: Should we convert some of these functions to properties
// of Node so we can use it as n.f(..) instead of f(n, ..)

function deleteNode(n) {
	if ( n.parentNode ) {
		n.parentNode.removeChild(n);
	} else {
		console.warn('ERROR: Null parentNode in deleteNode');
		console.trace();
	}
}

/* ------------- DOM post processor ----------------- */
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
	rewrite(root);
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
				var nTypeOf = node.getAttribute("typeof");
				if (DU.isTplMetaType(nTypeOf)) {
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
					} else if (nTypeOf.match(/End/)) { // we are guaranteed to match this
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
	if (DU.hasNodeName(node, "#document")) {
		node = node.body;
	}

	var c = node.lastChild;
	while (c) {
		if (tplIdToSkip && DU.isTplMarkerMeta(c) && (c.getAttribute("about") === tplIdToSkip)) {
			// Check if we hit the opening tag of the tpl/extension we are ignoring
			tplIdToSkip = null;
		} else if (DU.isMarkerMeta(c, "mw:EndTag") &&
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
				tplDP.tsr = DU.dataParsoid(c).tsr;
				DU.setDataParsoid(farthestTpl.end, tplDP);

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

function handlePres(document, env) {

	/* --------------------------------------------------------------
	 * Block tags change the behaviour of indent-pres.  This behaviour
	 * cannot be emulated till the DOM is built if we are to avoid
	 * having to deal with unclosed/mis-nested tags in the token stream.
	 *
	 * This function goes through the DOM looking for special kinds of
	 * block tags (as determined by the PHP parser behavior -- which
	 * has its own notion of block-tag which overlaps with, but is
	 * different from, the HTML block tag notion.
	 *
	 * Wherever such a block tag is found, any Parsoid-inserted
	 * pre-tags are removed.
	 * -------------------------------------------------------------- */
	function deleteIndentPreFromDOM(node) {
		var c = node.firstChild;
		while (c) {
			// get sibling before DOM is modified
			var c_sibling = c.nextSibling;

			if (DU.hasNodeName(c, "pre") && !DU.isLiteralHTMLNode(c)) {
				// space corresponding to the 'pre'
				node.insertBefore(document.createTextNode(' '), c);

				// transfer children over
				var c_child = c.firstChild;
				while (c_child) {
					var next_child = c_child.nextSibling;
					node.insertBefore(c_child, c);
					c_child = next_child;
				}

				// delete the pre
				deleteNode(c);
			} else if (!Util.tagClosesBlockScope(c.nodeName.toLowerCase())) {
				deleteIndentPreFromDOM(c);
			}

			c = c_sibling;
		}
	}

	function findAndHandlePres(doc, elt, indentPresHandled) {
		var children = elt.childNodes;
		for (var i = 0; i < children.length; i++) {
			var processed = false;
			var n = children[i];
			if (!indentPresHandled) {
				if (n.nodeType === Node.ELEMENT_NODE) {
					if (Util.tagOpensBlockScope(n.nodeName.toLowerCase())) {
						if (DU.isTplMetaType(n.getAttribute("typeof")) || DU.isLiteralHTMLNode(n)) {
							deleteIndentPreFromDOM(n);
							processed = true;
						}
					} else if (n.getAttribute("typeof") === "mw:Object/References") {
						// No pre-tags in references
						deleteIndentPreFromDOM(n);
						processed = true;
					}
				}
			}

			// Deal with html-pres
			if (DU.hasNodeName(n, "pre") && DU.isLiteralHTMLNode(n)) {
				var fc = n.firstChild;
				if (fc && fc.nodeType === Node.TEXT_NODE &&
					fc.data.match(/^(\r\n|\r|\n)([^\r\n]|$)/) && (
						!fc.nextSibling ||
						fc.nextSibling.nodeType !== Node.TEXT_NODE ||
						!fc.nextSibling.data.match(/^[\r\n]/)
					))
				{
					var matches = fc.data.match(/^(\r\n|\r|\n)/);
					if (matches) {
						// Record it in data-parsoid
						var preDP = DU.dataParsoid(n);
						preDP.strippedNL = matches[1];
						DU.setDataParsoid(n, preDP);
					}
				}
			}

			findAndHandlePres(doc, n, indentPresHandled || processed);
		}
	}

	// kick it off
	findAndHandlePres(document, document.body, false);
}

// If the last child of a node is a start-meta, simply
// move it up and make it the parent's sibling.
// This will move the start-meta closest to the content
// that the template/extension produced and improve accuracy
// of finding dom ranges and wrapping templates.
function migrateStartMetas(node, env) {
	var c = node.firstChild;
	while (c) {
		var sibling = c.nextSibling;
		if (c.childNodes.length > 0) {
			migrateStartMetas(c, env);
		}
		c = sibling;
	}

	var lastChild = node.lastChild;
	if (lastChild && DU.isTplStartMarkerMeta(lastChild)) {
		// console.warn("migration: " + lastChild.outerHTML);

		// We can migrate the meta-tag across this node's end-tag barrier only
		// if that end-tag is zero-width.
		var tagWidth = WT_TagWidths[node.nodeName.toLowerCase()];
		if (tagWidth && tagWidth[1] === 0 && !DU.isLiteralHTMLNode(node)) {
			node.parentNode.insertBefore(lastChild, node.nextSibling);
		}
	}

/* ----------------------------------------------------------
 * SSS FIXME: A little too aggressive and incorrect.
 * There is another condition that will let us migrate this
 * meta-tag across not just the end-tag but also across the newline
 * To be investigated
 *
	else if (lastChild.nodeType === Node.TEXT_NODE && lastChild.data.match(/^\n$/)) {
		// Occasionally (sometimes non-deterministically),
		// a stray newline messes with this meta-migration
		// Work around it (and then investigate why it is happening).
		//
		// var data = lastChild.data;
		lastChild = lastChild.previousSibling;
		if (lastChild && DU.isTplStartMarkerMeta(lastChild)) {
			// console.warn("migration (thwarted by: '" + data + "', len: " + data.length + "): " + lastChild.outerHTML);
			var p = node.parentNode;
			p.insertBefore(lastChild, node.nextSibling);
		}
	}
 *
 * ---------------------------------------------------------- */
}

/**
 * Find the common DOM ancestor of two DOM nodes
 */
function getDOMRange( env, doc, startElem, endMeta, endElem ) {
	// Detect empty content
	if (startElem.nextSibling === endElem) {
		var emptySpan = doc.createElement('span');
		startElem.parentNode.insertBefore(emptySpan, endElem);
	}

	var startAncestors = DU.pathToRoot(startElem);

	// now find common ancestor
	var elem = endElem;
	var parentNode = endElem.parentNode,
	    firstSibling, lastSibling;
	var res = null;
	while (parentNode && parentNode.nodeType !== Node.DOCUMENT_NODE) {
		var i = startAncestors.indexOf( parentNode );
		if (i === 0) {
			// widen the scope to include the full subtree
			res = {
				'root': startElem,
				aboutId: env.stripIdPrefix(startElem.getAttribute("about")),
				startElem: startElem,
				endElem: endMeta,
				start: startElem.firstChild,
				end: startElem.lastChild
			};
			break;
		} else if ( i > 0) {
			res = {
				'root': parentNode,
				aboutId: env.stripIdPrefix(startElem.getAttribute("about")),
				startElem: startElem,
				endElem: endMeta,
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
	if (tcStart === startElem && DU.hasNodeName(startElem, "meta")) {
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
			if (DU.hasNodeName(tcStartPar, 'p') && !DU.isLiteralHTMLNode(tcStartPar)) {
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
		var tcDP = DU.dataParsoid(tcStart);
		var seDP = DU.dataParsoid(startElem);
		if (tcDP && seDP && tcDP.dsr && seDP.dsr && tcDP.dsr[1] > seDP.dsr[1]) {
			// Since TSRs on template content tokens are cleared by the
			// template handler, all computed dsr values for template content
			// is always inferred from top-level content values and is safe.
			// So, do not overwrite a bigger end-dsr value.
			tcDP.dsr[0] = seDP.dsr[0];
			DU.setDataParsoid(tcStart, tcDP);
			done = true;
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
		if (DU.hasNodeName(meta, 'meta')) {
			deleteNode(meta);
		} else {
			// Remove mw:Object/* from the typeof
			var type = meta.getAttribute("typeof");
			type = type.replace(/\bmw:Object?(\/[^\s]+|\b)/, '');
			meta.setAttribute("typeof", type);
		}
	}

	function arraysIntersect(a1, a2) {
		// a1 and a2 are arrays of nodes.
		// We cannot use DOM nodes as hash keys
		// So for now, just rely on nested array check
		var i, j, m = a1.length, n = a2.length;
		for (i = 0; i < m; i++) {
			for (j = 0; j < n; j++) {
				if (a1[i] === a2[j]) {
					return true;
				}
			}
		}

		return false;
	}

	// 0. Sort by about tpl id
	tplRanges.sort(function(r1, r2) { return r1.aboutId - r2.aboutId; });

	// 1. Merge overlapping template ranges
	var newRanges = [];
	var i, numRanges = tplRanges.length;

	// Since the tpl ranges are sorted in textual order (by about-id)
	// it is sufficient to only look at the most recent template to see
	// if the current one overlaps with it.
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
/**
		console.warn("##############################################");
		console.warn("range " + i + "; r-start-elem: " + r.startElem.outerHTML);
		console.warn("range " + i + "; r-end-elem: " + r.endElem.outerHTML);
		console.warn("-----------------------------");
		console.warn("range " + i + "; r-start: " + r.start.outerHTML);
		console.warn("-----------------------------");
		console.warn("range " + i + "; r-end: " + r.end.outerHTML);
		console.warn("-----------------------------");
*/
		if (!prev) {
			// First range -- nothing to do
			newRanges.push(r);
			prev = r;
		} else if (r.start === prev.end && DU.inSiblingOrder(r.start, r.end)) {
			// Overlapping ranges.  Merge r with prev
			//
			// Because of foster-parenting, in some situations,
			// 'r.start' can occur after 'r.end'.  If yes, 'r' is
			// nested inside 'prev' and no fixup should be done.
			// Hence the check to see if r.end shows up after r.end

			startTagToStrip = r.startElem;
			endTagToRemove = prev.endElem;

			prev.end = r.end;
			prev.endElem = r.endElem;
		} else if (r.start === prev.end || r.start === prev.start) {
			// Simple nesting cases -- including foster-parenting case above.

			// Range 'r' is nested inside of range 'prev'
			// Skip 'r' completely.
			startTagToStrip = r.startElem;
			endTagToRemove = r.endElem;
		} else {
			// Generic nesting cases
			var rPath = DU.pathToRoot(r.start);
			var siblings = DU.pathToSibling(prev.start, prev.end);
			siblings.push(prev.end);

			// Find if there is an intersection between the two arrays.
			// If yes, we merge the 2 ranges since 'r' is considered
			// completely nested inside 'prev'.
			if (arraysIntersect(rPath, siblings)) {
				// Range 'r' is nested inside of range 'prev'
				// Skip 'r' completely.
				startTagToStrip = r.startElem;
				endTagToRemove = r.endElem;
			} else {
				// Default case -- no overlap or nesting
				newRanges.push(r);
				prev = r;
			}
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
		var dp1 = DU.dataParsoid(tcStart);
		var dp2 = DU.dataParsoid(tcEnd);
		var done = false;
		if (dp1.dsr) {
			// if range.end (tcEnd) is an ancestor of endElem,
			// and range.end content is produced by template,
			// we cannot use it.
			if (dp2.dsr) {
				if (dp2.dsr[1] > dp1.dsr[1]) {
					dp1.dsr[1] = dp2.dsr[1];
				}

				/* ----------------------------------------------------
				 * SSS FIXME: While this is a credible possibility and
				 * fixes some rt-issues, how do we distinguish between
				 * the two scenarios here?
				 *
				 * Example 1: meta-start and 'a' gets foster parented out
				 * but meta-end stays in the table and the fixup below is
				 * a valid fix.
				 *
				 * {|
				 * {{echo|
				 * a <div>b</div>
				 * }}
				 * |}
				 *
				 * Example 2: template generates the table-start tag
				 *
				 * {{gen-table-start|a <div>b</div>}}
				 * |}
				 *
				 * The argument, I guess, is that dsr for the table
				 * tag will not satisfy the property below.
				 * --------------------------------------------------- */

				// If tcEnd is a table, and it has a dsr-start that
				// is smaller than tsStart, then this could be
				// a foster-parented scenario.
				var endDsr = dp2.dsr[0];
				if (DU.hasNodeName(tcEnd, 'table') && endDsr !== null && endDsr < dp1.dsr[0]) {
					dp1.dsr[0] = endDsr;
				}
			}
			if (dp1.dsr[0] !== null && dp1.dsr[1] !== null) {
				dp1.src = env.text.substring( dp1.dsr[0], dp1.dsr[1] );
				DU.setDataParsoid(tcStart, dp1);
				done = true;
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
		if (DU.hasNodeName(startElem, "meta"))  {
			deleteNode(startElem);
		}

		deleteNode(range.endElem);
	}
}

function swallowTableIfNestedDSR(elt, tbl) {
	var eltDP = DU.dataParsoid(elt), eltDSR = eltDP.dsr,
		tblDP = DU.dataParsoid(tbl), tblTSR = tblDP.tsr;

	// IMPORTANT: Do not use dsr to compare because the table may not
	// have a valid dsr[1] (if the  table's end-tag is generated by
	// a template transcluded into the table) always.  But it is
	// sufficient to check against tsr[1] because the only way 'elt'
	// could have a dsr[0] after the table-start-tag but show up before
	// 'tbl' is if 'elt' got fostered out of the table.
	if (eltDSR && tblTSR && eltDSR[0] >= tblTSR[1]) {
		eltDP.dsr[0] = tblTSR[0];
		eltDP.dsr[1] = null;
		DU.setDataParsoid(elt, eltDP);
		return true;
	} else {
		return false;
	}
}

function findTableSibling( elem, about ) {
	var tableNode = null;
	elem = elem.nextSibling;
	while (elem &&
			(!DU.hasNodeName(elem, 'table') ||
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
function findWrappableTemplateRanges( root, tpls, doc, env ) {
	var tplRanges = [],
	    elem = root.firstChild,
		about, aboutRef;

	while (elem) {
		// get the next sibling before doing anything since
		// we may delete elem as part of encapsulation
		var nextSibling = elem.nextSibling;

		if ( elem.nodeType === Node.ELEMENT_NODE ) {
			var type = elem.getAttribute( 'typeof' ),
				// SSS FIXME: This regexp differs from that in isTplMetaType
				metaMatch = type ? type.match( /\b(mw:Object(?:\/[^\s]+|\b))/ ) : null;
			if ( metaMatch ) {
				var metaType = metaMatch[1];

				about = elem.getAttribute('about'),
				aboutRef = tpls[about];
				// Is this a start marker?
				if (!metaType.match(/\/End\b/)) {
					if ( aboutRef ) {
						aboutRef.start = elem;
						// content or end marker existed already
						if ( aboutRef.end ) {
							// End marker was foster-parented. Found actual
							// start tag.
							console.warn( 'end marker was foster-parented' );
							tplRanges.push(getDOMRange( env, doc, elem, aboutRef.end, aboutRef.end ));
						} else {
							// should not happen!
							console.warn( 'start found after content' );
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
						console.warn( 'foster-parented content following!' );
						if ( aboutRef && aboutRef.start ) {
							tplRanges.push(getDOMRange( env, doc, aboutRef.start, elem, tableNode ));
						} else {
							console.warn( 'found foster-parented end marker followed ' +
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
						if (tbl && tbl.nodeType === Node.TEXT_NODE && tbl.data.match(/^\n$/)) {
							tbl = tbl.nextSibling;
						}

						if (tbl &&
							DU.hasNodeName(tbl, 'table') &&
							swallowTableIfNestedDSR(sm.parentNode, tbl))
						{
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
				tplRanges = tplRanges.concat(findWrappableTemplateRanges( elem, tpls, doc, env ));
			}
		}

		elem = nextSibling;
	}

	return tplRanges;
}

function findBuilderCorrectedTags(node) {
	var children = node.childNodes,
		c = node.firstChild,
		sibling, expectedName;

	function addPlaceholderMeta ( node, dp, name ) {
		var placeHolder = node.ownerDocument.createElement('meta'),
			// TODO: pass in more precise source!
			endSrc = dp.src ||
				( DU.hasLiteralHTMLMarker(dp) ?
				  '</' + name + '>' : '' );

		if ( endSrc ) {
			placeHolder.setAttribute('typeof', 'mw:Placeholder');
			DU.setDataParsoid(placeHolder, {src: endSrc});

			// Insert the placeHolder
			node.parentNode.insertBefore(placeHolder, c);
		}
	}

	// Search forward and up for a shadow meta, skipping over other end metas
	function findMetaShadowNode ( node, type, name ) {
		while ( node ) {
			var sibling = node.nextSibling;
			if ( sibling !== null ) {
				if ( sibling.nodeType === node.ELEMENT_NODE ) {
					if ( sibling.nodeName.toLowerCase() === 'meta' ) {
						if ( DU.isMarkerMeta( sibling, type ) &&
								sibling.getAttribute('data-etag') === name )
						{
							return sibling;
						} else {
							node = sibling;
						}
					} else {
						return null;
					}
				} else {
					return null;
				}
			} else {
				node = node.parentNode;
			}
		}
		return null;
	}

	while (c !== null) {
		if (c.nodeType === Node.ELEMENT_NODE) {
			var dp = DU.dataParsoid(c),
				nextC,
				cNodeName = c.nodeName.toLowerCase();
			if (dp.tsr && !Util.isVoidElement(cNodeName) && !dp.selfClose) {
				var metaNode = findMetaShadowNode(c, 'mw:EndTag', cNodeName);
				if (!metaNode)
				{
					//console.log( c.nodeName, c.parentNode.outerHTML );
					// 'c' is a html node that has tsr, but no end-tag marker tag
					// => its closing tag was auto-generated by treebuilder.
					dp.autoInsertedEnd = true;
					DU.setDataParsoid(c, dp);
				}

				var fc = c.firstChild;
				if (!fc || !DU.isMarkerMeta(fc, "mw:StartTag") ||
						// SSS FIXME: This check below is a bad check
						// discovered by trying to fix the JSHint warning about
						// the strange use of "!"
						!fc.getAttribute('data-stag') === cNodeName + dp.tsr)
				{
					//console.log('autoInsertedStart:', c.outerHTML);
					dp.autoInsertedStart = true;
					DU.setDataParsoid(c, dp);
				}
			} else if ( cNodeName === 'meta') {
				var type = c.getAttribute('typeof');
				if ( type === 'mw:EndTag' )
				{
					// Got an mw:EndTag meta element, see if the previous sibling
					// is the corresponding element.
					sibling = c.previousSibling;
					expectedName = c.getAttribute('data-etag');
					if (!sibling ||
							sibling.nodeName.toLowerCase() !== expectedName)

					{
						// Not found, the tag was stripped. Insert an
						// mw:Placeholder for round-tripping
						//console.log('autoinsertedEnd', c.outerHTML, c.parentNode.outerHTML);
						addPlaceholderMeta(c, dp, expectedName);

					}
				} else if ( type === 'mw:StartTag' ) {
					sibling = c.previousSibling;
					expectedName = c.getAttribute('data-stag').replace(/:.*$/, '');
					if (( sibling && sibling.nodeName.toLowerCase() !== expectedName ) ||
							(!sibling && c.parentNode.nodeName.toLowerCase() !== expectedName ))
					{
						//console.log( 'start stripped! ', expectedName, c.parentNode.innerHTML );
						addPlaceholderMeta(c, dp, expectedName);
					}
				} else {
					// Jump over this meta tag, but preserve it
					c = c.nextSibling;
					continue;
				}

				// This meta matched mw:EndTag or mw:StartTag
				if ( !dp.tsr ) {
					// If there is no tsr this meta is useless for DSR
					// calculations. Remove the meta to avoid breaking
					// other brittle DOM passes working on the DOM.
					nextC = c.nextSibling;
					c.parentNode.removeChild(c);
					c = nextC;
					// and jump back to the start of the loop
					continue;
				}
			}


			findBuilderCorrectedTags(c);
		}

		c = c.nextSibling;
	}

	// delete mw:StartTag meta tags
	c = node.firstChild;
	while (c !== null) {
		sibling = c.nextSibling;
		if (DU.isMarkerMeta(c, "mw:StartTag")) {
			deleteNode(c);
		}
		c = sibling;
	}
}

// node  -- node to process
// [s,e) -- if defined, start/end position of wikitext source that generated
//          node's subtree
function computeNodeDSR(env, node, s, e, traceDSR) {

	// TSR info on all these tags are only valid for the opening tag.
	// (closing tags dont have attrs since tree-builder strips them
	//  and adds meta-tags tracking the corresponding TSR)
	//
	// On other tags, a, hr, br, meta-marker tags, the tsr spans
	// the entire DOM, not just the tag.
	var WT_tagsWithLimitedTSR = {
		"b" : true,
		"i" : true,
		"h1" : true,
		"h2" : true,
		"h3" : true,
		"h4" : true,
		"h5" : true,
		"li" : true,
		"dt" : true,
		"dd" : true,
		"table" : true,
		"caption" : true,
		"tr" : true,
		"td" : true,
		"th" : true,
		"pre" : true
	};

	function tsrSpansTagDOM(n, parsoidData) {
		// - tags known to have tag-specific tsr
		// - html tags with 'stx' set
		// - span tags with 'mw:Nowiki' type
		var name = n.nodeName.toLowerCase();
		return !WT_tagsWithLimitedTSR[name] &&
			!DU.hasLiteralHTMLMarker(parsoidData) &&
			!(n === 'span' && n.getAttribute("typeof") === "mw:Nowiki");
	}

	function computeListEltWidth(li, nodeName) {
		if (!li.previousSibling && li.firstChild) {
			var n = li.firstChild.nodeName.toLowerCase();
			if (n === 'dl' || n === 'ol' || n === 'ul') {
				// Special case!!
				// First child of a list that is on a chain
				// of nested lists doesn't get a width.
				return 0;
			}
		}

		// count nest listing depth and assign
		// that to the opening tag width.
		var depth = 0;
		while (nodeName === 'li' || nodeName === 'dd') {
			depth++;
			li = li.parentNode.parentNode;
			nodeName = li.nodeName.toLowerCase();
		}

		return depth;
	}

	function computeTagWidths(widths, child, dp) {
		var stWidth = widths[0], etWidth = null;

		if (DU.hasLiteralHTMLMarker(dp)) {
			if (dp.tsr) {
				etWidth = widths[1];
			}
		} else {
			var nodeName = child.nodeName.toLowerCase();
			// 'tr' tags not in the original source have zero width
			if (nodeName === 'tr' && !dp.startTagSrc) {
				stWidth = 0;
				etWidth = 0;
			} else {
				var wtTagWidth = WT_TagWidths[nodeName];
				if (stWidth === null) {
					// we didn't have a tsr to tell us how wide this tag was.
					if (nodeName === 'li' || nodeName === 'dd') {
						stWidth = computeListEltWidth(child, nodeName);
					} else if (wtTagWidth) {
						stWidth = wtTagWidth[0];
					}
				}
				etWidth = wtTagWidth ? wtTagWidth[1] : widths[1];
			}
		}

		return [stWidth, etWidth];
	}

	// No undefined values here onwards.
	// NOTE: Never use !s, !e, !cs, !ce for testing for non-null
	// because any of them could be zero.
	if (s === undefined) {
		s = null;
	}

	if (e === undefined) {
		e = null;
	}

	if (traceDSR) console.warn("Received " + s + ", " + e + " for " + node.nodeName + " --");

	var children = node.childNodes,
		savedEndTagWidth = null,
	    ce = e,
		// Initialize cs to ce to handle the zero-children case properly
		// if this node has no child content, then the start and end for
		// the child dom are indeed identical.  Alternatively, we could
		// explicitly code this check before everything and bypass this.
		cs = ce;
	for (var n = children.length, i = n-1; i >= 0; i--) {
		var isMarkerTag = false,
			child = children[i],
		    cType = child.nodeType,
			endTagWidth = null;
		cs = null;
		if (cType === Node.TEXT_NODE) {
			if (traceDSR) console.warn("-- Processing <" + node.nodeName + ":" + i + ">=#" + child.data + " with [" + cs + "," + ce + "]");
			if (ce !== null) {
				cs = ce - child.data.length;
			}
		} else if (cType === Node.COMMENT_NODE) {
			if (traceDSR) console.warn("-- Processing <" + node.nodeName + ":" + i + ">=!" + child.data + " with [" + cs + "," + ce + "]");
			if (ce !== null) {
				cs = ce - child.data.length - 7; // 7 chars for "<!--" and "-->"
			}
		} else if (cType === Node.ELEMENT_NODE) {
			if (traceDSR) console.warn("-- Processing <" + node.nodeName + ":" + i + ">=" + child.nodeName + " with [" + cs + "," + ce + "]");
			var cTypeOf = null,
				dp = DU.dataParsoid(child),
				tsr = dp.tsr,
				oldCE = tsr ? tsr[1] : null,
				propagateRight = false;

			if (DU.hasNodeName(child, "meta")) {
				// Unless they have been foster-parented,
				// meta marker tags have valid tsr info.
				cTypeOf = child.getAttribute("typeof");
				if (cTypeOf === "mw:EndTag" || cTypeOf === "mw:TSRMarker") {
					if (cTypeOf === "mw:EndTag") {
						// FIXME: This seems like a different function that is
						// tacked onto DSR computation, but there is no clean place
						// to do this one-off thing without doing yet another pass
						// over the DOM -- maybe we need a 'do-misc-things-pass'.
						//
						// Update table-end syntax using info from the meta tag
						var prev = child.previousSibling;
						if (prev && DU.hasNodeName(prev, "table")) {
							var prevDP = DU.dataParsoid(prev);
							if (!DU.hasLiteralHTMLMarker(prevDP)) {
								if (dp.endTagSrc) {
									prevDP.endTagSrc = dp.endTagSrc;
									DU.setDataParsoid(prev, prevDP);
								}
							}
						}
					}

					isMarkerTag = true;
					// TSR info will be absent if the tsr-marker came
					// from a template since template tokens have all
					// their tsr info. stripped.
					if (tsr) {
						endTagWidth = tsr[1] - tsr[0];
						cs = tsr[1];
						ce = tsr[1];
						propagateRight = true;
					}
				} else if (tsr) {
					if (DU.isTplMetaType(cTypeOf)) {
						// If this is a meta-marker tag (for templates, extensions),
						// we have a new valid 'cs'.  This marker also effectively resets tsr
						// back to the top-level wikitext source range from nested template
						// source range.
						cs = tsr[0];
						ce = tsr[1];
						propagateRight = true;
					} else {
						// All other meta-tags: <includeonly>, <noinclude>, etc.
						cs = tsr[0];
						ce = tsr[1];
					}
				}
			} else {
				// Non-meta tags
				var stWidth = null, etWidth = null,
					tagWidths, newDsr, ccs, cce;

				if (tsr && !dp.autoInsertedStart) {
					cs = tsr[0];
					if (tsrSpansTagDOM(child, dp)) {
						if (!ce || tsr[1] > ce) {
							ce = tsr[1];
							propagateRight = true;
						}
					} else {
						stWidth = tsr[1] - tsr[0];
					}
					if (traceDSR) console.warn("TSR: " + JSON.stringify(tsr) + "; cs: " + cs + "; ce: " + ce);
				} else if (s && child.previousSibling === null) {
					cs = s;
				}

				// Compute width of opening/closing tags for this dom node
				tagWidths = computeTagWidths([stWidth, savedEndTagWidth], child, dp);
				stWidth = tagWidths[0];
				etWidth = tagWidths[1];

				if (dp.autoInsertedStart) {
					stWidth = 0;
				}
				if (dp.autoInsertedEnd) {
					etWidth = 0;
				}

				// Process DOM subtree rooted at child
				ccs = cs !== null && stWidth !== null ? cs + stWidth : null;
				cce = ce !== null && etWidth !== null ? ce - etWidth : null;
				if (traceDSR) {
					console.warn("Before recursion, [cs,ce]=" + cs + "," + ce +
						"; [sw,ew]=" + stWidth + "," + etWidth +
						"; [ccs,cce]=" + ccs + "," + cce);
				}
				newDsr = computeNodeDSR(env, child, ccs, cce, traceDSR);

				// Min(child-dom-tree dsr[0] - tag-width, current dsr[0])
				if (stWidth !== null && newDsr[0] !== null) {
					var newCs = newDsr[0] - stWidth;
					if (cs === null || (!tsr && newCs < cs)) {
						cs = newCs;
					}
				}

				// Max(child-dom-tree dsr[1] + tag-width, current dsr[1])
				if (etWidth !== null && newDsr[1] !== null && ((newDsr[1] + etWidth) > ce)) {
					ce = newDsr[1] + etWidth;
				}
			}

			if (cs !== null || ce !== null) {
				dp.dsr = [cs, ce];
				if (traceDSR) {
					console.warn("-- UPDATING; " + child.nodeName + " with [" + cs + "," + ce + "]; typeof: " + cTypeOf);
					// Set up 'dbsrc' so we can debug this
					dp.dbsrc = env.text.substring(cs, ce);
				}
			}

			// Propagate any required changes to the right
			// taking care not to cross-over into template content
			if (ce !== null &&
				(propagateRight || oldCE !== ce || e === null) &&
				!DU.isTplStartMarkerMeta(child))
			{
				var sibling = child.nextSibling;
				var newCE = ce;
				while (newCE !== null && sibling && !DU.isTplStartMarkerMeta(sibling)) {
					var nType = sibling.nodeType;
					if (nType === Node.TEXT_NODE) {
						newCE = newCE + sibling.data.length;
					} else if (nType === Node.COMMENT_NODE) {
						newCE = newCE + sibling.data.length + 7;
					} else if (nType === Node.ELEMENT_NODE) {
						var siblingDP = DU.dataParsoid(sibling);
						if (siblingDP.dsr && siblingDP.dsr[0] === newCE && e !== null) {
							break;
						}

						if (!siblingDP.dsr) {
							siblingDP.dsr = [null, null];
						}

						if (siblingDP.dsr[0] > newCE) {
							// Update and move right
							if (traceDSR) {
								console.warn("CHANGING ce.start of " + sibling.nodeName + " from " + siblingDP.dsr[0] + " to " + newCE);
								// debug info
								if (siblingDP.dsr[1]) {
									siblingDP.src = env.text.substring(newCE, siblingDP.dsr[1]);
								}
							}
							siblingDP.dsr[0] = newCE;
							DU.setDataParsoid(sibling, siblingDP);
						}
						newCE = siblingDP.dsr[1];
					} else {
						break;
					}
					sibling = sibling.nextSibling;
				}

				// Propagate new end information
				if (!sibling) {
					e = newCE;
				}
			}

			if (Object.keys(dp).length > 0) {
				DU.setDataParsoid(child, dp);
			}
		}

		if (isMarkerTag) {
			node.removeChild(child); // No use for this marker tag after this
		}

		// ce for next child = cs of current child
		ce = cs;
		// end-tag width from marker meta tag
		savedEndTagWidth = endTagWidth;
	}

	if (cs === undefined || cs === null) {
		cs = s;
	}

	if (traceDSR) {
		// Detect errors
		if (s !== null && s !== undefined && cs !== s) {
			console.warn("*********** ERROR: cs/s mismatch for node: " +
				node.nodeName + " s: " + s + "; cs: " + cs + " ************");
		}
		console.warn("For " + node.nodeName + ", returning: " + cs + ", " + e);
	}

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
	computeNodeDSR(env, root, 0, env.text.length, traceDSR);

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
	var tpls = {};
	if (env.debug || (env.dumpFlags && (env.dumpFlags.indexOf("dom:pre-encap") !== -1))) {
		console.warn("------ DOM: pre-encapsulation -------");
		console.warn(document.outerHTML);
		console.warn("----------------------------");
	}
	// walk through document and look for tags with typeof="mw:Object*"
	var tplRanges = findWrappableTemplateRanges( document.body, tpls, document, env );
	if (tplRanges.length > 0) {
		encapsulateTemplates(env, document, tplRanges);
	}
}


function DOMPostProcessor(env, options) {
	this.env = env;
	this.processors = [
		patchUpDOM,
		migrateStartMetas,
		normalizeDocument,
		findBuilderCorrectedTags,
		handlePres,
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
			env.errCB(e);
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
