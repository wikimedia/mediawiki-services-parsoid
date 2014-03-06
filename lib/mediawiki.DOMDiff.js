"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	JSUtils = require('./jsutils.js').JSUtils;

/**
 * A DOM diff helper class
 *
 * Compares two DOMs and annotates a copy of the passed-in DOM with change
 * information for the selective serializer.
 */
function DOMDiff ( env ) {
	this.env = env;
	this.debugging = env.conf.parsoid.debug ||
		(env.conf.parsoid.traceFlags && env.conf.parsoid.traceFlags.indexOf('selser') !== -1);
	this.debug = this.debugging ? console.log : function(){};

	this.specializedAttribHandlers = JSUtils.mapObject({
		'data-mw': this.dataMWEquals.bind(this)
	});
}

var DDP = DOMDiff.prototype;

/**
 * Diff two HTML documents, and add / update data-parsoid-diff attributes with
 * change information.
 */
DDP.diff = function ( node ) {
	// work on a cloned copy of the passed-in node
	var workNode = node.cloneNode(true);

	// SSS FIXME: Is this required?
	//
	// First do a quick check on the top-level nodes themselves
	// FIXME gwicke: Disabled for now as the VE seems to drop data-parsoid on
	// the body and the serializer does not respect a 'modified' flag on the
	// body. This also assumes that we always diff on the body element.
	//if (!this.treeEquals(this.env.page.dom, workNode, false)) {
	//	this.markNode(workNode, 'modified');
	//	return { isEmpty: false, dom: workNode };
	//}

	// The root nodes are equal, call recursive differ
	var foundChange = this.doDOMDiff(this.env.page.dom, workNode);
	this.debug('ORIG:\n', this.env.page.dom.outerHTML, '\nNEW :\n', workNode.outerHTML );
	return { isEmpty: ! foundChange, dom: workNode };
};

// These attributes are ignored for equality purposes if they are added to a
// node.
var ignoreAttributes = JSUtils.arrayToSet([
	// Do our own full diff for now, so ignore data-ve-changed info.
	'data-ve-changed',
	// SSS: Don't ignore data-parsoid because in VE, sometimes wrappers get
	// moved around without their content which occasionally leads to incorrect
	// DSR being used by selser.  Hard to describe a reduced test case here.
	// Discovered via: /mnt/bugs/2013-05-01T09:43:14.960Z-Reverse_innovation
	// 'data-parsoid': 1,
	'data-parsoid-diff',
	'about'
]);

/**
 * Test if two data-mw objects are identical
 * - independent of order of attributes in data-mw
 * - html attributes are parsed to DOM and recursively compared
 */
DDP.dataMWEquals = function(dmw1, dmw2) {
	var keys1 = Object.keys(dmw1),
		keys2 = Object.keys(dmw2);

	// Some quick checks
	if (keys1.length !== keys2.length) {
		return false;
	} else if (keys1.length === 0) {
		return true;
	}

	// Sort keys so we can traverse array and compare keys
	keys1.sort();
	keys2.sort();
	for (var i = 0; i < keys1.length; i++) {
		var k1 = keys1[i],
			k2 = keys2[i];

		if (k1 !== k2) {
			return false;
		}

		var v1 = dmw1[k1],
			v2 = dmw2[k1];

		// Deal with null, undefined (and 0, '')
		// since they cannot be inspected
		if (!v1 || !v2) {
			if (v1 !== v2) {
				return false;
			}
		} else if (v1.constructor !== v2.constructor) {
			return false;
		} else if (k1 === 'html') {
			// For 'html' attributes, parse string and recursively compare DOM
			if (v1 !== v2 && !this.treeEquals(DU.parseHTML(v1).body, DU.parseHTML(v2).body, true)) {
				return false;
			}
		} else if ( v1.constructor === Object || Array.isArray(v1) ) {
			// For 'array' and 'object' attributes, recursively apply dataMWEquals
			if (!this.dataMWEquals(v1, v2)) {
				return false;
			}
		} else if (v1 !== v2) {
			return false;
		}

		// Phew! survived this key
	}

	// Phew! survived all checks -- identical objects
	return true;
};

/**
 * Test if two DOM nodes are equal without testing subtrees
 */
DDP.treeEquals = function (nodeA, nodeB, deep) {
	if ( nodeA.nodeType !== nodeB.nodeType ) {
		return false;
	} else if (nodeA.nodeType === nodeA.TEXT_NODE ||
			nodeA.nodeType === nodeA.COMMENT_NODE)
	{
		// In the past we've had bugs where we let non-primitive strings
		// leak into our DOM.  Safety first:
		console.assert(nodeA.nodeValue === nodeA.nodeValue.valueOf());
		console.assert(nodeB.nodeValue === nodeB.nodeValue.valueOf());
		// ok, now do the comparison.
		return nodeA.nodeValue === nodeB.nodeValue;
	} else if (nodeA.nodeType === nodeA.ELEMENT_NODE) {
		// Compare node name and attribute length
		if (nodeA.nodeName !== nodeB.nodeName ||
			!DU.attribsEquals(nodeA, nodeB, ignoreAttributes, this.specializedAttribHandlers))
		{
			return false;
		}

		// Passed all tests, element node itself is equal.
		if ( deep ) {
			// Compare children too
			if (nodeA.childNodes.length !== nodeB.childNodes.length) {
				return false;
			}
			var childA = nodeA.firstChild,
				childB = nodeB.firstChild;
			while(childA) {
				if (!this.treeEquals(childA, childB, deep)) {
					return false;
				}
				childA = childA.nextSibling;
				childB = childB.nextSibling;
			}
		}

		// Did not find a diff yet, so the trees must be equal.
		return true;
	}
};

function nextNonTemplateSibling(env, node) {
	return DU.isTplElementNode(env, node) ? DU.skipOverEncapsulatedContent(node) : node.nextSibling;
}

/**
 * Diff two DOM trees by comparing them node-by-node
 *
 * TODO: Implement something more intelligent like
 * http://gregory.cobena.free.fr/www/Publications/%5BICDE2002%5D%20XyDiff%20-%20published%20version.pdf,
 * which uses hash signatures of subtrees to efficiently detect moves /
 * wrapping.
 *
 * Adds / updates a data-parsoid-diff structure with change information.
 *
 * Returns true if subtree is changed, false otherwise.
 *
 * TODO:
 * Assume typical CSS white-space, so ignore ws diffs in non-pre content.
 */
DDP.doDOMDiff = function ( baseParentNode, newParentNode ) {
	var dd = this;

	function debugOut(nodeA, nodeB, laPrefix) {
		laPrefix = laPrefix || "";
		if (dd.debugging) {
			dd.debug("--> A" + laPrefix + ":" + (DU.isElt(nodeA) ? nodeA.outerHTML : JSON.stringify(nodeA.nodeValue)));
			dd.debug("--> B" + laPrefix + ":" + (DU.isElt(nodeB) ? nodeB.outerHTML : JSON.stringify(nodeB.nodeValue)));
		}
	}

	// Perform a relaxed version of the recursive treeEquals algorithm that
	// allows for some minor differences and tries to produce a sensible diff
	// marking using heuristics like look-ahead on siblings.
	var baseNode = baseParentNode.firstChild,
		newNode = newParentNode.firstChild,
		lookaheadNode = null,
		foundDiffOverall = false,
		dontAdvanceNewNode = false;

	while ( baseNode && newNode ) {
		dontAdvanceNewNode = false;
		debugOut(baseNode, newNode);
		// shallow check first
		if ( ! this.treeEquals(baseNode, newNode, false) ) {
			this.debug("-- not equal --");
			var origNode = newNode,
				foundDiff = false;

			// Some simplistic look-ahead, currently limited to a single level
			// in the DOM.

			// look-ahead in *new* DOM to detect insertions
			if (DU.isContentNode(baseNode)) {
				this.debug("--lookahead in new dom--");
				lookaheadNode = newNode.nextSibling;
				while (lookaheadNode) {
					debugOut(baseNode, lookaheadNode, "new");
					if (DU.isContentNode(lookaheadNode) &&
						this.treeEquals(baseNode, lookaheadNode, true))
					{
						// mark skipped-over nodes as inserted
						var markNode = newNode;
						while (markNode !== lookaheadNode) {
							this.debug("--found diff: inserted--");
							this.markNode(markNode, 'inserted');
							markNode = markNode.nextSibling;
						}
						foundDiff = true;
						newNode = lookaheadNode;
						break;
					}
					lookaheadNode = nextNonTemplateSibling(this.env, lookaheadNode);
				}
			}

			// look-ahead in *base* DOM to detect deletions
			if (!foundDiff && DU.isContentNode(newNode)) {
				this.debug("--lookahead in old dom--");
				lookaheadNode = baseNode.nextSibling;
				while (lookaheadNode) {
					debugOut(lookaheadNode, newNode, "old");
					if (DU.isContentNode(lookaheadNode) &&
						this.treeEquals(lookaheadNode, newNode, true))
					{
						this.debug("--found diff: deleted--");
						// mark skipped-over nodes as deleted
						this.markNode(newNode, 'deleted');
						baseNode = lookaheadNode;
						foundDiff = true;
						break;
					}
					lookaheadNode = nextNonTemplateSibling(this.env, lookaheadNode);
				}
			}

			if (!foundDiff) {
				if (origNode.nodeName === baseNode.nodeName) {
					// Identical wrapper-type, but modified.
					// Mark as modified, and recurse.
					this.debug("--found diff: modified-wrapper--");
					this.markNode(origNode, 'modified-wrapper');
					if (!DU.isTplElementNode(this.env, baseNode) && !DU.isTplElementNode(this.env, origNode)) {
						// Dont recurse into template-like-content
						this.doDOMDiff(baseNode, origNode);
					}
				} else {
					// Mark the sub-tree as modified since
					// we have two entirely different nodes here
					this.debug("--found diff: modified--");
					this.markNode(origNode, 'modified');

					// If the two subtree are drastically different, clearly,
					// there were deletions in the new subtree before 'origNode'.
					// Add a deletion marker since this is important for accurate
					// separator handling in selser.
					this.markNode(origNode, 'deleted');

					// We now want to compare current newNode with the next baseNode.
					dontAdvanceNewNode = true;
				}
			}

			// Record the fact that direct children changed in the parent node
			this.debug("--found diff: children-changed--");
			this.markNode(newParentNode, 'children-changed');

			foundDiffOverall = true;
		} else if (!DU.isTplElementNode(this.env, baseNode) && !DU.isTplElementNode(this.env, newNode)) {
			this.debug("--shallow equal: recursing--");
			// Recursively diff subtrees if not template-like content
			var subtreeDiffers = this.doDOMDiff(baseNode, newNode);
			if (subtreeDiffers) {
				this.debug("--found diff: subtree-changed--");
				this.markNode(newNode, 'subtree-changed');
			}
			foundDiffOverall = subtreeDiffers || foundDiffOverall;
		}

		// And move on to the next pair (skipping over template HTML)
		if (baseNode && newNode) {
			baseNode = nextNonTemplateSibling(this.env, baseNode);
			if (!dontAdvanceNewNode) {
				newNode = nextNonTemplateSibling(this.env, newNode);
			}
		}
	}

	// mark extra new nodes as modified
	while (newNode) {
		this.debug("--found trailing new node: inserted--");
		this.markNode(newNode, 'inserted');
		foundDiffOverall = true;
		newNode = nextNonTemplateSibling(this.env, newNode);
	}

	// If there are extra base nodes, something was deleted. Mark the parent as
	// having lost children for now.
	if (baseNode) {
		this.debug("--found trailing base nodes: deleted--");
		this.markNode(newParentNode, 'deleted-child');
		// SSS FIXME: WTS checks for zero children in a few places
		// That code would have to be upgraded if we emit mw:DiffMarker
		// in this scenario. So, bailing out in this one case for now.
		if (newParentNode.childNodes.length > 0) {
			var meta = newParentNode.ownerDocument.createElement('meta');
			meta.setAttribute('typeof', 'mw:DiffMarker');
			newParentNode.appendChild(meta);
		}
		foundDiffOverall = true;
	}

	return foundDiffOverall;
};


/******************************************************
 * Helpers
 *****************************************************/

DDP.markNode = function(node, change) {
	if ( change === 'deleted' ) {
		// insert a meta tag marking the place where content used to be
		DU.prependTypedMeta(node, 'mw:DiffMarker');
	} else {
		if (node.nodeType === node.ELEMENT_NODE) {
			DU.setDiffMark(node, this.env, change);
		} else if (node.nodeType !== node.TEXT_NODE && node.nodeType !== node.COMMENT_NODE &&
				node.nodeType !== node.DOCUMENT_NODE && node.nodeType !== node.DOCUMENT_TYPE_NODE) {
			this.env.log("error", "Unhandled node type", node.nodeType, "in markNode!" );
			return;
		}
	}
};

if (typeof module === "object") {
	module.exports.DOMDiff = DOMDiff;
}
