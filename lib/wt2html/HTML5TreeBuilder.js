'use strict';

/* Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from the node 'html5' module. Feed it tokens using
 * processToken, and it will build you a DOM tree retrievable using .document
 * or .body(). */

var events = require('events');
var util = require('util');
var HTMLParser = require('domino').impl.HTMLParser;
var defines = require('./parser.defines.js');
var Util = require('../utils/Util.js').Util;
var SanitizerConstants = require('./tt/Sanitizer.js').SanitizerConstants;

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

	/* --------------------------------------------------------------------
	 * Crude tracking of whether we are in a table
	 *
	 * The only requirement for correctness of detecting fostering content
	 * is that as long as there is an unclosed <table> tag, this value
	 * is positive.
	 *
	 * We can ensure that by making sure that independent of how many
	 * excess </table> tags we run into, this value is never negative.
	 *
	 * So, since this.tableDepth >= 0 always, whenever a <table> tag is seen,
	 * this.tableDepth >= 1 always, and our requirement is met.
	 * -------------------------------------------------------------------- */
	this.tableDepth = 0;

	// Have we inserted a transclusion shadow meta already?
	// We only need one for every run of strings and newline tokens.
	this.haveTransclusionShadow = false;

	this.parser = new HTMLParser();
	this.insertToken({ type: 'DOCTYPE', name: 'html' });
	this.insertToken({ type: 'StartTag', name: 'body' });
};

var types = new Map(Object.entries({
	EOF: -1,
	Characters: 1,
	StartTag: 2,
	EndTag: 3,
	Comment: 4,
	DOCTYPE: 5,
}));

// FIXME: This conversion code can be eliminated by cleaning up processToken.
TreeBuilder.prototype.insertToken = function(tok) {
	var t = types.get(tok.type);
	var value, arg3;
	switch (tok.type) {
		case 'StartTag':
		case 'EndTag':
		case 'DOCTYPE':
			value = tok.name;
			if (Array.isArray(tok.data)) {
				arg3 = tok.data.map(function(a) {
					return [a.nodeName, a.nodeValue];
				});
			}
			break;
		case 'Characters':
		case 'Comment':
		case 'EOF':
			value = tok.data;
			break;
		default:
			console.assert(false, "Unexpected type: " + tok.type);
	}
	this.parser.insertToken(t, value, arg3);
};

TreeBuilder.prototype.onChunk = function(tokens) {
	var s = Date.now();
	var n = tokens.length;
	for (var i = 0; i < n; i++) {
		this.processToken(tokens[i]);
	}
	this.env.bumpTimeUse("HTML5 TreeBuilder", Date.now() - s);
};

TreeBuilder.prototype.onEnd = function() {
	// Check if the EOFTk actually made it all the way through, and flag the
	// page where it did not!
	if (this.lastToken && this.lastToken.constructor !== EOFTk) {
		this.env.log("error", "EOFTk was lost in page", this.env.page.name);
	}
	this.emit('document', this.parser.document());
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
	if (this.pipelineId === 0) {
		this.env.bumpParserResourceUse('token');
	}

	var attribs = token.attribs || [];
	var dataAttribs = token.dataAttribs || { tmp: {} };

	if (!dataAttribs.tmp) {
		dataAttribs.tmp = {};
	}

	if (this.inTransclusion) {
		dataAttribs.tmp.inTransclusion = true;
	}

	// Assign tagId to open/self-closing tags
	if (token.constructor === TagTk || token.constructor === SelfclosingTagTk) {
		dataAttribs.tmp.tagId = this.tagId++;
	}

	// Always insert data-parsoid
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
			this.insertToken({ type: 'Characters', data: data });
			// NlTks are only fostered when accompanied by
			// non-whitespace. Safe to ignore.
			if (this.inTransclusion && this.tableDepth > 0 &&
				token.constructor === String && !this.haveTransclusionShadow) {
				// If inside a table and a transclusion, add a meta tag
				// after every text node so that we can detect
				// fostered content that came from a transclusion.
				this.env.log("debug/html", this.pipelineId, "Inserting shadow transclusion meta");
				this.insertToken({
					type: 'StartTag',
					name: 'meta',
					data: [{ nodeName: "typeof", nodeValue: "mw:TransclusionShadow" }],
				});
				this.haveTransclusionShadow = true;
			}
			break;
		case TagTk:
			tName = token.name;
			if (tName === "table") {
				this.tableDepth++;
				// Don't add foster box in transclusion
				// Avoids unnecessary insertions, the case where a table
				// doesn't have tsr info, and the messy unbalanced table case,
				// like the navbox
				if (!this.inTransclusion) {
					this.env.log("debug/html", this.pipelineId, "Inserting foster box meta");
					this.insertToken({
						type: 'StartTag',
						name: 'table',
						data: [{ nodeName: "typeof", nodeValue: "mw:FosterBox" }],
					});
				}
			}
			this.insertToken({ type: 'StartTag', name: tName, data: this._att(attribs) });
			this.env.log("debug/html", this.pipelineId, "Inserting shadow meta for", tName);
			attrs = [
				{ nodeName: "typeof", nodeValue: "mw:StartTag" },
				{ nodeName: "data-stag", nodeValue: tName + ":" + dataAttribs.tmp.tagId },
				{ nodeName: "data-parsoid", nodeValue: JSON.stringify(dataAttribs) },
			];
			this.insertToken({
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
					this.insertToken({
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
			this.insertToken({ type: 'StartTag', name: tName, data: newAttrs });
			if (!Util.isVoidElement(tName)) {
				// VOID_ELEMENTS are automagically treated as self-closing by
				// the tree builder
				this.insertToken({ type: 'EndTag', name: tName, data: newAttrs });
			}
			break;
		case EndTagTk:
			tName = token.name;
			if (tName === 'table' && this.tableDepth > 0) {
				this.tableDepth--;
			}
			this.insertToken({ type: 'EndTag', name: tName });
			if (dataAttribs && !dataAttribs.autoInsertedEnd) {
				attrs = this._att(attribs).concat([
					{ nodeName: "typeof", nodeValue: "mw:EndTag" },
					{ nodeName: "data-etag", nodeValue: tName },
					{ nodeName: "data-parsoid", nodeValue: JSON.stringify(dataAttribs) },
				]);
				this.env.log("debug/html", this.pipelineId, "Inserting shadow meta for", tName);
				this.insertToken({
					type: 'Comment',
					data: JSON.stringify({
						"@type": "mw:shadow",
						attrs: attrs,
					}),
				});
			}
			break;
		case CommentTk:
			this.insertToken({ type: 'Comment', data: token.value });
			break;
		case EOFTk:
			this.insertToken({ type: 'EOF' });
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

	// If we encountered a non-string non-nl token, we have broken
	// a run of string+nl content and the next occurence of one of
	// those tokens will need transclusion shadow protection again.
	if (token.constructor !== String && token.constructor !== NlTk) {
		this.haveTransclusionShadow = false;
	}

	// Store the last token
	this.lastToken = token;
};


if (typeof module === "object") {
	module.exports.TreeBuilder = TreeBuilder;
}
