/** @module */

'use strict';

const { WikitextConstants: Consts } = require('../../../config/WikitextConstants.js');
const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { Util } = require('../../../utils/Util.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

/**
 * For an explanation of what TSR is, see ComputeDSR#computeNodeDSR()
 *
 * TSR info on all these tags are only valid for the opening tag.
 * (closing tags dont have attrs since tree-builder strips them
 *  and adds meta-tags tracking the corresponding TSR)
 *
 * On other tags, a, hr, br, meta-marker tags, the tsr spans
 * the entire DOM, not just the tag.
 *
 * This code is not in {@link WikitextConstants} because this
 * information is Parsoid-implementation-specific.
 * @namespace
 */
const WtTagsWithLimitedTSR = {
	"b":       true,
	"i":       true,
	"h1":      true,
	"h2":      true,
	"h3":      true,
	"h4":      true,
	"h5":      true,
	"h6":      true,
	"ul":      true,
	"ol":      true,
	"dl":      true,
	"li":      true,
	"dt":      true,
	"dd":      true,
	"table":   true,
	"caption": true,
	"tr":      true,
	"td":      true,
	"th":      true,
	"hr":      true, // void element
	"br":      true, // void element
	"pre":     true,
};

class ComputeDSR {
	tsrSpansTagDOM(n, parsoidData) {
		// - tags known to have tag-specific tsr
		// - html tags with 'stx' set
		// - tags with certain typeof properties (Parsoid-generated
		//   constructs: placeholders, lang variants, DisplayHack)
		var name = n.nodeName.toLowerCase();
		return !(
			WtTagsWithLimitedTSR[name] ||
			DOMUtils.matchTypeOf(
				n,
				/^mw:(Placeholder|LanguageVariant|DisplaySpace)$/
			) ||
			WTUtils.hasLiteralHTMLMarker(parsoidData)
		);
	}

	acceptableInconsistency(opts, node, cs, s) {
		/**
		 * 1. For wikitext URL links, suppress cs-s diff warnings because
		 *    the diffs can come about because of various reasons since the
		 *    canonicalized/decoded href will become the a-link text whose width
		 *    will not match the tsr width of source wikitext
		 *
		 *    (a) urls with encoded chars (ex: 'http://example.com/?foo&#61;bar')
		 *    (b) non-canonical spaces (ex: 'RFC  123' instead of 'RFC 123')
		 *
		 * 2. We currently dont have source offsets for attributes.
		 *    So, we get a lot of spurious complaints about cs/s mismatch
		 *    when DSR computation hit the <body> tag on this attribute.
		 *    opts.attrExpansion tell us when we are processing an attribute
		 *    and let us suppress the mismatch warning on the <body> tag.
		 *
		 * 3. Other scenarios .. to be added
		 */
		if (node.nodeName === 'A' && (WTUtils.usesURLLinkSyntax(node) || WTUtils.usesMagicLinkSyntax(node))) {
			return true;
		} else if (opts.attrExpansion && DOMUtils.isBody(node)) {
			return true;
		} else {
			return false;
		}
	}

	computeListEltWidth(li) {
		if (!li.previousSibling && li.firstChild) {
			if (DOMUtils.isList(li.firstChild)) {
				// Special case!!
				// First child of a list that is on a chain
				// of nested lists doesn't get a width.
				return 0;
			}
		}

		// count nest listing depth and assign
		// that to the opening tag width.
		var depth = 0;
		while (li.nodeName === 'LI' || li.nodeName === 'DD') {
			depth++;
			li = li.parentNode.parentNode;
		}

		return depth;
	}

	computeATagWidth(node, dp) {
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
			if (WTUtils.usesWikiLinkSyntax(node, dp) && !WTUtils.hasExpandedAttrsType(node)) {
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
			} else if (dp.tsr && WTUtils.usesExtLinkSyntax(node, dp)) {
				return [dp.extLinkContentOffsets[0] - dp.tsr[0], 1];
			} else if (WTUtils.usesURLLinkSyntax(node, dp) || WTUtils.usesMagicLinkSyntax(node, dp)) {
				return [0, 0];
			} else {
				return null;
			}
		}
	}

	computeTagWidths(widths, node, dp) {
		if (dp.extTagOffsets) {
			return [dp.extTagOffsets[2], dp.extTagOffsets[3]];
		}

		var stWidth = widths[0];
		var etWidth = typeof (widths[1]) === 'number' ? widths[1] : null;

		if (WTUtils.hasLiteralHTMLMarker(dp)) {
			if (dp.selfClose) {
				etWidth = 0;
			}
		} else if (node.getAttribute('typeof') === 'mw:LanguageVariant') {
			stWidth = 2; // -{
			etWidth = 2; // }-
		} else {
			var nodeName = node.nodeName;
			// 'tr' tags not in the original source have zero width
			if (nodeName === 'TR' && !dp.startTagSrc) {
				stWidth = 0;
				etWidth = 0;
			} else {
				var wtTagWidth = Consts.WtTagWidths.get(nodeName);
				if (stWidth === null) {
					// we didn't have a tsr to tell us how wide this tag was.
					if (nodeName === 'A') {
						wtTagWidth = this.computeATagWidth(node, dp);
						stWidth = wtTagWidth ? wtTagWidth[0] : null;
					} else if (nodeName === 'LI' || nodeName === 'DD') {
						stWidth = this.computeListEltWidth(node);
					} else if (wtTagWidth) {
						stWidth = wtTagWidth[0];
					}
				}

				if (etWidth === null && wtTagWidth) {
					etWidth = wtTagWidth[1];
				}
			}
		}

		return [stWidth, etWidth];
	}

	/**
	 * Compute TSR for a {@link Node}.
	 *
	 * TSR = "Tag Source Range".  Start and end offsets giving the location
	 * where the tag showed up in the original source.
	 *
	 * DSR = "DOM Source Range".  [0] and [1] are open and end,
	 * [2] and [3] are widths of the container tag.
	 *
	 * TSR is set by the tokenizer. In most cases, it only applies to the
	 * specific tag (opening or closing).  However, for self-closing
	 * tags that the tokenizer generates, the TSR values applies to the entire
	 * DOM subtree (opening tag + content + closing tag).
	 *
	 * Ex: So [[foo]] will get tokenized to a SelfClosingTagTk(...) with a TSR
	 * value of [0,7].  The DSR algorithm will then use that info and assign
	 * the a-tag rooted at the <a href='...'>foo</a> DOM subtree a DSR value of
	 * [0,7,2,2], where 2 and 2 refer to the opening and closing tag widths.
	 *
	 * [s,e) -- if defined, start/end position of wikitext source that generated
	 *          node's subtree
	 *
	 * @param {Frame} frame
	 * @param {Node} node node to process
	 * @param {number} s start position, inclusive
	 * @param {number} e end position, exclusive
	 * @param {number} dsrCorrection
	 * @param {Object} opts
	 */
	computeNodeDSR(frame, node, s, e, dsrCorrection, opts) {
		const env = frame.env;
		function trace() {
			var args = arguments;
			env.log("trace/dsr", function() {
				var buf = '';
				for (var i in args) {
					buf += typeof args[i] === 'string' ? args[i] : JSON.stringify(args[i]);
				}
				return buf;
			});
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

		if (e === null && !node.hasChildNodes()) {
			e = s;
		}

		trace("BEG: ", node.nodeName, " with [s, e]=", [s, e]);

		var correction;
		var savedEndTagWidth = null;
		var ce = e;
		// Initialize cs to ce to handle the zero-children case properly
		// if this node has no child content, then the start and end for
		// the child dom are indeed identical.  Alternatively, we could
		// explicitly code this check before everything and bypass this.
		var cs = ce;
		var rtTestMode = env.conf.parsoid.rtTestMode;

		var child = node.lastChild;
		while (child !== null) {
			var prevChild = child.previousSibling;
			var isMarkerTag = false;
			var origCE = ce;
			var cType = child.nodeType;
			var endTagInfo = null;
			var fosteredNode = false;
			cs = null;

			// In edit mode, StrippedTag marker tags will be removed and wont
			// be around to miss in the filling gap.  So, absorb its width into
			// the DSR of its previous sibling.  Currently, this fix is only for
			// B and I tags where the fix is clear-cut and obvious.
			if (!rtTestMode) {
				var next = child.nextSibling;
				if (next && DOMUtils.isElt(next)) {
					var ndp = DOMDataUtils.getDataParsoid(next);
					if (ndp.src &&
						DOMUtils.hasTypeOf(next, 'mw:Placeholder/StrippedTag')) {
						if (Consts.WTQuoteTags.has(ndp.name) &&
							Consts.WTQuoteTags.has(child.nodeName)) {
							correction = ndp.src.length;
							ce += correction;
							dsrCorrection = correction;
							if (Util.isValidDSR(ndp.dsr)) {
								// Record original DSR for the meta tag
								// since it will now get corrected to zero width
								// since child acquires its width.
								if (!ndp.tmp) {
									ndp.tmp = {};
								}
								ndp.tmp.origDSR = [ndp.dsr[0], ndp.dsr[1], null, null];
							}
						}
					}
				}
			}

			env.log("trace/dsr", function() {
				var i = child.parentNode.childNodes.indexOf(child); // slow, for debugging only
				return "     CHILD: <" + child.parentNode.nodeName + ":" + i +
					">=" +
					(DOMUtils.isElt(child) ? '' : (DOMUtils.isText(child) ? '#' : '!')) +
					(DOMUtils.isElt(child) ?
						(child.nodeName === 'META' ? child.outerHTML : child.nodeName) :
						JSON.stringify(child.data)) +
					" with " + JSON.stringify([cs, ce]);
			});

			if (cType === node.TEXT_NODE) {
				if (ce !== null) {
					// This code is replicated below. Keep both in sync.
					cs = ce - child.data.length - WTUtils.indentPreDSRCorrection(child);
				}
			} else if (cType === node.COMMENT_NODE) {
				if (ce !== null) {
					// decode html entities & reencode as wikitext to find length
					cs = ce - WTUtils.decodedCommentLength(child);
				}
			} else if (cType === node.ELEMENT_NODE) {
				var dp = DOMDataUtils.getDataParsoid(child);
				var tsr = dp.tsr;
				var oldCE = tsr ? tsr[1] : null;
				var propagateRight = false;
				var stWidth = null;
				var etWidth = null;

				fosteredNode = dp.fostered;

				// In edit-mode, we are making dsr corrections to account for
				// stripped tags (end tags usually).  When stripping happens,
				// in most common use cases, a corresponding end tag is added
				// back elsewhere in the DOM.
				//
				// So, when an autoInsertedEnd tag is encountered and a matching
				// dsr-correction is found, make a 1-time correction in the
				// other direction.
				//
				// Currently, this fix is only for
				// B and I tags where the fix is clear-cut and obvious.
				if (!rtTestMode && ce !== null && dp.autoInsertedEnd && DOMUtils.isQuoteElt(child)) {
					correction = (3 + child.nodeName.length);
					if (correction === dsrCorrection) {
						ce -= correction;
						dsrCorrection = 0;
					}
				}

				if (child.nodeName === "META") {
					// Unless they have been foster-parented,
					// meta marker tags have valid tsr info.
					if (DOMUtils.matchTypeOf(child, /^mw:(EndTag|TSRMarker)$/)) {
						if (DOMUtils.hasTypeOf(child, "mw:EndTag")) {
							// FIXME: This seems like a different function that is
							// tacked onto DSR computation, but there is no clean place
							// to do this one-off thing without doing yet another pass
							// over the DOM -- maybe we need a 'do-misc-things-pass'.
							//
							// Update table-end syntax using info from the meta tag
							var prev = child.previousSibling;
							if (prev && prev.nodeName === "TABLE") {
								var prevDP = DOMDataUtils.getDataParsoid(prev);
								if (!WTUtils.hasLiteralHTMLMarker(prevDP)) {
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
							endTagInfo = {
								width: tsr[1] - tsr[0],
								nodeName: child.getAttribute("data-etag") || '',
							};
							cs = tsr[1];
							ce = tsr[1];
							propagateRight = true;
						}
					} else if (tsr) {
						if (WTUtils.isTplMarkerMeta(child)) {
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
					} else if (DOMUtils.matchTypeOf(child, /^mw:Placeholder(\/\w*)?$/) && ce !== null && dp.src) {
						cs = ce - dp.src.length;
					}
					if (dp.extTagOffsets) {
						stWidth = dp.extTagOffsets[2];
						etWidth = dp.extTagOffsets[3];
						dp.extTagOffsets = undefined;
					}
				} else if (DOMUtils.hasTypeOf(child, "mw:Entity") && ce !== null && dp.src) {
					cs = ce - dp.src.length;
				} else {
					var tagWidths, newDsr, ccs, cce;
					if (DOMUtils.matchTypeOf(child, /^mw:Placeholder(\/\w*)?$/) && ce !== null && dp.src) {
						cs = ce - dp.src.length;
					} else {
						// Non-meta tags
						if (tsr && !dp.autoInsertedStart) {
							cs = tsr[0];
							if (this.tsrSpansTagDOM(child, dp)) {
								if (tsr[1] !== null && tsr[1] > 0) {
									ce = tsr[1];
									propagateRight = true;
								}
							} else {
								stWidth = tsr[1] - tsr[0];
							}

							trace("     TSR: ", tsr, "; cs: ", cs, "; ce: ", ce);
						} else if (s && child.previousSibling === null) {
							cs = s;
						}
					}

					// Compute width of opening/closing tags for this dom node
					tagWidths = this.computeTagWidths([stWidth, savedEndTagWidth], child, dp);
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

					/* -----------------------------------------------------------------
					 * Process DOM rooted at 'child'.
					 *
					 * NOTE: You might wonder why we are not checking for the zero-children
					 * case. It is strictly not necessary and you can set newDsr directly.
					 *
					 * But, you have 2 options: [ccs, ccs] or [cce, cce]. Setting it to
					 * [cce, cce] would be consistent with the RTL approach. We should
					 * then compare ccs and cce and verify that they are identical.
					 *
					 * But, if we handled the zero-child case like the other scenarios,
					 * we don't have to worry about the above decisions and checks.
					 * ----------------------------------------------------------------- */

					if (WTUtils.isDOMFragmentWrapper(child) || child.getAttribute('typeof') === 'mw:LanguageVariant') {
						// Eliminate artificial cs/s mismatch warnings since this is
						// just a wrapper token with the right DSR but without any
						// nested subtree that could account for the DSR span.
						newDsr = [ccs, cce];
					} else if (child.nodeName === 'A'
						&& WTUtils.usesWikiLinkSyntax(child, dp)
						&& dp.stx !== "piped") {
						/* -------------------------------------------------------------
						 * This check here eliminates artificial DSR mismatches on content
						 * text of the A-node because of entity expansion, etc.
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
						env.log("trace/dsr", function() {
							return "     before-recursing:" +
								"[cs,ce]=" + JSON.stringify([cs, ce]) +
								"; [sw,ew]=" + JSON.stringify([stWidth, etWidth]) +
								"; subtree-[cs,ce]=" + JSON.stringify([ccs, cce]);
						});

						trace("<recursion>");
						newDsr = this.computeNodeDSR(frame, child, ccs, cce, dsrCorrection, opts);
						trace("</recursion>");
					}

					// cs = min(child-dom-tree dsr[0] - tag-width, current dsr[0])
					if (stWidth !== null && newDsr[0] !== null) {
						var newCs = newDsr[0] - stWidth;
						if (cs === null || (!tsr && newCs < cs)) {
							cs = newCs;
						}
					}

					// ce = max(child-dom-tree dsr[1] + tag-width, current dsr[1])
					if (etWidth !== null && newDsr[1] !== null) {
						var newCe = newDsr[1] + etWidth;
						if (newCe > ce) {
							ce = newCe;
						}
					}
				}

				if (cs !== null || ce !== null) {
					if (ce < 0) {
						if (!fosteredNode) {
							env.log("warn/dsr/negative", "Negative DSR for node: " + node.nodeName + "; resetting to zero");
						}
						ce = 0;
					}

					// Fostered nodes get a zero-dsr width range.
					if (fosteredNode) {
						// Reset to 0, if necessary.
						// This is critical to avoid duplication of fostered content in selser mode.
						if (origCE < 0) {
							origCE = 0;
						}
						dp.dsr = [origCE, origCE];
					} else {
						dp.dsr = [cs, ce, stWidth, etWidth];
					}
					env.log("trace/dsr", function() {
						var str = "     UPDATING " + child.nodeName +
							" with " + JSON.stringify([cs, ce]) + "; typeof: " + child.getAttribute('typeof');
						// Set up 'dbsrc' so we can debug this
						dp.dbsrc = frame.srcText.substring(cs, ce);
						return str;
					});
				}

				// Propagate any required changes to the right
				// taking care not to cross-over into template content
				if (ce !== null &&
					(propagateRight || oldCE !== ce || e === null) &&
					!WTUtils.isTplStartMarkerMeta(child)) {
					var sibling = child.nextSibling;
					var newCE = ce;
					while (newCE !== null && sibling && !WTUtils.isTplStartMarkerMeta(sibling)) {
						var nType = sibling.nodeType;
						if (nType === node.TEXT_NODE) {
							newCE = newCE + sibling.data.length + WTUtils.indentPreDSRCorrection(sibling);
						} else if (nType === node.COMMENT_NODE) {
							newCE += WTUtils.decodedCommentLength(sibling);
						} else if (nType === node.ELEMENT_NODE) {
							var siblingDP = DOMDataUtils.getDataParsoid(sibling);

							if (!siblingDP.dsr) {
								siblingDP.dsr = [null, null];
							}


							if (siblingDP.fostered ||
								(siblingDP.dsr[0] !== null && siblingDP.dsr[0] === newCE) ||
								(siblingDP.dsr[0] !== null && siblingDP.tsr && siblingDP.dsr[0] < newCE)) {
								// sibling is fostered
								//   => nothing to propagate past it
								// sibling's dsr[0] matches what we might propagate
								//   => nothing will change
								// sibling's dsr value came from tsr and it is not outside expected range
								//   => stop propagation so you don't overwrite it
								break;
							}

							// Update and move right
							env.log("trace/dsr", function() {
								var str = "     CHANGING ce.start of " + sibling.nodeName +
									" from " + siblingDP.dsr[0] + " to " + newCE;
								// debug info
								if (siblingDP.dsr[1]) {
									siblingDP.dbsrc = frame.srcText.substring(newCE, siblingDP.dsr[1]);
								}
								return str;
							});

							siblingDP.dsr[0] = newCE;
							// If we have a dsr[1] as well and since we updated
							// dsr[0], we have to ensure that the two values don't
							// introduce an inconsistency where dsr[0] > dsr[1].
							// Since we are in a LTR pass and are pushing updates
							// forward, we are resolving it by updating dsr[1] as
							// well. There could be scenarios where this would be
							// incorrect, but there is no universal fix here.
							if (siblingDP.dsr[1] !== null && newCE > siblingDP.dsr[1]) {
								siblingDP.dsr[1] = newCE;
							}
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

			// Dont change state if we processed a fostered node
			if (fosteredNode) {
				ce = origCE;
			} else {
				// ce for next child = cs of current child
				ce = cs;

				// Save end-tag width from marker meta tag
				if (endTagInfo && child.previousSibling &&
					endTagInfo.nodeName.toUpperCase() === child.previousSibling.nodeName) {
					savedEndTagWidth = endTagInfo.width;
				} else {
					savedEndTagWidth = null;
				}
			}

			// No use for this marker tag after this.
			// Looks like DSR computation assumes that
			// these meta tags will be removed.
			if (isMarkerTag) {
				// Collapse text nodes to prevent n^2 effect in the LTR propagation pass
				// Example: enwiki:Colonization?oldid=718468597
				var nextChild = child.nextSibling;
				if (DOMUtils.isText(prevChild) && DOMUtils.isText(nextChild)) {
					var prevText = prevChild.nodeValue;
					var nextText = nextChild.nodeValue;

					// Process prevText in place
					if (ce !== null) {
						// indentPreDSRCorrection is not required here since
						// we'll never come down this branch (mw:TSRMarker won't exist
						// in indent-pres, and mw:EndTag markers won't have a text node
						// for its previous sibling), but, for sake of maintenance sanity,
						// replicating code from above.
						cs = ce - prevText.length - WTUtils.indentPreDSRCorrection(prevChild);
						ce = cs;
					}

					// Update DOM
					var newNode = node.ownerDocument.createTextNode(prevText + nextText);
					node.replaceChild(newNode, prevChild);
					node.removeChild(nextChild);
					prevChild = newNode.previousSibling;
				}
				node.removeChild(child);
			}

			child = prevChild;
		}

		if (cs === undefined || cs === null) {
			cs = s;
		}

		// Detect errors
		if (s !== null && s !== undefined && cs !== s && !this.acceptableInconsistency(opts, node, cs, s)) {
			env.log("warn/dsr/inconsistent", "DSR inconsistency: cs/s mismatch for node:",
				node.nodeName, "s:", s, "; cs:", cs);
		}

		trace("END: ", node.nodeName, ", returning: ", cs, ", ", e);

		return [cs, e];
	}

	/**
	 * Computes DSR ranges for every node of a DOM tree.
	 *
	 * @param {Object} rootNode
	 *     The root of the tree for which DSR has to be computed.
	 *
	 * @param {Object} env
	 *     The environment/context for the parse pipeline.
	 *
	 * @param {Object} options
	 *     Options governing DSR computation
	 *     sourceOffsets: [start, end] source offset. If missing, this defaults to
	 *                    [0, frame.srcText.length]
	 *     attrExpansion: Is this an attribute expansion pipeline?
	 */
	run(rootNode, env, options) {
		if (!options) {
			options = {};
		}
		var frame = options.frame || env.topFrame;

		var startOffset = options.sourceOffsets ? options.sourceOffsets[0] : 0;
		var endOffset = options.sourceOffsets ? options.sourceOffsets[1] : frame.srcText.length;
		env.log("trace/dsr", "------- tracing DSR computation -------");

		// The actual computation buried in trace/debug stmts.
		var opts = { attrExpansion: options.attrExpansion };
		this.computeNodeDSR(frame, rootNode, startOffset, endOffset, 0, opts);

		var dp = DOMDataUtils.getDataParsoid(rootNode);
		dp.dsr = [startOffset, endOffset, 0, 0];

		env.log("trace/dsr", "------- done tracing computation -------");
	}
}

if (typeof module === "object") {
	module.exports.ComputeDSR = ComputeDSR;
}
