"use strict";

/* Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from the node 'html5' module. Feed it tokens using
 * processToken, and it will build you a DOM tree retrievable using .document
 * or .body(). */

var events = require('events'),
	$ = require( 'jquery' ),
	HTML5 = require('./html5/index');

var FauxHTML5 = {};


FauxHTML5.TreeBuilder = function ( env ) {
	// The parser we are going to emit our tokens to
	this.parser = new HTML5.Parser();

	// Sets up the parser
	this.parser.parse(this);

	// implicitly start a new document
	this.processToken(new TagTk( 'body' ));

	this.env = env;
	this.trace = env.debug || (env.traceFlags && (env.traceFlags.indexOf("html") !== -1));
};

// Inherit from EventEmitter
FauxHTML5.TreeBuilder.prototype = new events.EventEmitter();
FauxHTML5.TreeBuilder.prototype.constructor = FauxHTML5.TreeBuilder;

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

	if (this.trace) console.warn("---- <chunk> ----");

	this.env.dp( 'chunk: ' + JSON.stringify( tokens, null, 2 ) );
	for (var i = 0; i < n; i++) {
		this.processToken(tokens[i]);
	}

	if (this.trace) console.warn("---- </chunk> ----");
};

FauxHTML5.TreeBuilder.prototype.onEnd = function ( ) {
	// Check if the EOFTk actually made it all the way through, and flag the
	// page where it did not!
	if ( this.lastToken && this.lastToken.constructor !== EOFTk ) {
		this.env.errCB( "EOFTk was lost in page " + this.env.pageName );
	}

	//console.warn('Fauxhtml5 onEnd');
	// FIXME HACK: For some reason the end token is not processed sometimes,
	// which normally fixes the body reference up.
	var document = this.parser.document;
	document.body = document.getElementsByTagName('body')[0];

	this.emit( 'document', document );

	// XXX: more clean up to allow reuse.
	this.parser.setup();
	this.processToken(new TagTk( 'body' ));
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

	if ( dataAttribs ) {
		var dataMW = JSON.stringify( dataAttribs );
		if ( dataMW !== '{}' ) {
			attribs = attribs.concat([
					{
						// Mediawiki-specific round-trip / non-semantic information
						k: 'data-parsoid',
						v: dataMW
					} ] );
		}
	}

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
			if (dataAttribs && dataAttribs.tsr) {
				attrs = [];
				if ( this.trace ) console.warn('inserting shadow meta');
				attrs.push({nodeName: "typeof", nodeValue: "mw:StartTag"});
				attrs.push({nodeName: "data-stag", nodeValue: tName + ':' + dataAttribs.tsr});
				this.emit('token', {type: 'StartTag', name: 'meta', data: attrs});
			}
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

			if ( this.trace ) console.warn('inserting shadow meta');
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
