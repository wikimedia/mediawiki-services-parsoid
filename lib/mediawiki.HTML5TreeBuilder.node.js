'use strict';

/* Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from the node 'html5' module. Feed it tokens using
 * processToken, and it will build you a DOM tree retrievable using .document
 * or .body(). */

var events = require('events');
var util = require('util');
var HTML5 = require('html5');
var domino = require('domino');
var defines = require('./mediawiki.parser.defines.js');
var Util = require('./mediawiki.Util.js').Util;
var SanitizerConstants = require('./ext.core.Sanitizer.js').SanitizerConstants;

// define some constructor shortcuts
var CommentTk = defines.CommentTk;
var EOFTk = defines.EOFTk;
var NlTk = defines.NlTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;


/**
 * @class
 * @extends EventEmitter
 * @constructor
 */
function TreeBuilder(env) {
	events.EventEmitter.call(this);
	this.env = env;

	// Reset variable state and set up the parser
	this.resetState();
}

// Inherit from EventEmitter
util.inherits(TreeBuilder, events.EventEmitter);

/**
 * Register for (token) 'chunk' and 'end' events from a token emitter,
 * normally the TokenTransformDispatcher.
 */
TreeBuilder.prototype.addListenersOn = function(emitter) {
	emitter.addListener('chunk', this.onChunk.bind(this));
	emitter.addListener('end', this.onEnd.bind(this));
};

/**
 * Debugging aid: set pipeline id
 */
TreeBuilder.prototype.setPipelineId = function(id) {
	this.pipelineId = id;
};

// HTML5 tokenizer stubs
TreeBuilder.prototype.setState = function(state) {};

TreeBuilder.prototype.resetState = function() {
	// Reset vars
	this.tagId = 1;  // Assigned to start/self-closing tags
	this.inTransclusion = false;
	this.precededByPre = false;

	if (!this._treeBuilder) {
		// Set up a new tree builder
		this._treeBuilder = new HTML5.DOMTreeBuilder(domino);
		this.addListener('token',
			this._treeBuilder.processToken.bind(this._treeBuilder));
	}

	// Reset the tree builder
	this._treeBuilder.startTokenization(this);

	// At this point, domino has already created a document element for us but
	// the html5 library would like to use its own (keeps an internal state of
	// open elements). Remove it and process a body token to trigger rebuilding.
	this.doc = this._treeBuilder.document;
	this.doc.removeChild(this.doc.lastChild);
	this.processToken(new TagTk('body'));
};

TreeBuilder.prototype.onChunk = function(tokens) {
	var n = tokens.length;
	for (var i = 0; i < n; i++) {
		this.processToken(tokens[i]);
	}
};

TreeBuilder.prototype.onEnd = function() {
	// Check if the EOFTk actually made it all the way through, and flag the
	// page where it did not!
	if (this.lastToken && this.lastToken.constructor !== EOFTk) {
		this.env.log("error", "EOFTk was lost in page", this.env.page.name);
	}
	this.emit('document', this.doc);
	this.emit('end');
	this.resetState();
};

TreeBuilder.prototype._att = function(maybeAttribs) {
	return maybeAttribs.map(function(attr) {
		var a = { nodeName: attr.k, nodeValue: attr.v };
		// In the sanitizer, we've permitted the XML namespace declaration.
		// Pass the appropriate URI so that domino doesn't (rightfully) throw
		// a NAMESPACE_ERR.
		if (SanitizerConstants.XMLNS_ATTRIBUTE_RE.test(attr.k)) {
			a.namespaceURI = "http://www.w3.org/2000/xmlns/";
		}
		return a;
	});
};

// Adapt the token format to internal HTML tree builder format, call the actual
// html tree builder by emitting the token.
TreeBuilder.prototype.processToken = function(token) {
	var attribs = token.attribs || [];
	// Always insert data-parsoid
	var dataAttribs = token.dataAttribs || {};

	if (this.inTransclusion) {
		dataAttribs.inTransclusion = true;
	}

	// Assign tagid to open/self-closing tags
	if (token.constructor === TagTk || token.constructor === SelfclosingTagTk) {
		dataAttribs.tagId = this.tagId++;
	}

	attribs = attribs.concat([
		{ k: 'data-parsoid', v: JSON.stringify(dataAttribs) },
	]);

	this.env.log("trace/html", this.pipelineId, function() {
		return JSON.stringify(token);
	});

	var tName, attrs, tProperty, data;
	switch (token.constructor) {
		case String:
		case NlTk:
			data = (token.constructor === NlTk) ? '\n' : token;
			if (this.preceededByPre && data[0] === '\n') {
				// Emit two newlines when preceded by a pre because the
				// treebuilder will eat one.
				data = '\n' + data;
			}
			this.emit('token', { type: 'Characters', data: data });
			if (this.inTransclusion) {
				this.env.log("debug/html", this.pipelineId, "Inserting shadow transclusion meta");
				this.emit('token', {
					type: 'StartTag',
					name: 'meta',
					data: [{ nodeName: "typeof", nodeValue: "mw:TransclusionShadow" }],
				});
			}
			break;
		case TagTk:
			tName = token.name;
			if (tName === "table") {
				// Don't add foster box in transclusion
				// Avoids unnecessary insertions, the case where a table
				// doesn't have tsr info, and the messy unbalanced table case,
				// like the navbox
				if (!this.inTransclusion) {
					this.env.log("debug/html", this.pipelineId, "Inserting foster box meta");
					this.emit('token', {
						type: 'StartTag',
						name: 'table',
						self_closing: true,
						data: [{ nodeName: "typeof", nodeValue: "mw:FosterBox" }],
					});
				}
			}
			this.emit('token', {type: 'StartTag', name: tName, data: this._att(attribs)});
			this.env.log("debug/html", this.pipelineId, "Inserting shadow meta for", tName);
			attrs = [
				{ nodeName: "typeof", nodeValue: "mw:StartTag" },
				{ nodeName: "data-stag", nodeValue: tName + ":" + dataAttribs.tagId },
				{ nodeName: "data-parsoid", nodeValue: JSON.stringify(dataAttribs) },
			];
			this.emit('token', {
				type: 'Comment',
				data: JSON.stringify({
					"@type": "mw:shadow",
					attrs: attrs,
				}),
			});
			break;
		case SelfclosingTagTk:
			tName = token.name;

			// Re-expand an empty-line meta-token into its constituent comment + WS tokens
			if (Util.isEmptyLineMetaToken(token)) {
				this.onChunk(dataAttribs.tokens);
				break;
			}

			tProperty = token.getAttribute("property");
			if (tName === "pre" && tProperty && tProperty.match(/^mw:html$/)) {
				// Unpack pre tags.
				var toks;
				attribs = attribs.filter(function(attr) {
					if (attr.k === "content") {
						toks = attr.v;
						return false;
					} else {
						return attr.k !== "property";
					}
				});
				var endpos = dataAttribs.endpos;
				dataAttribs.endpos = undefined;
				var tsr = dataAttribs.tsr;
				if (tsr) {
					dataAttribs.tsr = [ tsr[0], endpos ];
				}
				dataAttribs.stx = 'html';
				toks.unshift(new TagTk('pre', attribs, dataAttribs));
				dataAttribs = { stx: 'html'};
				if (tsr) {
					dataAttribs.tsr = [ tsr[1] - 6, tsr[1] ];
				}
				toks.push(new EndTagTk('pre', [], dataAttribs));
				this.onChunk(toks);
				break;
			}

			// Convert mw metas to comments to avoid fostering.
			// But, <ref> marker metas, <*include*> metas, behavior switch metas
			// should be fostered since they end up generating
			// HTML content at the marker site.
			if (tName === 'meta') {
				var tTypeOf = token.getAttribute('typeof');
				var shouldFoster = (/^mw:(Extension\/ref\/Marker|Includes\/(OnlyInclude|IncludeOnly|NoInclude))\b/).test(tTypeOf);
				if (!shouldFoster) {
					var prop = token.getAttribute('property');
					shouldFoster = (/^(mw:PageProp\/[a-zA-Z]*)\b/).test(prop);
				}
				if (!shouldFoster) {
					// transclusions state
					if (tTypeOf.match(/^mw:Transclusion/)) {
						this.inTransclusion = /^mw:Transclusion$/.test(tTypeOf);
					}
					this.emit('token', {
						type: 'Comment',
						data: JSON.stringify({
							'@type': tTypeOf,
							attrs: this._att(attribs),
						}),
					});
					break;
				}
			}

			var newAttrs = this._att(attribs);
			this.emit('token', { type: 'StartTag', name: tName, data: newAttrs });
			if (!Util.isVoidElement(tName)) {
				// VOID_ELEMENTS are automagically treated as self-closing by
				// the tree builder
				this.emit('token', { type: 'EndTag', name: tName, data: newAttrs });
			}
			break;
		case EndTagTk:
			tName = token.name;
			this.emit('token', {type: 'EndTag', name: tName});
			if (dataAttribs && !dataAttribs.autoInsertedEnd) {
				attrs = this._att(attribs).concat([
					{ nodeName: "typeof", nodeValue: "mw:EndTag" },
					{ nodeName: "data-etag", nodeValue: tName },
					{ nodeName: "data-parsoid", nodeValue: JSON.stringify(dataAttribs) },
				]);
				this.env.log("debug/html", this.pipelineId, "Inserting shadow meta for", tName);
				this.emit('token', {
					type: 'Comment',
					data: JSON.stringify({
						"@type": "mw:shadow",
						attrs: attrs,
					}),
				});
			}
			break;
		case CommentTk:
			this.emit('token', { type: 'Comment', data: token.value });
			break;
		case EOFTk:
			this.emit('token', { type: 'EOF' });
			break;
		default:
			var errors = [
				"-------- Unhandled token ---------",
				"TYPE: " + token.constructor.name,
				"VAL : " + JSON.stringify(token),
			];
			this.env.log("error", errors.join("\n"));
			break;
	}

	// Keep track of preceeding by pre
	if (token.constructor === TagTk) {
		if (token.name === "pre") {
			this.preceededByPre = true;
		} else if (token.name === "span" &&
			token.getAttribute('typeof') === "mw:Nowiki") {
			// Nowikis are emitted as elements in pres
			// and should be ignored for the sake of first nl eating.
			/* jshint noempty: false */
		} else {
			this.preceededByPre = false;
		}
	} else {
		this.preceededByPre = false;
	}

	// Store the last token
	this.lastToken = token;
};


if (typeof module === "object") {
	module.exports.TreeBuilder = TreeBuilder;
}
