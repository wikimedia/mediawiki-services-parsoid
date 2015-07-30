/*
 * Handy JavaScript API for Parsoid DOM, inspired by the
 * python `mwparserfromhell` package.
 */
'use strict';
require('../lib/core-upgrade.js');

// TO DO:
// comment/tag/text/figure
// PTemplate#get should return PParameter and support mutation.
// PExtLink#url PWikiLink#title should handle mw:ExpandedAttrs
// make separate package?

var WikitextSerializer = require('../lib/mediawiki.WikitextSerializer.js').WikitextSerializer;
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;
var util = require('util');

// WTS helper
var wts = function(env, nodes) {
	// XXX: Serializing to wikitext is very user-friendly, but it depends on
	// WTS.serializeDOMSync which we might not want to keep around forever.
	// An alternative would be:
	//    return DU.normalizeOut(node, 'parsoidOnly');
	// which might be almost as friendly.
	var body;
	if (nodes.length === 1 && DU.isBody(nodes[0])) {
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
var PNode, PNodeList, PExtLink, PHeading, PHtmlEntity, PTemplate, PWikiLink;

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
		if (this._update) { this._update(); }
		if (this.parent) { this.parent.update(); }
	}, },
	_querySelectorAll: { value: function(selector) {
		return Array.from(this.container.querySelectorAll(selector));
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
	 * @param {Object} [opts]
	 * @param {boolean} [opts.recursive]
	 *    Set to `false` to avoid recursing into templates.
	 */
	_filter: { value: function(result, selector, func, opts) {
		var self = this;
		var recursive = (opts && opts.recursive) !== false;
		var tSelector = '[typeof~="mw:Transclusion"]';
		if (selector) {
			tSelector += ',' + selector;
		}
		this._querySelectorAll(tSelector).forEach(function(node) {
			var ty = node.getAttribute('typeof') || '';
			var isTemplate = /\bmw:Transclusion\b/.test(ty);
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
	 * Return an array of {@link PExtLink} representing external links
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PExtLink[]}
	 */
	filterExtLinks: { value: function(opts) {
		return this._filter([], 'a[rel="mw:ExtLink"]', function(r, parent, node, opts) {
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
		return this._filter([], 'h1,h2,h3,h4,h5,h6', function(r, parent, node, opts) {
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
		return this._filter([], '[typeof="mw:Entity"]', function(r, parent, node, opts) {
			r.push(new PHtmlEntity(parent.pdoc, parent, node));
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
	 * Return an array of {@link PWikiLink} representing wiki links
	 * found in this {@link PNodeList}.
	 * @inheritdoc #_filter
	 * @return {PWikiLink[]}
	 */
	filterWikiLinks: { value: function(opts) {
		return this._filter([], 'a[rel="mw:WikiLink"]', function(r, parent, node, opts) {
			r.push(new PWikiLink(parent.pdoc, parent, node));
		}, opts);
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
 * - {@link PExtLink}: external links, like `[http://example.com Example]`
 * - {@link PHeading}: headings, like `== Section 1 ==`
 * - {@link PHtmlEntity}: html entities, like `&nbsp;`
 * - {@link PTemplate}: templates, like `{{foo|bar}}`
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
	this._cachedHtml = Object.create(null);
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
	matches: {
		value: function(name) {
			var href = './' + this.pdoc.env.normalizeTitle('Template:' + name);
			return this._template.template.target.href === href;
		},
	},
	/**
	 * The names of the parameters supplied to this template.
	 * Unnamed parameters are given numeric indexes.
	 * @property {String[]}
	 */
	params: {
		get: function() {
			return Object.keys(this._template.template.params).sort();
		},
	},
	/**
	 * Return `true` if any parameter in the template is named `name`.
	 * With `ignoreEmpty`, `false` will be returned even if the template
	 * contains a parameter named `name`, if the parameter's value is empty
	 * (ie, only contains whitespace).  Note that a template may have
	 * multiple parameters with the same name, but only the last one is
	 * read by Parsoid (and the MediaWiki parser).
	 * @param {String} name
	 * @param {Object} [opts]
	 * @param {Boolean} [opts.ignoreEmpty=false]
	 */
	has: {
		value: function(name, opts) {
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
	 * @param {String} name
	 * @param {String|Node|PNodeList} value
	 */
	add: {
		value: function(k, v) {
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
	 * @param {String} name
	 * @param {Object} [opts]
	 * @param {Boolean} [opts.keepField=false]
	 */
	remove: {
		value: function(k, opts) {
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
	// XXX we should return a PParameter instance, so we can make key/value
	// into accessors and allow mutation.
	/**
	 * Get the parameter whose name is `name`.
	 * @param {String} name
	 * @return {Object} The parameter record.
	 * @return {String} return.name The given parameter name.
	 * @return {PNodeList|undefined} return.key
	 *   Source nodes corresponding to the parameter name.
	 *   For example, in `{{echo|{{echo|1}}=hello}}` the parameter name
	 *   is `"1"`, but the `key` field would contain the `{{echo|1}}`
	 *   template invocation, as a {@link PNodeList}.
	 * @return {PNodeList} return.value
	 *   The parameter value.
	 */
	get: {
		value: function(k) {
			if (!this._cachedHtml[k]) {
				var doc = this.ownerDocument;
				var param = this._template.template.params[k];
				var valDiv = doc.createElement('div');
				valDiv.innerHTML = param.html;
				this._cachedHtml[k] = {
					name: k,
					value: new PNodeList(this.pdoc, this, valDiv, {
						update: function() {
							var t = this.parent._template;
							delete t.template.params[k].wt;
							t.template.params[k].html = this.container.innerHTML;
							this.parent._template = t;
						},
					}),
				};
				if (param.key && param.key.html) {
					// T106852 means this doesn't always work.
					var keyDiv = doc.createElement('div');
					keyDiv.innerHTML = param.key.html;
					this._cachedHtml[k].key = new PNodeList(this.pdoc, this, keyDiv, {
						update: function() {
							var t = this.parent._template;
							delete t.template.params[k].key.wt;
							t.template.params[k].key.html = this.container.innerHTML;
							this.parent._template = t;
						},
					});
				}
			}
			return this._cachedHtml[k];
		},
	},
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
});

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
});

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
});


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
});

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
};
