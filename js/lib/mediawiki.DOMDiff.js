var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	NODE = require('./mediawiki.wikitext.constants.js').Node,
	Util = require('./mediawiki.Util.js').Util;

/**
 * A DOM diff helper class
 *
 * Compares two DOMs and annotates a copy of the passed-in DOM with change
 * information for the selective serializer.
 */
function DOMDiff ( env ) {
	this.env = env;
	this.debug = env.conf.parsoid.debug ||
		(env.conf.parsoid.traceFlags && env.conf.parsoid.traceFlags.indexOf('selser') !== -1) ?
						console.error : function(){};
	this.currentId = 0;
	this.startPos = 0; // start offset of the current unmodified chunk
	this.curPos = 0; // end offset of the last processed node
}

var DDP = DOMDiff.prototype;

/**
 * Diff two HTML documents, and add / update data-parsoid-diff attributes with
 * change information.
 */
DDP.diff = function ( node ) {
	// work on a cloned copy of the passed-in node
	var workNode = node.cloneNode(true);

	// First do a quick check on the nodes themselves
	if (!this.treeEquals(this.env.page.dom, workNode, false)) {
		this.markNode(workNode, 'modified');
		return { isEmpty: false, dom: workNode };
	}


	// The root nodes are equal, call recursive differ
	var foundChange = this.doDOMDiff(this.env.page.dom, workNode);
	this.debug('ORIG:\n', this.env.page.dom.outerHTML, '\nNEW :\n', workNode.outerHTML );
	return { isEmpty: ! foundChange, dom: workNode };
};

// These attributes are ignored for equality purposes if they are added to a
// node.
var ignoreAttributes = {
	//Do our own full diff for now, so ignore data-ve-changed info.
	'data-ve-changed': 1,
	'data-parsoid': 1,
	'about': 1
};

function countIgnoredAttributes (attributes) {
	var n = 0;
	for (var name in ignoreAttributes) {
		if (attributes[name]) {
			n++;
		}
	}
	return n;
}


/**
 * Order-sensitive (for now) attribute equality test
 */
DDP.attribsEquals = function(nodeA, nodeB) {
	// First compare the number of attributes
	if ( nodeA.attributes.length !== nodeB.attributes.length &&
			(nodeA.attributes.length - countIgnoredAttributes(nodeA.attributes) !==
			 nodeB.attributes.length - countIgnoredAttributes(nodeB.attributes)) )
	{
		return false;
	}
	// same number of attributes, also check their values
	var skippedA = 0,
		skippedB = 0;
	for (var i = 0, la = nodeA.attributes.length, lb = nodeB.attributes.length;
			i + skippedA < la && i + skippedB < lb; i++)
	{
		if ( ignoreAttributes[nodeA.attributes[i + skippedA].name] ) {
			skippedA++;
			continue;
		}
		if ( ignoreAttributes[nodeB.attributes[i + skippedB].name] ) {
			skippedB++;
			continue;
		}
		if (nodeA.attributes[i + skippedA].name !== nodeB.attributes[i + skippedB].name ||
				nodeA.attributes[i + skippedA].value !== nodeB.attributes[i + skippedB].value)
		{
			return false;
		}
	}
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
		return nodeA.nodeValue === nodeB.nodeValue;
	} else if (nodeA.nodeType === nodeA.ELEMENT_NODE) {
		// Compare node name and attribute length
		if (nodeA.nodeName !== nodeB.nodeName || !this.attribsEquals(nodeA, nodeB)) {
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
	// Perform a relaxed version of the recursive treeEquals algorithm that
	// allows for some minor differences and tries to produce a sensible diff
	// marking using heuristics like look-ahead on siblings.
	var baseNode = baseParentNode.firstChild,
		newNode = newParentNode.firstChild,
		lookaheadNode = null,
		foundDiff = false,
		foundDiffOverall = false;
	while ( baseNode && newNode ) {
		// Reset per-iteration diff flag
		foundDiff = false;
		// Quick shallow equality check first
		if ( ! this.treeEquals(baseNode, newNode, false) ) {
			// Check if one of them is IEW (inter-element whitespace),
			// and try to skip over it if it is
			//if ( DU.isIEW(baseNode) ) {
			//	baseNode = baseNode.nextSibling;
			//	continue;
			//} else if ( DU.isIEW(newNode) ) {
			//	newNode = newNode.nextSibling;
			//	continue;
			//}

			// Some simplistic look-ahead, currently limited to a single level
			// in the DOM.

			// look-ahead in *new* DOM to detect insertions
			lookaheadNode = newNode.nextSibling;
			while (lookaheadNode) {
				if (this.treeEquals(baseNode, lookaheadNode, true) &&
						!DU.isIEW(lookaheadNode))
				{
					// mark skipped-over nodes as inserted
					var markNode = newNode;
					// XXX: Somehow markNode would be null here sometimes,
					// although I see no reason why that would be so
					while(markNode && markNode !== lookaheadNode) {
						this.markNode(markNode, 'inserted');
						markNode = markNode.nextSibling;
					}
					foundDiff = true;
					newNode = lookaheadNode;
					break;
				}
				lookaheadNode = lookaheadNode.nextSibling;
			}

			// look-ahead in *base* DOM to detect deletions
			if (!foundDiff) {
				lookaheadNode = baseNode.nextSibling;
				while (lookaheadNode) {
					if (this.treeEquals(newNode, lookaheadNode, true)
							//&& !DU.isIEW(lookaheadNode)
						)
					{
						// TODO: treat skipped-over nodes as deleted
						// insertModificationMarker
						//console.log('inserting deletion mark before ' + newNode.outerHTML);
						this.markNode(newNode, 'deleted-before');
						foundDiff = true;
						baseNode = lookaheadNode;
						break;
					}
					lookaheadNode = lookaheadNode.nextSibling;
				}
			}

			// nothing found, mark new node as modified / differing
			if (!foundDiff) {
				this.markNode(newNode, 'modified');
			}
			foundDiffOverall = true;
		} else if(!DU.isTplElementNode(this.env, newNode)) {
			// Recursively diff subtrees if not template-like content
			foundDiffOverall = this.doDOMDiff(baseNode, newNode) || foundDiffOverall;
		}

		// And move on to the next pair
		baseNode = baseNode.nextSibling;
		newNode = newNode.nextSibling;
	}

	// mark extra new nodes as modified
	while (newNode) {
		this.markNode(newNode, 'modified');
		foundDiffOverall = true;
		newNode = newNode.nextSibling;
	}

	// If there are extra base nodes, something was deleted. Mark the parent as
	// having lost children for now.
	if (baseNode) {
		this.markNode(newParentNode, 'deleted-child');
		foundDiffOverall = true;
	}

	return foundDiffOverall;
};




/******************************************************
 * Helpers
 *****************************************************/

DDP.markNode = function(node, change) {
	if (node.nodeType === node.ELEMENT_NODE) {
		DU.setDiffMark(node, this.env, change);
	} else if (node.nodeType === node.TEXT_NODE || node.nodeType === node.COMMENT_NODE) {
		var markNode;
		if ( change === 'deleted-before' ) {
			// insert a meta tag
			markNode = DU.prependTypedMeta(node, 'mw:DiffMarker');
		} else {
			// wrap node in span
			markNode = DU.wrapTextInTypedSpan(node, 'mw:DiffMarker');
		}
		DU.setDiffMark(markNode, this.env, change);
	} else {
		console.error('ERROR: Unhandled node type ' + node.nodeType + ' in markNode!');
		console.trace();
	}
};


if (typeof module === "object") {
	module.exports.DOMDiff = DOMDiff;
}
