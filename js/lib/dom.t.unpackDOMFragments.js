"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

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

/**
 * DOMTraverser handler that unpacks DOM fragments which were injected in the
 * token pipeline.
 */
function unpackDOMFragments(env, node) {
	if (DU.isElt(node)) {
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
			if (sibling && DU.isElt(sibling) &&
					sibling.getAttribute('about') === node.getAttribute('about'))
			{
				// remove optional second element added by wrapper tokens
				lastNode = sibling;
				DU.deleteNode(sibling);
			}


			// Transfer the new dsr -- just dsr[0] and dsr[1] since tag-widths
			// will be incorrect for reuse of template expansions
			var firstChild = dummyNode.firstChild;
			DU.loadDataParsoid(firstChild);
			if (!firstChild.data.parsoid) {
				console.log(node.data.parsoid, dummyNode.outerHTML);
			}

			var dsr = node.data.parsoid.dsr;
			// There is currently no DSR for DOMFragments nested inside
			// transclusion / extension content (extension inside template
			// content etc).
			// TODO: Make sure that is the only reason for not having a DSR
			// here.
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
			}
			//else {
			//	console.error( 'ERROR in ' + env.page.name +
			//			': no DOMFragment wrapper dsr on ' + node.outerHTML );
			//}

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
			DU.deleteNode(node);
			return nextNode;
		}
	}
	return true;
}

if (typeof module === "object") {
	module.exports.unpackDOMFragments = unpackDOMFragments;
}
