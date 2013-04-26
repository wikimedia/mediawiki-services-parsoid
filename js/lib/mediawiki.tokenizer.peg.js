/**
 * Tokenizer for wikitext, using PEG.js and a separate PEG grammar file
 * (pegTokenizer.pegjs.txt)
 *
 * Use along with a HTML5TreeBuilder and the DOMPostProcessor(s) for HTML
 * output.
 *
 */
"use strict";

var PEG = require('pegjs'),
	path = require('path'),
	LRU = require("lru-cache"),
	fs = require('fs'),
	events = require('events');

function PegTokenizer( env, canCache ) {
	this.env = env;
	this.canCache = canCache;
	this.options = {};
	if ( this.canCache ) {
		this.cacheAccum = { chunks: [] };
	}
}

// Inherit from EventEmitter
PegTokenizer.prototype = new events.EventEmitter();
PegTokenizer.prototype.constructor = PegTokenizer;

PegTokenizer.src = false;

/*
 * Process text.  The text is tokenized in chunks and control
 * is yielded to the event loop after each top-level block is
 * tokenized enabling the tokenized chunks to be processed at
 * the earliest possible opportunity.
 */
PegTokenizer.prototype.process = function( text, cacheKey ) {
	this._processText(text, false, cacheKey);
};

/**
 * Set start and end offsets of the source that generated this DOM
 */
PegTokenizer.prototype.setSourceOffsets = function(start, end) {
	this.options.startOffset = start;
	this.options.endOffset = end;
};

/*
 * Process text synchronously -- the text is tokenized in one shot
 */
PegTokenizer.prototype.processSync = function( text, cacheKey ) {
	this._processText(text, true, cacheKey);
};

/*
 * The main worker. Sets up event emission ('chunk' and 'end' events).
 * Consumers are supposed to register with PegTokenizer before calling
 * process().
 */
PegTokenizer.prototype._processText = function( text, fullParse, cacheKey ) {
	if ( !this.tokenizer ) {
		// Construct a singleton static tokenizer.
		var pegSrcPath = path.join( __dirname, 'pegTokenizer.pegjs.txt' );
		this.src = fs.readFileSync( pegSrcPath, 'utf8' );
		var tokenizerSource = PEG.buildParser(this.src,
				{ cache: true, trackLineAndColumn: false }).toSource();

		/* We patch the generated source to assign the arguments array for the
		* parse function to a function-scoped variable. We use this to pass
		* in callbacks and other information, which can be used from actions
		* run when matching a production. In particular, we pass in a
		* callback called for a chunk of tokens in toplevelblock. Setting this
		* callback per call to parse() keeps the tokenizer reentrant, so that it
		* can be reused to expand templates while a main parse is ongoing.
		* PEG tokenizer construction is very expensive, so having a single
		* reentrant tokenizer is a big win.
		*
		* We could also make modules available to the tokenizer by prepending
		* requires to the source.
		*/
		tokenizerSource = tokenizerSource.replace( 'parse: function(input, startRule) {',
					'parse: function(input, startRule) { var pegArgs = arguments[2];' )
						// Include the stops key in the cache key
						.replace(/var cacheKey = "[^@"]+@" \+ pos/g,
								function(m){ return m +' + stops.key'; });
		// replace trailing whitespace, to make jshint happier.
		tokenizerSource = tokenizerSource.replace(/[ \t]+$/mg, '');
		// add jshint config
		tokenizerSource =
			'/* jshint loopfunc:true, latedef:false, nonstandard:true */\n' +
			tokenizerSource + ';';

		// eval is not evil in the case of a grammar-generated tokenizer.
		/* jshint evil:true */
		//console.warn( tokenizerSource );
		PegTokenizer.prototype.tokenizer = eval( tokenizerSource );
		// alias the parse method
		this.tokenizer.tokenize = this.tokenizer.parse;

		// Also, while we are at it, create a tokenizer cache.
		PegTokenizer.prototype.cache = LRU(25);
	}
	if ( this.canCache && cacheKey ) {
		var maybeCached = this.cache.get(cacheKey);
		if ( maybeCached ) {
			try {
				this.env.tp( 'tokenizer cache hit for ' + cacheKey );
				//console.warn( JSON.stringify( maybeCached, null, 2 ) );
				for ( var i = 0, l = maybeCached.length; i < l; i++ ) {
					var cachedChunk = maybeCached[i];
					if (this.env.conf.parsoid.trace) {
						this.env.tracer.outputChunk(cachedChunk);
					}
					// emit a clone of this chunk
					this.emit('chunk', cachedChunk );
				}
				this.emit('end');
				return;
			} catch ( e ) {
				this.env.errCB(e);
			}

		} else {
			this.cacheAccum.key = cacheKey;
		}
	}

	// Some input normalization: force a trailing newline
	//if ( text.substring(text.length - 1) !== "\n" ) {
	//	text += "\n";
	//}

	var chunkCB;
	if ( this.canCache && cacheKey ) {
		chunkCB = this.onCacheChunk.bind( this );
	} else {
		chunkCB = this.emit.bind( this, 'chunk' );
	}

	// Kick it off!
	var srcOffset = this.options.startOffset || 0;
	var args = { cb: chunkCB, pegTokenizer: this, srcOffset: srcOffset, env: this.env };
	if (fullParse) {
		if ( ! this.env.conf.parsoid.debug ) {
			try {
				this.tokenizer.tokenize(text, 'start', args);
			} catch (e) {
				this.env.errCB(e);
			}
		} else {
			this.tokenizer.tokenize(text, 'start', args);
		}
		this.onEnd();
	} else {
		this.tokenizeAsync(text, srcOffset, chunkCB);
	}
};

PegTokenizer.prototype.tokenizeAsync = function( text, srcOffset, cb ) {
	var ret,
		pegTokenizer = this,
		args = { cb: cb, pegTokenizer: this, srcOffset: srcOffset, env: this.env };

	if ( ! this.env.conf.parsoid.debug ) {
		try {
			ret = this.tokenizer.tokenize(text, 'toplevelblock', args);
		} catch (e) {
			this.env.errCB(e);
			return;
		}
	} else {
		ret = this.tokenizer.tokenize(text, 'toplevelblock', args);
	}

	if (ret.eof) {
		this.onEnd();
	} else {
		// Schedule parse of next chunk
		process.nextTick(function() {
			// console.warn("new input: " + JSON.stringify(ret.newInput));
			// console.warn("offset   : " + ret.newOffset);
			pegTokenizer.tokenizeAsync(ret.newInput, ret.newOffset, cb);
		});
	}
};

PegTokenizer.prototype.onCacheChunk = function ( chunk ) {
	// make a deep copy of the chunk for now
	this.cacheAccum.chunks.push( chunk.slice() );
	//console.warn( 'onCacheChunk: ' + this.cacheAccum.key + JSON.stringify( chunk, null, 2 ) );
	try {
		this.emit('chunk', chunk);
	} catch ( e ) {
		this.env.errCB(e);
	}
};

PegTokenizer.prototype.onEnd = function ( ) {
	if ( this.canCache && this.cacheAccum.key) {
		this.cache.set(this.cacheAccum.key, this.cacheAccum.chunks);
		// reset cacheAccum
		this.cacheAccum = { chunks: [] };
	}

	// Reset source offsets
	this.options.startOffset = undefined;
	this.options.endOffset = undefined;

	this.emit('end');
};

/**
 * Tokenize via a production passed in as an arg.
 * The text is tokenized synchronously in one shot.
 */
PegTokenizer.prototype.tokenize = function( text, production ) {
	try {
		// Some productions use callbacks: start, tlb, toplevelblock.
		// All other productions return tokens directly.
		var toks = [],
			retToks = this.tokenizer.tokenize(text, production, {
				cb: function(r) { toks = toks.concat(r); },
				pegTokenizer: this,
				srcOffset: this.options.startOffset || 0,
				env: this.env
			});

		if (retToks.constructor === Array && retToks.length > 0) {
			toks = toks.concat(retToks);
		}
		return toks;
	} catch ( e ) {
		// console.warn("Input: " + text);
		// console.warn("Rule : " + production);
		// console.warn("ERROR: " + e);
		// console.warn("Stack: " + e.stack);
		return false;
	}
};

/**
 * Tokenize a URL
 */
PegTokenizer.prototype.tokenizeURL = function( text ) {
	return this.tokenize(text, "url");
};

PegTokenizer.prototype.processImageOptions = function( text ) {
	return this.tokenize(text, 'img_options');
};

/*
 * Inline breaks, flag-enabled production which detects end positions for
 * active higher-level productions in inline and other nested productions.
 * Those inner productions are then exited, so that the outer production can
 * handle the end marker.
 */
PegTokenizer.prototype.inline_breaks = function (input, pos, stops ) {
	var counters = stops.counters;
	switch( input[pos] ) {
		case '=':
			return stops.onStack( 'equal' ) ||
				( counters.h &&
					( pos === input.length - 1 ||
					  input.substr( pos + 1 )
						// possibly more equals followed by spaces or comments
						.match(/^=*(?:[ \t]+|<\!--(?:(?!-->)[^\r\n])+-->)*(?:[\r\n]|$)/) !== null )
				) || null;
		case '|':
			return stops.onStack('pipe') ||
				//counters.template ||
				counters.linkdesc || (
					stops.onStack('table') && (
						counters.tableCellArg || (
							pos < input.length - 1 && input[pos+1].match(/[}|]/) !== null
						)
					)
				) ||
				null;
		case '{':
			// {{!}} pipe templates..
			return (
						( stops.onStack( 'pipe' ) &&
						  ! counters.template &&
						  input.substr(pos, 5) === '{{!}}' ) ||
						( stops.onStack( 'table' ) &&
							(
								input.substr(pos, 10) === '{{!}}{{!}}' ||
								counters.tableCellArg
							)
						)
					) && input.substr( pos, 5 ) === '{{!}}' || null;
		case "!":
			return stops.onStack( 'table' ) && input[pos + 1] === "!" ||
				null;
		case "}":
			return counters.template && input[pos + 1] === "}" || null;
		case ":":
			return counters.colon &&
				! stops.onStack( 'extlink' ) &&
				! counters.linkdesc || null;
		case "\r":
			return stops.onStack( 'table' ) &&
				input.substr(pos).match(/\r\n?\s*[!|]/) !== null ||
				null;
		case "\n":
			//console.warn(JSON.stringify(input.substr(pos, 5)), stops);
			return ( stops.onStack( 'table' ) &&
				// allow leading whitespace in tables
				input.substr(pos, 200).match( /^\n\s*[!|]/ ) ) ||
				// break on table-like syntax when the table stop is not
				// enabled. XXX: see if this can be improved
				//input.substr(pos, 200).match( /^\n[!|]/ ) ||
				null;
		case "]":
			return stops.onStack( 'extlink' ) ||
				( counters.linkdesc && input[pos + 1] === ']' ) ||
				null;
		case "<":
			return ( counters.pre &&  input.substr( pos, 6 ) === '<pre>' ) ||
				( counters.noinclude && input.substr(pos, 12) === '</noinclude>' ) ||
				( counters.includeonly && input.substr(pos, 14) === '</includeonly>' ) ||
				( counters.onlyinclude && input.substr(pos, 14) === '</onlyinclude>' ) ||
				null;
		default:
			return null;
	}
};

// Alternate version of the above. The hash is likely faster, but the nested
// function calls seem to cancel that out.
PegTokenizer.prototype.breakMap = {
	'=': function(input, pos, syntaxFlags) {
		return syntaxFlags.equal ||
			( syntaxFlags.h &&
				input.substr( pos + 1, 200)
				.match(/[ \t]*[\r\n]/) !== null ) || null;
	},
	'|': function ( input, pos, syntaxFlags ) {
		return syntaxFlags.template ||
			syntaxFlags.linkdesc ||
			( syntaxFlags.table &&
				(
					input[pos + 1].match(/[|}]/) !== null ||
					syntaxFlags.tableCellArg
				)
			) || null;
	},
	"!": function ( input, pos, syntaxFlags ) {
		return syntaxFlags.table && input[pos + 1] === "!" ||
			null;
	},
	"}": function ( input, pos, syntaxFlags ) {
		return syntaxFlags.template && input[pos + 1] === "}" || null;
	},
	":": function ( input, pos, syntaxFlags ) {
		return syntaxFlags.colon &&
			! syntaxFlags.extlink &&
			! syntaxFlags.linkdesc || null;
	},
	"\r": function ( input, pos, syntaxFlags ) {
		return syntaxFlags.table &&
			input.substr(pos, 4).match(/\r\n?[!|]/) !== null ||
			null;
	},
	"\n": function ( input, pos, syntaxFlags ) {
		return syntaxFlags.table &&
			input[pos + 1] === '!' ||
			input[pos + 1] === '|' ||
			null;
	},
	"]": function ( input, pos, syntaxFlags ) {
		return syntaxFlags.extlink ||
			( syntaxFlags.linkdesc && input[pos + 1] === ']' ) ||
			null;
	},
	"<": function ( input, pos, syntaxFlags ) {
		return syntaxFlags.pre &&  input.substr( pos, 6 ) === '</pre>' || null;
	}
};

PegTokenizer.prototype.inline_breaks_hash = function (input, pos, syntaxFlags ) {
	return this.breakMap[ input[pos] ]( input, pos, syntaxFlags);
	//console.warn( 'ilbn res: ' + JSON.stringify( [ res, input.substr( pos, 4 ) ] ) );
	//return res;
};

if (typeof module === "object") {
	module.exports.PegTokenizer = PegTokenizer;
}
