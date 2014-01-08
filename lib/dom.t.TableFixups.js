"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
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

		// Now update data-mw
		// XXX: use data.mw instead, see
		// https://bugzilla.wikimedia.org/show_bug.cgi?id=53109
		var dataMW = DU.getJSONAttribute(nextNode, 'data-mw'),
			nodeSrc = DU.getWTSource(env, node);
		if (!dataMW.parts) {
			dataMW.parts = [];
		}
		dataMW.parts.unshift(nodeSrc);
		DU.setJSONAttribute(nextNode, 'data-mw', dataMW);

		// Delete the duplicated <td> node.
		node.parentNode.removeChild(node);
		// This node was deleted, so don't continue processing on it.
		return nextNode;
	}

	return true;
};


/**
 * Helpers for reparseTemplatedAttributes
 */
TableFixups.prototype.hasOnlyOneTransclusionChild = function (node) {
	var n = 0;
	node.childNodes.forEach(function(n) {
		if (DU.isFirstEncapsulationWrapperNode(n)) {
			n++;
		}
		if (n > 1) {
			return false;
		}
	});
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
TableFixups.prototype.collectAttributishContent = function (node) {
	var buf = [],
		nodes = [],
		transclusionNode,
		// Build the result.
		buildRes = function () {
			return {
				txt: buf.join(''),
				nodes: nodes,
				transclusionNode: transclusionNode
			};
		},
		child = node.firstChild;
	while (child) {
		if (!transclusionNode &&
				child.nodeType === node.TEXT_NODE &&
				! /[|]/.test(child.nodeValue))
		{
			buf.push(child.nodeValue);
		} else if (transclusionNode &&
				child.nodeName === 'SPAN' &&
				DU.hasTypeOf(child, 'mw:Nowiki'))
		{
			buf.push(child.textContent);
		} else if (child.nodeName === 'SPAN' &&
				child.childNodes.length === 1 &&
				(child.getAttribute('typeof') === null &&
				 transclusionNode &&
				 child.getAttribute('about') === transclusionNode.getAttribute('about') ||
				 DU.hasTypeOf(child, 'mw:Transclusion')))
		{
			buf.push(child.textContent);
			if (!transclusionNode && DU.hasTypeOf(child, 'mw:Transclusion')) {
				transclusionNode = child;
			}
		} else {
			return buildRes();
		}
		nodes.push(child);
		if (/[|]/.test(buf.last())) {
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
TableFixups.prototype.reparseTemplatedAttributes = function (env, node) {
	var dp = DU.getDataParsoid( node );

	// Cheap checks first
	if (!DU.isLiteralHTMLNode(node) &&
		// We use the dsr start tag width as a proxy for 'has no attributes
		// yet'. We accept '|' and '||' (row-based syntax), so at most two
		// chars.
		dp.dsr && dp.dsr[2] !== null && dp.dsr[2] <= 2)
	{
		// Now actually look at the content
		var attributishContent = this.collectAttributishContent(node),
			transclusionNode = attributishContent.transclusionNode;

			// First of all make sure we have a transclusion that produces leading
			// text content
		if ( transclusionNode &&
				// Check for the pipe character in the attributish text.
				// Also make sure that we only trigger for simple
				// attribute-only cases for now.  Don't handle |{{multicells}}
				// where multicells expands to something like style="foo"| Bar
				// || Baz
				/^[^|]+[|][^|]*$/.test(attributishContent.txt) &&
				// And only handle a single nested transclusion for now
				// TODO: Handle data-mw construction for multi-transclusion content as
				// well, then relax this restriction.
				this.hasOnlyOneTransclusionChild(node)
		   )
		{
			//console.log(node.data.parsoid.dsr, JSON.stringify(attributishText));

			// Try to re-parse the attributish text content
			var attributishPrefix = attributishContent.txt.match(/^[^|]+\|/)[0],
				// re-parse the attributish prefix
				attributeTokens = this.tokenizer
					.tokenizeTableCellAttributes(attributishPrefix);
			if (attributeTokens) {
				// Found attributes.

				// Sanitize them
				var sanitizedToken = this.sanitizer
					.sanitizeTokens(
							[new TagTk(node.nodeName.toLowerCase(),
								attributeTokens[0])])[0];
				//console.log(JSON.stringify(sanitizedToken));

				// and transfer the sanitized attributes to the td node
				sanitizedToken.attribs.forEach(function(kv) {
					node.setAttribute(kv.k, kv.v);
				});

				// Update the template encapsulation including data-mw

				// Lift up the about group to our td node.
				node.setAttribute('typeof', transclusionNode.getAttribute('typeof'));
				node.setAttribute('about', transclusionNode.getAttribute('about'));
				var dataMW = DU.getJSONAttribute(transclusionNode, 'data-mw'),
					parts = dataMW.parts,
					tnDP = DU.getDataParsoid( transclusionNode );
				// Get the td and content source up to the transclusion start
				parts.unshift(env.page.src.substring( dp.dsr[0], tnDP.dsr[0] ));
				// Add wikitext for the table cell content following the
				// transclusion. This is safe as we are currently only
				// handling a single transclusion in the content, which is
				// guaranteed to have a dsr that covers the transclusion
				// itself.
				parts.push(env.page.src.substring( tnDP.dsr[1], dp.dsr[1] ));

				// Save the new data-mw on the td node
				// XXX: use data.mw instead, see
				// https://bugzilla.wikimedia.org/show_bug.cgi?id=53109
				DU.setJSONAttribute(node, 'data-mw', {parts: parts});
				dp.pi = tnDP.pi;

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
						// content was consumed by attributes, so just drop it
						// from the cell
						node.removeChild(n);
					}
				}
				// Remove template encapsulation from other children. The
				// table cell wraps everything now.
				node.childNodes.map(function(childNode) {
					if (childNode.getAttribute && childNode.getAttribute('about')) {
						childNode.removeAttribute('about');
					}
				});
			}
		}
	}
	return true;
};

if (typeof module === "object") {
	module.exports.TableFixups = TableFixups;
}
