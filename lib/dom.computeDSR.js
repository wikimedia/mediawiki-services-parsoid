"use strict";

var Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Util = require('./mediawiki.Util.js').Util,
	dumpDOM = require('./dom.dumper.js').dumpDOM;

// Helper function to detect when an A-node uses [[..]] style wikilink syntax
// mw:ExtLink rel-type is not sufficient anymore since [[..]] style links can
// also be tagged ext-links
function usesWikiLinkSyntax(aNode, dp) {
	return aNode.getAttribute("rel") === "mw:WikiLink" ||
		(dp.stx && dp.stx !== "url" && dp.stx !== "protocol");
}

function usesExtLinkSyntax(aNode, dp) {
	return aNode.getAttribute("rel") === "mw:ExtLink" &&
		(!dp.stx || (dp.stx !== "url" && dp.stx !== "protocol"));
}

function usesURLLinkSyntax(aNode, dp) {
	return aNode.getAttribute("rel") === "mw:ExtLink" &&
		dp.stx &&
		(dp.stx === "url" || dp.stx === "protocol");
}

function acceptableInconsistency(opts, node, cs, s) {
	/**
	 * 1. For wikitext URL links, suppress cs-s diff warnings because
	 *    the diffs can come about because of various reasions since the
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
	if (node.nodeName === 'A' && usesURLLinkSyntax(node, DU.getDataParsoid( node ))) {
		return true;
	} else if (opts.attrExpansion && node.nodeName === 'BODY') {
		return true;
	} else {
		return false;
	}
}

/* ------------------------------------------------------------------------
 * TSR = "Tag Source Range".  Start and end offsets giving the location
 * where the tag showed up in the original source.
 *
 * DSR = "DOM Source Range".  [0] and [1] are open and end,
 * [2] and [3] are widths of the container tag.
 *
 * TSR is set by the tokenizer. In most cases, it only applies to the
 * specific tag (opening or closing).  However, for self-closing
 * tags that the tokenizer generates, the TSR values applies to the entire
 * DOM subtree (opening tag + content + closign tag).
 *
 * Ex: So [[foo]] will get tokenized to a SelfClosingTagTk(...) with a TSR
 * value of [0,7].  The DSR algorithm will then use that info and assign
 * the a-tag rooted at the <a href='...'>foo</a> DOM subtree a DSR value of
 * [0,7,2,2], where 2 and 2 refer to the opening and closing tag widths.
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
 * node  -- node to process
 * [s,e) -- if defined, start/end position of wikitext source that generated
 *          node's subtree
 * --------------------------------------------------------------------------- */
function computeNodeDSR(env, node, s, e, dsrCorrection, opts) {
	function computeListEltWidth(li, nodeName) {
		if (!li.previousSibling && li.firstChild) {
			var n = li.firstChild.nodeName.toLowerCase();
			if (n === 'dl' || n === 'ol' || n === 'ul') {
				// Special case!!
				// First child of a list that is on a chain
				// of nested lists doesn't get a width.
				return 0;
			}
		}

		// count nest listing depth and assign
		// that to the opening tag width.
		var depth = 0;
		while (nodeName === 'li' || nodeName === 'dd') {
			depth++;
			li = li.parentNode.parentNode;
			nodeName = li.nodeName.toLowerCase();
		}

		return depth;
	}

	function computeATagWidth(node, dp) {
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
			if (usesWikiLinkSyntax(node, dp) &&
				!DU.isExpandedAttrsMetaType(node.getAttribute("typeof")))
			{
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
			} else if (dp.tsr && usesExtLinkSyntax(node, dp)) {
				return [dp.targetOff - dp.tsr[0], 1];
			} else if (usesURLLinkSyntax(node, dp)) {
				return [0, 0];
			} else {
				return null;
			}
		}
	}

	function computeTagWidths(widths, node, dp) {
		var stWidth = widths[0], etWidth = null;

		if (dp.tagWidths) {
			return dp.tagWidths;
		} else if (DU.hasLiteralHTMLMarker(dp)) {
			if (dp.tsr) {
				etWidth = widths[1];
			}
		} else {
			var nodeName = node.nodeName;
			// 'tr' tags not in the original source have zero width
			if (nodeName === 'TR' && !dp.startTagSrc) {
				stWidth = 0;
				etWidth = 0;
			} else {
				var wtTagWidth = Consts.WT_TagWidths[nodeName];
				if (stWidth === null) {
					// we didn't have a tsr to tell us how wide this tag was.
					if (nodeName === 'A') {
						wtTagWidth = computeATagWidth(node, dp);
						stWidth = wtTagWidth ? wtTagWidth[0] : null;
					} else if (nodeName === 'LI' || nodeName === 'DD') {
						stWidth = computeListEltWidth(node, nodeName);
					} else if (wtTagWidth) {
						stWidth = wtTagWidth[0];
					}
				}
				etWidth = wtTagWidth ? wtTagWidth[1] : widths[1];
			}
		}

		return [stWidth, etWidth];
	}

	function trace() {
		if (opts.traceDSR) {
			Util.debug_pp.apply(Util, ['', ''].concat([].slice.apply(arguments)));
		}
	}

	function traceNode(node, i, cs, ce) {
		if (opts.traceDSR) {
			trace(
				"-- Processing <", node.parentNode.nodeName, ":", i,
				">=", DU.isElt(node) ? '' : (DU.isText(node) ? '#' : '!'),
				DU.isElt(node) ? (node.nodeName === 'META' ? node.outerHTML : node.nodeName) : node.data,
				" with [", cs, ",", ce, "]"
			);
		}
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

	trace("Received ", s, ", ", e, " for ", node.nodeName);

	var correction;
	var children = node.childNodes,
		savedEndTagWidth = null,
	    ce = e,
		// Initialize cs to ce to handle the zero-children case properly
		// if this node has no child content, then the start and end for
		// the child dom are indeed identical.  Alternatively, we could
		// explicitly code this check before everything and bypass this.
		cs = ce,
		editMode = env.conf.parsoid.editMode;
	for (var n = children.length, i = n-1; i >= 0; i--) {
		var isMarkerTag = false,
			origCE = ce,
			child = children[i],
		    cType = child.nodeType,
			endTagWidth = null,
			fosteredNode = false;
		cs = null;

		// In edit mode, StrippedTag marker tags will be removed and wont
		// be around to miss in the filling gap.  So, absorb its width into
		// the DSR of its previous sibling.  Currently, this fix is only for
		// B and I tags where the fix is clear-cut and obvious.
		if (editMode) {
			var next = child.nextSibling;
			if ( next && DU.isElt( next ) ) {
				var ndp = DU.getDataParsoid( next );
				if ( ndp.src &&
					/(?:^|\s)mw:Placeholder\/StrippedTag(?=$|\s)/.test(next.getAttribute("typeof")) )
				{
					if (Consts.WTQuoteTags.has( ndp.name ) &&
						Consts.WTQuoteTags.has( child.nodeName ))
					{
						correction = ndp.src.length;
						ce += correction;
						dsrCorrection = correction;
					}
				}
			}
		}

		traceNode(child, i, cs, ce);

		if (cType === node.TEXT_NODE) {
			if (ce !== null) {
				cs = ce - child.data.length - DU.indentPreDSRCorrection(child);
			}
		} else if (cType === node.COMMENT_NODE) {
			if (ce !== null) {
				cs = ce - child.data.length - 7; // 7 chars for "<!--" and "-->"
			}
		} else if (cType === node.ELEMENT_NODE) {
			var cTypeOf = child.getAttribute("typeof"),
				dp = DU.getDataParsoid( child ),
				tsr = dp.tsr,
				oldCE = tsr ? tsr[1] : null,
				propagateRight = false,
				stWidth = null, etWidth = null;

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
			if (editMode && ce !== null && dp.autoInsertedEnd && DU.isQuoteElt(child)) {
				correction = (3 + child.nodeName.length);
				if (correction === dsrCorrection) {
					ce -= correction;
					dsrCorrection = 0;
				}
			}

			if (DU.hasNodeName(child, "meta")) {
				// Unless they have been foster-parented,
				// meta marker tags have valid tsr info.
				if (cTypeOf === "mw:EndTag" || cTypeOf === "mw:TSRMarker") {
					if (cTypeOf === "mw:EndTag") {
						// FIXME: This seems like a different function that is
						// tacked onto DSR computation, but there is no clean place
						// to do this one-off thing without doing yet another pass
						// over the DOM -- maybe we need a 'do-misc-things-pass'.
						//
						// Update table-end syntax using info from the meta tag
						var prev = child.previousSibling;
						if (prev && DU.hasNodeName(prev, "table")) {
							var prevDP = DU.getDataParsoid( prev );
							if (!DU.hasLiteralHTMLMarker(prevDP)) {
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
						endTagWidth = tsr[1] - tsr[0];
						cs = tsr[1];
						ce = tsr[1];
						propagateRight = true;
					}
				} else if (tsr) {
					if (DU.isTplMetaType(cTypeOf)) {
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
				} else if (/^mw:Placeholder(\/\w*)?$/.test(cTypeOf) && ce !== null && dp.src) {
					cs = ce - dp.src.length;
				} else {
					var property = child.getAttribute("property");
					if (property && property.match(/mw:objectAttr/)) {
						cs = ce;
					}
				}
				if (dp.tagWidths) {
					stWidth = dp.tagWidths[0];
					etWidth = dp.tagWidths[1];
					delete dp.tagWidths;
				}
			} else if (cTypeOf === "mw:Entity" && ce !== null && dp.src) {
				cs = ce - dp.src.length;
			} else {
				var tagWidths, newDsr, ccs, cce;
				if (/^mw:Placeholder(\/\w*)?$/.test(cTypeOf) && dp.src) {
					cs = ce - dp.src.length;
				} else {
					// Non-meta tags
					if (tsr && !dp.autoInsertedStart) {
						cs = tsr[0];
						if (DU.tsrSpansTagDOM(child, dp)) {
							if (!ce || tsr[1] > ce) {
								ce = tsr[1];
								propagateRight = true;
							}
						} else {
							stWidth = tsr[1] - tsr[0];
						}

						if (opts.traceDSR) {
							trace("TSR: ", tsr, "; cs: ", cs, "; ce: ", ce);
						}
					} else if (s && child.previousSibling === null) {
						cs = s;
					}
				}

				// Compute width of opening/closing tags for this dom node
				tagWidths = computeTagWidths([stWidth, savedEndTagWidth], child, dp);
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

				trace("Before recursion, [cs,ce]=", cs, ",", ce,
					"; [sw,ew]=", stWidth, ",", etWidth,
					"; [ccs,cce]=", ccs + ",", cce);

				/* -----------------------------------------------------------------
				 * Process DOM rooted at 'child'.
				 *
				 * NOTE: You might wonder why we are not checking for the zero-children
				 * case.  It is strictly not necessary and you can set newDsr directly.
				 *
				 * But, you have 2 options: [ccs, ccs] or [cce, cce].  Setting it to
				 * [cce, cce] would be consistent with the RTL approach.  We should
				 * then compare ccs and cce and verify that they are identical.
				 *
				 * But, if we handled the zero-child case like the other scenarios,
				 * we don't have to worry about the above decisions and checks.
				 * ----------------------------------------------------------------- */

				if (child.nodeName === 'A' &&
					usesWikiLinkSyntax(child, dp) &&
					dp.stx !== "piped")
				{
					/* -------------------------------------------------------------
					 * This check here eliminates artifical DSR mismatches on content
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
				} else if (DU.isDOMFragmentWrapper(child)) {
					// Eliminate artificial cs/s mismatch warnings since this is
					// just a wrapper token with the right DSR but without any
					// nested subtree that could account for the DSR span.
					newDsr = [ccs, cce];
				} else {
					newDsr = computeNodeDSR(env, child, ccs, cce, dsrCorrection, opts);
				}

				// Min(child-dom-tree dsr[0] - tag-width, current dsr[0])
				if (stWidth !== null && newDsr[0] !== null) {
					var newCs = newDsr[0] - stWidth;
					if (cs === null || (!tsr && newCs < cs)) {
						cs = newCs;
					}
				}

				// Max(child-dom-tree dsr[1] + tag-width, current dsr[1])
				if (etWidth !== null && newDsr[1] !== null && ((newDsr[1] + etWidth) > ce)) {
					ce = newDsr[1] + etWidth;
				}
			}

			if (cs !== null || ce !== null) {
				if (ce < 0) {
					if (!fosteredNode) {
						console.warn("WARNING: Negative DSR for node: " + node.nodeName + "; resetting to zero");
					}
					ce = 0;
				}
				dp.dsr = [cs, ce, stWidth, etWidth];
				if (opts.traceDSR) {
					trace("-- UPDATING; ", child.nodeName, " with [", cs, ",", ce, "]; typeof: ", cTypeOf);
					// Set up 'dbsrc' so we can debug this
					dp.dbsrc = env.page.src.substring(cs, ce);
				}
			}

			// Propagate any required changes to the right
			// taking care not to cross-over into template content
			if (ce !== null &&
				(propagateRight || oldCE !== ce || e === null) &&
				!DU.isTplStartMarkerMeta(child))
			{
				var sibling = child.nextSibling;
				var newCE = ce;
				while (newCE !== null && sibling && !DU.isTplStartMarkerMeta(sibling)) {
					var nType = sibling.nodeType;
					if (nType === node.TEXT_NODE) {
						newCE = newCE + sibling.data.length + DU.indentPreDSRCorrection(sibling);
					} else if (nType === node.COMMENT_NODE) {
						newCE = newCE + sibling.data.length + 7;
					} else if (nType === node.ELEMENT_NODE) {
						var siblingDP = DU.getDataParsoid( sibling );
						if (siblingDP.dsr && siblingDP.tsr && siblingDP.dsr[0] <= newCE && e !== null) {
							// sibling's dsr wont change => ltr propagation stops here.
							break;
						}

						if (!siblingDP.dsr) {
							siblingDP.dsr = [null, null];
						}

						// Update and move right
						if (opts.traceDSR) {
							trace("CHANGING ce.start of ", sibling.nodeName, " from ", siblingDP.dsr[0], " to ", newCE);
							// debug info
							if (siblingDP.dsr[1]) {
								siblingDP.dbsrc = env.page.src.substring(newCE, siblingDP.dsr[1]);
							}
						}
						siblingDP.dsr[0] = newCE;
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

		if (isMarkerTag) {
			node.removeChild(child); // No use for this marker tag after this
		}

		// Dont change state if we processed a fostered node
		if (fosteredNode) {
			ce = origCE;
		} else {
			// ce for next child = cs of current child
			ce = cs;
			// end-tag width from marker meta tag
			savedEndTagWidth = endTagWidth;
		}
	}

	if (cs === undefined || cs === null) {
		cs = s;
	}

	// Detect errors
	if (s !== null && s !== undefined && cs !== s && !acceptableInconsistency(opts, node, cs, s)) {
		env.log("warning", "DSR inconsistency: cs/s mismatch for node:",
			node.nodeName, "s:",s,"; cs:",cs);
	}

	trace("For ", node.nodeName, ", returning: ", cs, ", ", e);

	return [cs, e];
}

function computeDSR(root, env, options) {
	var startOffset = options.sourceOffsets ? options.sourceOffsets[0] : 0,
		endOffset = options.sourceOffsets ? options.sourceOffsets[1] : env.page.src.length,
		psd = env.conf.parsoid;

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:pre-dsr") !== -1))) {
		console.warn("------ DOM: pre-DSR -------");
		dumpDOM( options, root );
		console.warn("----------------------------");
	}

	var traceDSR = env.debug || (psd.traceFlags && (psd.traceFlags.indexOf("dsr") !== -1));
	if (traceDSR) { console.warn("------- tracing DSR computation -------"); }

	// The actual computation buried in trace/debug stmts.
	var body = root.body,
		opts = { traceDSR: traceDSR, attrExpansion: options.attrExpansion };
	computeNodeDSR(env, body, startOffset, endOffset, 0, opts);

	var dp = DU.getDataParsoid( body );
	dp.dsr = [startOffset, endOffset, 0, 0];

	if (traceDSR) { console.warn("------- done tracing DSR computation -------"); }

	if (psd.debug || (psd.dumpFlags && (psd.dumpFlags.indexOf("dom:post-dsr") !== -1))) {
		console.warn("------ DOM: post-DSR -------");
		dumpDOM( options, root );
		console.warn("----------------------------");
	}
}

if (typeof module === "object") {
	module.exports.computeDSR = computeDSR;
	module.exports.computeNodeDSR = computeNodeDSR;
}
