"use strict";

var Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	Sanitizer = require('./ext.core.Sanitizer.js').Sanitizer,
	defines = require('./mediawiki.parser.defines.js');


// define some constructor shortcuts
var TagTk = defines.TagTk;

/**
 * TableFixups class
 *
 * Provides two DOMTraverser visitors that implement the two parts of
 * https://bugzilla.wikimedia.org/show_bug.cgi?id=50603:
 * - stripDoubleTDs
 * - reparseTemplatedAttributes
 */
function TableFixups (env) {
	/**
	 * Set up some helper objects for reparseTemplatedAttributes
	 */

	/**
	 * Actually the regular tokenizer, but we'll use
	 * tokenizeTableCellAttributes only.
	 */
	this.tokenizer = new PegTokenizer( env );
	// XXX: Don't require us to fake a manager!
	var fakeManager = {
		env: env,
		addTransform: function(){}
	};
	this.sanitizer = new Sanitizer( fakeManager );
}

/**
 * DOM visitor that strips the double td for this test case:
 * |{{echo|{{!}} Foo}}
 *
 * @public
 *
 * See https://bugzilla.wikimedia.org/show_bug.cgi?id=50603
 */
TableFixups.prototype.stripDoubleTDs = function (env, node) {
	var nextNode = node.nextSibling;

	if (!DU.isLiteralHTMLNode(node) &&
		nextNode !== null &&
	    nextNode.nodeName === 'TD' &&
	    !DU.isLiteralHTMLNode(nextNode) &&
		DU.nodeEssentiallyEmpty(node) &&
		(// FIXME: will not be set for nested templates
		 DU.isFirstEncapsulationWrapperNode(nextNode) ||
		 // Hacky work-around for nested templates
		 /^{{.*?}}$/.test( DU.getDataParsoid( nextNode ).src ))
	    )
	{
		// Update the dsr. Since we are coalescing the first
		// node with the second (or, more precisely, deleting
		// the first node), we have to update the second DSR's
		// starting point and start tag width.
		var nodeDSR     = DU.getDataParsoid( node ).dsr,
		    nextNodeDSR = DU.getDataParsoid( nextNode ).dsr;

		if (nodeDSR && nextNodeDSR) {
			nextNodeDSR[0] = nodeDSR[0];
		}

		var dataMW = DU.getDataMw(nextNode),
			nodeSrc = DU.getWTSource(env, node);
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
};

/**
 * Collect potential attribute content
 *
 * We expect this to be text nodes without a pipe character followed by one or
 * more nowiki spans, followed by a template encapsulation with pure-text and
 * nowiki content. Collection stops when encountering other nodes or a pipe
 * character.
 */
TableFixups.prototype.collectAttributishContent = function(env, node, templateWrapper) {
	var buf = [],
		nodes = [],
		transclusionNode = templateWrapper ||
			(DU.hasTypeOf(node, 'mw:Transclusion') ? node : null);

	// Build the result.
	var buildRes = function () {
			return {
				txt: buf.join(''),
				nodes: nodes,
				transclusionNode: transclusionNode
			};
		},
		child = node.firstChild;

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
		if (DU.isComment(child)) { /* jshint noempty:false */
			// <!--foo--> are not comments in CSS and PHP parser strips them
		} else if (DU.isText(child)) {
			buf.push(child.nodeValue);
		} else if (child.nodeName !== 'SPAN') {
			// The idea here is that style attributes can only
			// be text/comment nodes, and nowiki-spans at best.
			// So, if we hit anything else, there is nothing more
			// to do here!
			return buildRes();
		} else if (transclusionNode && DU.hasTypeOf(child, 'mw:Nowiki')) {
			// Nowiki span added in the template to protect otherwise
			// meaningful wikitext chars used in attributes.
			buf.push(child.textContent);
		} else if (DU.hasTypeOf(child, 'mw:Transclusion') &&
				DU.allChildrenAreTextOrComments(child))
		{
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
		} else if (transclusionNode &&
				child.getAttribute('typeof') === null &&
				child.getAttribute('about') === transclusionNode.getAttribute('about') &&
				DU.allChildrenAreTextOrComments(child))
		{
			// Continue accumulating only if we hit grouped template content
			buf.push(child.textContent);
		} else {
			return buildRes();
		}

		nodes.push(child);

		// Are we done accumulating?
		if (/(?:^|[^|])\|(?:[^|]|$)/.test(buf.last())) {
			return buildRes();
		}

		child = child.nextSibling;
	}

	return buildRes();
};

/**
 * Bug 44498, second part of bug 50603
 *
 * @public
 *
 * Handle wikitext like
 *
 * {|
 * |{{nom|Bar}}
 * |}
 *
 * where nom expands to style="foo" class="bar"|Bar. The attributes are
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

TableFixups.prototype.reparseTemplatedAttributes = function(env, node, templateWrapper) {
	// Collect attribute content and examine it
	var attributishContent = this.collectAttributishContent(env, node, templateWrapper),
		transclusionNode = attributishContent.transclusionNode;

	// First of all make sure we have a transclusion
	// that produces leading text content
	if (!transclusionNode
		// Check for the pipe character in the attributish text.
		|| !/^[^|]+\|[^|]*([^|]\|\|[^|]*)*$/.test(attributishContent.txt)
	   )
	{
		return;
	}

	// Try to re-parse the attributish text content
	var attributishPrefix = attributishContent.txt.match(/^[^|]+\|/)[0];
	// re-parse the attributish prefix
	var attributeTokens = this.tokenizer
			.tokenizeTableCellAttributes(attributishPrefix);

	// No attributes => nothing more to do!
	if (!attributeTokens) {
		return;
	}

	// Found attributes.
	// Sanitize them
	var sanitizedToken = this.sanitizer
		.sanitizeTokens(
			[ new TagTk(node.nodeName.toLowerCase(), attributeTokens[0]) ]
		)[0];

	// and transfer the sanitized attributes to the td node
	sanitizedToken.attribs.forEach(function(kv) {
		node.setAttribute(kv.k, kv.v);
	});

	// Update the template encapsulation including data-mw

	// If the transclusion node was embedded within the td node,
	// lift up the about group to the td node.
	if (node !== transclusionNode) {
		node.setAttribute('typeof', transclusionNode.getAttribute('typeof'));
		node.setAttribute('about', transclusionNode.getAttribute('about'));
		var dataMW = DU.getDataMw(transclusionNode),
			parts = dataMW.parts,
			dp = DU.getDataParsoid( node ),
			tnDP = DU.getDataParsoid( transclusionNode );

		// Get the td and content source up to the transclusion start
		if (dp.dsr[0] < tnDP.dsr[0]) {
			parts.unshift(env.page.src.substring( dp.dsr[0], tnDP.dsr[0] ));
		}

		// Add wikitext for the table cell content following the
		// transclusion. This is safe as we are currently only
		// handling a single transclusion in the content, which is
		// guaranteed to have a dsr that covers the transclusion
		// itself.
		if (tnDP.dsr[1] < dp.dsr[1]) {
			parts.push(env.page.src.substring( tnDP.dsr[1], dp.dsr[1] ));
		}

		// Save the new data-mw on the td node
		DU.setDataMw(node, { parts: parts });
		dp.pi = tnDP.pi;
	}

	// Remove the span wrapper
	var attributishNodes = attributishContent.nodes;
	while(attributishNodes.length) {
		var n = attributishNodes.shift();
		if (/[|]/.test(n.textContent)) {
			// Remove the consumed prefix from the text node
			var nValue;
			if (n.nodeName === '#text') {
				nValue = n.nodeValue;
			} else {
				nValue = n.textContent;
			}
			// and convert it into a simple text node
			node.replaceChild(node.ownerDocument.createTextNode(nValue.replace(/^[^|]*[|]/, '')), n);
		} else {
			// content was consumed by attributes, so just drop it from the cell
			node.removeChild(n);
		}
	}

	if (node !== transclusionNode) {
		// Remove template encapsulation from other children.
		// The td node wraps everything now.
		var child = node.firstChild;
		while (child) {
			// Remove the span wrapper -- this simplifies the problem of
			// analyzing the <td> for additional fixups (|| Boo || Baz) by
			// potentially invoking 'reparseTemplatedAttributes' on this cell
			// with some modifications.
			if (child.nodeName === 'SPAN' && child.getAttribute('about')) {
				var next = child.firstChild || child.nextSibling;
				DU.migrateChildren(child, node, child);
				DU.deleteNode(child);
				child = next;
			} else {
				child = child.nextSibling;
			}
		}
	}

	return;
};

// SSS FIXME: It is silly to examine every fricking <td> for possible fixup.
// We only need to examine <td>s that either have mw:Transclusion typeof or
// have a child (not descendent) with a mw:Transclusion typeof.
//
// This info is not readily available right now, but perhaps could be provided
// based on annotating nodes via a tmp attribute during tpl wrapping.
//
// Or, perhaps the tokenizer can mark <td>s that have a transclusion node
// on the same wikitext line.
//
// TO BE DONE.
function needsReparsing(node) {
	var testRE = node.nodeName === 'TD' ? /[|]/ : /[!|]/;
	var child = node.firstChild;
	while (child) {
		if (DU.isText(child) && testRE.test(child.textContent)) {
			return true;
		} else if (child.nodeName === 'SPAN') {
			var about = child.getAttribute("about");
			if (about && Util.isParsoidObjectId(about) && testRE.test(child.textContent)) {
				return true;
			}
		}
		child = child.nextSibling;
	}

	return false;
}

TableFixups.prototype.handleTableCellTemplates = function (env, node) {
	// Don't bother with literal HTML nodes or nodes that don't need reparsing
	if (DU.isLiteralHTMLNode(node) || !needsReparsing(node)) {
		return true;
	}

	// First, fixup the <td> for templated attrs
	var about = node.getAttribute("about");
	var templateWrapper = about && Util.isParsoidObjectId(about) ? node : null;
	this.reparseTemplatedAttributes(env, node, templateWrapper);

	// Now, examine the <td> to see if it hides additional <td>s
	// and split it up if required.
	//
	// DOMTraverser will process the new cell and invoke
	// handleTableCellTemplates on it which ensures that
	// if any addition attribute fixup or splits are required,
	// they will get done.
	var newCell, ownerDoc = node.ownerDocument;
	var child = node.firstChild;
	while (child) {
		var next = child.nextSibling;

		if (newCell) {
			newCell.appendChild(child);
		} else if (DU.isText(child)) {
			var cellName = node.nodeName.toLowerCase(),
				txt1, txt2, match;

			if (cellName === 'td') {
				match = child.textContent.match(/^(.*?[^|])?\|\|([^|].*)?$/);
			} else { /* cellName === 'th' */
				// Find the first match of || or !!
				var match1 = child.textContent.match(/^(.*?[^|])?\|\|([^|].*)?$/);
				var match2 = child.textContent.match(/^(.*?[^!])?\!\!([^!].*)?$/);
				if (match1 && match2) {
					match = (match1[1]||'').length < (match2[1]||'').length ? match1 : match2;
				} else {
					match = match1 || match2;
				}
			}

			if (match) {
				txt1 = match[1] || '';
				txt2 = match[2] || '';
				newCell = ownerDoc.createElement(cellName);
				// Refetch the about attribute since 'reparseTemplatedAttributes'
				// might have added one to it.
				newCell.setAttribute("about", node.getAttribute("about"));
				child.textContent = txt1;
				newCell.appendChild(ownerDoc.createTextNode(txt2));
				node.parentNode.insertBefore(newCell, node.nextSibling);
			}
		}

		child = next;
	}

	return true;
};

if (typeof module === "object") {
	module.exports.TableFixups = TableFixups;
}
