"use strict";
/*
 * MediaWiki-compatible italic/bold handling as a token stream transformation.
 */

var Util = require('./mediawiki.Util.js').Util,
    defines = require('./mediawiki.parser.defines.js');
// define some constructor shortcuts
var NlTk = defines.NlTk,
    TagTk = defines.TagTk,
    SelfclosingTagTk = defines.SelfclosingTagTk,
    EndTagTk = defines.EndTagTk;

function QuoteTransformer ( dispatcher ) {
	this.reset();
	this.register( dispatcher );
}

// constants
QuoteTransformer.prototype.quoteAndNewlineRank = 2.1;
QuoteTransformer.prototype.anyRank = 2.101; // Just after regular quote and newline

QuoteTransformer.prototype.reset = function ( ) {
	// Chunks alternate between quote tokens and sequences of non-quote
	// tokens.  The quote tokens are later replaced with the actual tag
	// token for italic or bold.  The first chunk is a non-quote chunk.
	this.chunks = [];
	// The current chunk we're accumulating into.
	this.currentChunk = [];
	// last italic / last bold open tag seen.  Used to add autoInserted flags
	// where necessary.
	this.last = Object.create(null);

	this.isActive = false;
};


// Register this transformer with the TokenTransformer
QuoteTransformer.prototype.register = function ( dispatcher ) {
	this.dispatcher = dispatcher;
	// Register for QUOTE tag tokens
	dispatcher.addTransform( this.onQuote.bind(this), "QuoteTransformer:onQuote",
			this.quoteAndNewlineRank, 'tag', 'mw-quote' );
};

// Make a copy of the token context
QuoteTransformer.prototype._startNewChunk = function ( ) {
	this.chunks.push( this.currentChunk );
	this.currentChunk = [];
};

// Handle QUOTE tags. These are collected in italic/bold lists depending on
// the length of quote string. Actual analysis and conversion to the
// appropriate tag tokens is deferred until the next NEWLINE token triggers
// onNewLine.
QuoteTransformer.prototype.onQuote = function ( token, frame, prevToken ) {
	var qlen = token.value.length;

	if ( ! this.isActive ) {
		this.dispatcher.addTransform( this.onNewLine.bind(this), "QuoteTransformer:onNewLine",
				this.quoteAndNewlineRank, 'newline' );
		// Treat 'th' just the same as a newline
		this.dispatcher.addTransform( this.onNewLine.bind(this), "QuoteTransformer:onNewLine",
				this.quoteAndNewlineRank, 'tag', 'td' );
		// Treat 'td' just the same as a newline
		this.dispatcher.addTransform( this.onNewLine.bind(this), "QuoteTransformer:onNewLine",
				this.quoteAndNewlineRank, 'tag', 'th' );
		// Treat end-of-input just the same as a newline
		this.dispatcher.addTransform( this.onNewLine.bind(this), "QuoteTransformer:onNewLine:end",
				this.quoteAndNewlineRank, 'end' );
		// register for any token if not yet active
		this.dispatcher.addTransform( this.onAny.bind(this), "QuoteTransformer:onAny", this.anyRank, 'any' );
		this.isActive = true;
		// add initial context to chunks (we'll get rid of it later)
		this.currentChunk.push( prevToken ? prevToken : '' );
	}

	if (qlen===2 || qlen===3 || qlen===5) {
			this._startNewChunk();
			this.currentChunk.push( token );
			this._startNewChunk();
	} else {
		console.assert(false, "should be transformed by tokenizer");
	}

	return {};
};

QuoteTransformer.prototype.onAny = function ( token, frame, prevToken ) {
	//console.warn('qt onAny: ' + JSON.stringify(token, null, 2));
	this.currentChunk.push( token );
	return {};
};

// Handle NEWLINE tokens, which trigger the actual quote analysis on the
// collected quote tokens so far.
QuoteTransformer.prototype.onNewLine = function (  token, frame, prevToken ) {
	var res, qlen, i;

	if( ! this.isActive ) {
		// Nothing to do, quick abort.
		return { token: token };
	}
	//token.rank = this.quoteAndNewlineRank;

	// count number of bold and italics
	var numbold = 0, numitalics = 0;
	for (i = 1; i < this.chunks.length; i += 2) {
		console.assert(this.chunks[i].length===1); // quote token
		qlen = this.chunks[i][0].value.length;
		if (qlen===2 || qlen===5) { numitalics++; }
		if (qlen===3 || qlen===5) { numbold++; }
	}

	// balance out tokens, convert placeholders into tags
	if ( (numitalics % 2 === 1) && (numbold % 2 === 1) ) {
		var firstsingleletterword = -1,
			firstmultiletterword = -1,
			firstspace = -1;
		for (i = 1; i < this.chunks.length; i += 2) {
			// only look at bold tags
			if (this.chunks[i][0].value.length !== 3) { continue; }
			// find the first previous token which is text
			// (this is an approximation, since the wikitext algorithm looks
			// at the raw unparsed source here)
			var prevChunk = this.chunks[i-1], ctxPrevToken = '';
			for (var j = prevChunk.length - 1;
				 ctxPrevToken.length < 2 && j >= 0;
				 j--) {
				if (prevChunk[j].constructor === String) {
					ctxPrevToken = prevChunk[j] + ctxPrevToken;
				}
			}
			//console.warn("balancing! " + ctxPrevToken);
			var lastchar = ctxPrevToken[ctxPrevToken.length - 1],
			secondtolastchar = ctxPrevToken[ctxPrevToken.length - 2];
			if (lastchar === ' ' && firstspace === -1) {
				firstspace = i;
			} else if (lastchar !== ' ') {
				if ( secondtolastchar === ' ' &&
					 firstsingleletterword === -1)
				{
					firstsingleletterword = i;
					// if firstsingleletterword is set, we don't need
					// to look at the options options, so we can bail early
					break;
				} else if ( firstmultiletterword === -1) {
					firstmultiletterword = i;
				}
			}
		}

		// console.log("fslw: " + firstsingleletterword + "; fmlw: " + firstmultiletterword + "; fs: " + firstspace);

		// now see if we can convert a bold to an italic and
		// an apostrophe
		if (firstsingleletterword > -1) {
			this.convertBold(firstsingleletterword);
		} else if (firstmultiletterword > -1) {
			this.convertBold(firstmultiletterword);
		} else if (firstspace > -1) {
			this.convertBold(firstspace);
		} else {
			// (notice that it is possible for all three to be -1 if, for
			// example, there is only one pentuple-apostrophe in the line)
			// In this case, do no balancing.
			/* jshint noempty: false */
		}
	}

	// convert the quote tokens into tags
	this.convertQuotesToTags();

	// return all collected tokens including the newline
	this.currentChunk.push( token );
	this._startNewChunk();
	this.chunks[0].shift(); // remove 'prevToken' before first quote.
	res = { tokens: Array.prototype.concat.apply([], this.chunks) };

	// prepare for next line
	this.reset();

	// remove registrations
	this.dispatcher.removeTransform( this.quoteAndNewlineRank, 'end' );
	this.dispatcher.removeTransform( this.quoteAndNewlineRank, 'tag', 'td' );
	this.dispatcher.removeTransform( this.quoteAndNewlineRank, 'tag', 'th' );
	this.dispatcher.removeTransform( this.quoteAndNewlineRank, 'newline' );
	this.dispatcher.removeTransform( this.anyRank, 'any' );
	//console.warn( 'res:' + JSON.stringify( res, null, 2 ));

	return res;
};

// Convert a bold token to italic to balance an uneven number of both bold and
// italic tags. In the process, one quote needs to be converted back to text.
QuoteTransformer.prototype.convertBold = function ( i ) {
	// this should be a bold tag.
	console.assert(i > 0 && this.chunks[i].length===1 &&
				   this.chunks[i][0].value.length === 3);
	// we're going to convert it to a single plain text ' plus an italic tag
	this.chunks[i-1].push( "'" );
	var oldbold = this.chunks[i][0];
	var tsr = oldbold.dataAttribs ? oldbold.dataAttribs.tsr : null;
	if ( tsr ) {
		tsr = [ tsr[0]+1, tsr[1] ];
	}
	var newbold = new SelfclosingTagTk( 'mw-quote', [], { tsr: tsr });
	newbold.value = "''"; // italic!
	this.chunks[i] = [ newbold ];
};

// Convert quote tokens to tags, using the same state machine as the
// PHP parser uses.
QuoteTransformer.prototype.convertQuotesToTags = function() {

	var lastboth = -1, state = '', i, qlen;
	for (i = 1; i < this.chunks.length; i += 2) {
		console.assert(this.chunks[i].length === 1);
		qlen = this.chunks[i][0].value.length;
		if (qlen === 2) {
			if (state === 'i') {
				this.quoteToTag(i, [new EndTagTk( 'i' )]);
				state = '';
			} else if (state === 'bi') {
				this.quoteToTag(i, [new EndTagTk( 'i' )]);
				state = 'b';
			} else if (state === 'ib') {
				// annoying!
				this.quoteToTag(i, [new EndTagTk( 'b' ), new EndTagTk( 'i' ),
									new TagTk( 'b' )], "bogus two");
				state = 'b';
			} else if (state === 'both') {
				this.quoteToTag(lastboth, [new TagTk( 'b' ), new TagTk( 'i' )]);
				this.quoteToTag(i, [new EndTagTk( 'i' )]);
				state = 'b';
			} else { // state can be 'b' or ''
				this.quoteToTag(i, [new TagTk( 'i' )]);
				state += 'i';
			}
		} else if (qlen === 3) {
			if (state === 'b') {
				this.quoteToTag(i, [new EndTagTk( 'b' )]);
				state = '';
			} else if (state === 'ib') {
				this.quoteToTag(i, [new EndTagTk( 'b' )]);
				state = 'i';
			} else if (state === 'bi') {
				// annoying!
				this.quoteToTag(i, [new EndTagTk( 'i' ), new EndTagTk( 'b' ),
									new TagTk( 'i' )], "bogus two");
				state = 'i';
			} else if (state === 'both') {
				this.quoteToTag(lastboth, [new TagTk( 'i' ), new TagTk( 'b' )]);
				this.quoteToTag(i, [new EndTagTk( 'b' )]);
				state = 'i';
			} else { // state can be 'i' or ''
				this.quoteToTag(i, [new TagTk( 'b' )]);
				state += 'b';
			}
		} else if (qlen === 5) {
			if (state === 'b') {
				this.quoteToTag(i, [new EndTagTk( 'b' ), new TagTk( 'i' )]);
				state = 'i';
			} else if (state === 'i') {
				this.quoteToTag(i, [new EndTagTk( 'i' ), new TagTk( 'b' )]);
				state = 'b';
			} else if (state === 'bi') {
				this.quoteToTag(i, [new EndTagTk( 'i' ), new EndTagTk( 'b' )]);
				state = '';
			} else if (state === 'ib') {
				this.quoteToTag(i, [new EndTagTk( 'b' ), new EndTagTk( 'i' )]);
				state = '';
			} else if (state === 'both') {
				this.quoteToTag(lastboth, [new TagTk( 'i' ), new TagTk( 'b' )]);
				this.quoteToTag(i, [new EndTagTk( 'b' ), new EndTagTk( 'i' )]);
				state = '';
			} else { // state == ''
				lastboth = i;
				state = 'both';
			}
		}
	}

	// now close all remaining tags.  notice that order is important.
	if ( state === 'both' ) {
		this.quoteToTag(lastboth, [new TagTk( 'b' ), new TagTk( 'i' )]);
		state = 'bi';
	}
	if ( state === 'b' || state === 'ib' ) {
		this.currentChunk.push( new EndTagTk( 'b' ) );
		this.last.b.dataAttribs.autoInsertedEnd = 1;
	}
	if ( state === 'i' || state === 'bi' || state === 'ib' ) {
		this.currentChunk.push( new EndTagTk( 'i' ) );
		this.last.i.dataAttribs.autoInsertedEnd = 1;
	}
	if ( state === 'bi' ) {
		this.currentChunk.push( new EndTagTk( 'b' ) );
		this.last.b.dataAttribs.autoInsertedEnd = 1;
	}
};

// Convert italics/bolds into tags
QuoteTransformer.prototype.quoteToTag = function( chunk, tags, ignoreBogusTwo ){
	console.assert(this.chunks[chunk].length === 1);
	var result = [];
	var oldtag = this.chunks[chunk][0];
	// make tsr
	var tsr = oldtag.dataAttribs ? oldtag.dataAttribs.tsr : null;
	var startpos = tsr ? tsr[0] : null, endpos = tsr ? tsr[1] : null;
	for (var i=0; i<tags.length; i++) {
		if (tsr) {
			if ( i===0 && ignoreBogusTwo ) {
				this.last[tags[i].name].dataAttribs.autoInsertedEnd = 1;
			} else if ( i === 2 && ignoreBogusTwo ) {
				tags[i].dataAttribs.autoInsertedStart = 1;
			} else if (tags[i].name === 'b') {
				tags[i].dataAttribs.tsr = [ startpos, startpos + 3 ];
				startpos = tags[i].dataAttribs.tsr[1];
			} else if (tags[i].name === 'i') {
				tags[i].dataAttribs.tsr = [ startpos, startpos + 2 ];
				startpos = tags[i].dataAttribs.tsr[1];
			} else { console.assert(false); }
		}
		this.last[tags[i].name] = (tags[i].constructor === EndTagTk) ? null : tags[i];
		result.push(tags[i]);
	}
	if (tsr) { console.assert(startpos === endpos, startpos, endpos); }
	this.chunks[chunk] = result;
};

if (typeof module === "object") {
	module.exports.QuoteTransformer = QuoteTransformer;
}
