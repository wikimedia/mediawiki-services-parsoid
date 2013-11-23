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

var gid = 0;

FauxHTML5.TreeBuilder = function ( env ) {
	events.EventEmitter.call(this);

	this.uid = gid++;

	// The parser we are going to emit our tokens to
	this.parser = new HTML5.Parser({
		document: domino.createDocument( '<html></html>' )
	});

	// Sets up the parser
	this.parser.tokenizer = this;

	// implicitly start a new document
	this.processToken(new TagTk( 'body' ));

	this.env = env;
	this.trace = env.conf.parsoid.debug || (env.conf.parsoid.traceFlags && (env.conf.parsoid.traceFlags.indexOf("html") !== -1));

	// Reset variable state
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

FauxHTML5.TreeBuilder.prototype.resetState = function () {
	// Assigned to start/self-closing tags
	this.tagId = 1;

	// Reset the parser
	this.removeAllListeners( "token" );
	this.removeAllListeners( "end" );
	this.parser.setup();
	this.processToken(new TagTk( 'body' ));

	this.needsReset = false;
	this.inTransclusion = false;
};

FauxHTML5.TreeBuilder.prototype.onChunk = function ( tokens ) {

	// Makes sure the state is also reset for sub-pipelines
	if (this.needsReset) {
		this.resetState();
	}

	var n = tokens.length;
	if (n === 0) {
		return;
	}

	if (this.trace) { console.warn("---- HTML-" + this.uid + ":<chunk> ----"); }

	this.env.dp( 'chunk: ' + JSON.stringify( tokens, null, 2 ) );
	for (var i = 0; i < n; i++) {
		this.processToken(tokens[i]);
	}

	if (this.trace) { console.warn("---- HTML-" + this.uid + ":</chunk> ----"); }
};

FauxHTML5.TreeBuilder.prototype.onEnd = function ( ) {
	// Check if the EOFTk actually made it all the way through, and flag the
	// page where it did not!
	if ( this.lastToken && this.lastToken.constructor !== EOFTk ) {
		this.env.errCB( "EOFTk was lost in page " + this.env.page.name );
	}

	//console.warn('Fauxhtml5 onEnd');
	var document = this.parser.document;

	this.emit( 'document', document );

	// Make sure the state is also reset for sub-pipelines
	this.needsReset = true;
};

FauxHTML5.TreeBuilder.prototype._att = function (maybeAttribs) {
	if ( Array.isArray( maybeAttribs ) ) {
		return maybeAttribs.map(function ( attr ) {
			return { name: attr.k, value: attr.v };
		});
	}
	return [];
};

// Adapt the token format to internal HTML tree builder format, call the actual
// html tree builder by emitting the token.
FauxHTML5.TreeBuilder.prototype.processToken = function (token) {
	//console.warn( 'processToken: ' + JSON.stringify( token ));

	var attribs = token.attribs || [],
	    dataAttribs = token.dataAttribs;

	// Always insert data-parsoid
	if (!dataAttribs) {
		dataAttribs = {};
	}

	if ( this.inTransclusion ) {
		if ( Object.isFrozen( dataAttribs ) ) {
			dataAttribs = Util.clone( dataAttribs );
		}
		dataAttribs.inTransclusion = true;
	}

	// Assign tagid to open/self-closing tags
	if ((token.constructor === TagTk || token.constructor === SelfclosingTagTk) &&
		token.name !== 'body')
	{
		if (Object.isFrozen(dataAttribs)) {
			dataAttribs = Util.clone(dataAttribs);
		}
		dataAttribs.tagId = this.tagId++;
	}

	attribs = attribs.concat([ {
		k: 'data-parsoid',
		v: JSON.stringify(dataAttribs)
	} ]);

	if (this.trace) {
		console.warn("T:html: " + JSON.stringify(token));
	}

	var tName, attrs, tTypeOf, tProperty,
		self = this,
		isNotPrecededByPre = function () {
			return  ! self.lastToken ||
						self.lastToken.constructor !== TagTk ||
						self.lastToken.name !== 'pre';
		};
	switch( token.constructor ) {
		case String:
			// note that we sometimes add 'dataAttrib' and 'get' fields to
			// string objects, making them non-primitive.
			// ("git grep 'new String'" for more details)
			// we strip that information from the tokens here so we don't
			// end up with non-primitive strings in the DOM.
			token = token.valueOf(); // convert token to primitive string.
			if ( token.match(/^[ \t\r\n\f]+$/) && isNotPrecededByPre() ) {
				// Treat space characters specially so that the tree builder
				// doesn't apply the foster parenting algorithm
				this.emit('token', {type: 'SpaceCharacters', data: token});
			} else {
				// Emit the newline as Characters token to prevent it from
				// being eaten by the treebuilder when preceded by a pre.
				this.emit('token', {type: 'Characters', data: token});

				if ( this.inTransclusion ) {
					if ( this.trace ) {
						console.warn('inserting shadow transclusion meta');
					}
					this.emit('token', {
						type: 'StartTag',
						name: 'meta',
						data: [ { name: "typeof", value: "mw:TransclusionShadow" } ]
					});
				}

			}
			break;
		case NlTk:
			if (isNotPrecededByPre()) {
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
					if ( this.trace ) {
						console.warn('inserting foster box meta');
					}
					this.emit('token', {
						type: 'StartTag',
						name: 'meta',
						data: [ { name: "typeof", value: "mw:FosterBox" } ]
					});
				}
			}
			this.emit('token', {type: 'StartTag', name: tName, data: this._att(attribs)});
			attrs = [];
			if ( this.trace ) { console.warn('inserting shadow meta for ' + tName); }
			attrs.push({name: "typeof", value: "mw:StartTag"});
			var stag = tName + ":" + dataAttribs.tagId;
			if ( dataAttribs.tsr ) {
				stag += ":" + dataAttribs.tsr.join( "," );
			}
			attrs.push({ name: "data-stag", value: stag });
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
				delete dataAttribs.endpos;
				var tsr = dataAttribs.tsr;
				if (tsr) {
					dataAttribs.tsr = [ tsr[0], tsr[0] + endpos ];
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
			tTypeOf = token.getAttribute( "typeof" );
			if ( tName === "meta" && tTypeOf && tTypeOf.match( /^mw:/ ) ) {
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

			this.emit('token', {type: 'StartTag', name: tName, data: this._att(attribs)});
			if ( HTML5.VOID_ELEMENTS.indexOf( tName ) < 0 ) {
				// VOID_ELEMENTS are automagically treated as self-closing by
				// the tree builder
				this.emit('token', {type: 'EndTag', name: tName, data: this._att(attribs)});
			}
			break;
		case EndTagTk:
			tName = token.name;
			this.emit('token', {type: 'EndTag', name: tName});
			if (dataAttribs && !dataAttribs.autoInsertedEnd) {
				attrs = this._att( attribs );
				attrs.push({ name: "typeof", value: "mw:EndTag" });
				attrs.push({ name: "data-etag", value: tName });
				if ( this.trace ) { console.warn('inserting shadow meta for ' + tName); }
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
			this.emit('end');
			this.emit('token', { type: 'EOF' } );
			this.document = this.parser.document;
			if ( ! this.document.body ) {
				// HACK: This should not be needed really.
				this.document.body = this.parser.document.getElementsByTagName('body')[0];
			}
			// Emit the document to consumers
			//this.emit('document', this.document);
			break;
		default:
			console.warn("-------- Unhandled token ---------");
			console.warn("TYPE: " + token.constructor.name);
			console.warn("VAL : " + JSON.stringify(token));
			console.trace();
			break;
	}
	this.lastToken = token;
};


if (typeof module === "object") {
	module.exports.FauxHTML5 = FauxHTML5;
}
