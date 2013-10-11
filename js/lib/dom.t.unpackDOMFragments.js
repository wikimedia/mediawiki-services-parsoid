"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Util = require('./mediawiki.Util.js').Util,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	computeNodeDSR = require('./dom.computeDSR.js').computeNodeDSR,
	wrapTemplatesInTree = require('./dom.wrapTemplates.js').wrapTemplatesInTree;

function hasBadNesting(targetNode, fragmentNode) {
	// SSS FIXME: This is not entirely correct. This is only
	// looking for nesting of identical tags. But, HTML tree building
	// has lot more restrictions on nesting. It seems the simplest way
	// to get all the rules right is to (serialize + reparse).
	function isNestableElement(nodeName) {
		return nodeName === 'SPAN' ||
			nodeName === 'DIV' ||
			Consts.HTML.FormattingTags.has(nodeName);
	}

	return isNestableElement(targetNode.nodeName) &&
		DU.treeHasElement(fragmentNode, targetNode.nodeName);
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

function fixAbouts(env, node, aboutIdMap) {
	var c = node.firstChild;
	while (c) {
		if (DU.isElt(c)) {
			var cAbout = c.getAttribute("about");
			if (cAbout) {
				// Update about
				var newAbout = aboutIdMap.get(cAbout);
				if (!newAbout) {
					newAbout = env.newAboutId();
					aboutIdMap.set(cAbout, newAbout);
				}
				c.setAttribute("about", newAbout);
			}

			fixAbouts(env, c, aboutIdMap);
		}

		c = c.nextSibling;
	}
}

/**
* DOMTraverser handler that unpacks DOM fragments which were injected in the
* token pipeline.
*/
function unpackDOMFragments(env, node) {
	if (DU.isElt(node)) {
		var typeOf = node.getAttribute('typeof'),
			about = node.getAttribute('about'),
			lastNode = node;
		if (/(?:^|\s)mw:DOMFragment(?=$|\s)/.test(typeOf)) {
			// Replace this node and possibly a sibling with node.dp.html
			var fragmentParent = node.parentNode,
				dummyNode = node.ownerDocument.createElement(fragmentParent.nodeName);

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

			var html = node.data.parsoid.html;
			if (!html || /(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
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
			if (about !== null && sibling && DU.isElt(sibling) &&
					sibling.getAttribute('about') === about)
			{
				// remove optional second element added by wrapper tokens
				lastNode = sibling;
				DU.deleteNode(sibling);
			}

			var contentNode = dummyNode.firstChild;

			// Update DSR
			//
			// There is currently no DSR for DOMFragments nested inside
			// transclusion / extension content (extension inside template
			// content etc).
			// TODO: Make sure that is the only reason for not having a DSR here.
			var dsr = node.data.parsoid.dsr;
			if (dsr) {
				// Load data-parsoid attr so we can use firstChild.data.parsoid
				DU.loadDataParsoid(contentNode);
				if (!contentNode.data.parsoid) {
					console.log(node.data.parsoid, dummyNode.outerHTML);
				}

				var type = contentNode.getAttribute("typeof");
				if (/(?:^|\s)mw:(Transclusion|Extension)(?=$|\s)/.test(type)) {
					contentNode.data.parsoid.dsr = [dsr[0], dsr[1]];
				} else { // non-transcluded images
					contentNode.data.parsoid.dsr = [dsr[0], dsr[1], 2, 2];
					// Reused image -- update dsr by tsrDelta on all
					// descendents of 'firstChild' which is the <figure> tag
					var tsrDelta = node.data.parsoid.tsrDelta;
					if (tsrDelta) {
						addDeltaToDSR(contentNode, tsrDelta);
					}
				}

			}

			var n;
			if (node.data.parsoid.tmp.isForeignContent) {
				// Foreign Content = Transclusion and Extension content
				//
				// Set about-id always to ensure the unwrapped node
				// is recognized as encapsulated content as well.
				n = dummyNode.firstChild;
				while (n) {
					if (DU.isElt(n)) {
						n.setAttribute("about", about);
					}
					n = n.nextSibling;
				}
			} else {
				// Replace old about-id with new about-id that is
				// unique to the global page environment object.
				//
				// <figure>s are reused from cache. Note that figure captions
				// can contain multiple independent transclusions. Each one
				// of those individual transclusions should get a new unique
				// about id. Hence a need for an aboutIdMap and the need to
				// walk the entire tree.

				fixAbouts(env, dummyNode, new Map());

				// Discard unnecessary span wrappers
				n = dummyNode.firstChild;
				while (n) {
					var next = n.nextSibling;

					// Preserve wrappers that have an about id
					if (DU.isElt(n) && !n.getAttribute(about)) {
						DU.loadDataParsoid(n);
						if (n.data.parsoid.tmp.wrapper) {
							DU.migrateChildren(n, n.parentNode, n);
							DU.deleteNode(n);
						}
					}

					n = next;
				}
			}

			var nextNode = node.nextSibling;
			if (hasBadNesting(fragmentParent, dummyNode)) {
				/*------------------------------------------------------------------------
				 * Say fragmentParent has child nodes  c1, c2, N, c3, etc.
				 *
				 * doc1: ... fragmentParent -> [c1, c2, N=mw:DOMFragment, c3, ...] ...
				 *
				 * If fragmentParent is an A-tag and N:domfragment has an A-tag, we have a problem.
				 *
				 * 1. Transform: [fragmentParent: [c1, c2, "#unique-hash-code", c3, ..]]
				 * 2. str = fragmentParent.outerHTML.replace(#unique-hash-code, N.domFragment.html)
				 * 3. ParseHTML(str) to get
				 *    doc2: [BODY: [fragmentParent: [c1, c2, ...], A-nested, c3, ...]]
				 * 4. Replace doc1:fragmentParent with doc2:body.childNodes
				 * ----------------------------------------------------------------------- */
				var timestamp = (new Date()).toString();
				fragmentParent.replaceChild(node.ownerDocument.createTextNode(timestamp), node);

				var newDoc = DU.parseHTML(fragmentParent.outerHTML.replace(timestamp, dummyNode.innerHTML));
				DU.migrateChildrenBetweenDocs(newDoc.body, fragmentParent.parentNode, fragmentParent);

				// fragmentParent itself is useless now
				DU.deleteNode(fragmentParent);
			} else {
				// Move the content nodes over and delete the placeholder node
				DU.migrateChildren(dummyNode, fragmentParent, node);
				DU.deleteNode(node);
			}

			return nextNode;
		}
	}
	return true;
}

if (typeof module === "object") {
	module.exports.unpackDOMFragments = unpackDOMFragments;
}
