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

var isElementContentWhitespace = function ( e ) {
	return (e.data.match(/^[ \r\n\t]*$/) !== null);
};

function minimize_inline_tags(root, rewriteable_nodes) {
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
		console.log(e.stack);
	}
}

var normalize_document = function(document) {
	minimize_inline_tags(document.body, ['b','u','i','s']);
};

/**
* Wrap all top-level inline elements in paragraphs.
* TODO: This should also be applied inside block-level elements, but in that
* case the first paragraph usually remains plain inline.
*/
var process_inlines_in_p = function ( document ) {
	var body = document.body,
		newP = document.createElement('p'),
		cnodes = body.childNodes,
		inParagraph = false,
		deleted = 0;

	for (var i = 0, length = cnodes.length; i < length; i++) {
		var child = cnodes[i - deleted],
			ctype = child.nodeType;

		// If we have a P-node from our immediate sibling, continue accumulating
		//   - if we have a text node, comment node, or an inline tag
		//   - if not, stop!
		// If we dont have a P-node from our sibling, create one if we have
		//   - non-white space text
		//   - an inline tag that is not a meta
		//   For the text node, strip leading newlines and add it as
		//   a new text node outside the paragraph.

		if ((ctype === Node.TEXT_NODE &&
				(inParagraph || !isElementContentWhitespace( child ))) ||
			(ctype === Node.ELEMENT_NODE &&
				!Util.isBlockTag(child.nodeName.toLowerCase()) &&
				(inParagraph || child.nodeName.toLowerCase() !== 'meta')) ||
			(ctype === Node.COMMENT_NODE &&
				inParagraph ))
		{
			if ( ctype === Node.TEXT_NODE && !inParagraph ) {
				var leadingNewLines = child.data.match(/^[\r\n]+/);
				if ( leadingNewLines ) {
					// don't include newlines in the paragraph
					child.parentNode.insertBefore(
							document.createTextNode( leadingNewLines[0] ),
							child
							);
					deleted--;
					child.data = child.data.substr( leadingNewLines[0].length );
				}
			}

			// wrap in paragraph
			newP.appendChild(child);

			inParagraph = true;
			deleted++;
		} else if (inParagraph) {
			body.insertBefore(newP, child);
			deleted--;
			newP = document.createElement('p');
			inParagraph = false;
		}
	}

	if (inParagraph) {
		body.appendChild(newP);
	}
};


/**
 * Remove trailing newlines from paragraph content (and move them to
 * inter-element whitespace)
 */
var remove_trailing_newlines_from_paragraphs = function ( document ) {
	var cnodes = document.body.childNodes;
	for( var i = 0; i < cnodes.length; i++ ) {
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
};

/**
 * Find the common DOM ancestor of two DOM nodes
 */
var getDOMRange = function ( startElem, endElem ) {
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
	while (parentNode && parentNode.nodeType !== Node.DOCUMENT_NODE) {
		var i = startAncestors.indexOf( parentNode );
		if (i === 0) {
			return {
				'root': startElem,
				// widen the scope to include the full subtree
				start: startElem.firstChild,
				end: startElem.lastChild
			};
		} else if ( i > 0) {
			return {
				'root': parentNode,
				start: startAncestors[i - 1],
				end: elem
			};
		}
		elem = parentNode;
		parentNode = elem.parentNode;
	}

	return null;
};

/**
 * TODO: split in common ancestor algo, sibling splicing and -annotation /
 * wrapping
 */
var encapsulateTrees = function ( startElem, endElem, doc ) {
	var range = getDOMRange( startElem, endElem );

	if ( range ) {
		// Detect empty content
		if (range.start.nextSibling === range.end) {
			var emptySpan = doc.createElement('span');
			range.start.parentNode.insertBefore(emptySpan, range.end);
		}

		//console.log ( 'HTML of template-affected subtrees: ' );
		var n = range.start,
			about = startElem.getAttribute('about');
		while (n) {
			if ( n.nodeType === Node.TEXT_NODE ) {
				// TODO: wrap into span
				var span = doc.createElement( 'span' );
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

		// SSS FIXME: This code below (start/end elt. deletion and fixup)
		// won't always work. Where deletion of the tags will bring
		// non-template content under templated-affected nodes, we will
		// have to preserve the tags and let the VE and serializer be
		// smart about handling them -- alternatively, in certain scenarios,
		// we maybe able to introduce additional span/div nodes to cleanly
		// separate non-template content from template-content.
		//
		// To be continued ...
		if (startElem.nodeName.toLowerCase() === "meta")  {
			// Transfer start info to the first node that can receive it
			// (only if our current start element is a meta!)
			n = startElem;
			while (n.nextSibling === null) {
				n = n.parentNode;
			}
			n = n.nextSibling;

			// SSS FIXME: Deal with comment nodes properly.
			while (n.nodeType === Node.COMMENT_NODE) {
				n = n.nextSibling;
			}

			var t1 = n.getAttribute("typeof"),
				t2 = startElem.getAttribute("typeof");
			n.setAttribute("typeof", t1 ? t1 + " " + t2 : t2);
			n.setAttribute("data-parsoid", startElem.getAttribute("data-parsoid"));

			startElem.parentNode.removeChild(startElem);
		}

		endElem.parentNode.removeChild(endElem);
	}
};

var findTableSibling = function ( elem, about ) {
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
};

/**
 * Recursive worker
 */
var doEncapsulateTemplateOutput = function ( root, tpls, doc ) {
	var elem = root.firstChild;
	while (elem) {
		// get the next sibling before doing anything since
		// we may delete elem as part of encapsulation
		var nextSibling = elem.nextSibling;

		if ( elem.nodeType === Node.ELEMENT_NODE ) {
			var type = elem.getAttribute( 'typeof' ),
				match = type ? type.match( /(?:^|\s)(mw:Object(?:\/[^\s]+)?)/ ) : null;
			if ( match ) {
				var tm = match[1],
					about = elem.getAttribute('about'),
					aboutRef = tpls[about];
				//console.log( tm );
				if ( tm === 'mw:Object/Template' ) {
					if ( aboutRef ) {
						aboutRef.start = elem;
						// content or end marker existed already
						if ( aboutRef.end ) {
							// End marker was foster-parented. Found actual
							// start tag.
							console.warn( 'end marker was foster-parented' );
							encapsulateTrees( elem, aboutRef.end, doc );
						} else {
							// should not happen!
							console.warn( 'start found after content' );
						}
					} else {
						tpls[about] = { start: elem };
					}
				} else if ( tm === 'mw:Object/Template/End' ) {
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
							encapsulateTrees( aboutRef.start, tableNode, doc );
						} else {
							console.warn( 'found foster-parented end marker followed ' +
									'by table, but no start marker!');
						}
					} else if ( aboutRef ) {
						// no foster-parenting involved, plain start/end pair.
						// Walk up the DOM to find common parent with start tag.
						aboutRef.end = elem;

						encapsulateTrees( aboutRef.start, aboutRef.end, doc );
					} else {
						tpls[about] = { end: elem };
					}
				} else {
					// recurse down the tree
					doEncapsulateTemplateOutput( elem, tpls, doc );
				}
			} else {
				// recurse down the tree
				doEncapsulateTemplateOutput( elem, tpls, doc );
			}
		}

		elem = nextSibling;
	}
};

/**
 * Encapsulate template-affected DOM structures by wrapping text nodes into
 * spans and adding RDFa attributes to all subtree roots according to
 * http://www.mediawiki.org/wiki/Parsoid/RDFa_vocabulary#Template_content
 */
var encapsulateTemplateOutput = function ( document ) {
	// walk through document and look for tags with typeof="mw:Object*"
	var tpls = {};
	doEncapsulateTemplateOutput( document.body, tpls, document );
};


function DOMPostProcessor () {
	this.processors = [
		process_inlines_in_p,
		remove_trailing_newlines_from_paragraphs,
		normalize_document,
		encapsulateTemplateOutput
	];
}

// Inherit from EventEmitter
DOMPostProcessor.prototype = new events.EventEmitter();
DOMPostProcessor.prototype.constructor = DOMPostProcessor;

DOMPostProcessor.prototype.doPostProcess = function ( document ) {
	for(var i = 0; i < this.processors.length; i++) {
		try {
			this.processors[i](document);
		} catch ( e ) {
			console.log(e.stack);
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
