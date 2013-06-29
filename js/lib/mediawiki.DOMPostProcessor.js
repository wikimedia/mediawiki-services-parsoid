/* Perform post-processing steps on an already-built HTML DOM. */

"use strict";

var events = require('events'),
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Node = require('./mediawiki.wikitext.constants.js').Node,
	domino = require('./domino');

// map from mediawiki metadata names to RDFa property names
var metadataMap = {
	ns: 'mw:articleNamespace',
	// the articleID is not stable across article deletion/restore, while
	// the revisionID is.  So we're going to omit the articleID from the
	// parsoid API for now; uncomment if we find a use case.
	//id: 'mw:articleId',
	rev_revid:     'schema:CreativeWork/version',
	rev_parentid:  'schema:CreativeWork/version/parent',
	rev_timestamp: 'schema:CreativeWork/dateModified',
	// user is not stable (but userid is)
	rev_user:      'schema:CreativeWork/contributor/username',
	rev_userid:    'schema:CreativeWork/contributor',
	rev_sha1:      'mw:revisionSHA1',
	rev_comment:   'schema:CreativeWork/comment'
};

// Sanity check for dom behavior: we are
// relying on DOM level 4 getAttribute. In level 4, getAttribute on a
// non-existing key returns null instead of the empty string.
var testDom = domino.createWindow('<h1>Hello world</h1>').document;
if (testDom.body.getAttribute('somerandomstring') === '') {
	throw('Your DOM version appears to be out of date! \n' +
			'Please run npm update in the js directory.');
}

// Known wikitext tag widths
var WT_TagWidths = {
	"body"  : [0,0],
	"html"  : [0,0],
	"head"  : [0,0],
	"p"     : [0,0],
	"meta"  : [0,0],
	"tbody" : [0,0],
	"pre"   : [1,0],
	// For lists and elements,
	// also see computeListEltWidth
	"ol"    : [0,0],
	"ul"    : [0,0],
	"dl"    : [0,0],
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
	"table" : [2,2],
	"tr"    : [2,0],
	"td"    : [null,0],
	"th"    : [null,0],
	"b"     : [3,3],
	"i"     : [2,2],
	"br"    : [0,0],
	"figure": [2,2]
	// a-tag width computed by computeATagWidth
	// what about span, figure, caption, figcaption?
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

/**
 * Class for helping us traverse the DOM.
 *
 * @param node {HTMLNode} The node to be traversed
 */
function DOMTraverser() {
	this.handlers = [];
}

/**
 * Add a handler to the DOM traversal
 *
 * @param {Function} action A callback, called on each node we
 * traverse that matches nodeName. First argument is the DOM
 * node. Return false if you want to stop any further callbacks from
 * being called on the node.  Return the new node if you need to replace
 * it or change its siblings; traversal will continue with the new node.
 */
DOMTraverser.prototype.addHandler = function ( nodeName, action ) {
	var handler = {
		run: action,
		name: nodeName
	};

	this.handlers.push( handler );
};

DOMTraverser.prototype.callHandlers = function ( node ) {
	var ix, result, name = ( node.nodeName || '' ).toLowerCase();

	for ( ix = 0; ix < this.handlers.length; ix++ ) {
		if ( this.handlers[ix].name === null ||
				this.handlers[ix].name === name ) {
			result = this.handlers[ix].run( node );
			if ( result !== true ) {
				if ( result === undefined ) {
					console.error('DOMPostProcessor.traverse: undefined return! ' +
							'Bug in ' + this.handlers[ix].run +
							' when handling ' + node.outerHTML);
				}

				// abort processing for this node
				return result;
			}

			// Sanity check for broken handlers
			if (node.parentNode === null) {
				console.error('DOMPostProcessor.traverse: null parentNode! ' +
						'Bug in ' + this.handlers[ix].run +
						' when handling ' + node.outerHTML);
				return node;
			}
		}
	}
	return true;
};

/**
 * Traverse the DOM and fire the handlers that are registered
 *
 * Handlers can return
 * - the next node to process
 *   - aborts processing for current node, continues with returned node
 *   - can also be null, so .nextSibling works even on last child
 * - true
 *   - continue regular processing on current node
 */
DOMTraverser.prototype.traverse = function ( node ) {
	if (node.nodeType === node.DOCUMENT_NODE) {
		// skip to body
		node = node.body;
	}

	var workNode = node.firstChild;
	var result;

	while ( workNode !== null ) {
		// Call the handlers on this workNode
		result = this.callHandlers( workNode );

		if ( result !== true ) {
			// Something changed.
			// Continue to work on the returned node, if not null.
			workNode = result;
		} else {
			// the 'continue processing' case
			if ( DU.isElt(workNode) &&
					workNode.childNodes.length > 0 )
			{
				this.traverse( workNode );
			}
			workNode = workNode.nextSibling;
		}
	}
};

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
	// XXX FIXME XXX
	// when parsoid tackles
	// http://ar.wikipedia.org/w/index.php?title=%D9%82%D8%A7%D9%84%D8%A8:%D8%A3%D8%AD%D9%88%D8%A7%D8%B6_%D8%B9%D9%85%D8%A7%D9%86&oldid=9394524
	// it ends up invoking split_into_disjoint_sublists(JS Array[10203])
	// which then recursively invokes itself, tries to put 10203 frames
	// on the stack, runs out of call stack space and crashes.
	// We've turned off the minimizeInlineTags pass for now (see bug 42803)
	// but if we turn it back on, we need to rewrite this function to
	// remove the recursion and use an explicit stack. [CSA]
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
function handleUnbalancedTableTags(node, env, options, tplIdToSkip) {
	function foundMatch(currTpl, nodeName) {
		// Did we hit a table (table/th/td/tr/tbody/th) tag
		// that is outside a template?
		var insideTpl = currTpl && !currTpl.start;
		if (!insideTpl && ['tr', 'td', 'th', 'tbody', 'table'].indexOf(nodeName) !== -1) {
			if (currTpl) {
				currTpl.isCulprit = true;
			}
			return true;
		}

		return false;
	}

	// This walks the DOM right-to-left and tries to find a table-tag
	// (opening or closing tag) that is outside a template.  It keeps
	// track of the currently open template and checks for a table-tag
	// match only when outside it.  When a match is found, it returns
	// the most recently closed template and returns it all the way up.
	function findProblemTemplate(node, currTpl) {
		while (node !== null) {
			if (DU.isElt(node)) {
				var nTypeOf = node.getAttribute("typeof");
				if (DU.isTplMetaType(nTypeOf)) {
					var insideTpl = currTpl && !currTpl.start;
					if (insideTpl && node.getAttribute("about") === currTpl.tplId) {
						currTpl.start = node;
						// console.warn("---> TPL <start>: " + currTpl.tplId);
					} else if (!insideTpl && nTypeOf.match(/End/)) {
						currTpl = { end: node, tplId: node.getAttribute("about") || "" };
						// console.warn("---> TPL <end>: " + currTpl.tplId);
					}
				}

				var nodeName = node.nodeName.toLowerCase();

				// Test for "end"-tag before processing subtree
				if (foundMatch(currTpl, nodeName)) {
					return currTpl;
				}

				// Process subtree
				if (node.lastChild) {
					currTpl = findProblemTemplate(node.lastChild, currTpl);
					if (currTpl && currTpl.isCulprit) {
						// We got what we wanted -- get out of here.
						return currTpl;
					}
				}

				// Test for "start"-tag after processing subtree
				if (foundMatch(currTpl, nodeName)) {
					return currTpl;
				}
			}

			// Move left
			node = node.previousSibling;
		}

		return currTpl;
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
		} else if (DU.isMarkerMeta(c, "mw:EndTag") && c.getAttribute("data-etag") === "table") {
			// We have a stray table-end-tag marker -- this signals a problem either with
			// wikitext or with our parsed DOM.  In either case, we do the following:
			// * Find the farthest template beyond which there is a top-level table tag
			// * Artifically expand that template's range to cover this missing end tag.
			// This effectively papers over the problem by treating the entire content as
			// output of that farthest template and protects it from being edited.

			// console.warn("---- found table etag: " + c.outerHTML);
			var problemTpl = findProblemTemplate(c.previousSibling, null);
			if (problemTpl && problemTpl.isCulprit) {
				// console.warn("---- found problem tpl: " + problemTpl.tplId);
				// Move that template's end-tag after c
				c.parentNode.insertBefore(problemTpl.end, c.nextSibling);

				// Update TSR
				DU.getDataParsoid( problemTpl.end ).tsr = Util.clone( DU.getDataParsoid( c ).tsr );

				// Skip all nodes till we find the opening id of this template
				// FIXME: Ugh!  Duplicate tree traversal
				tplIdToSkip = problemTpl.tplId;
			}
		} else if (c.nodeType === Node.ELEMENT_NODE) {
			// Look at c's subtree
			handleUnbalancedTableTags(c, env, options, tplIdToSkip);
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

		function fixedIndentPreText(str, isLastChild) {
			if (isLastChild) {
				return str.replace(/\n(?!$)/g, "\n ");
			} else {
				return str.replace(/\n/g, "\n ");
			}
		}

		function reinsertLeadingSpace(elt, isLastChild) {
			var children = elt.childNodes;
			for (var i = 0, n = children.length; i < n; i++) {
				var c = children[i];
				if (c.nodeType === Node.TEXT_NODE) {
					c.data = fixedIndentPreText(c.data, isLastChild && i === n-1);
				} else {
					// recurse
					reinsertLeadingSpace(c, isLastChild && i === n-1);
				}
			}
		}

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
					var next = c_child.nextSibling;
					if (c_child.nodeType === Node.TEXT_NODE) {
						// new child with fixed up text
						c_child = document.createTextNode(fixedIndentPreText(c_child.data, next === null));
					} else if (c_child.nodeType === Node.ELEMENT_NODE) {
						// recursively process all text nodes to make
						// sure every new line gets a space char added back.
						reinsertLeadingSpace(c_child, next === null);
					}
					node.insertBefore(c_child, c);
					c_child = next;
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
		var children = elt.childNodes, n;
		for (var i = 0; i < children.length; i++) {
			var processed = false;
			n = children[i];
			if (!indentPresHandled) {
				if (n.nodeType === Node.ELEMENT_NODE) {
					if (Util.tagOpensBlockScope(n.nodeName.toLowerCase())) {
						if (DU.isTplMetaType(n.getAttribute("typeof")) || DU.isLiteralHTMLNode(n)) {
							deleteIndentPreFromDOM(n);
							processed = true;
						}
					} else if (n.getAttribute("typeof") === "mw:Extension/References") {
						// SSS FIXME: This may no longer be added after we started
						// stripping leading whitespace in refs in ext.Cite.js.
						// Verify and get rid of this special case.
						//
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
						DU.getDataParsoid( n ).strippedNL = matches[1];
					}
				}
			}

			findAndHandlePres(doc, n, indentPresHandled || processed);
		}
	}

	// kick it off
	findAndHandlePres(document, document.body, false);
}

// Migrate trailing newlines out of
function migrateTrailingNLs(elt, env) {

	// We can migrate a newline out of a node if one of the following is true:
	// (1) The ends a line in wikitext (=> not a literal html tag)
	// (2) The node has an auto-closed end-tag (wikitext-generated or literal html tag)
	// (3) It is the rightmost node in the DOM subtree rooted at a node
	//     that ends a line in wikitext
	function canMigrateNLOutOfNode(node) {
		// These nodes either end a line in wikitext (tr, li, dd, ol, ul, dl, caption, p)
		// or have implicit closing tags that can leak newlines to those that end a line (th, td)
		//
		// SSS FIXME: Given condition 2, we may not need to check th/td anymore
		// (if we can rely on auto inserted start/end tags being present always).
		var nodesToMigrateFrom = Util.arrayToHash([
			"th", "td", "tr", "li", "dd", "ol", "ul", "dl", "caption", "p"
		]);

		function nodeEndsLineInWT(node) {
			return nodesToMigrateFrom[node.nodeName.toLowerCase()] && !DU.isLiteralHTMLNode(node);
		}

		return node && (
			nodeEndsLineInWT(node) ||
			(DU.isElt(node) && DU.getDataParsoid( node ).autoInsertedEnd) ||
			(!node.nextSibling && canMigrateNLOutOfNode(node.parentNode))
		);
	}

	// A node has zero wt width if:
	// - tsr[0] == tsr[1]
	// - only has children with zero wt width
	function hasZeroWidthWT(node) {
		var tsr = DU.getDataParsoid( node ).tsr;
		if (!tsr || tsr[0] === null || tsr[0] !== tsr[1]) {
			return false;
		}

		var c = node.firstChild;
		while (c && DU.isElt(c) && hasZeroWidthWT(c)) {
			c = c.nextSibling;
		}

		return c === null;
	}

	if (DU.hasNodeName(elt, "pre")) {
		return;
	}

	// 1. Process DOM rooted at 'elt' first
	var children = elt.childNodes;
	for (var i = 0; i < children.length; i++) {
		migrateTrailingNLs(children[i], env);
	}

	// 2. Process 'elt' itself after -- skip literal-HTML nodes
	if (canMigrateNLOutOfNode(elt)) {
		var firstEltToMigrate = null,
			migrationBarrier = null,
			partialContent = false,
			n = elt.lastChild;

		// We can migrate trailing newline-containing separators
		// across meta tags as long as the metas:
		// - are not literal html metas (found in wikitext)
		// - are not mw:PageProp (cannot cross page-property boundary
		// - are not mw:Includes/* (cannot cross <*include*> boundary)
		// - are not ext/tpl start/end markers (cannot cross ext/tpl boundary)
		// - are not ext placeholder markers (cannot cross ext boundaries)
		while (n && DU.hasNodeName(n, "meta") && !DU.isLiteralHTMLNode(n)) {
			var prop = n.getAttribute("property"),
			    type = n.getAttribute("typeof");

			if (prop && prop.match(/mw:PageProp/)) {
				break;
			}

			if (type && (DU.isTplMetaType(type) || type.match(/\b(mw:Includes|mw:Extension\/)/))) {
				break;
			}

			migrationBarrier = n;
			n = n.previousSibling;
		}

		// We can migrate trailing newlines across nodes that have zero-wikitext-width.
		if (n && !DU.hasNodeName(n, "meta")) {
			while (n && DU.isElt(n) && hasZeroWidthWT(n)) {
				migrationBarrier = n;
				n = n.previousSibling;
			}
		}

		// Find nodes that need to be migrated out:
		// - a sequence of comment and newline nodes that is preceded by
		//   a non-migratable node (text node with non-white-space content
		//   or an element node).
		var foundNL = false;
		while (n && (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.COMMENT_NODE)) {
			if (n.nodeType === Node.COMMENT_NODE) {
				firstEltToMigrate = n;
			} else {
				if (n.data.match(/^\s*\n\s*$/)) {
					foundNL = true;
					firstEltToMigrate = n;
					partialContent = false;
				} else if (n.data.match(/\n$/)) {
					foundNL = true;
					firstEltToMigrate = n;
					partialContent = true;
					break;
				} else {
					break;
				}
			}

			n = n.previousSibling;
		}

		if (firstEltToMigrate && foundNL) {
			var eltParent = elt.parentNode,
				insertPosition = elt.nextSibling;

			n = firstEltToMigrate;
			while (n !== migrationBarrier) {
				var next = n.nextSibling;
				if (partialContent) {
					var nls = n.data;
					n.data = n.data.replace(/\n+$/, '');
					nls = nls.substring(n.data.length);
					n = n.ownerDocument.createTextNode(nls);
					partialContent = false;
				}
				eltParent.insertBefore(n, insertPosition);
				n = next;
			}
		}
	}
}

// If the last child of a node is a start-meta, simply
// move it up and make it the parent's sibling.
// This will move the start-meta closest to the content
// that the template/extension produced and improve accuracy
// of finding dom ranges and wrapping templates.
function migrateStartMetas( node, env ) {
	var c = node.firstChild;
	while (c) {
		var sibling = c.nextSibling;
		if (c.childNodes.length > 0) {
			migrateStartMetas(c, env);
		}
		c = sibling;
	}

	if (node.nodeName !== 'HTML') {
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
	}
}

/**
 * Find the common DOM ancestor of two DOM nodes
 */
function getDOMRange( env, doc, startElem, endMeta, endElem ) {
	var startElemIsMeta = DU.hasNodeName(startElem, "meta");

	// Detect empty content
	if (startElemIsMeta && startElem.nextSibling === endElem) {
		var emptySpan = doc.createElement('span');
		startElem.parentNode.insertBefore(emptySpan, endElem);
	}

	var startAncestors = DU.pathToRoot(startElem);

	// now find common ancestor
	var elem = endElem;
	var parentNode = endElem.parentNode;
	var range = null;
	while (parentNode && parentNode.nodeType !== Node.DOCUMENT_NODE) {
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
	if (tcStart.nodeType === Node.COMMENT_NODE || tcStart.nodeType === Node.TEXT_NODE) {
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
		if (tcDP && seDP && tcDP.dsr && seDP.dsr && tcDP.dsr[1] > seDP.dsr[1]) {
			// Since TSRs on template content tokens are cleared by the
			// template handler, all computed dsr values for template content
			// is always inferred from top-level content values and is safe.
			// So, do not overwrite a bigger end-dsr value.
			tcDP.dsr[0] = seDP.dsr[0];
			done = true;
		}

		if (!done) {
			tcStart.data.parsoid.dsr = Util.clone( seDP.dsr );
			tcStart.data.parsoid.src = seDP.src;
		}
	}

	if (!DU.inSiblingOrder(range.start, range.end)) {
		// In foster-parenting situations, the end-meta tag (and hence r.end)
		// can show up before the r.start which would be the table itself.
		// So, we record this info for later analysis
		range.flipped = true;
		if (!range.end.data) {
			range.end.data = {};
		}
		range.end.data.tmp_fostered = true;
	}

	return range;
}

function findTopLevelNonOverlappingRanges(document, env, tplRanges) {
	function stripStartMeta(meta) {
		if (DU.hasNodeName(meta, 'meta')) {
			deleteNode(meta);
		} else {
			// Remove mw:* from the typeof
			var type = meta.getAttribute("typeof");
			type = type.replace(/\bmw:[^\/]*(\/[^\s]+|\b)/, '');
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
		tplArray.push({ dsr: dsr, args: argInfo.dict, keys: argInfo.keys });
	}

	var i, r, n, e;
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
				if (!n.data) {
					n.data = {};
				}
				// Use a "_tmp" prefix on tplRanges so that it doesn't
				// get serialized out as a data-attribute by utility
				// methods on the DOM -- the prefix will be a signal
				// to the method to not serialize it.  This data on the
				// DOM nodes is purely temporary and doesn't need to
				// persist beyond this pass.
				var tpls = n.data.tmp_tplRanges;
				if (!tpls) {
					tpls = {};
					n.data.tmp_tplRanges = tpls;
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

	// For each range r:(s, e), walk up from s --> root and if if any of
	// these nodes have tpl-ranges (besides r itself) assigned to them,
	// then r is nested in those other templates and can be ignored.
	var nestedRangesMap = {};
	var docBody = document.body;
	for (i = 0; i < numRanges; i++) {
		r = tplRanges[i];
		n = r.start;

		// console.warn("Range: " + r.id);

		while (n !== docBody) {
			if (n.data && n.data.tmp_tplRanges) {
				if (n !== r.start) {
					// console.warn("1. nested; n_tpls: " + Object.keys(n.data.tmp_tplRanges));

					// 'r' is nested for sure
					// Record a range in which 'r' is nested in.
					nestedRangesMap[r.id] = Object.keys(n.data.tmp_tplRanges)[0];
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
					var s_tpls = r.start.data.tmp_tplRanges,
						e_tpls = r.end.data.tmp_tplRanges,
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
			deleteNode(endTagToRemove);
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
		if (dp1.dsr) {
			if (dp2.dsr) {
				// Case 1. above
				if (dp2.dsr[1] > dp1.dsr[1]) {
					dp1.dsr[1] = dp2.dsr[1];
				}

				// Case 2. above
				var endDsr = dp2.dsr[0];
				if (DU.hasNodeName(tcEnd, 'table') &&
					((endDsr !== null && endDsr < dp1.dsr[0]) ||
					 (tcStart.data && tcStart.data.tmp_fostered)))
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
				var keyArrays = [];
				/* jshint loopfunc: true */ // yes, this function is in a loop
				tplArray.forEach(function(a) {
					if (a.keys) {
						keyArrays.push(a.keys);
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
						// the corresponding private metadata in keyArrays
						// above.
						if (a.args) { // XXX: not sure why args can be undefined here
							a.args.i = infoIndex;
						}
						infoIndex++;
						return {template: a.args};
					}
				});

				// Output the data-mw obj.
				var datamw = (tplArray.length === 1) ? tplArray[0].template : { parts: tplArray };
				range.start.setAttribute("data-mw", JSON.stringify(datamw));
				range.start.data.parsoid.keys = keyArrays;
			}
		} else {
			console.warn("ERROR: Do not have necessary info. to encapsulate Tpl: " + i);
			console.warn("Start Elt : " + startElem.outerHTML);
			console.warn("End Elt   : " + range.endElem.innerHTML);
			console.warn("Start DSR : " + JSON.stringify(dp1 || {}));
			console.warn("End   DSR : " + JSON.stringify(dp2 || {}));
		}

		// Remove startElem (=range.startElem) if a meta.  If a meta,
		// it is guaranteed to be a marker meta added to mark the start
		// of the template.
		// However, tcStart (= range.start), even if a meta, need not be
		// a marker meta added for the template.
		if (DU.hasNodeName(startElem, "meta") &&
				/\bmw:(:?Transclusion|Param)\b/.test(startElem.getAttribute('typeof'))) {
			deleteNode(startElem);
		}

		deleteNode(range.endElem);
	}
}

function swallowTableIfNestedDSR(elt, tbl) {
	var eltDP = DU.getDataParsoid( elt ),
		eltDSR = eltDP.dsr,
		tblDP = DU.getDataParsoid( tbl ),
		tblTSR = tblDP.tsr;

	// IMPORTANT: Do not use dsr to compare because the table may not
	// have a valid dsr[1] (if the  table's end-tag is generated by
	// a template transcluded into the table) always.  But it is
	// sufficient to check against tsr[1] because the only way 'elt'
	// could have a dsr[0] after the table-start-tag but show up before
	// 'tbl' is if 'elt' got fostered out of the table.
	if (eltDSR && tblTSR && eltDSR[0] >= tblTSR[1]) {
		eltDP.dsr[0] = tblTSR[0];
		eltDP.dsr[1] = null;
		return true;
	} else {
		return false;
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

		if ( elem.nodeType === Node.ELEMENT_NODE ) {
			var type = elem.getAttribute( 'typeof' ),
				// SSS FIXME: This regexp differs from that in isTplMetaType
				metaMatch = type ? type.match( /\b(mw:(?:Transclusion|Param)(\/[^\s]+)?)\b/ ) : null;

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
			if (metaMatch && ( DU.getDataParsoid( elem ).tsr || type.match(/\/End\b/))) {
				var metaType = metaMatch[1];

				about = elem.getAttribute('about'),
				aboutRef = tpls[about];
				// Is this a start marker?
				if (!metaType.match(/\/End\b/)) {
					if ( aboutRef ) {
						aboutRef.start = elem;
						// content or end marker existed already
						if ( aboutRef.end ) {
							// End marker was foster-parented.
							// Found actual start tag.
							console.warn( 'end marker was foster-parented for ' + about);
							tplRanges.push(getDOMRange( env, doc, elem, aboutRef.end, aboutRef.end ));
						} else {
							// should not happen!
							console.warn( 'start found after content for ' + about );
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
				tplRanges = tplRanges.concat(findWrappableTemplateRanges( doc, env, elem, tpls ));
			}
		}

		elem = nextSibling;
	}

	return tplRanges;
}

function findBuilderCorrectedTags(document, env) {
	function addPlaceholderMeta( node, dp, name, opts ) {
		// If node is in a position where the placeholder
		// node will get fostered out, dont bother adding one
		// since the browser and other compliant clients will
		// move the placeholder out of the table.
		if (DU.isFosterablePosition(node)) {
			return;
		}

		var src = dp.src;

		if (!src) {
			if (dp.tsr) {
				src = env.page.src.substring(dp.tsr[0], dp.tsr[1]);
			} else if (opts.tsr) {
				src = env.page.src.substring(opts.tsr[0], opts.tsr[1]);
			} else if (DU.hasLiteralHTMLMarker(dp)) {
				if (opts.start) {
					src = "<" + name + ">";
				} else if (opts.end) {
					src = "</" + name + ">";
				}
			}
		}

		if ( src ) {
			var placeHolder;

			placeHolder = node.ownerDocument.createElement('meta'),
			placeHolder.setAttribute('typeof', 'mw:Placeholder/StrippedTag');
			placeHolder.data = { parsoid: { src: src, name: name.toUpperCase() } };

			// Insert the placeHolder
			node.parentNode.insertBefore(placeHolder, node);
		}
	}

	// Search forward for a shadow meta, skipping over other end metas
	function findMetaShadowNode( node, type, name ) {
		while ( node ) {
			var sibling = node.nextSibling;
			if (!sibling || !DU.isMarkerMeta( sibling, type )) {
				return null;
			}

			if (sibling.getAttribute('data-etag') === name ) {
				return sibling;
			}

			node = sibling;
		}

		return null;
	}

	// This pass:
	// 1. Finds start-tag marker metas that dont have a corresponding start tag
	//    and adds placeholder metas for the purposes of round-tripping.
	// 2. Deletes any useless end-tag marker metas
	// 3. Deletes empty nodes that is entirely builder inserted (both start/end)
	function findDeletedStartTagsAndMore(node) {
		// handle unmatched mw:StartTag meta tags
		var c = node.firstChild;
		while (c !== null) {
			var sibling = c.nextSibling;
			if (DU.isElt(c)) {
				var dp = DU.getDataParsoid( c );
				if (DU.hasNodeName(c, "meta")) {
					var metaType = c.getAttribute("typeof");
					if (metaType === "mw:StartTag") {
						var dataStag = c.getAttribute('data-stag'),
							data = dataStag.split(":"),
							stagTsr = data[1].split(","),
							expectedName = data[0];
						sibling = c.previousSibling;
						if (( sibling && sibling.nodeName.toLowerCase() !== expectedName ) ||
							(!sibling && c.parentNode.nodeName.toLowerCase() !== expectedName))
						{
							//console.log( 'start stripped! ', expectedName, c.parentNode.innerHTML );
							addPlaceholderMeta(c, dp, expectedName, {start: true, tsr: stagTsr});
						}
						deleteNode(c);
					} else if (metaType === "mw:EndTag" && !dp.tsr) {
						// If there is no tsr, this meta is useless for DSR
						// calculations. Remove the meta to avoid breaking
						// other brittle DOM passes working on the DOM.
						deleteNode(c);
					}
				} else if (dp.autoInsertedStart && dp.autoInsertedEnd && c.childNodes.length === 0) {
					// Delete any node that was inserted as a fixup node but has no content
					deleteNode(c);
				} else {
					findDeletedStartTagsAndMore(c);
				}
			}
			c = sibling;
		}
	}

	// This pass tries to match nodes with their start and end tag marker metas
	// and adds autoInsertedEnd/Start flags if it detects the tags to be inserted by
	// the HTML tree builder
	function findAutoInsertedTags(node) {
		var c = node.firstChild,
			sibling, expectedName;

		while (c !== null) {

			// Skip over template/extension content
			if (DU.isTplElementNode( env, node )) {
				var about = node.getAttribute( 'about' );
				c = c.nextSibling;
				while (c && node.getAttribute('about') === about) {
					c = c.nextSibling;
				}

				if (!c) {
					return;
				}
			}

			if (c.nodeType === Node.ELEMENT_NODE) {
				// Process subtree first
				findAutoInsertedTags(c);

				var dp = DU.getDataParsoid( c ),
					cNodeName = c.nodeName.toLowerCase();

				// Dont bother detecting auto-inserted start/end if:
				// -> c is a void element
				// -> c is not self-closed
				// -> c is not tbody unless it is a literal html tag
				//    tbody-tags dont exist in wikitext and are always
				//    closed properly.  How about figure, caption, ... ?
				//    Is this last check useless optimization?????
				if (!Util.isVoidElement(cNodeName) &&
					!dp.selfClose &&
					(cNodeName !== 'tbody' || DU.hasLiteralHTMLMarker(dp)))
				{
					// Do we need to run auto-inserted end-tag detection on c?
					// -> Yes if we have tsr
					// -> Yes if dont have tsr but end tag is outside template
					if (dp.tsr || DU.endTagOutsideTemplate(c, dp)) {
						// Detect auto-inserted end-tags
						var metaNode = findMetaShadowNode(c, 'mw:EndTag', cNodeName);
						if (!metaNode) {
							//console.log( c.nodeName, c.parentNode.outerHTML );
							// 'c' is a html node that has tsr, but no end-tag marker tag
							// => its closing tag was auto-generated by treebuilder.
							dp.autoInsertedEnd = true;
						}
					}

					if (dp.tsr) {
						// Detect auto-inserted start-tags
						var fc = c.firstChild;
						while (fc) {
							if (fc.nodeType !== Node.ELEMENT_NODE) {
								break;
							}
							var fcDP = DU.getDataParsoid( fc );
							if (fcDP.autoInsertedStart) {
								fc = fc.firstChild;
							} else {
								break;
							}
						}

						expectedName = cNodeName + ":" + dp.tsr;
						if (fc &&
							DU.isMarkerMeta(fc, "mw:StartTag") &&
							fc.getAttribute('data-stag') === expectedName)
						{
							// Strip start-tag marker metas that has its matching node
							deleteNode(fc);
						} else {
							//console.log('autoInsertedStart:', c.outerHTML);
							dp.autoInsertedStart = true;
						}
					}
				} else if (cNodeName === 'meta') {
					var type = c.getAttribute('typeof');
					if ( type === 'mw:EndTag' ) {
						// Got an mw:EndTag meta element, see if the previous sibling
						// is the corresponding element.
						sibling = c.previousSibling;
						expectedName = c.getAttribute('data-etag');
						if (!sibling || sibling.nodeName.toLowerCase() !== expectedName) {
							// Not found, the tag was stripped. Insert an
							// mw:Placeholder for round-tripping
							//console.log('autoinsertedEnd', c.innerHTML, c.parentNode.innerHTML);
							// console.warn("expected.nodeName: " + expectedName + "; sibling.nodeName: " + sibling.nodeName);
							addPlaceholderMeta(c, dp, expectedName, {end: true});
						}
					} else {
						// Jump over this meta tag, but preserve it
						c = c.nextSibling;
						continue;
					}
				}
			}

			c = c.nextSibling;
		}
	}

	findAutoInsertedTags(document.body);
	findDeletedStartTagsAndMore(document);
}

// TSR = "Tag Source Range".  Start and end offsets giving the location
// where the tag showed up in the original source.
//
// DSR = "DOM Source Range".  [0] and [1] are open and end,
// [2] and [3] are widths of the container tag.
// So [[foo]] will have DSR [0,7,2,2]

// node  -- node to process
// [s,e) -- if defined, start/end position of wikitext source that generated
//          node's subtree
function computeNodeDSR(env, node, s, e, dsrCorrection, traceDSR) {

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
		"ul" : true,
		"ol" : true,
		"dl" : true,
		"li" : true,
		"dt" : true,
		"dd" : true,
		"table" : true,
		"caption" : true,
		"tr" : true,
		"td" : true,
		"th" : true,
		"hr" : true, // void element
		"br" : true, // void element
		"pre" : true
	};

	function tsrSpansTagDOM(n, parsoidData) {
		// - tags known to have tag-specific tsr
		// - html tags with 'stx' set
		// - span tags with 'mw:Nowiki' type
		var name = n.nodeName.toLowerCase();
		return !WT_tagsWithLimitedTSR[name] &&
			!DU.hasLiteralHTMLMarker(parsoidData) &&
			!DU.isNodeOfType(n, 'span', 'mw:Nowiki');
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

	function computeATagWidth(node, dp) {
		/* -------------------------------------------------------------
		 * Tag widths are computed as per this logic here:
		 *
		 * 1. [[Foo|bar]] <-- piped mw:WikiLink
		 *     -> start-tag: "[[Foo|"
		 *     -> content  : "bar"
		 *     -> end-tag  : "]]"
		 *
		 * 2. [[Foo]] <-- non-piped mw:WikiLink
		 *     -> start-tag: "[["
		 *     -> content  : "Foo"
		 *     -> end-tag  : "]]"
		 *
		 * 3. [[{{echo|Foo}}|Foo]] <-- tpl-attr mw:WikiLink
		 *    Dont bother setting tag widths since dp.sa["href"] will be
		 *    the expanded target and won't correspond to original source.
		 *    We dont always have access to the meta-tag that has the source.
		 *
		 * 4. [http://wp.org foo] <-- mw:ExtLink
		 *     -> start-tag: "[http://wp.org "
		 *     -> content  : "foo"
		 *     -> end-tag  : "]"
		 * -------------------------------------------------------------- */
		if (!dp) {
			return null;
		} else {
			var aType = node.getAttribute("rel");
			if (aType === "mw:WikiLink" &&
				!DU.isExpandedAttrsMetaType(node.getAttribute("typeof")))
			{
				if (dp.stx === "piped") {
					var href = dp.sa ? dp.sa.href : null;
					if (href) {
						return [href.length + 3, 2];
					} else {
						return null;
					}
				} else {
					return [2, 2];
				}
			} else if (aType === "mw:ExtLink" && dp.tsr && dp.stx !== 'url') {
				return [dp.targetOff - dp.tsr[0], 1];
			} else {
				return null;
			}
		}
	}

	function computeTagWidths(widths, node, dp) {
		var stWidth = widths[0], etWidth = null;

		if (dp.tagWidths) {
			return dp.tagWidths;
		} else if (DU.hasLiteralHTMLMarker(dp)) {
			if (dp.tsr) {
				etWidth = widths[1];
			}
		} else {
			var nodeName = node.nodeName.toLowerCase();
			// 'tr' tags not in the original source have zero width
			if (nodeName === 'tr' && !dp.startTagSrc) {
				stWidth = 0;
				etWidth = 0;
			} else {
				var wtTagWidth = WT_TagWidths[nodeName];
				if (stWidth === null) {
					// we didn't have a tsr to tell us how wide this tag was.
					if (nodeName === 'a') {
						wtTagWidth = computeATagWidth(node, dp);
						stWidth = wtTagWidth ? wtTagWidth[0] : null;
					} else if (nodeName === 'li' || nodeName === 'dd') {
						stWidth = computeListEltWidth(node, nodeName);
					} else if (wtTagWidth) {
						stWidth = wtTagWidth[0];
					}
				}
				etWidth = wtTagWidth ? wtTagWidth[1] : widths[1];
			}
		}

		return [stWidth, etWidth];
	}

	function trace() {
		if (traceDSR) {
			Util.debug_pp.apply(Util, ['', ''].concat([].slice.apply(arguments)));
		}
	}

	function traceNode(node, i, cs, ce) {
		if (traceDSR) {
			trace(
				"-- Processing <", node.parentNode.nodeName, ":", i,
				">=", DU.isElt(node) ? '' : (DU.isText(node) ? '#' : '!'),
				DU.isElt(node) ? (node.nodeName === 'META' ? node.outerHTML : node.nodeName) : node.data,
				" with [", cs, ",", ce, "]"
			);
		}
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

	trace("Received ", s, ", ", e, " for ", node.nodeName);

	var correction;
	var children = node.childNodes,
		savedEndTagWidth = null,
	    ce = e,
		// Initialize cs to ce to handle the zero-children case properly
		// if this node has no child content, then the start and end for
		// the child dom are indeed identical.  Alternatively, we could
		// explicitly code this check before everything and bypass this.
		cs = ce,
		editMode = env.conf.parsoid.editMode;
	for (var n = children.length, i = n-1; i >= 0; i--) {
		var isMarkerTag = false,
			child = children[i],
		    cType = child.nodeType,
			endTagWidth = null;
		cs = null;

		// In edit mode, StrippedTag marker tags will be removed and wont
		// be around to miss in the filling gap.  So, absorb its width into
		// the DSR of its previous sibling.
		if (editMode) {
			var next = child.nextSibling;
			if (next) {
				if (DU.isElt(next) && next.data.parsoid.src &&
					/\bmw:Placeholder\/StrippedTag\b/.test(next.getAttribute("typeof")))
				{
					if (next.data.parsoid.name in {B:1, I:1} && child.nodeName in {B:1, I:1}) {
						correction = next.data.parsoid.src.length;
						ce += correction;
						dsrCorrection = correction;
					}
				}
			}
		}

		traceNode(child, i, cs, ce);

		if (cType === Node.TEXT_NODE) {
			if (ce !== null) {
				cs = ce - child.data.length - DU.indentPreDSRCorrection(child);
			}
		} else if (cType === Node.COMMENT_NODE) {
			if (ce !== null) {
				cs = ce - child.data.length - 7; // 7 chars for "<!--" and "-->"
			}
		} else if (cType === Node.ELEMENT_NODE) {
			var cTypeOf = child.getAttribute("typeof"),
				dp = DU.getDataParsoid( child ),
				tsr = dp.tsr,
				oldCE = tsr ? tsr[1] : null,
				propagateRight = false,
				stWidth = null, etWidth = null;

			// In edit-mode, we are making dsr corrections to account for
			// stripped tags (end tags usually).  When stripping happens,
			// in most common use cases, a corresponding end tag is added
			// back elsewhere in the DOM.
			//
			// So, when an autoInsertedEnd tag is encountered and a matching
			// dsr-correction is found, make a 1-time correction in the
			// other direction.
			if (editMode && ce !== null && dp.autoInsertedEnd && child.nodeName in {B:1, I:1}) {
				correction = (3 + child.nodeName.length);
				if (correction === dsrCorrection) {
					ce -= correction;
					dsrCorrection = 0;
				}
			}

			if (DU.hasNodeName(child, "meta")) {
				// Unless they have been foster-parented,
				// meta marker tags have valid tsr info.
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
							var prevDP = DU.getDataParsoid( prev );
							if (!DU.hasLiteralHTMLMarker(prevDP)) {
								if (dp.endTagSrc) {
									prevDP.endTagSrc = dp.endTagSrc;
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
				} else if (/^mw:Placeholder(\/\w*)?$/.test(cTypeOf) && ce !== null && dp.src) {
					cs = ce - dp.src.length;
				} else {
					var property = child.getAttribute("property");
					if (property && property.match(/mw:objectAttr/)) {
						cs = ce;
					}
				}
				if (dp.tagWidths) {
					stWidth = dp.tagWidths[0];
					etWidth = dp.tagWidths[1];
					delete dp.tagWidths;
				}
			} else if (cTypeOf === "mw:Entity" && ce !== null && dp.src) {
				cs = ce - dp.src.length;
			} else {
				var tagWidths, newDsr, ccs, cce;
				if (/^mw:Placeholder(\/\w*)?$/.test(cTypeOf) && dp.src) {
					cs = ce - dp.src.length;
				} else {
					// Non-meta tags
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

						if (traceDSR) {
							trace("TSR: ", tsr, "; cs: ", cs, "; ce: ", ce);
						}
					} else if (s && child.previousSibling === null) {
						cs = s;
					}
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

				ccs = cs !== null && stWidth !== null ? cs + stWidth : null;
				cce = ce !== null && etWidth !== null ? ce - etWidth : null;

				trace("Before recursion, [cs,ce]=", cs, ",", ce,
					"; [sw,ew]=", stWidth, ",", etWidth,
					"; [ccs,cce]=", ccs + ",", cce);

				/* -----------------------------------------------------------------
				 * Process DOM rooted at 'child'.
				 *
				 * NOTE: You might wonder why we are not checking for the zero-children
				 * case.  It is strictly not necessary and you can set newDsr directly.
				 *
				 * But, you have 2 options: [ccs, ccs] or [cce, cce].  Setting it to
				 * [cce, cce] would be consistent with the RTL approach.  We should
				 * then compare ccs and cce and verify that they are identical.
				 *
				 * But, if we handled the zero-child case like the other scenarios,
				 * we don't have to worry about the above decisions and checks.
				 * ----------------------------------------------------------------- */

				if (DU.hasNodeName(child, "a") &&
					child.getAttribute("rel") === "mw:WikiLink" &&
					dp.stx !== "piped")
				{
					/* -------------------------------------------------------------
					 * This check here eliminates artifical DSR mismatches on content
					 * text of the a-node because of entity expansion, etc.
					 *
					 * Ex: [[7%25 solution]] will be rendered as:
					 *    <a href=....>7% solution</a>
					 * If we descend into the text for the a-node, we'll have a 2-char
					 * DSR mismatch which will trigger artificial error warnings.
					 *
					 * In the non-piped link scenario, all dsr info is already present
					 * in the link target and so we get nothing new by processing
					 * content.
					 * ------------------------------------------------------------- */
					newDsr = [ccs, cce];
				} else {
					newDsr = computeNodeDSR(env, child, ccs, cce, dsrCorrection, traceDSR);
				}

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
				dp.dsr = [cs, ce, stWidth, etWidth];
				if (traceDSR) {
					trace("-- UPDATING; ", child.nodeName, " with [", cs, ",", ce, "]; typeof: ", cTypeOf);
					// Set up 'dbsrc' so we can debug this
					dp.dbsrc = env.page.src.substring(cs, ce);
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
						newCE = newCE + sibling.data.length + DU.indentPreDSRCorrection(sibling);
					} else if (nType === Node.COMMENT_NODE) {
						newCE = newCE + sibling.data.length + 7;
					} else if (nType === Node.ELEMENT_NODE) {
						var siblingDP = DU.getDataParsoid( sibling );
						if (siblingDP.dsr && siblingDP.tsr && siblingDP.dsr[0] <= newCE && e !== null) {
							// sibling's dsr wont change => ltr propagation stops here.
							break;
						}

						if (!siblingDP.dsr) {
							siblingDP.dsr = [null, null];
						}

						// Update and move right
						if (traceDSR) {
							trace("CHANGING ce.start of ", sibling.nodeName, " from ", siblingDP.dsr[0], " to ", newCE);
							// debug info
							if (siblingDP.dsr[1]) {
								siblingDP.dbsrc = env.page.src.substring(newCE, siblingDP.dsr[1]);
							}
						}
						siblingDP.dsr[0] = newCE;
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

	// Detect errors
	if (s !== null && s !== undefined && cs !== s) {
		console.warn("WARNING: DSR inconsistency: cs/s mismatch for node: " +
			node.nodeName + " s: " + s + "; cs: " + cs);
	}

	trace("For ", node.nodeName, ", returning: ", cs, ", ", e);

	return [cs, e];
}

var saveDataParsoid; // forward declaration

function dumpDomWithDataAttribs( root ) {
	function cloneData(node, clone) {
		var d = node.data;
		if (d && d.constructor === Object && (Object.keys(d.parsoid).length > 0)) {
			clone.data = Util.clone(d);
			saveDataParsoid( clone, true );
		}

		node = node.firstChild;
		clone = clone.firstChild;
		while (node) {
			cloneData(node, clone);
			node = node.nextSibling;
			clone = clone.nextSibling;
		}
	}

	root = root.documentElement;
	// cloneNode doesn't clone data => walk DOM to clone it
	var clonedRoot = root.cloneNode( true );
	cloneData(root, clonedRoot);
	console.warn(clonedRoot.innerHTML);
}

function computeDocDSR(root, env, options) {
	var startOffset = options.sourceOffsets ? options.sourceOffsets[0] : 0,
		endOffset = options.sourceOffsets ? options.sourceOffsets[1] : env.page.src.length,
		psd = env.conf.parsoid;

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:pre-dsr") !== -1))) {
		console.warn("------ DOM: pre-DSR -------");
		dumpDomWithDataAttribs( root );
		console.warn("----------------------------");
	}

	var traceDSR = env.debug || (psd.traceFlags && (psd.traceFlags.indexOf("dsr") !== -1));
	if (traceDSR) { console.warn("------- tracing DSR computation -------"); }

	// The actual computation buried in trace/debug stmts.
	var body = root.body;
	computeNodeDSR(env, body, startOffset, endOffset, 0, traceDSR);

	var dp = DU.getDataParsoid( body );
	dp.dsr = [startOffset, endOffset, 0, 0];

	if (traceDSR) { console.warn("------- done tracing DSR computation -------"); }

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:post-dsr") !== -1))) {
		console.warn("------ DOM: post-DSR -------");
		dumpDomWithDataAttribs( root );
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
	var psd = env.conf.parsoid;

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:pre-encap") !== -1))) {
		console.warn("------ DOM: pre-encapsulation -------");
		dumpDomWithDataAttribs( document );
		console.warn("----------------------------");
	}

	var tplRanges = findWrappableTemplateRanges( document, env, document.body, tpls );
	if (tplRanges.length > 0) {
		tplRanges = findTopLevelNonOverlappingRanges(document, env, tplRanges);
		encapsulateTemplates(document, env, tplRanges.ranges, tplRanges.tplArrays);
	}

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:post-encap") !== -1))) {
		console.warn("------ DOM: post-encapsulation -------");
		dumpDomWithDataAttribs( document );
		console.warn("----------------------------");
	}
}

function stripMarkerMetas(editMode, node) {
	// Sometimes a non-tpl meta node might get the mw:Transclusion typeof
	// element attached to it. So, check the property to make sure it is not
	// of those metas before deleting it.
	//
	// Ex: {{compactTOC8|side=yes|seealso=yes}} generates a mw:PageProp/notoc meta
	// that gets the mw:Transclusion typeof attached to it.  It is not okay to
	// delete it!
	var metaType = node.getAttribute("typeof");
	if (metaType &&
		// TODO: Use /Start for all Transclusion / Param markers!
		(metaType.match(/\bmw:(StartTag|EndTag|Extension\/ref\/Marker|TSRMarker)\/?[^\s]*\b/) &&
		!node.getAttribute("property")) ||
		(editMode && metaType === "mw:Placeholder/StrippedTag")
	) {
		var nextNode = node.nextSibling;
		deleteNode(node);
		// stop the traversal, since this node is no longer in the DOM.
		return nextNode;
	} else {
		return true;
	}
}

function addDeltaToDSR(node, delta) {
	// Add 'delta' to dsr[0] and dsr[1] for nodes in the subtree
	// node's dsr has already been updated
	var child = node.firstChild;
	while (child) {
		if (DU.isElt(child)) {
			DU.loadDataParsoid(child);
			if (child.data.parsoid.dsr) {
				// SSS FIXME: We've exploited partial DSR information
				// in propagating DSR values across the DOM.  But, worth
				// revisiting at some point to see if we want to change this
				// so that either both or no value is present to eliminate these
				// kind of checks.
				//
				// Currently, it can happen that one or the other
				// value can be null.  So, we should try to udpate
				// the dsr value in such a scenario.
				if (typeof(child.data.parsoid.dsr[0]) === 'number') {
					child.data.parsoid.dsr[0] += delta;
				}
				if (typeof(child.data.parsoid.dsr[1]) === 'number') {
					child.data.parsoid.dsr[1] += delta;
				}
			}
			addDeltaToDSR(child, delta);
		}
		child = child.nextSibling;
	}
}

/*
 * For the following wikitext (called the "LI hack"):
 *
 *     * <li class="..."> foo
 *
 * the Parsoid parser, pre-post processing generates something like
 *
 *     <li></li><li class="...">foo</li>
 *
 * This visitor deletes such spurious '<li>'s to match the output of
 * the PHP parser.
 *
 * However, note that the wikitext '<li></li>', any preceding wikitext
 * asterisk '*' absent, should indeed expand into two nodes in the
 * DOM.
 */
function cleanUpLIHack(env, node) {
	var prevNode = node.previousSibling;

	/* Does `node` contain nothing or just non-newline whitespace? */
	function nodeEssentiallyEmpty(node) {
		var childNodes = node.childNodes;
		if (0 === childNodes.length) {
			return true;
		} else if (childNodes.length > 1) {
			return false;
		} else {
			var child = childNodes[0];
			return (child.nodeName === "#text" &&
				/^[ \t]*$/.test(child.nodeValue));
		}
	}

	if (DU.isLiteralHTMLNode(node) &&
	    prevNode !== null &&
	    prevNode.nodeName === 'LI' &&
	    !DU.isLiteralHTMLNode(prevNode) &&
	    nodeEssentiallyEmpty(prevNode)) {
		// We have to store the extra information in order to
		// reconstruct the original source for roundtripping.
		node.data.parsoid.liHackSrc = DU.getWTSource(env, prevNode);

		// Update the dsr. Since we are coalescing the first
		// node with the second (or, more precisely, deleting
		// the first node), we have to update the second DSR's
		// starting point and start tag width.
		var nodeDSR     = node.data.parsoid.dsr,
		    prevNodeDSR = prevNode.data.parsoid.dsr;

		if (nodeDSR && prevNodeDSR) {
			node.data.parsoid.dsr = [ prevNodeDSR[0],
						  nodeDSR[1],
						  nodeDSR[2] + prevNodeDSR[1] - prevNodeDSR[0],
						  nodeDSR[3] ];
		}

		// Delete the duplicated <li> node.
		deleteNode(prevNode);
	}

	return true;
}

/**
 * DOMTraverser handler that unpacks DOM fragments which were injected in the
 * token pipeline.
 */
function unpackDOMFragments(env, node) {
	if (node.nodeType === node.ELEMENT_NODE) {
		var typeOf = node.getAttribute('typeof'),
			about = node.getAttribute('about'),
			lastNode = node;
		if (/\bmw:DOMFragment\b/.test(typeOf)) {
			// Replace this node and possibly a sibling with node.dp.html
			var parentNode = node.parentNode,
				// Use a div rather than a p, as the p might be stripped out
				// later if the children are block-level.
				dummyName = parentNode.nodeName !== 'P' ? parentNode.nodeName : 'div',
				dummyNode = node.ownerDocument.createElement(dummyName);

			if (!node.data || !node.data.parsoid) {
				// FIXME gwicke: This normally happens on Fragment content
				// inside other Fragment content. Print out some info about
				// the culprit for now.
				var out = 'undefined data.parsoid: ',
					workNode = node;
				while(workNode && workNode.getAttribute) {
					out += workNode.nodeName + '-' +
						workNode.getAttribute('about') + '-' +
						workNode.getAttribute('typeof') + '|';
					workNode = workNode.parentNode;
				}
				DU.loadDataParsoid(node);
			}

			var html = node.data.parsoid.html,
				tsrDelta = node.data.parsoid.tsrDelta;
			if (!html || /\bmw:Transclusion\b/.test(typeOf)) {
				// Ex: A multi-part template with an extension in its
				// output (possibly passed in as a parameter).
				//
				// Example:
				// echo '{{echo|<math>1+1</math>}}' | node parse --extensions math
				//
				// Simply remove the mw:DOMFragment typeof for now, as the
				// entire content will still be encapsulated as a
				// mw:Transclusion.
				DU.removeTypeOf(node, 'mw:DOMFragment');
				return true;
			}
			dummyNode.innerHTML = html;

			// get rid of the wrapper sibling (simplifies logic below)
			var sibling = node.nextSibling;
			if (sibling && sibling.nodeType === node.ELEMENT_NODE &&
					sibling.getAttribute('about') === node.getAttribute('about'))
			{
				// remove optional second element added by wrapper tokens
				lastNode = sibling;
				deleteNode(sibling);
			}

			// Potentially undo paragraph wrapping.
			if (parentNode.nodeName === 'P' &&
					(parentNode.childNodes.length === 1 ||
					 // This approximates the case where there are more nodes,
					 // but those would normally not trigger a paragraph.
					 // XXX gwicke: This can likely be improved!
					 /^[ \t]*$/.test(parentNode.textContent)))
			{
				// check if the content has a blocklevel element
				var hasBlock = DU.hasBlockElementDescendant(dummyNode);
				//console.log(dummyNode.nodeName, hasBlock,
				//		JSON.stringify(dummyNode.textContent),
				//		dummyNode.innerHTML);
				if (hasBlock || /^[ \t]*$/.test(dummyNode.textContent || '')) {
					// Block-level elements are not wrapped into paragraphs,
					// so fix it up here. Remove the parentNode and use its
					// parent instead.
					var newParent = parentNode.parentNode;
					while (parentNode.firstChild) {
						// move children up
						newParent.insertBefore(parentNode.firstChild, parentNode);
					}
					deleteNode(parentNode);
					parentNode = newParent;
				}
			}

			// Transfer the new dsr -- just dsr[0] and dsr[1] since tag-widths
			// will be incorrect for reuse of template expansions
			var firstChild = dummyNode.firstChild;
			DU.loadDataParsoid(firstChild);
			if (!firstChild.data.parsoid) {
				console.log(node.data.parsoid, dummyNode.outerHTML);
			}

			var dsr = node.data.parsoid.dsr;
			// FIXME: Not sure why this would be missing
			if (dsr) {
				var type = firstChild.getAttribute("typeof");
				if (/\bmw:(Transclusion|Extension)\b/.test(type)) {
					firstChild.data.parsoid.dsr = [dsr[0], dsr[1]];
				} else { // non-transcluded images
					firstChild.data.parsoid.dsr = [dsr[0], dsr[1], 2, 2];
					// Reused image -- update dsr by tsrDelta on all
					// descendents of 'firstChild' which is the <figure> tag
					if (tsrDelta) {
						addDeltaToDSR(firstChild, tsrDelta);
					}
				}
			} else {
				console.error( 'ERROR in ' + env.page.name + ': no DOMFragment wrapper dsr on ' + node.outerHTML );
			}

			// Move the old content nodes over from the dummyNode
			while (firstChild) {
				// Transfer the about attribute so that it is still unique in
				// the page
				firstChild.setAttribute('about', about);
				// Load data-parsoid for all children
				DU.loadDataParsoid(firstChild);
				parentNode.insertBefore(firstChild, node);
				firstChild = dummyNode.firstChild;
			}
			// And delete the placeholder node
			var nextNode = node.nextSibling;
			deleteNode(node);
			return nextNode;
		}
	}
	return true;
}

function generateReferences(refsExt, node) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		DU.loadDataParsoid(child);
		if (DU.isElt(child)) {
			var typeOf = child.getAttribute('typeof');
			if ((/\bmw:Extension\/ref\/Marker\b/).test(typeOf)) {
				refsExt.extractRefFromNode(child);
			} else if ((/\bmw:Extension\/references\b/).test(typeOf)) {
				refsExt.insertReferencesIntoDOM(child);
			} else if (child.childNodes.length > 0) {
				generateReferences(refsExt, child);
			}
		}

		child = nextChild;
	}
}

var findAndHandleNeighbour; // forward declaration

/**
 * Function for fetching the link prefix based on a link node.
 *
 * The content will be reversed, so be ready for that.
 */
function getLinkPrefix( env, node ) {
	var baseAbout = null,
		regex = env.conf.wiki.linkPrefixRegex;

	if ( !regex ) {
		return null;
	}

	if ( node !== null && DU.isTplElementNode( env, node ) ) {
		baseAbout = node.getAttribute( 'about' );
	}

	node = node === null ? node : node.previousSibling;
	return findAndHandleNeighbour( env, false, regex, node, baseAbout );
}

/**
 * Function for fetching the link trail based on a link node.
 */
function getLinkTrail( env, node ) {
	var baseAbout = null,
		regex = env.conf.wiki.linkTrailRegex;

	if ( !regex ) {
		return null;
	}

	if ( node !== null && DU.isTplElementNode( env, node ) ) {
		baseAbout = node.getAttribute( 'about' );
	}

	node = node === null ? node : node.nextSibling;
	return findAndHandleNeighbour( env, true, regex, node, baseAbout );
}

/**
 * Abstraction of both link-prefix and link-trail searches.
 */
findAndHandleNeighbour = function( env, goForward, regex, node, baseAbout ) {
	var value, matches, document, nextSibling,
		nextNode = goForward ? 'nextSibling' : 'previousSibling',
		innerNode = goForward ? 'firstChild' : 'lastChild',
		getInnerNeighbour = goForward ? getLinkTrail : getLinkPrefix,
		result = { content: [], src: '' };

	while ( node !== null ) {
		nextSibling = node[nextNode];
		document = node.ownerDocument;

		if ( node.nodeType === node.TEXT_NODE ) {
			matches = node.nodeValue.match( regex );
			value = { content: node, src: node.nodeValue };
			if ( matches !== null ) {
				value.src = matches[0];
				if ( value.src === node.nodeValue ) {
					// entire node matches linkprefix/trail
					value.content = node;
					deleteNode(node);
				} else {
					// part of node matches linkprefix/trail
					value.content = document.createTextNode( matches[0] );
					node.parentNode.replaceChild( document.createTextNode( node.nodeValue.replace( regex, '' ) ), node );
				}
			} else {
				value.content = null;
				break;
			}
		} else if ( DU.isTplElementNode( env, node ) &&
				baseAbout !== '' && baseAbout !== null &&
				node.getAttribute( 'about' ) === baseAbout ) {
			value = getInnerNeighbour( env, node[innerNode] );
		} else {
			break;
		}

		if ( value.content !== null ) {
			if ( value.content instanceof Array ) {
				result.content = result.content.concat( value.content );
			} else {
				result.content.push( value.content );
			}

			if ( goForward ) {
				result.src += value.src;
			} else {
				result.src = value.src + result.src;
			}

			if ( value.src !== node.nodeValue ) {
				break;
			}
		} else {
			break;
		}
		node = nextSibling;
	}

	return result;
};

/**
 * Workhorse function for bringing linktrails and link prefixes into link content.
 * NOTE that this function mutates the node's siblings on either side.
 */
function handleLinkNeighbours( env, node ) {
	if ( node.getAttribute( 'rel' ) !== 'mw:WikiLink' ) {
		return true;
	}

	var ix, prefix = getLinkPrefix( env, node ),
		trail = getLinkTrail( env, node ),
		dp = DU.getDataParsoid( node );

	if ( prefix && prefix.content ) {
		for ( ix = 0; ix < prefix.content.length; ix++ ) {
			node.insertBefore( prefix.content[ix], node.firstChild );
		}
		if ( prefix.src.length > 0 ) {
			dp.prefix = prefix.src;
			if ( dp.dsr ) {
				dp.dsr[0] -= prefix.src.length;
				dp.dsr[2] += prefix.src.length;
			}
		}
	}

	if ( trail && trail.content && trail.content.length ) {
		for ( ix = 0; ix < trail.content.length; ix++ ) {
			node.appendChild( trail.content[ix] );
		}
		if ( trail.src.length > 0 ) {
			dp.tail = trail.src;
			if ( dp.dsr ) {
				dp.dsr[1] += trail.src.length;
				dp.dsr[3] += trail.src.length;
			}
		}
		// indicate that the node's tail siblings have been consumed
		return node;
	} else {
		return true;
	}
}

/**
 * @method
 *
 * Migrate data-parsoid attributes into a property on each DOM node. We'll
 * migrate them back in the final DOM traversal.
 *
 * @param {Node} node
 */
function migrateDataParsoid( node ) {
	DU.loadDataParsoid( node );
	return true;
}

/**
 * @method
 *
 * Save the data-parsoid attributes on each node.
 */
saveDataParsoid = function( node, debugDump ) {
	if ( node.nodeType === node.ELEMENT_NODE && node.data ) {
		if (!debugDump && node.data.parsoid && node.data.parsoid.tsr) {
			node.data.parsoid.tsr = undefined;
		}
		DU.saveDataAttribs( node );
	}
	return true;
};

/**
 * @method
 *
 * Create a <meta> element in the document.head with the given attrs.
*/
function appendMeta(document, attrs) {
	var elt = document.createElement('meta');
	DU.addAttributes(elt, attrs);
	document.head.appendChild(elt);
}

function DOMPostProcessor(env, options) {
	this.env = env;
	this.options = options;

	// DOM traverser that runs before the in-order DOM handlers.
	var dataParsoidLoader = new DOMTraverser();
	dataParsoidLoader.addHandler( null, migrateDataParsoid );

	// Common post processing
	this.processors = [
		dataParsoidLoader.traverse.bind( dataParsoidLoader ),
		handleUnbalancedTableTags,
		migrateStartMetas,
		//normalizeDocument,
		findBuilderCorrectedTags,
		handlePres,
		migrateTrailingNLs
	];

	if (options.wrapTemplates) {
		// dsr computation and tpl encap are only relevant
		// for top-level content that is not wrapped in an extension
		this.processors.push(computeDocDSR);
		this.processors.push(encapsulateTemplateOutput);
	}

	// DOM traverser for passes that can be combined and will run at the end
	// 1. Link prefixes and suffixes
	// 2. Strip marker metas -- removes left over marker metas (ex: metas
	//    nested in expanded tpl/extension output).
	// 3. Unpack DOM fragments (reused transclusion and extension content)
	var lastDOMHandler = new DOMTraverser();
	lastDOMHandler.addHandler( 'a', handleLinkNeighbours.bind( null, env ) );
	lastDOMHandler.addHandler( null, unpackDOMFragments.bind(null, env) );
	this.processors.push(lastDOMHandler.traverse.bind(lastDOMHandler));

	// A pure DOM transformation
	this.processors.push(generateReferences.bind(null,
				env.conf.parsoid.nativeExtensions.cite.references));

	var dataParsoidSaver = new DOMTraverser();

	dataParsoidSaver.addHandler( 'meta', stripMarkerMetas.bind(null, env.conf.parsoid.editMode) );
	dataParsoidSaver.addHandler( 'li', cleanUpLIHack.bind( null, env ) );
	dataParsoidSaver.addHandler( null, saveDataParsoid );
	this.processors.push(dataParsoidSaver.traverse.bind(dataParsoidSaver));
}

// Inherit from EventEmitter
DOMPostProcessor.prototype = new events.EventEmitter();
DOMPostProcessor.prototype.constructor = DOMPostProcessor;

DOMPostProcessor.prototype.setSourceOffsets = function(start, end) {
	this.options.sourceOffsets = [start, end];
};

DOMPostProcessor.prototype.doPostProcess = function ( document ) {
	var env = this.env,
		psd = env.conf.parsoid;

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:post-builder") !== -1))) {
		console.warn("---- DOM: after tree builder ----");
		console.warn(document.innerHTML);
		console.warn("--------------------------------");
	}

	for (var i = 0; i < this.processors.length; i++) {
		try {
			this.processors[i](document, this.env, this.options);
		} catch ( e ) {
			env.errCB(e);
		}
	}

	// add mw: RDFa prefix to top level
	document.documentElement.setAttribute('prefix',
	                                      'mw: http://mediawiki.org/rdf/');

	// add <head> content based on page meta data
	if (!document.head) {
		document.documentElement.
			insertBefore(document.createElement('head'), document.body);
	}
	appendMeta(document, { charset: "UTF-8" });
	// don't let schema: prefix leak into <body>
	document.head.setAttribute('prefix', 'schema: http://schema.org/');
	var m = env.page.meta || {};
	Object.keys(m).forEach(function(f) {
		if (metadataMap[f] && m[f] !== null && m[f] !== undefined) {
			appendMeta(document, { property: metadataMap[f],
			                       content:  ''+m[f] });
		}
	});
	var r = m.revision || {};
	Object.keys(r).forEach(function(f) {
		if (metadataMap['rev_'+f] && r[f] !== null && r[f] !== undefined) {
			var value = '' + r[f];
			if (f==='timestamp') { value=new Date(r[f]).toISOString(); }
			if (f==='user') {
				value = env.conf.wiki.baseURI +
					env.conf.wiki.namespaceNames[2] + ':' + value;
			}
			if (f==='userid') {
				// This special page doesn't exist (yet).
				value = env.conf.wiki.baseURI +
					'Special:UserById/' + value;
			}
			appendMeta(document, { property: metadataMap['rev_'+f],
			                       content:  value });
		}
	});
	if (!document.querySelector('head > title')) {
		// this is a workaround for a bug in domino 1.0.9
		document.head.appendChild(document.createElement('title'));
	}
	document.title = env.page.meta.title;

	// Hack: Add a base href element to the head element of the HTML DOM so
	// that our relative links resolve fine when the DOM is viewed directly
	// from the web API. (Add the page name, in case it's a subpage.)
	var baseMeta = document.createElement('base');
	baseMeta.setAttribute('href', env.conf.wiki.baseURI + env.page.name);
	document.head.appendChild(baseMeta);
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
