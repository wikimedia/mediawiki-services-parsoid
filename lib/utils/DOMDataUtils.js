/**
 * These helpers pertain to HTML and data attributes of a node.
 * @module
 */

'use strict';

const semver = require('semver');
const { DOMUtils } = require('./DOMUtils.js');
const { JSUtils } = require('./jsutils.js');

class DOMDataUtils {
	// The following getters and setters load from the .dataobject store,
	// with the intention of eventually moving them off the nodes themselves.

	static getNodeData(node) {
		if (!node.dataobject) {
			node.dataobject = {};
		}
		console.assert(!node.dataobject.stored);
		return node.dataobject;
	}

	static getDataParsoid(node) {
		var data = this.getNodeData(node);
		if (!data.parsoid) {
			data.parsoid = {};
		}
		if (!data.parsoid.tmp) {
			data.parsoid.tmp = {};
		}
		return data.parsoid;
	}

	static getDataMw(node) {
		var data = this.getNodeData(node);
		if (!data.mw) {
			data.mw = {};
		}
		return data.mw;
	}

	static validDataMw(node) {
		return !!Object.keys(this.getDataMw(node)).length;
	}

	static setDataParsoid(node, dpObj) {
		var data = this.getNodeData(node);
		data.parsoid = dpObj;
	}

	static setDataMw(node, dmObj) {
		var data = this.getNodeData(node);
		data.mw = dmObj;
	}

	static setNodeData(node, data) {
		node.dataobject = data;
	}

	/**
	 * Get an object from a JSON-encoded XML attribute on a node.
	 *
	 * @param {Node} node
	 * @param {string} name Name of the attribute
	 * @param {any} defaultVal What should be returned if we fail to find a valid JSON structure
	 */
	static getJSONAttribute(node, name, defaultVal) {
		if (!DOMUtils.isElt(node)) {
			return defaultVal;
		}
		var attVal = node.getAttribute(name);
		if (!attVal) {
			return defaultVal;
		}
		try {
			return JSON.parse(attVal);
		} catch (e) {
			console.warn('ERROR: Could not decode attribute-val ' + attVal +
					' for ' + name + ' on node ' + node.outerHTML);
			return defaultVal;
		}
	}

	/**
	 * Set an attribute on a node to a JSON-encoded object.
	 *
	 * @param {Node} node
	 * @param {string} name Name of the attribute.
	 * @param {Object} obj
	 */
	static setJSONAttribute(node, name, obj) {
		node.setAttribute(name, JSON.stringify(obj));
	}

	// Similar to the method on tokens
	static setShadowInfo(node, name, val, origVal) {
		if (val === origVal || origVal === null) { return; }
		var dp = this.getDataParsoid(node);
		if (!dp.a) { dp.a = {}; }
		if (!dp.sa) { dp.sa = {}; }
		if (origVal !== undefined &&
				// FIXME: This is a hack to not overwrite already shadowed info.
				// We should either fix the call site that depends on this
				// behaviour to do an explicit check, or double down on this
				// by porting it to the token method as well.
				!dp.a.hasOwnProperty(name)) {
			dp.sa[name] = origVal;
		}
		dp.a[name] = val;
	}

	static addAttributes(elt, attrs) {
		Object.keys(attrs).forEach(function(k) {
			if (attrs[k] !== null && attrs[k] !== undefined) {
				elt.setAttribute(k, attrs[k]);
			}
		});
	}

	// Similar to the method on tokens
	static addNormalizedAttribute(node, name, val, origVal) {
		node.setAttribute(name, val);
		this.setShadowInfo(node, name, val, origVal);
	}

	/**
	 * Test if a node matches a given typeof.
	 */
	static hasTypeOf(node, type) {
		if (!node.getAttribute) {
			return false;
		}
		var typeOfs = node.getAttribute('typeof');
		if (!typeOfs) {
			return false;
		}
		return typeOfs.split(' ').indexOf(type) !== -1;
	}

	/**
	 * Add a type to the typeof attribute. This method works for both tokens
	 * and DOM nodes as it only relies on getAttribute and setAttribute, which
	 * are defined for both.
	 */
	static addTypeOf(node, type) {
		var typeOf = node.getAttribute('typeof');
		if (typeOf) {
			var types = typeOf.split(' ');
			if (types.indexOf(type) === -1) {
				// not in type set yet, so add it.
				types.push(type);
			}
			node.setAttribute('typeof', types.join(' '));
		} else {
			node.setAttribute('typeof', type);
		}
	}

	/**
	 * Remove a type from the typeof attribute. This method works on both
	 * tokens and DOM nodes as it only relies on
	 * getAttribute/setAttribute/removeAttribute.
	 */
	static removeTypeOf(node, type) {
		var typeOf = node.getAttribute('typeof');
		function notType(t) {
			return t !== type;
		}
		if (typeOf) {
			var types = typeOf.split(' ').filter(notType);

			if (types.length) {
				node.setAttribute('typeof', types.join(' '));
			} else {
				node.removeAttribute('typeof');
			}
		}
	}

	/**
	 * Removes the `data-*` attribute from a node, and migrates the data to the
	 * document's JSON store. Generates a unique id with the following format:
	 * ```
	 * mw<base64-encoded counter>
	 * ```
	 * but attempts to keep user defined ids.
	 */
	static storeInPageBundle(node, env, data) {
		var uid = node.getAttribute('id');
		var document = node.ownerDocument;
		var pb = this.getDataParsoid(document).pagebundle;
		var docDp = pb.parsoid;
		var origId = uid || null;
		if (docDp.ids.hasOwnProperty(uid)) {
			uid = null;
			// FIXME: Protect mw ids while tokenizing to avoid false positives.
			env.log('info', 'Wikitext for this page has duplicate ids: ' + origId);
		}
		if (!uid) {
			do {
				docDp.counter += 1;
				uid = 'mw' + JSUtils.counterToBase64(docDp.counter);
			} while (document.getElementById(uid));
			this.addNormalizedAttribute(node, 'id', uid, origId);
		}
		docDp.ids[uid] = data.parsoid;
		if (data.hasOwnProperty('mw')) {
			pb.mw.ids[uid] = data.mw;
		}
	}

	/**
	 * @param {Document} doc
	 * @param {Object} obj
	 */
	static injectPageBundle(doc, obj) {
		var pb = JSON.stringify(obj);
		var script = doc.createElement('script');
		this.addAttributes(script, {
			id: 'mw-pagebundle',
			type: 'application/x-mw-pagebundle',
		});
		script.appendChild(doc.createTextNode(pb));
		doc.head.appendChild(script);
	}

	/**
	 * @param {Document} doc
	 * @return {Object|null}
	 */
	static extractPageBundle(doc) {
		var pb = null;
		var dpScriptElt = doc.getElementById('mw-pagebundle');
		if (dpScriptElt) {
			dpScriptElt.parentNode.removeChild(dpScriptElt);
			pb = JSON.parse(dpScriptElt.text);
		}
		return pb;
	}

	/**
	 * Applies the `data-*` attributes JSON structure to the document.
	 * Leaves `id` attributes behind -- they are used by citation
	 * code to extract `<ref>` body from the DOM.
	 */
	static applyPageBundle(doc, pb) {
		DOMUtils.visitDOM(doc.body, (node) => {
			if (DOMUtils.isElt(node)) {
				var id = node.getAttribute('id');
				if (pb.parsoid.ids.hasOwnProperty(id)) {
					this.setJSONAttribute(node, 'data-parsoid', pb.parsoid.ids[id]);
				}
				if (pb.mw && pb.mw.ids.hasOwnProperty(id)) {
					// Only apply if it isn't already set.  This means earlier
					// applications of the pagebundle have higher precedence,
					// inline data being the highest.
					if (node.getAttribute('data-mw') === null) {
						this.setJSONAttribute(node, 'data-mw', pb.mw.ids[id]);
					}
				}
			}
		});
	}

	static visitAndLoadDataAttribs(node, markNew) {
		DOMUtils.visitDOM(node, (...args) => this.loadDataAttribs(...args), markNew);
	}

	// These are intended be used on a document after post-processing, so that
	// the underlying .dataobject is transparently applied (in the store case)
	// and reloaded (in the load case), rather than worrying about keeping
	// the attributes up-to-date throughout that phase.  For the most part,
	// using this.ppTo* should be sufficient and using these directly should be
	// avoided.

	static loadDataAttribs(node, markNew) {
		if (!DOMUtils.isElt(node)) {
			return;
		}
		// Reset the node data object's stored state, since we're reloading it
		this.setNodeData(node, {});
		var dp = this.getJSONAttribute(node, 'data-parsoid', {});
		if (markNew) {
			if (!dp.tmp) { dp.tmp = {}; }
			dp.tmp.isNew = (node.getAttribute('data-parsoid') === null);
		}
		this.setDataParsoid(node, dp);
		node.removeAttribute('data-parsoid');
		this.setDataMw(node, this.getJSONAttribute(node, 'data-mw', undefined));
		node.removeAttribute('data-mw');
	}

	static visitAndStoreDataAttribs(node, options) {
		DOMUtils.visitDOM(node, (...args) => this.storeDataAttribs(...args), options);
	}

	/**
	 * @param {Node} node
	 * @param {Object} [options]
	 */
	static storeDataAttribs(node, options) {
		if (!DOMUtils.isElt(node)) { return; }
		options = options || {};
		console.assert(!(options.discardDataParsoid && options.keepTmp));  // Just a sanity check
		var dp = this.getDataParsoid(node);
		// Don't modify `options`, they're reused.
		var discardDataParsoid = options.discardDataParsoid;
		if (dp.tmp.isNew) {
			// Only necessary to support the cite extension's getById,
			// that's already been loaded once.
			//
			// This is basically a hack to ensure that DOMUtils.isNewElt
			// continues to work since we effectively rely on the absence
			// of data-parsoid to identify new elements. But, loadDataAttribs
			// creates an empty {} if one doesn't exist. So, this hack
			// ensures that a loadDataAttribs + storeDataAttribs pair don't
			// dirty the node by introducing an empty data-parsoid attribute
			// where one didn't exist before.
			//
			// Ideally, we'll find a better solution for this edge case later.
			discardDataParsoid = true;
		}
		var data = null;
		if (!discardDataParsoid) {
			// WARNING: keeping tmp might be a bad idea.  It can have DOM
			// nodes, which aren't going to serialize well.  You better know
			// of what you do.
			if (!options.keepTmp) { dp.tmp = undefined; }
			if (options.storeInPageBundle) {
				data = data || {};
				data.parsoid = dp;
			} else {
				this.setJSONAttribute(node, 'data-parsoid', dp);
			}
		}
		// Strip invalid data-mw attributes
		if (this.validDataMw(node)) {
			if (options.storeInPageBundle && options.env &&
					// The pagebundle didn't have data-mw before 999.x
					semver.satisfies(options.env.outputContentVersion, '^999.0.0')) {
				data = data || {};
				data.mw = this.getDataMw(node);
			} else {
				this.setJSONAttribute(node, 'data-mw', this.getDataMw(node));
			}
		}
		// Store pagebundle
		if (data !== null) {
			this.storeInPageBundle(node, options.env, data);
		}
		// Indicate that this node's data has been stored so that if we try
		// to access it after the fact we're aware.
		const nd = this.getNodeData(node);
		nd.stored = true;
	}
}

if (typeof module === "object") {
	module.exports.DOMDataUtils = DOMDataUtils;
}
