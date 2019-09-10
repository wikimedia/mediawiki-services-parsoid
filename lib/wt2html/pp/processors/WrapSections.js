/** @module */

'use strict';

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { JSUtils } = require('../../../utils/jsutils.js');
const { Util } = require('../../../utils/Util.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

var arrayMap = JSUtils.arrayMap;
var lastItem = JSUtils.lastItem;

class WrapSections {
	createNewSection(state, rootNode, sectionStack, tplInfo, currSection, node, newLevel, pseudoSection) {
		/* Structure for regular (editable or not) sections
		 *   <section data-mw-section-id="..">
		 *     <h*>..</h*>
		 *     ..
		 *   </section>
		 *
		 * Lead sections and pseudo-sections won't have <h*> or <div> tags
		 */
		var section = {
			level: newLevel,
			// useful during debugging, unrelated to the data-mw-section-id
			debug_id: state.count++,
			container: state.doc.createElement('section'),
		};

		/* Step 1. Get section stack to the right nesting level
		 * 1a. Pop stack till we have a higher-level section.
		 */
		var stack = sectionStack;
		while (stack.length > 0 && newLevel <= lastItem(stack).level) {
			stack.pop();
		}

		/* 1b. Push current section onto stack if it is a higher-level section */
		if (currSection && newLevel > currSection.level) {
			stack.push(currSection);
		}

		/* Step 2: Add new section where it belongs: a parent section OR body */
		var parentSection = stack.length > 0 ? lastItem(stack) : null;
		if (parentSection) {
			parentSection.container.appendChild(section.container);
		} else {
			rootNode.insertBefore(section.container, node);
		}

		/* Step 3: Add <h*> to the <section> */
		section.container.appendChild(node);

		/* Step 4: Assign data-mw-section-id attribute
		 *
		 * CX wants <section> tags with a distinguishing attribute so that
		 * it can differentiate between its internal use of <section> tags
		 * with what Parsoid adds. So, we will add a data-mw-section-id
		 * attribute always.
		 *
		 * data-mw-section-id = 0 for the lead section
		 * data-mw-section-id = -1 for non-editable sections
		 *     Note that templated content cannot be edited directly.
		 * data-mw-section-id = -2 for pseudo sections
		 * data-mw-section-id > 0 for everything else and this number
		 *     matches PHP parser / Mediawiki's notion of that section.
		 *
		 * The code here handles uneditable sections because of templating.
		 */
		if (pseudoSection) {
			section.container.setAttribute('data-mw-section-id', -2);
		} else if (state.inTemplate) {
			section.container.setAttribute('data-mw-section-id', -1);
		} else {
			section.container.setAttribute('data-mw-section-id', state.sectionNumber);
		}

		/* Ensure that template continuity is not broken if the section
		 * tags aren't stripped by a client */
		if (tplInfo && node !== tplInfo.first) {
			section.container.setAttribute('about', tplInfo.about);
		}

		return section;
	}

	wrapSectionsInDOM(state, currSection, rootNode) {
		var tplInfo = null;
		var sectionStack = [];
		var highestSectionLevel = 7;
		var node = rootNode.firstChild;
		while (node) {
			var next = node.nextSibling;
			var addedNode = false;

			// Track entry into templated output
			if (!state.inTemplate && WTUtils.isFirstEncapsulationWrapperNode(node)) {
				var about = node.getAttribute("about") || '';
				state.inTemplate = true;
				tplInfo = {
					first: node,
					about: about,
					last: lastItem(WTUtils.getAboutSiblings(node, about)),
				};
			}

			if (/^H[1-6]$/.test(node.nodeName)) {
				var level = Number(node.nodeName[1]);

				// HTML <h*> tags don't get section numbers!
				if (!WTUtils.isLiteralHTMLNode(node)) {
					// This could be just `state.sectionNumber++` without the
					// complicated if-guard if T214538 were fixed in core;
					// see T213468 where this more-complicated behavior was
					// added to match core's eccentricities.
					var dp = DOMDataUtils.getDataParsoid(node);
					if (dp && dp.tmp && dp.tmp.headingIndex) {
						state.sectionNumber = dp.tmp.headingIndex;
					}
					if (level < highestSectionLevel) {
						highestSectionLevel = level;
					}
					currSection = this.createNewSection(state, rootNode, sectionStack, tplInfo, currSection, node, level);
					addedNode = true;
				}
			} else if (DOMUtils.isElt(node)) {
				// If we find a higher level nested section,
				// (a) Make current section non-editable
				// (b) There are 2 options here.
				//     Best illustrated with an example
				//     Consider the wiktiext below.
				//        <div>
				//        =1=
				//        b
				//        </div>
				//        c
				//        =2=
				//     1. Create a new pseudo-section to wrap 'node'
				//        There will be a <section> around the <div> which includes 'c'.
				//     2. Don't create the pseudo-section by setting 'currSection = null'
				//        But, this can leave some content outside any top-level section.
				//        'c' will not be in any section.
				//     The code below implements strategy 1.
				var nestedHighestSectionLevel = this.wrapSectionsInDOM(state, null, node);
				if (currSection && nestedHighestSectionLevel <= currSection.level) {
					currSection.container.setAttribute('data-mw-section-id', -1);
					currSection = this.createNewSection(state, rootNode, sectionStack, tplInfo, currSection, node, nestedHighestSectionLevel, true);
					addedNode = true;
				}
			}

			if (currSection && !addedNode) {
				currSection.container.appendChild(node);
			}

			if (tplInfo && tplInfo.first === node) {
				tplInfo.firstSection = currSection;
			}

			// Track exit from templated output
			if (tplInfo && tplInfo.last === node) {
				// The opening node and closing node of the template
				// are in different sections! This might require resolution.
				if (currSection !== tplInfo.firstSection) {
					tplInfo.lastSection = currSection;
					state.tplsAndExtsToExamine.push(tplInfo);
				}

				tplInfo = null;
				state.inTemplate = false;
			}

			node = next;
		}

		// The last section embedded in a non-body DOM element
		// should always be marked non-editable since it will have
		// the closing tag (ex: </div>) showing up in the source editor
		// which we cannot support in a visual editing environment.
		if (currSection && !DOMUtils.isBody(rootNode)) {
			currSection.container.setAttribute('data-mw-section-id', -1);
		}

		return highestSectionLevel;
	}

	getDSR(tplInfo, node, start) {
		if (node.nodeName !== 'SECTION') {
			var dsr = DOMDataUtils.getDataParsoid(node).dsr || DOMDataUtils.getDataParsoid(tplInfo.first).dsr;
			return start ? dsr[0] : dsr[1];
		}

		var offset = 0;
		var c = start ? node.firstChild : node.lastChild;
		while (c) {
			if (!DOMUtils.isElt(c)) {
				offset += c.textContent.length;
			} else {
				return this.getDSR(tplInfo, c, start) + (start ? -offset : offset);
			}
			c = start ? c.nextSibling : c.previousSibling;
		}

		return -1;
	}

	resolveTplExtSectionConflicts(state) {
		const self = this;
		state.tplsAndExtsToExamine.forEach(function(tplInfo) {
			var s1 = tplInfo.firstSection && tplInfo.firstSection.container; // could be undefined
			var s2 = tplInfo.lastSection.container; // guaranteed to be non-null

			// Find a common ancestor of s1 and s2 (could be s1)
			var s2Ancestors = arrayMap(DOMUtils.pathToRoot(s2));
			var s1Ancestors = [];
			var ancestor;
			var i;
			if (s1) {
				for (ancestor = s1; !s2Ancestors.has(ancestor); ancestor = ancestor.parentNode) {
					s1Ancestors.push(ancestor);
				}
				// ancestor is now the common ancestor of s1 and s2
				s1Ancestors.push(ancestor);
				i = s2Ancestors.get(ancestor);
			}

			var n, tplDsr, dmw;
			if (!s1 || ancestor === s1) {
				// Scenario 1: s1 is s2's ancestor OR s1 doesn't exist.
				// In either case, s2 only covers part of the transcluded content.
				// But, s2 could also include content that follows the transclusion.
				// If so, append the content of the section after the last node
				// to data-mw.parts.
				if (tplInfo.last.nextSibling) {
					var newTplEndOffset = self.getDSR(tplInfo, s2, false); // will succeed because it traverses non-tpl content
					tplDsr = DOMDataUtils.getDataParsoid(tplInfo.first).dsr;
					var tplEndOffset = tplDsr[1];
					dmw = DOMDataUtils.getDataMw(tplInfo.first);
					if (DOMUtils.hasTypeOf(tplInfo.first, 'mw:Transclusion')) {
						if (dmw.parts) { dmw.parts.push(state.getSrc(tplEndOffset, newTplEndOffset)); }
					} else { /* Extension */
						// https://phabricator.wikimedia.org/T184779
						dmw.extSuffix = state.getSrc(tplEndOffset, newTplEndOffset);
					}
					// Update DSR
					tplDsr[1] = newTplEndOffset;

					// Set about attributes on all children of s2 - add span wrappers if required
					var span;
					for (n = tplInfo.last.nextSibling; n; n = n.nextSibling) {
						if (DOMUtils.isElt(n)) {
							n.setAttribute('about', tplInfo.about);
							span = null;
						} else {
							if (!span) {
								span = state.doc.createElement('span');
								span.setAttribute('about', tplInfo.about);
								n.parentNode.replaceChild(span, n);
							}
							span.appendChild(n);
							n = span; // to ensure n.nextSibling is correct
						}
					}
				}
			} else {
				// Scenario 2: s1 and s2 are in different subtrees
				// Find children of the common ancestor that are on the
				// path from s1 -> ancestor and s2 -> ancestor
				console.assert(
					s1Ancestors.length >= 2 && i >= 1,
					'Scenario assumptions violated.'
				);
				var newS1 = s1Ancestors[s1Ancestors.length - 2]; // length >= 2 since we know ancestors != s1
				var newS2 = s2Ancestors.item(i - 1); // i >= 1 since we know s2 is not s1's ancestor
				var newAbout = state.env.newAboutId(); // new about id for the new wrapping layer

				// Ensure that all children from newS1 and newS2 have about attrs set
				for (n = newS1; n !== newS2.nextSibling; n = n.nextSibling) {
					n.setAttribute('about', newAbout);
				}

				// Update transclusion info
				var dsr1 = self.getDSR(tplInfo, newS1, true); // will succeed because it traverses non-tpl content
				var dsr2 = self.getDSR(tplInfo, newS2, false); // will succeed because it traverses non-tpl content
				var tplDP = DOMDataUtils.getDataParsoid(tplInfo.first);
				tplDsr = tplDP.dsr;
				dmw = Util.clone(DOMDataUtils.getDataMw(tplInfo.first));
				if (DOMUtils.hasTypeOf(tplInfo.first, 'mw:Transclusion')) {
					if (dmw.parts) {
						dmw.parts.unshift(state.getSrc(dsr1, tplDsr[0]));
						dmw.parts.push(state.getSrc(tplDsr[1], dsr2));
					}
					DOMDataUtils.setDataMw(newS1, dmw);
					newS1.setAttribute('typeof', 'mw:Transclusion');
					// Copy the template's parts-information object
					// which has white-space information for formatting
					// the transclusion and eliminates dirty-diffs.
					DOMDataUtils.setDataParsoid(newS1, { pi: tplDP.pi, dsr: [ dsr1, dsr2 ] });
				} else { /* extension */
					// https://phabricator.wikimedia.org/T184779
					dmw.extPrefix = state.getSrc(dsr1, tplDsr[0]);
					dmw.extSuffix = state.getSrc(tplDsr[1], dsr2);
					DOMDataUtils.setDataMw(newS1, dmw);
					newS1.setAttribute('typeof', tplInfo.first.getAttribute('typeof') || '');
					DOMDataUtils.setDataParsoid(newS1, { dsr: [ dsr1, dsr2 ] });
				}
			}
		});
	}

	/**
	 */
	run(rootNode, env, options) {
		if (!env.wrapSections) {
			return;
		}

		var doc = rootNode.ownerDocument;
		var leadSection = {
			container: doc.createElement('section'),
			debug_id: 0,
			// lowest possible level since we don't want
			// any nesting of h-tags in the lead section
			level: 6,
			lead: true,
		};
		leadSection.container.setAttribute('data-mw-section-id', 0);

		// Global state
		var state = {
			env: env,
			count: 1,
			doc: doc,
			rootNode: rootNode,
			sectionNumber: 0,
			inTemplate: false,
			tplsAndExtsToExamine: [],
			getSrc: function(s, e) {
				return options.frame.srcText.substring(s,e);
			},
		};
		this.wrapSectionsInDOM(state, leadSection, rootNode);

		// There will always be a lead section, even if sometimes it only
		// contains whitespace + comments.
		rootNode.insertBefore(leadSection.container, rootNode.firstChild);

		// Resolve template conflicts after all sections have been added to the DOM
		this.resolveTplExtSectionConflicts(state);
	}
}

module.exports = {
	WrapSections: WrapSections,
};
