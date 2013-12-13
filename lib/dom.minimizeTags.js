"use strict";

require('./core-upgrade.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

function minimizeInlineTags(root, rewriteable_nodes) {
	var rewriteable_node_map = null;

	function printPath(p) {
		return p.map(function(n) { return n.nodeName; }).join('|');
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
			rewriteable_node_map[rewriteable_nodes[i].toUpperCase()] = true;
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
			if (DU.isElt(sole_node)) {
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
			if (DU.isFirstEncapsulationWrapperNode(s)) {
				// Dont descend into template generated content
				P.push({path: [], orig_parent: node, children: [s]});
			} else if (DU.isElt(s)) {
				var p = longest_linear_path(s);
				if (p.length === 0) {
					rewrite(s);
					// console.log("Pushed EMPTY with orig_parent: " + node.nodeName);
					P.push({path: [], orig_parent: node, children: [s]});
				} else {
					var p_tail = p.last();

					// console.log("llp: " + printPath(p));

					// process subtree (depth-first)
					rewrite(p_tail);

					// collect the restructured p_tail subtree (children)
					var child_nodes  = p_tail.childNodes;
					var new_children = [];
					for (var j = 0, n2 = child_nodes.length; j < n2; j++) {
						new_children.push(child_nodes[j]);
					}

					// console.log("Pushed: " + printPath(p) + ", tail: " + p_tail.nodeName + "; new_children: " + new_children.length);
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

		// Do not cross into templates and block tags
		while (DU.isElt(node) &&
			!DU.isBlockTag(node.nodeName) &&
			!DU.isFirstEncapsulationWrapperNode(node))
		{
			path.push(node);
			children = node.childNodes;
			if (children.length !== 1) {
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
				// console.log("LCS: " + printPath(lcs));
				var prev = lcs[0];
				for (var k = 1, lcs_len = lcs.length; k < lcs_len; k++) {
					var curr = lcs[k];
					// console.log("adding " + curr.nodeName + " to " + prev.nodeName);

					// prev will have exactly one child
					// -- remove that child and make curr its child
					prev.removeChild(prev.firstChild);
					prev.appendChild(curr);
					prev = curr;
				}

				// Lastly, attach lcs to the incoming parent
				parent_node.appendChild(lcs[0]);
			}

			var paths     = s.paths;
			var num_paths = paths.length;
			// console.log("sublist: lcs: " + printPath(lcs) + ", #paths: " + num_paths);
			if (num_paths === 1) {
				// Nothing more to do!  Stitch things up
				// two possible scenarios:
				// (a) we have an empty path    ==> attach the children to parent_node
				// (b) we have a non-empty path ==> attach the children to the end of the path
				var p        = paths[0].path;
				var children = paths[0].children;
				if (p.length === 0) {
					add_children(parent_node, children);
				} else {
					var p_tail = p.last();
					remove_all_children(p_tail);
					add_children(p_tail, children);
				}
			} else {
				// Process the sublist
				rewrite_paths(lcs.last(), strip_lcs(paths, lcs));
			}

			// console.log("done with this sublist");
		}
		// console.log("--done all sublists--");
	}

	// SSS FIXME: Check attributes between paths here
	// - if data-parsoid.stx.html, all attributes should match
	// - if not data-parsoid.stx.html, can only match with non-html tags
	function common_path(old, new_path) {
		var hash = {};
		for (var i = 0, n = new_path.length; i < n; i++) {
			var e = new_path[i].nodeName;
			if (is_rewriteable_node(e)) {
				hash[e] = new_path[i];
			}
		}

		var cp = [];
		for (i = 0, n = old.length; i < n; i++) {
			var hit = hash[old[i].nodeName];
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

		// console.log("Orig paths:\n-> " + paths.map(function(p) { return printPath(p.path); }).join("\n-> "));
		// console.log("Stripping " + printPath(lcs));

		var lcs_map = {};
		for (var i = 0, n = lcs.length; i < n; i++) {
			lcs_map[lcs[i].nodeName] = true;
		}

		for (i = 0, n = paths.length; i < n; i++) {
			var p = paths[i].path;
			for (var j = 0, l = p.length; j < l; j++) {
				// remove matching element
				if (lcs_map[p[j].nodeName]) {
					p.splice(j, 1);
					l--;
					j--;
				}
			}
		}

		// console.log("Stripped paths:\n-> " + paths.map(function(p) { return printPath(p.path); }).join("\n-> "));

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
		var p    = P[0];
		var curr = { paths: [p], lcs: p.path };
		var ret  = [];

		for (var i = 1, n = P.length; i < n; i++) {
			p = P[i];
			var new_lcs = common_path(curr.lcs, p.path);
			if (new_lcs.length === 0) {
				ret.push(curr);
				curr = { paths: [p], lcs: p.path };
			} else {
				curr.lcs = new_lcs;
				curr.paths.push(p);
			}
		}

		ret.push(curr);
		return ret;
	}

	// Init
	init();

	// Kick it off
	rewrite(root);
}

if (typeof module === "object") {
	module.exports.minimizeInlineTags = minimizeInlineTags;
}
