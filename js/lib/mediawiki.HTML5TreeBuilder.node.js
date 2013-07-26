"use strict";

/* Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from the node 'html5' module. Feed it tokens using
 * processToken, and it will build you a DOM tree retrievable using .document
 * or .body(). */

var events = require('events'),
	util = require('util'),
	$ = require( './fakejquery' ),
	HTML5 = require('./html5/index'),
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

	// The parser we are going to emit our tokens to
	this.parser = new HTML5.Parser();

	// Sets up the parser
	this.parser.parse(this);

	// implicitly start a new document
	this.processToken(new TagTk( 'body' ));

	this.env = env;
	this.trace = env.conf.parsoid.debug || (env.conf.parsoid.traceFlags && (env.conf.parsoid.traceFlags.indexOf("html") !== -1));

	// Assigned to start/self-closing tags
	this.tagId = 1;
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

FauxHTML5.TreeBuilder.prototype.onChunk = function ( tokens ) {
	var n = tokens.length;
	if (n === 0) {
		return;
	}

	if (this.trace) { console.warn("---- <chunk> ----"); }

	this.env.dp( 'chunk: ' + JSON.stringify( tokens, null, 2 ) );
	for (var i = 0; i < n; i++) {
		this.processToken(tokens[i]);
	}

	if (this.trace) { console.warn("---- </chunk> ----"); }
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

	// XXX: more clean up to allow reuse.
	this.parser.setup();
	this.processToken(new TagTk( 'body' ));
	this.tagId = 1; // Reset
};

FauxHTML5.TreeBuilder.prototype._att = function (maybeAttribs) {
	var atts = [];
	if ( maybeAttribs && $.isArray( maybeAttribs ) ) {
		for(var i = 0, length = maybeAttribs.length; i < length; i++) {
			var att = maybeAttribs[i];
			atts.push({nodeName: att.k, nodeValue: att.v});
		}
	}
	return atts;
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

	var tName, attrs,
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
			this.emit('token', {type: 'StartTag', name: tName, data: this._att(attribs)});
			attrs = [];
			if ( this.trace ) { console.warn('inserting shadow meta for ' + tName); }
			attrs.push({nodeName: "typeof", nodeValue: "mw:StartTag"});
			attrs.push({nodeName: "data-stag", nodeValue: tName + ':' + dataAttribs.tagId});
			this.emit('token', {type: 'StartTag', name: 'meta', data: attrs});
			break;
		case SelfclosingTagTk:
			tName = token.name;
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

			if ( this.trace ) { console.warn('inserting shadow meta for ' + tName); }
			attrs = this._att(attribs);
			attrs.push({nodeName: "typeof", nodeValue: "mw:EndTag"});
			attrs.push({nodeName: "data-etag", nodeValue: tName});
			this.emit('token', {type: 'StartTag', name: 'meta', data: attrs});
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
