/**
 * These utilities are for processing content that's generated
 * by parsing source input (ex: wikitext)
 *
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const XMLSerializer = require('../wt2html/XMLSerializer.js');

const { DOMDataUtils } = require('./DOMDataUtils.js');
const { DOMPostOrder } = require('./DOMPostOrder.js');
const { DOMUtils } = require('./DOMUtils.js');
const { Util } = require('./Util.js');
const { WTUtils } = require('./WTUtils.js');

class ContentUtils {
	/**
	 * XML Serializer.
	 *
	 * @param {Node} node
	 * @param {Object} [options] XMLSerializer options.
	 * @return {string}
	 */
	static toXML(node, options) {
		return XMLSerializer.serialize(node, options).html;
	}

	/**
	 * .dataobject aware XML serializer, to be used in the DOM
	 * post-processing phase.
	 *
	 * @param {Node} node
	 * @param {Object} [options]
	 * @return {string}
	 */
	static ppToXML(node, options) {
		// We really only want to pass along `options.keepTmp`
		DOMDataUtils.visitAndStoreDataAttribs(node, options);
		return this.toXML(node, options);
	}

	/**
	 * .dataobject aware HTML parser, to be used in the DOM
	 * post-processing phase.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {string} html
	 * @param {Object} [options]
	 * @return {Node}
	 */
	static ppToDOM(env, html, options) {
		options = options || {};
		var node = options.node;
		if (node === undefined) {
			node = env.createDocument(html).body;
		} else {
			node.innerHTML = html;
		}
		if (options.reinsertFosterableContent) {
			DOMUtils.visitDOM(node, (n, ...args) => {
				// untunnel fostered content
				const meta = WTUtils.reinsertFosterableContent(env, n, true);
				n = (meta !== null) ? meta : n;

				// load data attribs
				DOMDataUtils.loadDataAttribs(n, ...args);
			}, options);
		} else {
			// load data attribs
			DOMDataUtils.visitAndLoadDataAttribs(node, options);
		}
		return node;
	}

	/**
	 * Pull the data-parsoid script element out of the doc before serializing.
	 *
	 * @param {Node} node
	 * @param {Object} [options] XMLSerializer options.
	 * @return {string}
	 */
	static extractDpAndSerialize(node, options) {
		if (!options) { options = {}; }
		var pb = DOMDataUtils.extractPageBundle(DOMUtils.isBody(node) ? node.ownerDocument : node);
		var out = XMLSerializer.serialize(node, options);
		out.pb = pb;
		return out;
	}

	static stripSectionTagsAndFallbackIds(node) {
		var n = node.firstChild;
		while (n) {
			var next = n.nextSibling;
			if (DOMUtils.isElt(n)) {
				// Recurse into subtree before stripping this
				this.stripSectionTagsAndFallbackIds(n);

				// Strip <section> tags
				if (WTUtils.isParsoidSectionTag(n)) {
					DOMUtils.migrateChildren(n, n.parentNode, n);
					n.parentNode.removeChild(n);
				}

				// Strip <span typeof='mw:FallbackId' ...></span>
				if (WTUtils.isFallbackIdSpan(n)) {
					n.parentNode.removeChild(n);
				}
			}
			n = next;
		}
	}

	/**
	 * Shift the DSR of a DOM fragment.
	 */
	static shiftDSR(env, rootNode, dsrFunc) {
		/* eslint-disable no-use-before-define */ // mutual recursion ftw
		const dsrThunk = (dsr) => {
			// Clone the dsr
			const nDsr = dsrFunc(Array.from(dsr));
			// Map 'null' to 'undefined' in return value.
			return nDsr === null ? undefined : nDsr;
		};
		const convertNode = (node) => {
			if (!DOMUtils.isElt(node)) { return; }
			const dp = DOMDataUtils.getDataParsoid(node);
			if (Array.isArray(dp.dsr)) {
				dp.dsr = dsrThunk(dp.dsr);
			}
			if (Array.isArray(dp.tmp && dp.tmp.origDSR)) {
				dp.tmp.origDSR = dsrThunk(dp.tmp.origDSR);
			}
			if (Array.isArray(dp.extTagOffsets)) {
				dp.extTagOffsets = dsrThunk(dp.extTagOffsets);
			}
			// We don't need to setDataParsoid because dp is not a copy

			// Handle embedded HTML in Language Variant markup
			const dmwv =
				DOMDataUtils.getJSONAttribute(node, 'data-mw-variant', null);
			if (dmwv) {
				if (dmwv.disabled) {
					dmwv.disabled.t = convertString(dmwv.disabled.t);
				}
				if (dmwv.twoway) {
					dmwv.twoway.forEach((l) => {
						l.t = convertString(l.t);
					});
				}
				if (dmwv.oneway) {
					dmwv.oneway.forEach((l) => {
						l.f = convertString(l.f);
						l.t = convertString(l.t);
					});
				}
				if (dmwv.filter) {
					dmwv.filter.t = convertString(dmwv.filter.t);
				}
				DOMDataUtils.setJSONAttribute(node, 'data-mw-variant', dmwv);
			}

			if (DOMUtils.matchTypeOf(node, /^mw:(Image|ExpandedAttrs)$/)) {
				const dmw = DOMDataUtils.getDataMw(node);
				// Handle embedded HTML in template-affected attributes
				if (dmw.attribs) {
					dmw.attribs.forEach(a => a.forEach((kOrV) => {
						if (typeof (kOrV) !== 'string' && kOrV.html) {
							kOrV.html = convertString(kOrV.html);
						}
					}));
				}
				// Handle embedded HTML in figure-inline captions
				if (dmw.caption) {
					dmw.caption = convertString(dmw.caption);
				}
				DOMDataUtils.setDataMw(node, dmw);
			}

			if (DOMUtils.matchTypeOf(node, /^mw:DOMFragment(\/|$)/)) {
				const dp = DOMDataUtils.getDataParsoid(node);
				// Handle embedded HTML in tunneled DOM Fragments
				if (dp.html) {
					const nodes = env.fragmentMap.get(dp.html);
					nodes.forEach((n) => {
						DOMDataUtils.visitAndLoadDataAttribs(n);
						DOMPostOrder(n, convertNode);
						DOMDataUtils.visitAndStoreDataAttribs(n);
					});
				}
			}
		};
		const convertString = (str) => {
			const parentNode = rootNode.ownerDocument.createElement('body');
			const node = ContentUtils.ppToDOM(env, str, { node: parentNode });
			DOMPostOrder(node, convertNode);
			return ContentUtils.ppToXML(node, { innerXML: true });
		};
		/* eslint-enable no-use-before-define */
		DOMPostOrder(rootNode, convertNode);
		return rootNode; // chainable
	}

	/**
	 * Dump the DOM with attributes.
	 *
	 * @param {Node} rootNode
	 * @param {string} title
	 * @param {Object} [options]
	 */
	static dumpDOM(rootNode, title, options) {
		options = options || {};
		if (options.storeDiffMark || options.dumpFragmentMap) { console.assert(options.env); }

		function cloneData(node, clone) {
			if (!DOMUtils.isElt(node)) { return; }
			var d = DOMDataUtils.getNodeData(node);
			DOMDataUtils.setNodeData(clone, Util.clone(d));
			node = node.firstChild;
			clone = clone.firstChild;
			while (node) {
				cloneData(node, clone);
				node = node.nextSibling;
				clone = clone.nextSibling;
			}
		}

		function emit(buf, opts) {
			if ('outBuffer' in opts) {
				opts.outBuffer += buf.join('\n');
			} else if (opts.outStream) {
				opts.outStream.write(buf.join('\n') + '\n');
			} else {
				console.warn(buf.join('\n'));
			}
		}

		// cloneNode doesn't clone data => walk DOM to clone it
		var clonedRoot = rootNode.cloneNode(true);
		cloneData(rootNode, clonedRoot);

		var buf = [];
		if (!options.quiet) {
			buf.push('----- ' + title + ' -----');
		}

		buf.push(ContentUtils.ppToXML(clonedRoot, options));
		emit(buf, options);

		// Dump cached fragments
		if (options.dumpFragmentMap) {
			Array.from(options.env.fragmentMap.keys()).forEach(function(k) {
				buf = [];
				buf.push('='.repeat(15));
				buf.push("FRAGMENT " + k);
				buf.push("");
				emit(buf, options);

				const newOpts = Object.assign({}, options, { dumpFragmentMap: false, quiet: true });
				const fragment = options.env.fragmentMap.get(k);
				ContentUtils.dumpDOM(Array.isArray(fragment) ? fragment[0] : fragment, '', newOpts);
			});
		}

		if (!options.quiet) {
			emit(['-'.repeat(title.length + 12)], options);
		}
	}
}

if (typeof module === "object") {
	module.exports.ContentUtils = ContentUtils;
}
