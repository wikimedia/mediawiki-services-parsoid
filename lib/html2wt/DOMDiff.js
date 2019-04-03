/** @module */

'use strict';

require('../../core-upgrade.js');

const { ContentUtils } = require('../utils/ContentUtils.js');
const { DiffUtils } = require('./DiffUtils.js');
const { DOMDataUtils } = require('../utils/DOMDataUtils.js');
const { DOMUtils } = require('../utils/DOMUtils.js');
const { JSUtils } = require('../utils/jsutils.js');
const { WTUtils } = require('../utils/WTUtils.js');

// These attributes are ignored for equality purposes if they are added to a node.
const ignoreAttributes = new Set([
	// SSS: Don't ignore data-parsoid because in VE, sometimes wrappers get
	// moved around without their content which occasionally leads to incorrect
	// DSR being used by selser.  Hard to describe a reduced test case here.
	// Discovered via: /mnt/bugs/2013-05-01T09:43:14.960Z-Reverse_innovation
	// 'data-parsoid',
	'data-parsoid-diff',
	'about',
	DOMDataUtils.DataObjectAttrName(),
]);

function nextNonTemplateSibling(node) {
	return WTUtils.isEncapsulationWrapper(node) ? WTUtils.skipOverEncapsulatedContent(node) : node.nextSibling;
}

/**
 * A DOM diff helper class.
 *
 * Compares two DOMs and annotates a copy of the passed-in DOM with change
 * information for the selective serializer.
 * @class
 * @param {MWParserEnvironment} env
 */
class DOMDiff {
	constructor(env) {
		this.env = env;
		this.debug = (...args) => env.log("trace/domdiff", ...args);
		this.specializedAttribHandlers = JSUtils.mapObject({
			'data-mw': (nodeA, dmwA, nodeB, dmwB) => this.dataMWEquals(nodeA, dmwA, nodeB, dmwB),
			'data-parsoid': function(nodeA, dpA, nodeB, dpB, options) {
				return JSUtils.deepEquals(dpA, dpB);
			},
		});
	}

	/**
	 * Diff two HTML documents, and add / update data-parsoid-diff attributes with
	 * change information.
	 */
	diff(nodeA, nodeB) {
		this.domA = nodeA.ownerDocument;
		this.domB = nodeB.ownerDocument;

		this.debug(function() {
			return 'ORIG:\n' + nodeA.outerHTML + '\nNEW :\n' + nodeB.outerHTML;
		});

		// The root nodes are equal, call recursive differ
		var foundChange = this.doDOMDiff(nodeA, nodeB);
		return { isEmpty: !foundChange };
	}

	/**
	 * Test if two data-mw objects are identical.
	 * - independent of order of attributes in data-mw
	 * - html attributes are parsed to DOM and recursively compared
	 * - for id attributes, the DOM fragments are fetched and compared.
	 */
	dataMWEquals(nodeA, dmwA, nodeB, dmwB) {
		return this._dataMWEquals(nodeA, dmwA, nodeB, dmwB, {
			isTopLevel: true,
			inDmwBody: false,
		});
	}

	/**
	 * According to MediaWiki_DOM_spec, `id` and `html` attributes are acceptable
	 * formats in `data-mw.body` and in those contexts, they reference DOMs and
	 * we are going to treat them as such.
	 * @private
	 */
	_dataMWEquals(nodeA, dmwA, nodeB, dmwB, options) {
		var keysA = Object.keys(dmwA);
		var keysB = Object.keys(dmwB);

		// Some quick checks
		if (keysA.length !== keysB.length) {
			return false;
		} else if (keysA.length === 0) {
			return true;
		}

		// Sort keys so we can traverse array and compare keys
		keysA.sort();
		keysB.sort();
		for (var i = 0; i < keysA.length; i++) {
			var kA = keysA[i];
			var kB = keysB[i];

			if (kA !== kB) {
				return false;
			}

			var vA = dmwA[kA];
			var vB = dmwB[kA];

			// Deal with null, undefined (and 0, '')
			// since they cannot be inspected
			if (!vA || !vB) {
				if (vA !== vB) {
					return false;
				}
			} else if (vA.constructor !== vB.constructor) {
				return false;
			} else if (kA === 'id' && options.inDmwBody) {
				// For <refs> in <references> the element id can refer to the
				// global DOM, not the owner document DOM.
				var htmlA = nodeA.ownerDocument.getElementById(vA)
					|| this.domA.getElementById(vA);
				var htmlB = nodeB.ownerDocument.getElementById(vB)
					|| this.domB.getElementById(vB);

				if (htmlA && htmlB && !this.treeEquals(htmlA, htmlB, true)) {
					return false;
				} else if (!htmlA || !htmlB) {
					var type = nodeA.getAttribute('typeof') || '';
					var match = type.match(/mw:Extension\/(\w+)\b/);
					var extName = match ? match[1] : '---';
					// Log error
					if (!htmlA) {
						this.env.log('error/domdiff/orig/' + extName,
							'extension src id ' + JSON.stringify(vA) +
							" points to non-existent element for:",
							nodeA.outerHTML);
					}
					if (!htmlB) {
						this.env.log('error/domdiff/edited/' + extName,
							'extension src id ' + JSON.stringify(vB) +
							" points to non-existent element for:",
							nodeB.outerHTML);
					}

					// Fall back to default comparisons
					if (vA !== vB) {
						return false;
					}
				}
			} else if (kA === 'html' && options.inDmwBody) {
				// For 'html' attributes, parse string and recursively compare DOM
				if (!this.treeEquals(
						ContentUtils.ppToDOM(this.env, vA, { markNew: true }),
						ContentUtils.ppToDOM(this.env, vB, { markNew: true }),
						true)) {
					return false;
				}
			} else if (vA.constructor === Object || Array.isArray(vA)) {
				// For 'array' and 'object' attributes, recursively apply _dataMWEquals
				var inDmwBody = options.isTopLevel && kA === 'body';
				if (!this._dataMWEquals(nodeA, vA, nodeB, vB, { inDmwBody: inDmwBody })) {
					return false;
				}
			} else if (vA !== vB) {
				return false;
			}

			// Phew! survived this key
		}

		// Phew! survived all checks -- identical objects
		return true;
	}

	/**
	 * Test if two DOM nodes are equal.
	 * @param {Node} nodeA
	 * @param {Node} nodeB
	 * @param {boolean} deep
	 * @return {boolean}
	 */
	treeEquals(nodeA, nodeB, deep) {
		if (nodeA.nodeType !== nodeB.nodeType) {
			return false;
		} else if (DOMUtils.isText(nodeA)) {
			// In the past we've had bugs where we let non-primitive strings
			// leak into our DOM.  Safety first:
			console.assert(nodeA.nodeValue === nodeA.nodeValue.valueOf());
			console.assert(nodeB.nodeValue === nodeB.nodeValue.valueOf());
			// ok, now do the comparison.
			return nodeA.nodeValue === nodeB.nodeValue;
		} else if (DOMUtils.isComment(nodeA)) {
			return WTUtils.decodeComment(nodeA.data) === WTUtils.decodeComment(nodeB.data);
		} else if (DOMUtils.isElt(nodeA)) {
			// Compare node name and attribute length
			if (nodeA.nodeName !== nodeB.nodeName ||
				!DiffUtils.attribsEquals(nodeA, nodeB, ignoreAttributes, this.specializedAttribHandlers)) {
				return false;
			}

			// Passed all tests, element node itself is equal.
			if (deep) {
				var childA, childB;
				// Compare # of children, since that's fast.
				// (Avoid de-optimizing DOM by using node#childNodes)
				for (childA = nodeA.firstChild, childB = nodeB.firstChild;
					childA && childB;
					childA = childA.nextSibling, childB = childB.nextSibling) {
					/* don't look inside children yet, just look at # of children */
				}
				if (childA || childB) {
					return false; /* nodes have different # of children */
				}
				// Now actually compare the child subtrees
				for (childA = nodeA.firstChild, childB = nodeB.firstChild;
					childA && childB;
					childA = childA.nextSibling, childB = childB.nextSibling) {
					if (!this.treeEquals(childA, childB, deep)) {
						return false;
					}
				}
			}

			// Did not find a diff yet, so the trees must be equal.
			return true;
		}
	}

	/**
	 * Diff two DOM trees by comparing them node-by-node.
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
	doDOMDiff(baseParentNode, newParentNode) {
		var dd = this;

		function debugOut(nodeA, nodeB, laPrefix) {
			laPrefix = laPrefix || "";
			dd.env.log("trace/domdiff", function() {
				return "--> A" + laPrefix + ":" + (DOMUtils.isElt(nodeA) ? nodeA.outerHTML : JSON.stringify(nodeA.nodeValue));
			});
			dd.env.log("trace/domdiff", function() {
				return "--> B" + laPrefix + ":" + (DOMUtils.isElt(nodeB) ? nodeB.outerHTML : JSON.stringify(nodeB.nodeValue));
			});
		}

		// Perform a relaxed version of the recursive treeEquals algorithm that
		// allows for some minor differences and tries to produce a sensible diff
		// marking using heuristics like look-ahead on siblings.
		var baseNode = baseParentNode.firstChild;
		var newNode = newParentNode.firstChild;
		var lookaheadNode = null;
		var subtreeDiffers;
		var foundDiffOverall = false;
		var dontAdvanceNewNode = false;

		while (baseNode && newNode) {
			dontAdvanceNewNode = false;
			debugOut(baseNode, newNode);
			// shallow check first
			if (!this.treeEquals(baseNode, newNode, false)) {
				this.debug("-- not equal --");
				var savedNewNode = newNode;
				var foundDiff = false;

				// Some simplistic look-ahead, currently limited to a single level
				// in the DOM.

				// look-ahead in *new* DOM to detect insertions
				if (DOMUtils.isContentNode(baseNode)) {
					this.debug("--lookahead in new dom--");
					lookaheadNode = newNode.nextSibling;
					while (lookaheadNode) {
						debugOut(baseNode, lookaheadNode, "new");
						if (DOMUtils.isContentNode(lookaheadNode) &&
							this.treeEquals(baseNode, lookaheadNode, true)) {
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
						lookaheadNode = nextNonTemplateSibling(lookaheadNode);
					}
				}

				// look-ahead in *base* DOM to detect deletions
				if (!foundDiff && DOMUtils.isContentNode(newNode)) {
					var isBlockNode = WTUtils.isBlockNodeWithVisibleWT(baseNode);
					this.debug("--lookahead in old dom--");
					lookaheadNode = baseNode.nextSibling;
					while (lookaheadNode) {
						debugOut(lookaheadNode, newNode, "old");
						if (DOMUtils.isContentNode(lookaheadNode) &&
							this.treeEquals(lookaheadNode, newNode, true)) {
							this.debug("--found diff: deleted--");
							// mark skipped-over nodes as deleted
							this.markNode(newNode, 'deleted', isBlockNode);
							baseNode = lookaheadNode;
							foundDiff = true;
							break;
						} else if (!WTUtils.emitsSolTransparentSingleLineWT(lookaheadNode)) {
							// We only care about the deleted node prior to the one that
							// gets a tree match (but, ignore nodes that show up in wikitext
							// but don't affect sol-state or HTML rendering -- note that
							// whitespace is being ignored, but that whitespace occurs
							// between block nodes).
							isBlockNode = WTUtils.isBlockNodeWithVisibleWT(lookaheadNode);
						}
						lookaheadNode = nextNonTemplateSibling(lookaheadNode);
					}
				}

				if (!foundDiff) {
					if (!DOMUtils.isElt(savedNewNode)) {
						this.debug("--found diff: modified text/comment--");
						this.markNode(savedNewNode, 'deleted', WTUtils.isBlockNodeWithVisibleWT(baseNode));
					} else if (savedNewNode.nodeName === baseNode.nodeName &&
						DOMDataUtils.getDataParsoid(savedNewNode).stx === DOMDataUtils.getDataParsoid(baseNode).stx) {
						// Identical wrapper-type, but modified.
						// Mark modified-wrapper, and recurse.
						this.debug("--found diff: modified-wrapper--");
						this.markNode(savedNewNode, 'modified-wrapper');
						if (!WTUtils.isEncapsulationWrapper(baseNode) &&
							!WTUtils.isEncapsulationWrapper(savedNewNode)) {
							// Dont recurse into template-like-content
							subtreeDiffers = this.doDOMDiff(baseNode, savedNewNode);
							if (subtreeDiffers) {
								this.debug("--found diff: subtree-changed--");
								this.markNode(newNode, 'subtree-changed');
							}
						}
					} else {
						// We now want to compare current newNode with the next baseNode.
						dontAdvanceNewNode = true;

						// Since we are advancing in an old DOM without advancing
						// in the new DOM, there were deletions. Add a deletion marker
						// since this is important for accurate separator handling in selser.
						this.markNode(savedNewNode, 'deleted', WTUtils.isBlockNodeWithVisibleWT(baseNode));
					}
				}

				// Record the fact that direct children changed in the parent node
				this.debug("--found diff: children-changed--");
				this.markNode(newParentNode, 'children-changed');

				foundDiffOverall = true;
			} else if (!WTUtils.isEncapsulationWrapper(baseNode) && !WTUtils.isEncapsulationWrapper(newNode)) {
				this.debug("--shallow equal: recursing--");
				// Recursively diff subtrees if not template-like content
				subtreeDiffers = this.doDOMDiff(baseNode, newNode);
				if (subtreeDiffers) {
					this.debug("--found diff: subtree-changed--");
					this.markNode(newNode, 'subtree-changed');
				}
				foundDiffOverall = subtreeDiffers || foundDiffOverall;
			}

			// And move on to the next pair (skipping over template HTML)
			if (baseNode && newNode) {
				baseNode = nextNonTemplateSibling(baseNode);
				if (!dontAdvanceNewNode) {
					newNode = nextNonTemplateSibling(newNode);
				}
			}
		}

		// mark extra new nodes as inserted
		while (newNode) {
			this.debug("--found trailing new node: inserted--");
			this.markNode(newNode, 'inserted');
			foundDiffOverall = true;
			newNode = nextNonTemplateSibling(newNode);
		}

		// If there are extra base nodes, something was deleted. Mark the parent as
		// having lost children for now.
		if (baseNode) {
			this.debug("--found trailing base nodes: deleted--");
			this.markNode(newParentNode, 'children-changed');
			// SSS FIXME: WTS checks for zero children in a few places
			// That code would have to be upgraded if we emit mw:DiffMarker
			// in this scenario. So, bailing out in this one case for now.
			if (newParentNode.hasChildNodes()) {
				var meta = newParentNode.ownerDocument.createElement('meta');
				meta.setAttribute('typeof', 'mw:DiffMarker/deleted');
				if (WTUtils.isBlockNodeWithVisibleWT(baseNode)) {
					meta.setAttribute('data-is-block', 'true');
				}
				newParentNode.appendChild(meta);
			}
			foundDiffOverall = true;
		}

		return foundDiffOverall;
	}

	/* ***************************************************
	 * Helpers
	 * ***************************************************/

	/** @private */
	markNode(node, mark, blockNodeDeleted) {
		var meta;
		if (mark === 'deleted') {
			// insert a meta tag marking the place where content used to be
			meta = DiffUtils.prependTypedMeta(node, 'mw:DiffMarker/' + mark);
		} else {
			if (DOMUtils.isElt(node)) {
				DiffUtils.setDiffMark(node, this.env, mark);
			} else if (DOMUtils.isText(node) || DOMUtils.isComment(node)) {
				if (mark !== 'inserted') {
					this.env.log("error/domdiff",
						"BUG! CHANGE-marker for " + node.nodeType + " node is: " + mark);
				}
				meta = DiffUtils.prependTypedMeta(node, 'mw:DiffMarker/' + mark);
			} else if (node.nodeType !== node.DOCUMENT_NODE &&
					node.nodeType !== node.DOCUMENT_TYPE_NODE) {
				this.env.log("error/domdiff", "Unhandled node type", node.nodeType, "in markNode!");
			}
		}

		if (meta && blockNodeDeleted) {
			meta.setAttribute('data-is-block', 'true');
		}

		if (mark === 'deleted' || mark === 'inserted') {
			this.markNode(node.parentNode, 'children-changed');
		}
	}
}

if (typeof module === "object") {
	module.exports.DOMDiff = DOMDiff;
}
