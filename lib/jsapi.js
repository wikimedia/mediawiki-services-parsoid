/*
 * Handy JavaScript API for Parsoid DOM, inspired by the
 * python `mwparserfromhell` package.
 */
'use strict';
require('../lib/core-upgrade.js');

// TO DO:
// extension
// PExtLink#url PWikiLink#title should handle mw:ExpandedAttrs
// make separate package?

var WikitextSerializer = require('../lib/mediawiki.WikitextSerializer.js').WikitextSerializer;
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;
var DOMImpl = require('domino').impl;
var Node = DOMImpl.Node;
var NodeFilter = DOMImpl.NodeFilter;
var util = require('util');

// WTS helper
var wts = function(env, nodes) {
	// XXX: Serializing to wikitext is very user-friendly, but it depends on
	// WTS.serializeDOMSync which we might not want to keep around forever.
	// An alternative would be:
	//    return DU.normalizeOut(node, 'parsoidOnly');
	// which might be almost as friendly.
	var body;
	if (nodes.length === 0) {
		return '';
	} else if (nodes.length === 1 && DU.isBody(nodes[0])) {
		body = nodes[0];
	} else {
		body = nodes[0].ownerDocument.createElement('body');
		for (var i = 0; i < nodes.length; i++) {
			body.appendChild(nodes[i].cloneNode(true));
		}
	}
	return (new WikitextSerializer({ env: env })).serializeDOMSync(body);
};

// noop helper
var noop = function() { };

// Forward declarations of Wrapper classes.
var PNode, PNodeList, PComment, PExtLink, PHeading, PHtmlEntity, PMedia, PTag, PTemplate, PText, PWikiLink;

// HTML escape helper
var toHtmlStr = function(node, v) {
	if (typeof v === 'string') {
		var div = node.ownerDocument.createElement('div');
		div.textContent = v;
		return div.innerHTML;
	} else if (v instanceof PNodeList) {
		return v.container.innerHTML;
	} else {
		return v.outerHTML;
	}
};


/**
 * The PNodeList class wraps a collection of DOM {@link Node}s.
 * It provides methods that can be used to extract data from or
 * modify the nodes.  The `filter()` series of functions is very
 * useful for extracting and iterating over, for example, all
 * of the templates in the project (via {@link #filterTemplates}).
 * @class PNodeList
 * @alternateClassName Parsoid.PNodeList
 */
/**
 * @method constructor
 * @private
 * @param {PDoc} pdoc The parent document for this {@link PNodeList}.
 * @param {PNode|null} parent A {@link PNode} which will receive updates
 *    when this {@link PNodeList} is mutated.
 * @param {Node} container A DOM {@link Node} which is the parent of all
 *    of the DOM {@link Node}s in this {@link PNodeList}.  The container
 *    element itself is *not* considered part of the list.
 * @param {Object} [opts]
 * @param {Function} [opts.update]
 *    A function which will be invoked when {@link #update} is called.
 */
PNodeList = function PNodeList(pdoc, parent, container, opts) {
	this.pdoc = pdoc;
	this.parent = parent;
	this.container = container;
	this._update = (opts && opts.update);
	this._cachedPNodes = null;
};
Object.defineProperties(PNodeList.prototype, {
	/**
	 * Returns an {@link Array} of the DOM {@link Node}s represented
	 * by this {@link PNodeList}.
	 * @property {Node[]}
	 */
	nodes: {
		get: function() { return Array.from(this.container.childNodes); },
	},
	/**
	 * Call {@link #update} after manually mutating any of the DOM
	 * {@link Node}s represented by this {@link PNodeList} in order to
	 * ensure that any containing templates are refreshed with their
	 * updated contents.
	 *
	 * The mutation methods in the {@link PDoc}/{@link PNodeList} API
	 * automatically call {@link #update} for you when required.
	 * @method
	 */
	update: { value: function() {
		this._cachedPNodes = null;
		if (this._update) { this._update(); }
		if (this.parent) { this.parent.update(); }
	}, },
	_querySelectorAll: { value: function(selector) {
		var tweakedSelector = ',' + selector + ',';
		if (!(/,(COMMENT|TEXT),/.test(tweakedSelector))) {
			// Use fast native querySelectorAll
			return Array.from(this.container.querySelectorAll(selector));
		}
		// Implement comment/text node selector the hard way
		/* jshint bitwise: false */
		var whatToShow = NodeFilter.SHOW_ELEMENT; // always show templates
		if (/,COMMENT,/.test(tweakedSelector)) {
			whatToShow = whatToShow | NodeFilter.SHOW_COMMENT;
		}
		if (/,TEXT,/.test(tweakedSelector)) {
			whatToShow = whatToShow | NodeFilter.SHOW_TEXT;
		}
		var nodeFilter = function(node) {
			if (node.nodeType !== Node.ELEMENT_NODE) {
				return NodeFilter.FILTER_ACCEPT;
			}
			if (node.matches(PTemplate._selector)) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		};
		var result = [];
		var includeTemplates =
			/,\[typeof~="mw:Transclusion"\],/.test(tweakedSelector);
		var treeWalker = this.pdoc.document.createTreeWalker(
			this.container, whatToShow, nodeFilter, false
		);
		while (treeWalker.nextNode()) {
			var node = treeWalker.currentNode;
			// We don't need the extra test for ELEMENT_NODEs yet, since
			// non-template element nodes will be skipped by the nodeFilter
			// above. But if we ever extend filter() to be fully generic,
			// we might need the commented-out portion of this test.
			if (node.nodeType === Node.ELEMENT_NODE /* &&
				node.matches(PTemplate._selector) */
			) {
				treeWalker.lastChild(); // always skip over all children
				if (!includeTemplates) {
					continue; // skip template itself
				}
			}
			result.push(node);
		}
		return result;
	}, },
	_templatesForNode: { value: function(node) {
		// each Transclusion node could represent multiple templates.
		var parent = this;
		var result = [];
		DU.getDataMw(node).parts.forEach(function(part, i) {
			if (part.template) {
				result.push(new PTemplate(parent.pdoc, parent, node, i));
			}
		});
		return result;
	}, },
	/**
	 * @method
	 * @private
	 * @param {Array} result
	 *   A result array to append new items to as they are found
	 * @param {string} selector
	 *   CSS-style selector for the nodes of interest
	 * @param {Function} func
	 *    Function to apply to every non-template match
	 * @param {Object} [opts]
	 * @param {boolean} [opts.recursive]
	 *    Set to `false` to avoid recursing into templates.
	 */
	_filter: { value: function(result, selector, func, opts) {
		var self = this;
		var recursive = (opts && opts.recursive) !== false;
		var tSelector = PTemplate._selector;
		if (selector) {
			tSelector += ',' + selector;
		}
		this._querySelectorAll(tSelector).forEach(function(node) {
			var isTemplate = node.nodeType === Node.ELEMENT_NODE &&
				node.matches(PTemplate._selector);
			if (isTemplate) {
				self._templatesForNode(node).forEach(function(t) {
					if (!selector) {
						result.push(t);
					}
					if (recursive) {
						t.params.forEach(function(k) {
							var td = t.get(k);
							['key', 'value'].forEach(function(prop) {
								if (td[prop]) {
									td[prop]._filter(result, selector, func, opts);
								}
							});
						});
					}
				});
			} else {
				func(result, self, node, opts);
			}
		});
		return result;
	}, },

	/**
	 * Return an array of {@link PComment} representing comments
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PComment[]}
	 */
	filterComments: { value: function(opts) {
		return this._filter([], PComment._selector, function(r, parent, node, opts) {
			r.push(new PComment(parent.pdoc, parent, node));
		}, opts);
	}, },

	/**
	 * Return an array of {@link PExtLink} representing external links
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PExtLink[]}
	 */
	filterExtLinks: { value: function(opts) {
		return this._filter([], PExtLink._selector, function(r, parent, node, opts) {
			r.push(new PExtLink(parent.pdoc, parent, node));
		}, opts);
	}, },

	/**
	 * Return an array of {@link PHeading} representing headings
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PHeading[]}
	 */
	filterHeadings: { value: function(opts) {
		return this._filter([], PHeading._selector, function(r, parent, node, opts) {
			r.push(new PHeading(parent.pdoc, parent, node));
		}, opts);
	}, },

	/**
	 * Return an array of {@link PHtmlEntity} representing HTML entities
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PHtmlEntity[]}
	 */
	filterHtmlEntities: { value: function(opts) {
		return this._filter([], PHtmlEntity._selector, function(r, parent, node, opts) {
			r.push(new PHtmlEntity(parent.pdoc, parent, node));
		}, opts);
	}, },

	/**
	 * Return an array of {@link PMedia} representing images or other
	 * media content found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PMedia[]}
	 */
	filterMedia: { value: function(opts) {
		return this._filter([], PMedia._selector, function(r, parent, node, opts) {
			r.push(new PMedia(parent.pdoc, parent, node));
		}, opts);
	}, },

	/**
	 * Return an array of {@link PTemplate} representing templates
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PTemplate[]}
	 */
	filterTemplates: { value: function(opts) {
		return this._filter([], null, null, opts);
	}, },

	/**
	 * Return an array of {@link PText} representing plain text
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PText[]}
	 */
	filterText: { value: function(opts) {
		return this._filter([], PText._selector, function(r, parent, node, opts) {
			r.push(new PText(parent.pdoc, parent, node));
		}, opts);
	}, },

	/**
	 * Return an array of {@link PWikiLink} representing wiki links
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PWikiLink[]}
	 */
	filterWikiLinks: { value: function(opts) {
		return this._filter([], PWikiLink._selector, function(r, parent, node, opts) {
			r.push(new PWikiLink(parent.pdoc, parent, node));
		}, opts);
	}, },

	/**
	 * Internal list of PNodes in this list.
	 * @property {PNode[]}
	 * @private
	 */
	pnodes: { get: function() {
		if (this._cachedPNodes !== null) {
			return this._cachedPNodes;
		}
		var templates = new Set();
		var result = [];
		OUTER: for (var i = 0; i < this.container.childNodes.length; i++) {
			var node = this.container.childNodes.item(i);
			if (node.nodeType === Node.TEXT_NODE) {
				result.push(new PText(this.pdoc, this, node));
				continue;
			}
			if (node.nodeType === Node.COMMENT_NODE) {
				result.push(new PComment(this.pdoc, this, node));
				continue;
			}
			if (node.nodeType === Node.ELEMENT_NODE) {
				// Note: multiple PTemplates per Node, and possibly
				// multiple Nodes per PTemplate.
				if (node.matches(PTemplate._selector)) {
					templates.add(node.getAttribute('about'));
					this._templatesForNode(node).forEach(function(t) {
						result.push(t);
					});
					continue;
				} else if (templates.has(node.getAttribute('about'))) {
					continue;
				}
				// PTag is the catch-all; it should always be last.
				var which = [
					PExtLink, PHeading, PHtmlEntity, PMedia, PWikiLink,
					PTag,
				];
				for (var j = 0; j < which.length; j++) {
					var Ty = which[j];
					if (node.matches(Ty._selector)) {
						result.push(new Ty(this.pdoc, this, node));
						continue OUTER;
					}
				}
			}
			// Unknown type.
			result.push(new PNode(this.pdoc, this, node));
		}
		return (this._cachedPNodes = result);
	}, },

	/**
	 * The number of nodes within the node list.
	 * @property {Number}
	 */
	length: { get: function() { return this.pnodes.length; }, },

	/**
	 * Return the `index`th node within the node list.
	 * @param {Number} index
	 * @return {PNode}
	 */
	get: { value: function(index) { return this.pnodes[index]; }, },

	/**
	 * Return the index of `target` in the list of nodes, or `-1` if
	 * the target was not found.
	 *
	 * If `recursive` is true, we will look in all nodes of ours and
	 * their descendants, and return the index of our direct descendant
	 * node which contains the target.  Otherwise, the search is done
	 * only on direct descendants.
	 *
	 * If `fromIndex` is provided, it is the index to start the search
	 * at.
	 * @param {PNode|Node} target
	 * @param {Object} [options]
	 * @param {Boolean} [options.recursive=false]
	 * @param {Number} [options.fromIndex=0]
	 */
	indexOf: { value: function(target, options) {
		var recursive = Boolean(options && options.recursive);
		var fromIndex = Number(options && options.fromIndex) || 0;
		var child, children;
		var i, j;
		if (target instanceof PNode) {
			target = target.node;
		}
		for (i = fromIndex; i < this.length; i++) {
			child = this.get(i);
			if (child.matches(target)) {
				return i;
			}
			if (recursive) {
				children = child._children();
				for (j = 0; j < children.length; j++) {
					if (children[j].indexOf(target, options) !== -1) {
						return i;
					}
				}
			}
		}
		return -1;
	}, },

	/**
	 * Return a string representing the contents of this object
	 * as HTML conforming to the
	 * [MediaWiki DOM specification](https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec).
	 * @return {String}
	 */
	toHtml: { value: function() {
		return this.container.innerHTML;
	}, },

	/**
	 * Return a string representing the contents of this object as wikitext.
	 * @return {String}
	 */
	toString: { value: function() {
		return wts(this.pdoc.env, this.nodes);
	}, },
});
/**
 * Create a {@link PNodeList} from a string containing HTML.
 * @return {PNodeList}
 * @static
 */
PNodeList.fromHTML = function(pdoc, html) {
	var div = pdoc.document.createElement('div');
	div.innerHTML = html;
	return new PNodeList(pdoc, null, div);
};

/**
 * @class PNode
 * A PNode represents a specific DOM {@link Node}.  Its subclasses provide
 * specific accessors and mutators for associated semantic information.
 *
 * Useful subclasses of {@link PNode} include:
 *
 * - {@link PComment}: comments, like `<!-- example -->`
 * - {@link PExtLink}: external links, like `[http://example.com Example]`
 * - {@link PHeading}: headings, like `== Section 1 ==`
 * - {@link PHtmlEntity}: html entities, like `&nbsp;`
 * - {@link PMedia}: images and media, like `[[File:Foo.jpg|caption]]`
 * - {@link PTag}: other HTML tags, like `<span>`
 * - {@link PTemplate}: templates, like `{{foo|bar}}`
 * - {@link PText}: unformatted text, like `foo`
 * - {@link PWikiLink}: wiki links, like `[[Foo|bar]]`
 */
/**
 * @method constructor
 * @private
 * @param {PDoc} pdoc The parent document for this PNode.
 * @param {PNodeList|null} parent A containing node list which will receive
 *    updates when this {@link PNode} is mutated.
 * @param {Node} node The DOM node.
 * @param {Object} [opts]
 * @param {Function} [opts.update]
 *   A function which will be invoked when {@link #update} is called.
 * @param {Function} [opts.wtsNodes]
 *   A function returning an array of {@link Node}s which can tweak the
 *   portion of the document serialized by {@link #toString}.
 */
PNode = function PNode(pdoc, parent, node, opts) {
	/** @property {PDoc} pdoc The parent document for this {@link PNode}. */
	this.pdoc = pdoc;
	this.parent = parent;
	/** @property {Node} node The underlying DOM {@link Node}. */
	this.node = node;
	this._update = (opts && opts.update);
	this._wtsNodes = (opts && opts.wtsNodes);
};
Object.defineProperties(PNode.prototype, {
	ownerDocument: {
		get: function() { return this.node.ownerDocument; },
	},
	dataMw: {
		get: function() { return DU.getDataMw(this.node); },
		set: function(v) { DU.storeDataMw(this.node, v); this.update(); },
	},
	/**
	 * Internal helper: enumerate all PNodeLists contained within this node.
	 * @private
	 * @return {PNodeList[]}
	 */
	_children: { value: function() { return []; }, },
	/**
	 * Call {@link #update} after manually mutating the DOM {@link Node}
	 * associated with this {@link PNode} in order to ensure that any
	 * containing templates are refreshed with their updated contents.
	 *
	 * The mutation methods in the API automatically call {@link #update}
	 * for you when required.
	 * @method
	 */
	update: { value: function() {
		if (this._update) { this._update(); }
		if (this.parent) { this.parent.update(); }
	}, },
	/**
	 * Returns true if the `target` matches this node.  By default a
	 * node matches only if its #node is strictly equal to the target
	 * or the target's #node.  Subclasses can override this to provide
	 * more flexible matching: for example see {@link PText#matches}.
	 * @param {Node|PNode} target
	 * @return {Boolean} true if the target matches this node, false otherwise.
	 */
	matches: { value: function(target) {
		return (target === this) || (target === this.node) ||
			(target instanceof PNode && target.node === this.node);
	}, },
	/**
	 * @inheritdoc PNodeList#toHtml
	 * @method
	 */
	toHtml: { value: function() {
		var nodes = this._wtsNodes ? this._wtsNodes() : [ this.node ];
		return nodes.map(function(n) { return n.outerHTML; }).join('');
	}, },
	/**
	 * @inheritdoc PNodeList#toString
	 * @method
	 */
	toString: { value: function() {
		var nodes = this._wtsNodes ? this._wtsNodes() : [ this.node ];
		return wts(this.pdoc.env, nodes);
	}, },
});

// Helper: getter and setter for the inner contents of a node.
var innerAccessor = {
	get: function() {
		return new PNodeList(this.pdoc, this, this.node);
	},
	set: function(v) {
		this.node.innerHTML = toHtmlStr(this.node, v);
		this.update();
	},
};

/**
 * PComment represents a hidden HTML comment, like `<!-- fobar -->`.
 * @class PComment
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 */
PComment = function PComment(pdoc, parent, node, opts) {
	PNode.call(this, pdoc, parent, node, opts);
};
util.inherits(PComment, PNode);
Object.defineProperties(PComment.prototype, {
	/**
	 * The hidden text contained between `<!--` and `-->`.
	 * @property {String}
	 */
	contents: {
		get: function() {
			return DU.decodeComment(this.node.data);
		},
		set: function(v) {
			this.node.data = DU.encodeComment(v);
			this.update();
		},
	},
});
/**
 * @ignore
 * @static
 * @private
 */
PComment._selector = 'COMMENT'; // non-standard selector

/**
 * PExtLink represents an external link, like `[http://example.com Example]`.
 * @class PExtLink
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 */
PExtLink = function PExtLink(pdoc, parent, node, opts) {
	PNode.call(this, pdoc, parent, node, opts);
};
util.inherits(PExtLink, PNode);
Object.defineProperties(PExtLink.prototype, {
	/**
	 * The URL of the link target.
	 * @property {String}
	 */
	url: {
		// XXX url should be a PNodeList, but that requires handling
		// typeof="mw:ExpandedAttrs"
		get: function() {
			return this.node.getAttribute('href');
		},
		set: function(v) {
			this.node.setAttribute('href', v);
		},
	},
	/**
	 * The link title, as a {@link PNodeList}.
	 * You can assign a String, Node, or PNodeList to mutate the title.
	 * @property {PNodeList}
	 */
	title: innerAccessor,
	// XXX include this.url, once it is a PNodeList
	_children: { value: function() { return [this.title]; }, },
});
/**
 * @ignore
 * @static
 * @private
 */
PExtLink._selector = 'a[rel="mw:ExtLink"]';

/**
 * PHeading represents a section heading in wikitext, like `== Foo ==`.
 * @class PHeading
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 */
PHeading = function PHeading(pdoc, parent, node, opts) {
	PNode.call(this, pdoc, parent, node, opts);
};
util.inherits(PHeading, PNode);
Object.defineProperties(PHeading.prototype, {
	/**
	 * The heading level, as an integer between 1 and 6 inclusive.
	 * @property {Number}
	 */
	level: {
		get: function() {
			return +this.node.nodeName.slice(1);
		},
		set: function(v) {
			v = +v;
			if (v === this.level) {
				return;
			} else if (v >= 1 && v <= 6) {
				var nh = this.ownerDocument.createElement('h' + v);
				while (this.node.firstChild !== null) {
					nh.appendChild(this.node.firstChild);
				}
				this.node.parentNode.replaceChild(nh, this.node);
				this.node = nh;
				this.update();
			} else {
				throw new Error("Level must be between 1 and 6, inclusive.");
			}
		},
	},
	/**
	 * The title of the heading, as a {@link PNodeList}.
	 * You can assign a String, Node, or PNodeList to mutate the title.
	 * @property {PNodeList}
	 */
	title: innerAccessor,

	_children: { value: function() { return [this.title]; }, },
});
/**
 * @ignore
 * @static
 * @private
 */
PHeading._selector = 'h1,h2,h3,h4,h5,h6';

/**
 * PHtmlEntity represents an HTML entity, like `&nbsp;`.
 * @class PHtmlEntity
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 */
PHtmlEntity = function PHtmlEntity(pdoc, parent, node, opts) {
	PNode.call(this, pdoc, parent, node, opts);
};
util.inherits(PHtmlEntity, PNode);
Object.defineProperties(PHtmlEntity.prototype, {
	/**
	 * The character represented by the HTML entity.
	 * @property {String}
	 */
	normalized: {
		get: function() { return this.node.textContent; },
		set: function(v) {
			this.node.textContent = v;
			this.node.removeAttribute('data-parsoid');
			this.update();
		},
	},
	/**
	 * Extends {@link PNode#matches} to allow a target string to match
	 * if it matches this node's #normalized character.
	 * @method
	 * @inheritdoc PNode#matches
	 * @param {Node|PNode|String} target
	 */
	matches: { value: function(target) {
		return PNode.prototype.matches.call(this, target) ||
			this.normalized === target;
	}, },
});
/**
 * @ignore
 * @static
 * @private
 */
PHtmlEntity._selector = '[typeof="mw:Entity"]';

/**
 * PMedia represents an image or audio/video element in wikitext,
 * like `[[File:Foobar.jpg|caption]]`.
 * @class PMedia
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 */
PMedia = function PMedia(pdoc, parent, node, opts) {
	PNode.call(this, pdoc, parent, node, opts);
};
util.inherits(PMedia, PNode);
Object.defineProperties(PMedia.prototype, {
	// Internal helper: is the outer element a <figure> or a <span>?
	_isBlock: { get: function() { return this.node.tagName === 'FIGURE'; }, },
	// Internal helper: get at the 'caption' property in the dataMw
	_caption: {
		get: function() {
			var c = this.dataMw.caption;
			return c === undefined ? null : c;
		},
		set: function(v) {
			var dmw = this.dataMw;
			if (v === undefined || v === null) {
				delete dmw.caption;
			} else {
				dmw.caption = v;
			}
			this.dataMw = dmw;
		},
	},

	/**
	 * The caption of the image or media file, or `null` if not present.
	 * You can assign `null`, a String, Node, or PNodeList to mutate the
	 * contents.
	 * @property {PNodeList|null}
	 */
	caption: {
		get: function() {
			var c, captionDiv;
			// Note that _cachedNodeList is null if caption is missing.
			if (this._cachedNodeList === undefined) {
				if (this._isBlock) {
					c = this.node.firstChild.nextSibling;
					this._cachedNodeList =
						c ? new PNodeList(this.pdoc, this, c) : null;
				} else {
					c = this._caption;
					if (c === null) {
						this._cachedNodeList = null;
					} else {
						captionDiv = this.ownerDocument.createElement('div');
						captionDiv.innerHTML = c;
						this._cachedNodeList = new PNodeList(
							this.pdoc, this, captionDiv, {
								update: function() {
									this.parent._caption = this.container.innerHTML;
								},
							});
					}
				}
			}
			return this._cachedNodeList;
		},
		set: function(v) {
			this._cachedNodeList = undefined;
			if (this._isBlock) {
				var c = this.node.firstChild.nextSibling;
				if (v === null || v === undefined) {
					if (c) {
						this.node.removeChild(c);
						this.update();
					}
				} else {
					if (!c) {
						c = this.ownerDocument.createElement('figcaption');
						this.node.appendChild(c);
					}
					c.innerHTML = toHtmlStr(c, v);
					this.update();
				}
			} else {
				this._caption = (v === null || v === undefined) ? v :
					toHtmlStr(this.node, v);
				this.update();
			}
		},
	},

	_children: { value: function() {
		var c = this.caption;
		return c ? [ c ] : [];
	}, },
});
/**
 * @ignore
 * @static
 * @private
 */
PMedia._selector = 'figure,[typeof~="mw:Image"]';


/**
 * PTag represents any otherwise-unmatched tag.  This includes
 * HTML-style tags in wikicode, like `<span>`, as well as some
 * "invisible" tags like `<p>`.
 * @class PTag
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 */
PTag = function PTag(pdoc, parent, node, opts) {
	PNode.call(this, pdoc, parent, node, opts);
};
util.inherits(PTag, PNode);
Object.defineProperties(PTag.prototype, {
	/**
	 * The name of the tag, in lowercase.
	 */
	tagName: {
		get: function() { return this.node.tagName.toLowerCase(); },
	},

	/**
	 * The contents of the tag, as a {@PNodeList} object.
	 * You can assign a String, Node, or PNodeList to mutate the contents.
	 * @property {PNodeList}
	 */
	contents: innerAccessor,

	_children: { value: function() { return [this.contents]; }, },
});
/**
 * @ignore
 * @static
 * @private
 */
PTag._selector = '*'; // any otherwise-unmatched element

/**
 * PTemplate represents a wikitext template, like `{{foo}}`.
 * @class PTemplate
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 * @param {PDoc} pdoc The parent document for this PNode.
 * @param {PNodeList|null} parent A containing node list which will receive
 *    updates when this {@link PNode} is mutated.
 * @param {Node} node The DOM node.
 * @param {Number} which A single {@link Node} can represent multiple
 *   templates; this parameter serves to distinguish them.
 */
PTemplate = function PTemplate(pdoc, parent, node, which) {
	PNode.call(this, pdoc, parent, node, {
		wtsNodes: function() {
			// Templates are actually a collection of nodes.
			return this.parent._querySelectorAll
				('[about="' + this.node.getAttribute('about') + '"]');
		},
	});
	this.which = which;
	this._cachedParams = Object.create(null);
};
util.inherits(PTemplate, PNode);
Object.defineProperties(PTemplate.prototype, {
	_template: {
		get: function() {
			return this.dataMw.parts[this.which];
		},
		set: function(v) {
			var dmw = this.dataMw;
			dmw.parts[this.which] = v;
			this.dataMw = dmw;
		},
	},
	/**
	 * The name of the template, as a String.
	 *
	 * See: [T107194](https://phabricator.wikimedia.org/T107194)
	 * @property {String}
	 */
	name: {
		get: function() {
			// This should really be a PNodeList; see T107194
			return this._template.template.target.wt;
		},
		set: function(v) {
			var t = this._template;
			t.template.target.wt = v;
			t.template.target.href = './' +
				this.pdoc.env.normalizeTitle('Template:' + v);
			this._template = t;
		},
	},
	/**
	 * Test whether the name of this template matches a given string, after
	 * normalizing titles.
	 * @param {String} name The template name to test against.
	 * @return {Boolean}
	 */
	nameMatches: {
		value: function(name) {
			var href = './' + this.pdoc.env.normalizeTitle('Template:' + name);
			return this._template.template.target.href === href;
		},
	},
	/**
	 * The parameters supplied to this template.
	 * @property {PTemplate.Parameter[]}
	 */
	params: {
		get: function() {
			return Object.keys(this._template.template.params).sort().map(function(k) {
				return this.get(k);
			}, this);
		},
	},
	/**
	 * Return `true` if any parameter in the template is named `name`.
	 * With `ignoreEmpty`, `false` will be returned even if the template
	 * contains a parameter named `name`, if the parameter's value is empty
	 * (ie, only contains whitespace).  Note that a template may have
	 * multiple parameters with the same name, but only the last one is
	 * read by Parsoid (and the MediaWiki parser).
	 * @param {String|PTemplate.Parameter} name
	 * @param {Object} [opts]
	 * @param {Boolean} [opts.ignoreEmpty=false]
	 */
	has: {
		value: function(name, opts) {
			if (name instanceof PTemplate.Parameter) {
				name = name.name;
			}
			var t = this._template.template;
			return Object.prototype.hasOwnProperty.call(t.params, name) && (
				(opts && opts.ignoreEmpty) ?
					!/^\s*$/.test(t.params[name].html) : true
			);
		},
	},
	/**
	 * Add a parameter to the template with a given `name` and `value`.
	 * If `name` is already a parameter in the template, we'll replace
	 * its value.
	 * @param {String|PTemplate.Parameter} name
	 * @param {String|Node|PNodeList} value
	 */
	add: {
		value: function(k, v) {
			if (k instanceof PTemplate.Parameter) {
				k = k.name;
			}
			var t = this._template;
			var html = toHtmlStr(this.node, v);
			t.template.params[k] = { html: html };
			this._template = t;
		},
	},
	/**
	 * Remove a parameter from the template with the given `name`.
	 * If `keepField` is `true`, we will keep the parameter's name but
	 * blank its value.  Otherwise we will remove the parameter completely
	 * *unless* other parameters are dependent on it (e.g. removing
	 * `bar` from `{{foo|bar|baz}}` is unsafe because `{{foo|baz}}` is
	 * not what we expected, so `{{foo||baz}}` will be produced instead).
	 * @param {String|PTemplate.Parameter} name
	 * @param {Object} [opts]
	 * @param {Boolean} [opts.keepField=false]
	 */
	remove: {
		value: function(k, opts) {
			if (k instanceof PTemplate.Parameter) {
				k = k.name;
			}
			var t = this._template;
			var keepField = opts && opts.keepField;
			// if this is a numbered template, force keepField if there
			// are subsequent numbered templates.
			var isNumeric = (String(+k) === String(k));
			if (isNumeric && this.has(1 + (+k))) {
				keepField = true;
			}
			if (keepField) {
				t.template.params[k] = { html: '' };
			} else {
				delete t.template.params[k];
			}
			this._template = t;
		},
	},

	/**
	 * Get the parameter whose name is `name`.
	 * @param {String|PTemplate.Parameter} name
	 * @return {PTemplate.Parameter} The parameter record.
	 */
	get: {
		value: function(k) {
			if (k instanceof PTemplate.Parameter) {
				k = k.name;
			}
			if (!this._cachedParams[k]) {
				this._cachedParams[k] = new PTemplate.Parameter(this, k);
			}
			return this._cachedParams[k];
		},
	},

	_children: { value: function() {
		var result = [];
		this.params.forEach(function(k) {
			var p = this.get(k);
			if (p.key) { result.push(p.key); }
			result.push(p.value);
		}, this);
		return result;
	}, },
});
/**
 * @ignore
 * @static
 * @private
 */
PTemplate._selector = '[typeof~="mw:Transclusion"]';

/**
 * @class PTemplate.Parameter
 *
 * Represents a parameter of a template.
 *
 * For example, the template `{{foo|bar|spam=eggs}}` contains two
 * {@link PTemplate.Parameter}s: one whose #name is `"1"` and whose
 * whose #value is a {@link PNodeList} corresponding to `"bar"`, and one
 * whose #name is `"spam"` and whose #value is a {@link PNodeList}
 * corresponding to `"eggs"`.
 *
 * See: {@link PTemplate}
 */
/**
 * @method constructor
 * @private
 * @param {PTemplate} parent The parent template for this parameter.
 * @param {String} k The parameter name.
 */
PTemplate.Parameter = function Parameter(parent, k) {
	var doc = parent.ownerDocument;
	var param = parent._template.template.params[k];
	var valDiv = doc.createElement('div');
	valDiv.innerHTML = param.html;
	this._name = k;
	this._value = new PNodeList(parent.pdoc, parent, valDiv, {
		update: function() {
			var t = this.parent._template;
			delete t.template.params[k].wt;
			t.template.params[k].html = this.container.innerHTML;
			this.parent._template = t;
		},
	});
	var keyDiv = doc.createElement('div');
	this._key = new PNodeList(parent.pdoc, parent, keyDiv, {
		update: function() {
			var t = this.parent._template;
			if (this._hasKey) {
				if (!t.template.params[k].key) {
					t.template.params[k].key = {};
				}
				delete t.template.params[k].key.wt;
				t.template.params[k].key.html = this.container.innerHTML;
			} else {
				delete t.template.params[k].key;
			}
			this.parent._template = t;
		},
	});
	if (param.key && param.key.html) {
		// T106852 means this doesn't always work.
		keyDiv.innerHTML = param.key.html;
		this._key._hasKey = true;
	}
};
Object.defineProperties(PTemplate.Parameter.prototype, {
	/**
	 * @property {String} name
	 *   The expanded parameter name.
	 *   Unnamed parameters are given numeric indexes.
	 * @readonly
	 */
	name: { get: function() { return this._name; }, },
	/**
	 * @property {PNodeList|null} key
	 *   Source nodes corresponding to the parameter name.
	 *   For example, in `{{echo|{{echo|1}}=hello}}` the parameter name
	 *   is `"1"`, but the `key` field would contain the `{{echo|1}}`
	 *   template invocation, as a {@link PNodeList}.
	 */
	key: {
		get: function() { return this._key._hasKey ? this._key : null; },
		set: function(v) {
			if (v === null || v === undefined) {
				this._key.container.innerHTML = '';
				this._key._hasKey = false;
			} else {
				this._key.container.innerHTML =
					toHtmlStr(this._key.container, v);
			}
			this._key.update();
		},
	},
	/**
	 * @property {PNodeList} value
	 *    The parameter value.
	 */
	value: {
		get: function() { return this._value; },
		set: function(v) {
			this._value.container.innerHTML =
				toHtmlStr(this._value.container, v);
			this._value.update();
		},
	},
	toString: { value: function() {
		var k = this.key;
		return (k ? String(k) : this.name) + '=' + String(this.value);
	}, },
});

/**
 * PText represents ordinary unformatted text with no special properties.
 * @class PText
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 */
PText = function PText(pdoc, parent, node, opts) {
	PNode.call(this, pdoc, parent, node, opts);
};
util.inherits(PText, PNode);
Object.defineProperties(PText.prototype, {
	/**
	 * The actual text itself.
	 * @property {String}
	 */
	value: {
		get: function() {
			return this.node.data;
		},
		set: function(v) {
			this.node.data = v;
			this.update();
		},
	},
	/**
	 * Extends {@link PNode#matches} to allow a target string to match
	 * if it matches this node's #value.
	 * @method
	 * @inheritdoc PNode#matches
	 * @param {Node|PNode|String} target
	 */
	matches: { value: function(target) {
		return PNode.prototype.matches.call(this, target) ||
			this.value === target;
	}, },
});
/**
 * @ignore
 * @static
 * @private
 */
PText._selector = 'TEXT'; // non-standard selector

/**
 * PWikiLink represents an internal wikilink, like `[[Foo|Bar]]`.
 * @class PWikiLink
 * @extends PNode
 */
/**
 * @method constructor
 * @private
 * @inheritdoc PNode#constructor
 */
PWikiLink = function PWikiLink(pdoc, parent, node, opts) {
	PNode.call(this, pdoc, parent, node, opts);
};
util.inherits(PWikiLink, PNode);
Object.defineProperties(PWikiLink.prototype, {
	/**
	 * The title of the linked page.
	 * @property {String}
	 */
	title: {
		// XXX url should be a PNodeList, but that requires handling
		// typeof="mw:ExpandedAttrs"
		get: function() {
			return this.node.getAttribute('href').replace(/^.\//, '');
		},
		set: function(v) {
			var href = './' + this.pdoc.env.normalizeTitle(v);
			this.node.setAttribute('href', href);
			this.update();
		},
	},
	/**
	 * The text to display, as a {@link PNodeList}.
	 * You can assign a String, Node, or PNodeList to mutate the text.
	 * @property {PNodeList}
	 */
	text: innerAccessor,

	_children: { value: function() { return [this.text]; }, },
});
/**
 * @ignore
 * @static
 * @private
 */
PWikiLink._selector = 'a[rel="mw:WikiLink"]';

/**
 * A PDoc object wraps an entire Parsoid document.  Since it is an
 * instance of {@link PNodeList}, you can filter it, mutate it, etc.
 * But it also provides means to serialize the document as either
 * HTML (via {@link #document} or {@link #toHtml}) or wikitext
 * (via {@link #toString}).
 * @class
 * @extends PNodeList
 * @alternateClassName Parsoid.PDoc
 */
var PDoc = function PDoc(env, doc) {
	PNodeList.call(this, this, null, doc.body);
	this.env = env;
};
util.inherits(PDoc, PNodeList);
Object.defineProperties(PDoc.prototype, {
	/**
	 * An HTML {@link Document} representing article content conforming to the
	 * [MediaWiki DOM specification](https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec).
	 * @property {Document}
	 */
	document: {
		get: function() { return this.container.ownerDocument; },
		set: function(v) { this.container = v.body; },
	},
	/**
	 * Return a string representing the entire document as
	 * HTML conforming to the
	 * [MediaWiki DOM specification](https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec).
	 * @inheritdoc PNodeList#toHtml
	 * @method
	 */
	toHtml: { value: function() {
		// document.outerHTML is a Parsoid-ism; real browsers don't define it.
		var html = this.document.outerHTML;
		if (!html) {
			html = this.document.body.outerHTML;
		}
		return html;
	}, },
});

module.exports = {
	PDoc: PDoc,
	PNodeList: PNodeList,
	PNode: PNode,
	PComment: PComment,
	PExtLink: PExtLink,
	PHeading: PHeading,
	PHtmlEntity: PHtmlEntity,
	PMedia: PMedia,
	PTag: PTag,
	PTemplate: PTemplate,
	PText: PText,
	PWikiLink: PWikiLink,
};
