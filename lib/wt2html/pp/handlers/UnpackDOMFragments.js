/** @module */

'use strict';

var ContentUtils = require('../../../utils/ContentUtils.js').ContentUtils;
var DOMDataUtils = require('../../../utils/DOMDataUtils.js').DOMDataUtils;
var DOMUtils = require('../../../utils/DOMUtils.js').DOMUtils;
var Util = require('../../../utils/Util.js').Util;
var PipelineUtils = require('../../../utils/PipelineUtils.js').PipelineUtils;
var DOMTraverser = require('../../../utils/DOMTraverser.js').DOMTraverser;

class UnpackDOMFragments {
	static hasBadNesting(targetNode, fragment) {
		// SSS FIXME: This is not entirely correct. This is only
		// looking for nesting of identical tags. But, HTML tree building
		// has lot more restrictions on nesting. It seems the simplest way
		// to get all the rules right is to (serialize + reparse).

		function isNestableElement(nodeName) {
			// A-tags cannot ever be nested inside each other at any level.
			// This is the one scenario we definitely have to handle right now.
			// We need a generic robust solution for other nesting scenarios.
			return nodeName !== 'A';
		}

		return !isNestableElement(targetNode.nodeName) &&
			DOMUtils.treeHasElement(fragment, targetNode.nodeName);
	}

	static fixUpMisnestedTagDSR(targetNode, fragment, env) {
		// Currently, this only deals with A-tags
		if (targetNode.nodeName !== 'A') {
			return;
		}

		// Walk the fragment till you find an 'A' tag and
		// zero out DSR width for all tags from that point on.
		// This also requires adding span wrappers around
		// bare text from that point on.

		// QUICK FIX: Add wrappers unconditionally and strip unneeded ones
		// Since this scenario should be rare in practice, I am going to
		// go with this simple solution.
		PipelineUtils.addSpanWrappers(fragment.childNodes);

		var resetDSR = false;
		var currOffset = 0;
		var dsrFixer = new DOMTraverser();
		var fixHandler = function(node) {
			if (DOMUtils.isElt(node)) {
				var dp = DOMDataUtils.getDataParsoid(node);
				if (node.nodeName === 'A') {
					resetDSR = true;
				}
				if (resetDSR) {
					if (dp.dsr && dp.dsr[0] !== null && dp.dsr[0] !== undefined) {
						currOffset = dp.dsr[1] = dp.dsr[0];
					} else {
						dp.dsr = [currOffset, currOffset];
					}
					dp.misnested = true;
				} else if (dp.tmp.wrapper) {
					// Unnecessary wrapper added above -- strip it.
					var next = node.firstChild || node.nextSibling;
					DOMUtils.migrateChildren(node, node.parentNode, node);
					node.parentNode.removeChild(node);
					return next;
				}
			}
			return true;
		};
		dsrFixer.addHandler(null, fixHandler);
		dsrFixer.traverse(fragment.firstChild, env);
		fixHandler(fragment);
	}

	static fixAbouts(env, node, aboutIdMap) {
		var c = node.firstChild;
		while (c) {
			if (DOMUtils.isElt(c)) {
				if (c.hasAttribute('about')) {
					var cAbout = c.getAttribute("about");
					// Update about
					var newAbout = aboutIdMap.get(cAbout);
					if (!newAbout) {
						newAbout = env.newAboutId();
						aboutIdMap.set(cAbout, newAbout);
					}
					c.setAttribute("about", newAbout);
				}
				UnpackDOMFragments.fixAbouts(env, c, aboutIdMap);
			}
			c = c.nextSibling;
		}
	}

	static makeChildrenEncapWrappers(node, about) {
		PipelineUtils.addSpanWrappers(node.childNodes);

		var c = node.firstChild;
		while (c) {
			// FIXME: This unconditionally sets about on children
			// This is currently safe since all of them are nested
			// inside a transclusion, but do we need future-proofing?
			c.setAttribute("about", about);
			c = c.nextSibling;
		}
	}

	/**
	 * DOMTraverser handler that unpacks DOM fragments which were injected in the
	 * token pipeline.
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	static unpackDOMFragments(node, env) {
		if (!DOMUtils.isElt(node)) { return true; }

		// sealed fragments shouldn't make it past this point
		if (!DOMUtils.hasTypeOf(node, 'mw:DOMFragment')) { return true; }

		var dp = DOMDataUtils.getDataParsoid(node);

		// Replace this node and possibly a sibling with node.dp.html
		var fragmentParent = node.parentNode;
		var dummyNode = node.ownerDocument.createElement(fragmentParent.nodeName);

		console.assert(/^mwf/.test(dp.html));

		var nodes = env.fragmentMap.get(dp.html);

		if (dp.tmp && dp.tmp.isHtmlExt) {
			// FIXME: This is a silly workaround for foundationwiki which has the
			// "html" extension tag which lets through arbitrary content and
			// often does so in a way that doesn't consider that we'd like to
			// encapsulate it.  For example, it closes the tag in the middle
			// of style tag content to insert a template and then closes the style
			// tag in another "html" extension tag.  The balance proposal isn't
			// its friend.
			//
			// This works because importNode does attribute error checking, whereas
			// parsing does not.  A better fix would be to use one ownerDocument
			// for the entire parse, so no adoption is needed.  See T179082
			var html = nodes.map(n => ContentUtils.toXML(n)).join('');
			ContentUtils.ppToDOM(env, html, { node: dummyNode });
		} else {
			nodes.forEach(function(n) {
				var imp = dummyNode.ownerDocument.importNode(n, true);
				dummyNode.appendChild(imp);
			});
			DOMDataUtils.visitAndLoadDataAttribs(dummyNode);
		}

		let contentNode = dummyNode.firstChild;

		if (DOMUtils.hasTypeOf(node, 'mw:Transclusion')) {
			// Ensure our `firstChild` is an element to add annotation.  At present,
			// we're unlikely to end up with translusion annotations on fragments
			// where span wrapping hasn't occurred (ie. link contents, since that's
			// placed on the anchor itself) but in the future, nowiki spans may be
			// omitted or new uses for dom fragments found.  For now, the test case
			// necessitating this is an edgy link-in-link scenario:
			//   [[Test|{{1x|[[Hmm|Something <sup>strange</sup>]]}}]]
			PipelineUtils.addSpanWrappers(dummyNode.childNodes);
			// Reset `contentNode`, since the `firstChild` may have changed in
			// span wrapping.
			contentNode = dummyNode.firstChild;
			// Transfer typeof, data-mw, and param info
			// about attributes are transferred below.
			DOMDataUtils.setDataMw(contentNode, Util.clone(DOMDataUtils.getDataMw(node)));
			DOMDataUtils.addTypeOf(contentNode, "mw:Transclusion");
			DOMDataUtils.getDataParsoid(contentNode).pi = dp.pi;
		}

		// Update DSR:
		//
		// - Only update DSR for content that came from cache.
		// - For new DOM fragments from this pipeline,
		//   previously-computed DSR is valid.
		// - EXCEPTION: fostered content from tables get their DSR reset
		//   to zero-width.
		// - FIXME: We seem to also be doing this for new extension content,
		//   which is the only place still using `setDSR`.
		//
		// There is currently no DSR for DOMFragments nested inside
		// transclusion / extension content (extension inside template
		// content etc).
		// TODO: Make sure that is the only reason for not having a DSR here.
		var dsr = dp.dsr;
		if (dsr && (dp.tmp.setDSR || dp.tmp.fromCache || dp.fostered)) {
			var cnDP = DOMDataUtils.getDataParsoid(contentNode);
			if (DOMUtils.hasTypeOf(contentNode, 'mw:Transclusion')) {
				// FIXME: An old comment from c28f137 said we just use dsr[0] and
				// dsr[1] since tag-widths will be incorrect for reuse of template
				// expansions.  The comment was removed in ca9e760.
				cnDP.dsr = [dsr[0], dsr[1]];
			} else if (DOMUtils.matchTypeOf(contentNode, /^mw:(Nowiki|Extension(\/[^\s]+))$/) !== null) {
				cnDP.dsr = dsr;
			} else { // non-transcluded images
				cnDP.dsr = [dsr[0], dsr[1], 2, 2];
			}
		}

		if (dp.tmp.fromCache) {
			// Replace old about-id with new about-id that is
			// unique to the global page environment object.
			//
			// <figure>s are reused from cache. Note that figure captions
			// can contain multiple independent transclusions. Each one
			// of those individual transclusions should get a new unique
			// about id. Hence a need for an aboutIdMap and the need to
			// walk the entire tree.
			UnpackDOMFragments.fixAbouts(env, dummyNode, new Map());
		}

		// If the fragment wrapper has an about id, it came from template
		// annotating (the wrapper was an about sibling) and should be transferred
		// to top-level nodes after span wrapping.  This should happen regardless
		// of whether we're coming `fromCache` or not.
		// FIXME: Presumably we have a nesting issue here if this is a cached
		// transclusion.
		const about = node.getAttribute('about');
		if (about !== null) {
			// Span wrapping may not have happened for the transclusion above if
			// the fragment is not the first encapsulation wrapper node.
			PipelineUtils.addSpanWrappers(dummyNode.childNodes);
			let n = dummyNode.firstChild;
			while (n) {
				n.setAttribute("about", about);
				n = n.nextSibling;
			}
		}

		var nextNode = node.nextSibling;

		if (UnpackDOMFragments.hasBadNesting(fragmentParent, dummyNode)) {
			/* -----------------------------------------------------------------------
			 * If fragmentParent is an A element and the fragment contains another
			 * A element, we have an invalid nesting of A elements and needs fixing up
			 *
			 * doc1: ... fragmentParent -> [... dummyNode=mw:DOMFragment, ...] ...
			 *
			 * 1. Change doc1:fragmentParent -> [... "#unique-hash-code", ...] by replacing
			 *    node with the "#unique-hash-code" text string
			 *
			 * 2. str = parentHTML.replace(#unique-hash-code, dummyHTML)
			 *    We now have a HTML string with the bad nesting. We will now use the HTML5
			 *    parser to parse this HTML string and give us the fixed up DOM
			 *
			 * 3. ParseHTML(str) to get
			 *    doc2: [BODY -> [[fragmentParent -> [...], nested-A-tag-from-dummyNode, ...]]]
			 *
			 * 4. Replace doc1:fragmentParent with doc2:body.childNodes
			 * ----------------------------------------------------------------------- */
			var timestamp = (Date.now()).toString();
			fragmentParent.replaceChild(node.ownerDocument.createTextNode(timestamp), node);

			// If fragmentParent has an about, it presumably is nested inside a template
			// Post fixup, its children will surface to the encapsulation wrapper level.
			// So, we have to fix them up so they dont break the encapsulation.
			//
			// Ex: {{echo|[http://foo.com This is [[bad]], very bad]}}
			//
			// In this example, the <a> corresponding to Foo is fragmentParent and has an about.
			// dummyNode is the DOM corresponding to "This is [[bad]], very bad". Post-fixup
			// "[[bad]], very bad" are at encapsulation level and need about ids.
			const about = fragmentParent.getAttribute("about");
			if (about !== null) {
				UnpackDOMFragments.makeChildrenEncapWrappers(dummyNode, about);
			}

			// Set zero-dsr width on all elements that will get split
			// in dummyNode's tree to prevent selser-based corruption
			// on edits to a page that contains badly nested tags.
			UnpackDOMFragments.fixUpMisnestedTagDSR(fragmentParent, dummyNode, env);

			var dummyHTML = ContentUtils.ppToXML(dummyNode, {
				innerXML: true,
				// We just added some span wrappers and we need to keep
				// that tmp info so the unnecessary ones get stripped.
				// Should be fine since tmp was stripped before packing.
				keepTmp: true,
			});
			var parentHTML = ContentUtils.ppToXML(fragmentParent);

			var p = fragmentParent.previousSibling;

			// We rely on HTML5 parser to fixup the bad nesting (see big comment above)
			var newDoc = DOMUtils.parseHTML(parentHTML.replace(timestamp, dummyHTML));
			DOMUtils.migrateChildrenBetweenDocs(newDoc.body, fragmentParent.parentNode, fragmentParent);

			if (!p) {
				p = fragmentParent.parentNode.firstChild;
			} else {
				p = p.nextSibling;
			}

			while (p !== fragmentParent) {
				DOMDataUtils.visitAndLoadDataAttribs(p);
				p = p.nextSibling;
			}

			// Set nextNode to the previous-sibling of former fragmentParent (which will get deleted)
			// This will ensure that all nodes will get handled
			nextNode = fragmentParent.previousSibling;

			// fragmentParent itself is useless now
			fragmentParent.parentNode.removeChild(fragmentParent);
		} else {
			// Move the content nodes over and delete the placeholder node
			DOMUtils.migrateChildren(dummyNode, fragmentParent, node);
			node.parentNode.removeChild(node);
		}

		return nextNode;
	}
}

if (typeof module === "object") {
	module.exports.UnpackDOMFragments = UnpackDOMFragments;
}
