"use strict";

/* Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from the node 'html5' module. Feed it tokens using
 * processToken, and it will build you a DOM tree retrievable using .document
 * or .body(). */

var events = require('events'),
	util = require('util'),
	HTML5 = require('html5'),
	domino = require('./domino'),
	defines = require('./mediawiki.parser.defines.js'),
	Util = require('./mediawiki.Util.js').Util;

// define some constructor shortcuts
var CommentTk = defines.CommentTk,
    EOFTk = defines.EOFTk,
    NlTk = defines.NlTk,
    TagTk = defines.TagTk,
    SelfclosingTagTk = defines.SelfclosingTagTk,
    EndTagTk = defines.EndTagTk;

var FauxHTML5 = {};

FauxHTML5.TreeBuilder = function ( env ) {
	events.EventEmitter.call(this);

	this.env = env;

	// Reset variable state and set up the parser
	this.resetState();
};

// Inherit from EventEmitter
util.inherits(FauxHTML5.TreeBuilder, events.EventEmitter);

/**
 * Register for (token) 'chunk' and 'end' events from a token emitter,
 * normally the TokenTransformDispatcher.
 */
FauxHTML5.TreeBuilder.prototype.addListenersOn = function ( emitter ) {
	emitter.addListener('chunk', this.onChunk.bind( this ) );
	emitter.addListener('end', this.onEnd.bind( this ) );
};

FauxHTML5.TreeBuilder.prototype.resetVars = function () {
	// Assigned to start/self-closing tags
	this.tagId = 1;

	this.inTransclusion = false;
};

/**
 * Debugging aid: set pipeline id
 */
FauxHTML5.TreeBuilder.prototype.setPipelineId = function(id) {
	this.pipelineId = id;
};

FauxHTML5.TreeBuilder.prototype.resetState = function () {
	// Remove any old parser callbacks
	this.removeAllListeners( 'token' );
	this.removeAllListeners( 'end' );

	if (!this.parser) {
		// Set up a new parser
		this.parser = new HTML5.Parser({
			document: domino.createDocument( '<html></html>' )
		});
		this.parser.tokenizer = this;
	} else {
		// Set up a new document
		// TODO: Make this cleaner in HTML5, for example by accepting the
		// document in the setup method.
		this.parser.document =
			this.parser.tree.document =
			domino.createDocument( '<html></html>' );
	}

	this.parser.setup();
	this.processToken(new TagTk( 'body' ));

	this.resetVars();
};

FauxHTML5.TreeBuilder.prototype.onChunk = function ( tokens ) {
	var n = tokens.length;
	for (var i = 0; i < n; i++) {
		this.processToken(tokens[i]);
	}
};

FauxHTML5.TreeBuilder.prototype.onEnd = function ( ) {
	// Check if the EOFTk actually made it all the way through, and flag the
	// page where it did not!
	if ( this.lastToken && this.lastToken.constructor !== EOFTk ) {
		this.env.log("error", "EOFTk was lost in page", this.env.page.name);
	}
	this.emit('document', this.parser.document);
	this.resetState();
	this.emit('end');
};

FauxHTML5.TreeBuilder.prototype._att = function (maybeAttribs) {
	return maybeAttribs.map(function ( attr ) {
		return { name: attr.k, value: attr.v };
	});
};

// Adapt the token format to internal HTML tree builder format, call the actual
// html tree builder by emitting the token.
FauxHTML5.TreeBuilder.prototype.processToken = function (token) {
	//console.warn( 'processToken: ' + JSON.stringify( token ));

	var attribs = token.attribs || [],
		// Always insert data-parsoid
	    dataAttribs = token.dataAttribs || {};

	if ( this.inTransclusion ) {
		dataAttribs.inTransclusion = true;
	}

	// Assign tagid to open/self-closing tags
	if ((token.constructor === TagTk || token.constructor === SelfclosingTagTk) &&
		token.name !== 'body')
	{
		dataAttribs.tagId = this.tagId++;
	}

	attribs = attribs.concat([ {
		k: 'data-parsoid',
		v: JSON.stringify(dataAttribs)
	} ]);

	this.env.log("trace/html", this.pipelineId, function() { return JSON.stringify(token); });

	var tName, attrs, tProperty,
		self = this,
		isNotPrecededByPre = ! self.lastToken
						|| self.lastToken.constructor !== TagTk
						|| self.lastToken.name !== 'pre';
	switch( token.constructor ) {
		case String:
			if ( token.match(/^[ \t\r\n\f]+$/) && isNotPrecededByPre ) {
				// Treat space characters specially so that the tree builder
				// doesn't apply the foster parenting algorithm
				this.emit('token', {type: 'SpaceCharacters', data: token});
			} else {
				// Emit the newline as Characters token to prevent it from
				// being eaten by the treebuilder when preceded by a pre.
				this.emit('token', {type: 'Characters', data: token});

				if ( this.inTransclusion ) {
					this.env.log("debug/html", this.pipelineId, "Inserting shadow transclusion meta");
					this.emit('token', {
						type: 'StartTag',
						name: 'meta',
						data: [ { name: "typeof", value: "mw:TransclusionShadow" } ]
					});
				}

			}
			break;
		case NlTk:
			if (isNotPrecededByPre) {
				this.emit('token', {type: 'SpaceCharacters', data: '\n'});
			} else {
				// Emit the newline as Characters token to prevent it from
				// being eaten by the treebuilder when preceded by a pre.
				this.emit('token', {type: 'Characters', data: '\n'});
			}
			break;
		case TagTk:
			tName = token.name;
			if ( tName === "table" ) {
				// Don't add foster box in transclusion
				// Avoids unnecessary insertions, the case where a table
				// doesn't have tsr info, and the messy unbalanced table case,
				// like the navbox
				if ( !this.inTransclusion ) {
					this.env.log("debug/html", this.pipelineId, "Inserting foster box meta");
					this.emit('token', {
						type: 'StartTag',
						name: 'table',
						self_closing: true,
						data: [ { name: "typeof", value: "mw:FosterBox" } ]
					});
				}
			}
			this.emit('token', {type: 'StartTag', name: tName, data: this._att(attribs)});
			this.env.log("debug/html", this.pipelineId, "Inserting shadow meta for", tName);
			attrs = [
				{ name: "typeof", value: "mw:StartTag" },
				{ name: "data-stag", value: tName + ":" + dataAttribs.tagId },
				{ name: "data-parsoid", value: JSON.stringify(dataAttribs) }
			];
			this.emit('token', { type: 'Comment', data: JSON.stringify({
				"@type": "mw:shadow",
				attrs: attrs
			}) });
			break;
		case SelfclosingTagTk:
			tName = token.name;

			// Re-expand an empty-line meta-token into its constituent comment + WS tokens
			if (Util.isEmptyLineMetaToken(token)) {
				this.onChunk(dataAttribs.tokens);
				break;
			}

			tProperty = token.getAttribute( "property" );
			if ( tName === "pre" && tProperty && tProperty.match( /^mw:html$/ ) ) {
				// Unpack pre tags.
				var toks;
				attribs = attribs.filter(function( attr ) {
					if ( attr.k === "content" ) {
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
				toks.unshift( new TagTk( 'pre', attribs, dataAttribs ) );
				dataAttribs = { stx: 'html'};
				if (tsr) {
					dataAttribs.tsr = [ tsr[1] - 6, tsr[1] ];
				}
				toks.push( new EndTagTk( 'pre', [], dataAttribs ) );
				this.onChunk( toks );
				break;
			}

			// Convert mw metas to comments to avoid fostering.
			if ( tName === "meta" ) {
				var tTypeOf = token.getAttribute( "typeof" );
				if ( tTypeOf && tTypeOf.match( /^mw:/ ) ) {
					// transclusions state
					if ( tTypeOf.match( /^mw:Transclusion/ ) ) {
						this.inTransclusion = /^mw:Transclusion$/.test( tTypeOf );
					}
					this.emit( "token", { type: "Comment", data: JSON.stringify({
						"@type": tTypeOf,
						attrs: this._att( attribs )
					}) });
					break;
				}
			}

			var newAttrs = this._att(attribs);
			this.emit('token', {type: 'StartTag', name: tName, data: newAttrs});
			if ( !Util.isVoidElement(tName) ) {
				// VOID_ELEMENTS are automagically treated as self-closing by
				// the tree builder
				this.emit('token', {type: 'EndTag', name: tName, data: newAttrs});
			}
			break;
		case EndTagTk:
			tName = token.name;
			this.emit('token', {type: 'EndTag', name: tName});
			if (dataAttribs && !dataAttribs.autoInsertedEnd) {
				attrs = this._att( attribs );
				attrs.push({ name: "typeof", value: "mw:EndTag" });
				attrs.push({ name: "data-etag", value: tName });
				attrs.push({ name: "data-parsoid", value: JSON.stringify(dataAttribs)});
				this.env.log("debug/html", this.pipelineId, "Inserting shadow meta for", tName);
				this.emit('token', {type: 'Comment', data: JSON.stringify({
					"@type": "mw:shadow",
					attrs: attrs
				}) });
			}
			break;
		case CommentTk:
			this.emit('token', {type: 'Comment', data: token.value});
			break;
		case EOFTk:
			this.emit('token', { type: 'EOF' } );
			break;
		default:
			var errors = [
				"-------- Unhandled token ---------",
				"TYPE: " + token.constructor.name,
				"VAL : " + JSON.stringify(token)
			];
			this.env.log("error", errors.join("\n"));
			break;
	}
	this.lastToken = token;
};


if (typeof module === "object") {
	module.exports.FauxHTML5 = FauxHTML5;
}
