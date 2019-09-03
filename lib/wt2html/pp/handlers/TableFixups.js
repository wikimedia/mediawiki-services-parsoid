/** @module */

'use strict';

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { JSUtils } = require('../../../utils/jsutils.js');
const { Util } = require('../../../utils/Util.js');
const { WTUtils } = require('../../../utils/WTUtils.js');
const { PegTokenizer } = require('../../tokenizer.js');
const { Sanitizer } = require('../../tt/Sanitizer.js');

/**
 * TableFixups class.
 *
 * Provides two DOMTraverser visitors that implement the two parts of
 * https://phabricator.wikimedia.org/T52603 :
 * - stripDoubleTDs
 * - reparseTemplatedAttributes.
 * @class
 */
class TableFixups {
	constructor(env) {
		/**
		 * Set up some helper objects for reparseTemplatedAttributes
		 */

		/**
		 * Actually the regular tokenizer, but we'll use
		 * tokenizeTableCellAttributes only.
		 */
		this.tokenizer = new PegTokenizer(env);
	}

	/**
	 * DOM visitor that strips the double td for this test case:
	 * ```
	 * |{{echo|{{!}} Foo}}
	 * ```
	 *
	 * @see https://phabricator.wikimedia.org/T52603
	 */
	stripDoubleTDs(node, frame) {
		var nextNode = node.nextSibling;

		if (!WTUtils.isLiteralHTMLNode(node) &&
			nextNode !== null &&
			nextNode.nodeName === 'TD' &&
			!WTUtils.isLiteralHTMLNode(nextNode) &&
			DOMUtils.nodeEssentiallyEmpty(node) &&
			(
				// FIXME: will not be set for nested templates
				DOMUtils.hasTypeOf(nextNode, 'mw:Transclusion') ||
				// Hacky work-around for nested templates
				/^{{.*?}}$/.test(DOMDataUtils.getDataParsoid(nextNode).src)
			)
		) {
			// Update the dsr. Since we are coalescing the first
			// node with the second (or, more precisely, deleting
			// the first node), we have to update the second DSR's
			// starting point and start tag width.
			var nodeDSR = DOMDataUtils.getDataParsoid(node).dsr;
			var nextNodeDSR = DOMDataUtils.getDataParsoid(nextNode).dsr;

			if (nodeDSR && nextNodeDSR) {
				nextNodeDSR[0] = nodeDSR[0];
			}

			var dataMW = DOMDataUtils.getDataMw(nextNode);
			var nodeSrc = WTUtils.getWTSource(frame, node);
			if (!dataMW.parts) {
				dataMW.parts = [];
			}
			dataMW.parts.unshift(nodeSrc);

			// Delete the duplicated <td> node.
			node.parentNode.removeChild(node);
			// This node was deleted, so don't continue processing on it.
			return nextNode;
		}

		return true;
	}

	isSimpleTemplatedSpan(node) {
		return node.nodeName === 'SPAN' &&
			DOMDataUtils.hasTypeOf(node, 'mw:Transclusion') &&
			DOMUtils.allChildrenAreTextOrComments(node);
	}

	hoistTransclusionInfo(frame, child, tdNode) {
		var aboutId = child.getAttribute('about') || '';
		// Hoist all transclusion information from the child
		// to the parent tdNode.
		tdNode.setAttribute('typeof', child.getAttribute('typeof'));
		tdNode.setAttribute('about', aboutId);
		var dataMW = DOMDataUtils.getDataMw(child);
		var parts = dataMW.parts;
		var dp = DOMDataUtils.getDataParsoid(tdNode);
		var childDP = DOMDataUtils.getDataParsoid(child);

		// In `handleTableCellTemplates`, we're creating a cell w/o dsr info.
		if (!Util.isValidDSR(dp.dsr)) {
			dp.dsr = Util.clone(childDP.dsr);
		}

		// Get the td and content source up to the transclusion start
		if (dp.dsr[0] < childDP.dsr[0]) {
			parts.unshift(frame.srcText.substring(dp.dsr[0], childDP.dsr[0]));
		}

		// Add wikitext for the table cell content following the
		// transclusion. This is safe as we are currently only
		// handling a single transclusion in the content, which is
		// guaranteed to have a dsr that covers the transclusion
		// itself.
		if (childDP.dsr[1] < dp.dsr[1]) {
			parts.push(frame.srcText.substring(childDP.dsr[1], dp.dsr[1]));
		}

		// Save the new data-mw on the tdNode
		DOMDataUtils.setDataMw(tdNode, { parts: parts });
		dp.pi = childDP.pi;
		DOMDataUtils.setDataMw(child, undefined);

		// tdNode wraps everything now.
		// Remove template encapsulation from here on.
		// This simplifies the problem of analyzing the <td>
		// for additional fixups (|| Boo || Baz) by potentially
		// invoking 'reparseTemplatedAttributes' on split cells
		// with some modifications.
		while (child) {
			if (child.nodeName === 'SPAN' && child.getAttribute('about') === aboutId) {
				// Remove the encapsulation attributes. If there are no more attributes left,
				// the span wrapper is useless and can be removed.
				child.removeAttribute('about');
				child.removeAttribute('typeof');
				if (DOMDataUtils.noAttrs(child)) {
					var next = child.firstChild || child.nextSibling;
					DOMUtils.migrateChildren(child, tdNode, child);
					child.parentNode.removeChild(child);
					child = next;
				} else {
					child = child.nextSibling;
				}
			} else {
				child = child.nextSibling;
			}
		}
	}

	/**
	 * Collect potential attribute content.
	 *
	 * We expect this to be text nodes without a pipe character followed by one or
	 * more nowiki spans, followed by a template encapsulation with pure-text and
	 * nowiki content. Collection stops when encountering other nodes or a pipe
	 * character.
	 */
	collectAttributishContent(env, node, templateWrapper) {
		var buf = [];
		var nowikis = [];
		var transclusionNode = templateWrapper ||
				(DOMDataUtils.hasTypeOf(node, 'mw:Transclusion') ? node : null);

		// Build the result.
		var buildRes = function() {
			return {
				txt: buf.join(''),
				nowikis: nowikis,
				transclusionNode: transclusionNode,
			};
		};
		var child = node.firstChild;

		/*
		 * In this loop below, where we are trying to collect text content,
		 * it is safe to use child.textContent since textContent skips over
		 * comments. See this transcript of a node session:
		 *
		 *   > d.body.childNodes[0].outerHTML
		 *   '<span><!--foo-->bar</span>'
		 *   > d.body.childNodes[0].textContent
		 *   'bar'
		 *
		 * PHP parser strips comments during parsing, i.e. they don't impact
		 * how other wikitext constructs are parsed. So, in this code below,
		 * we have to skip over comments.
		 */
		while (child) {
			if (DOMUtils.isComment(child)) {
				// <!--foo--> are not comments in CSS and PHP parser strips them
			} else if (DOMUtils.isText(child)) {
				buf.push(child.nodeValue);
			} else if (child.nodeName !== 'SPAN') {
				// The idea here is that style attributes can only
				// be text/comment nodes, and nowiki-spans at best.
				// So, if we hit anything else, there is nothing more
				// to do here!
				return buildRes();
			} else {
				var typeOf = child.getAttribute('typeof') || '';
				if (/^mw:Entity$/.test(typeOf)) {
					buf.push(child.textContent);
				} else if (/^mw:Nowiki$/.test(typeOf)) {
					// Nowiki span were added to protect otherwise
					// meaningful wikitext chars used in attributes.

					// Save the content.
					nowikis.push(child.textContent);
					// And add in a marker to splice out later.
					buf.push('<nowiki>');
				} else if (this.isSimpleTemplatedSpan(child)) {
					// And only handle a single nested transclusion for now.
					// TODO: Handle data-mw construction for multi-transclusion content
					// as well, then relax this restriction.
					//
					// If we already had a transclusion node, we return
					// without attempting to fix this up.
					if (transclusionNode) {
						env.log("error/dom/tdfixup", "Unhandled TD-fixup scenario.",
							"Encountered multiple transclusion children of a <td>");
						return { transclusionNode: null };
					}

					// We encountered a transclusion wrapper
					buf.push(child.textContent);
					transclusionNode = child;
				} else if (transclusionNode && (!child.hasAttribute('typeof')) &&
						child.getAttribute('about') === transclusionNode.getAttribute('about') &&
						DOMUtils.allChildrenAreTextOrComments(child)) {
					// Continue accumulating only if we hit grouped template content
					buf.push(child.textContent);
				} else {
					return buildRes();
				}
			}

			// Are we done accumulating?
			if (buf.length > 0 && /(?:^|[^|])\|(?:[^|]|$)/.test(JSUtils.lastItem(buf))) {
				return buildRes();
			}

			child = child.nextSibling;
		}

		return buildRes();
	}

	/**
	 * T46498, second part of T52603
	 *
	 * Handle wikitext like
	 * ```
	 * {|
	 * |{{nom|Bar}}
	 * |}
	 * ```
	 * where nom expands to `style="foo" class="bar"|Bar`. The attributes are
	 * tokenized and stripped from the table contents.
	 *
	 * This method works well for the templates documented in
	 * https://en.wikipedia.org/wiki/Template:Table_cell_templates/doc
	 *
	 * Nevertheless, there are some limitations:
	 * - We assume that attributes don't contain wiki markup (apart from <nowiki>)
	 *   and end up in text or nowiki nodes.
	 * - Only a single table cell is produced / opened by the template that
	 *   contains the attributes. This limitation could be lifted with more
	 *   aggressive re-parsing if really needed in practice.
	 * - There is only a single transclusion in the table cell content. This
	 *   limitation can be lifted with more advanced data-mw construction.
	 */
	reparseTemplatedAttributes(frame, node, templateWrapper) {
		const env = frame.env;
		// Collect attribute content and examine it
		var attributishContent = this.collectAttributishContent(env, node, templateWrapper);

		// Check for the pipe character in the attributish text.
		if (!/^[^|]+\|([^|].*)?$/.test(attributishContent.txt)) {
			return;
		}

		// Try to re-parse the attributish text content
		var attributishPrefix = attributishContent.txt.match(/^[^|]+\|/)[0];

		// Splice in nowiki content.  We added in <nowiki> markers to prevent the
		// above regexps from matching on nowiki-protected chars.
		if (/<nowiki>/.test(attributishPrefix)) {
			attributishPrefix = attributishPrefix.replace(/<nowiki>/g, function() {
				// This is a little tricky.  We want to use the content from the
				// nowikis to reparse the string to kev/val pairs but the rule,
				// single_cell_table_args, will invariably get tripped up on
				// newlines which, to this point, were shuttled through in the
				// nowiki.  php's santizer will do this replace in attr vals so
				// it's probably a safe assumption ...
				return attributishContent.nowikis.shift().replace(/\s+/g, ' ');
			});
		}

		// re-parse the attributish prefix
		var attributeTokens = this.tokenizer
				.tokenizeTableCellAttributes(attributishPrefix, false);

		// No attributes => nothing more to do!
		if (attributeTokens instanceof Error) {
			return;
		}

		// Note that `row_syntax_table_args` (the rule used for tokenizing above)
		// returns an array consisting of [table_attributes, spaces, pipe]
		const attrs = attributeTokens[0];

		// Found attributes; sanitize them
		// and transfer the sanitized attributes to the td node
		Sanitizer.applySanitizedArgs(env, node, attrs);

		// If the transclusion node was embedded within the td node,
		// lift up the about group to the td node.
		var transclusionNode = attributishContent.transclusionNode;
		if (transclusionNode !== null && node !== transclusionNode) {
			this.hoistTransclusionInfo(frame, transclusionNode, node);
		}

		// Drop nodes that have been consumed by the reparsed attribute content.
		var n = node.firstChild;
		while (n) {
			if (/[|]/.test(n.textContent)) {
				// Remove the consumed prefix from the text node
				var nValue = n.nodeName === '#text' ? n.nodeValue : n.textContent;
				// and convert it into a simple text node
				node.replaceChild(node.ownerDocument.createTextNode(nValue.replace(/^[^|]*[|]/, '')), n);
				break;
			} else {
				var next = n.nextSibling;
				// content was consumed by attributes, so just drop it from the cell
				node.removeChild(n);
				n = next;
			}
		}
	}

	needsReparsing(node) {
		var testRE = node.nodeName === 'TD' ? /[|]/ : /[!|]/;
		var child = node.firstChild;
		while (child) {
			if (DOMUtils.isText(child) && testRE.test(child.textContent)) {
				return true;
			} else if (child.nodeName === 'SPAN') {
				if (WTUtils.hasParsoidAboutId(child) && testRE.test(child.textContent)) {
					return true;
				}
			}
			child = child.nextSibling;
		}

		return false;
	}

	handleTableCellTemplates(node, frame) {
		// Don't bother with literal HTML nodes or nodes that don't need reparsing.
		if (WTUtils.isLiteralHTMLNode(node) || !this.needsReparsing(node)) {
			return true;
		}

		// If the cell didn't have attrs, extract and reparse templated attrs
		var about;
		var dp = DOMDataUtils.getDataParsoid(node);
		var hasAttrs = !(dp.tmp && dp.tmp.noAttrs);

		if (!hasAttrs) {
			about = node.getAttribute("about");
			var templateWrapper = DOMUtils.hasTypeOf(node, 'mw:Transclusion') ?
				node : null;
			this.reparseTemplatedAttributes(frame, node, templateWrapper);
		}

		// Now, examine the <td> to see if it hides additional <td>s
		// and split it up if required.
		//
		// DOMTraverser will process the new cell and invoke
		// handleTableCellTemplates on it which ensures that
		// if any addition attribute fixup or splits are required,
		// they will get done.
		var newCell;
		var ownerDoc = node.ownerDocument;
		var child = node.firstChild;
		while (child) {
			var next = child.nextSibling;

			if (newCell) {
				newCell.appendChild(child);
			} else if (DOMUtils.isText(child) || this.isSimpleTemplatedSpan(child)) {
				var cellName = node.nodeName.toLowerCase();
				var hasSpanWrapper = !DOMUtils.isText(child);
				var match;

				if (cellName === 'td') {
					match = child.textContent.match(/^(.*?[^|])?\|\|([^|].*)?$/);
				} else { /* cellName === 'th' */
					// Find the first match of || or !!
					var match1 = child.textContent.match(/^(.*?[^|])?\|\|([^|].*)?$/);
					var match2 = child.textContent.match(/^(.*?[^!])?\!\!([^!].*)?$/);
					if (match1 && match2) {
						match = (match1[1] || '').length < (match2[1] || '').length ? match1 : match2;
					} else {
						match = match1 || match2;
					}
				}

				if (match) {
					child.textContent = match[1] || '';

					newCell = ownerDoc.createElement(cellName);
					if (hasSpanWrapper) {
						// Fix up transclusion wrapping
						about = child.getAttribute('about');
						this.hoistTransclusionInfo(frame, child, node);
					} else {
						// Refetch the about attribute since 'reparseTemplatedAttributes'
						// might have added one to it.
						about = node.getAttribute('about');
					}

					// about may not be present if the cell was inside
					// wrapped template content rather than being part
					// of the outermost wrapper.
					if (about) {
						newCell.setAttribute('about', about);
					}
					newCell.appendChild(ownerDoc.createTextNode(match[2] || ''));
					node.parentNode.insertBefore(newCell, node.nextSibling);

					// Set data-parsoid noAttrs flag
					var newCellDP = DOMDataUtils.getDataParsoid(newCell);
					newCellDP.tmp.noAttrs = true;
				}
			}

			child = next;
		}

		return true;
	}
}

if (typeof module === "object") {
	module.exports.TableFixups = TableFixups;
}
