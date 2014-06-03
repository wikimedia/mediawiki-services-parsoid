/**
 * Tokenizer for wikitext, using PEG.js and a separate PEG grammar file
 * (pegTokenizer.pegjs.txt)
 *
 * Use along with a HTML5TreeBuilder and the DOMPostProcessor(s) for HTML
 * output.
 *
 */
"use strict";

require('./core-upgrade.js');

var PEG = require('pegjs'),
	path = require('path'),
	fs = require('fs'),
	events = require('events'),
	util = require('util'),
	JSUtils = require('./jsutils.js').JSUtils;

// allow dumping compiled tokenizer to disk, for linting & debugging
var PARSOID_DUMP_TOKENIZER = process.env.PARSOID_DUMP_TOKENIZER || false;

/**
 * Includes passed to the tokenizer, so that it does not need to require those
 * on each call. They are available as pegArgs.pegIncludes, and are unpacked
 * in the head of pegTokenizer.pegjs.txt.
 */
var pegIncludes = {
		Util: require('./mediawiki.Util.js').Util,
		defines: require('./mediawiki.parser.defines.js'),
		tu: require('./mediawiki.tokenizer.utils.js'),
		constants: require('./mediawiki.wikitext.constants.js').WikitextConstants,
		// defined below to satisfy JSHint
		PegTokenizer: null
};

function PegTokenizer( env, options ) {
	events.EventEmitter.call(this);
	this.env = env;
	this.options = options || {};
	this.offsets = {};
}

pegIncludes.PegTokenizer = PegTokenizer;

// Inherit from EventEmitter
util.inherits(PegTokenizer, events.EventEmitter);

PegTokenizer.prototype.src = '';

PegTokenizer.prototype.initTokenizer = function() {

	// Construct a singleton static tokenizer.
	var pegSrcPath = path.join( __dirname, 'pegTokenizer.pegjs.txt' );
	this.src = fs.readFileSync( pegSrcPath, 'utf8' );

	var tokenizerSource = PEG.buildParser(this.src, {
		cache: true,
		trackLineAndColumn: false,
		output: "source",
		allowedStartRules: [
			"start",
			"toplevelblock",
			"table_start_tag",
			"url",
			"single_cell_table_args",
			"tplarg_or_template_or_bust"
		]
	});

	tokenizerSource = tokenizerSource
		// Include the stops key in the cache key
		.replace(/var key    = peg\$currPos [^,]+/g, function(m) {
			return m + ' + stops.key';
		});

	if (!PARSOID_DUMP_TOKENIZER) {
		// eval is not evil in the case of a grammar-generated tokenizer.
		/* jshint evil:true */
		PegTokenizer.prototype.tokenizer = new Function( 'return ' + tokenizerSource )();
	} else {
		// Optionally save & require the tokenizer source
		tokenizerSource = tokenizerSource
			.replace(/peg\$subclass\(child, parent\) {/g, function(m) {
				return m + "\n    /*jshint validthis:true, newcap:false */";
			});
		tokenizerSource =
			'/* jshint loopfunc:true, latedef:false, nonstandard:true, -W100 */\n' +
			'"use strict";\n' +
			'require("./core-upgrade.js");\n' +
			'module.exports = ' + tokenizerSource + ';';
		// write tokenizer to a file.
		var tokenizerFilename = __dirname + '/mediawiki.tokenizer.js';
		fs.writeFileSync(tokenizerFilename, tokenizerSource, 'utf8');
		PegTokenizer.prototype.tokenizer = require(tokenizerFilename);
	}

	// alias the parse method
	this.tokenizer.tokenize = this.tokenizer.parse;

};

/*
 * Process text.  The text is tokenized in chunks and control
 * is yielded to the event loop after each top-level block is
 * tokenized enabling the tokenized chunks to be processed at
 * the earliest possible opportunity.
 */
PegTokenizer.prototype.process = function( text ) {
	this._processText(text, false);
};

/**
 * Debugging aid: set pipeline id
 */
PegTokenizer.prototype.setPipelineId = function(id) {
	this.pipelineId = id;
};

/**
 * Set start and end offsets of the source that generated this DOM
 */
PegTokenizer.prototype.setSourceOffsets = function(start, end) {
	this.offsets.startOffset = start;
	this.offsets.endOffset = end;
};

/*
 * Process text synchronously -- the text is tokenized in one shot
 */
PegTokenizer.prototype.processSync = function( text ) {
	this._processText(text, true);
};

/*
 * The main worker. Sets up event emission ('chunk' and 'end' events).
 * Consumers are supposed to register with PegTokenizer before calling
 * process().
 */
PegTokenizer.prototype._processText = function( text, fullParse ) {
	if ( !this.tokenizer ) {
		this.initTokenizer();
	}

	// Some input normalization: force a trailing newline
	//if ( text.substring(text.length - 1) !== "\n" ) {
	//	text += "\n";
	//}

	var chunkCB = this.emit.bind( this, 'chunk' );

	// Kick it off!
	var srcOffset = this.offsets.startOffset || 0;
	var args = {
		cb: chunkCB,
		pegTokenizer: this,
		srcOffset: srcOffset,
		env: this.env,
		pegIncludes: pegIncludes,
		startRule: "start"
	};
	if (fullParse) {
		try {
			this.tokenizer.tokenize( text, args );
		} catch (e) {
			this.env.log("fatal", e);
			return;
		}
		this.onEnd();
	} else {
		this.tokenizeAsync(text, srcOffset, chunkCB);
	}
};

PegTokenizer.prototype.tokenizeAsync = function( text, srcOffset, cb ) {
	var ret,
		pegTokenizer = this,
		args = {
			cb: cb,
			pegTokenizer: this,
			srcOffset: srcOffset,
			env: this.env,
			pegIncludes: pegIncludes,
			startRule: "toplevelblock"
		};

	try {
		ret = this.tokenizer.tokenize( text, args );
	} catch (e) {
		this.env.log("fatal", e);
		return;
	}

	if (ret.eof) {
		this.onEnd();
	} else {
		// Schedule parse of next chunk
		setImmediate(function() {
			// console.warn("new input: " + JSON.stringify(ret.newInput));
			// console.warn("offset   : " + ret.newOffset);
			pegTokenizer.tokenizeAsync(ret.newInput, ret.newOffset, cb);
		});
	}
};


PegTokenizer.prototype.onEnd = function ( ) {
	// Reset source offsets
	this.offsets.startOffset = undefined;
	this.offsets.endOffset = undefined;
	this.emit('end');
};

/**
 * Tokenize via a production passed in as an arg.
 * The text is tokenized synchronously in one shot.
 */
PegTokenizer.prototype.tokenize = function(text, production, args, throwErr) {
	if ( !this.tokenizer ) {
		this.initTokenizer();
	}

	try {
		// Some productions use callbacks: start, tlb, toplevelblock.
		// All other productions return tokens directly.
		var toks = [];
		if (!args) {
			args = {
				cb: function(r) { toks = JSUtils.pushArray(toks, r); },
				pegTokenizer: this,
				srcOffset: this.offsets.startOffset || 0,
				env: this.env,
				pegIncludes: pegIncludes,
				startRule: production || "start"
			};
		}
		var retToks = this.tokenizer.tokenize( text, args );

		if ( Array.isArray(retToks) && retToks.length > 0 ) {
			toks = JSUtils.pushArray(toks, retToks);
		}
		return toks;
	} catch ( e ) {
		if (throwErr) {
			throw e;  // don't suppress errors
		} else {
			// console.warn("Input: " + text);
			// console.warn("Rule : " + production);
			// console.warn("ERROR: " + e);
			// console.warn("Stack: " + e.stack);
			return false;
		}
	}
};

/**
 * Tokenize a URL
 */
PegTokenizer.prototype.tokenizeURL = function( text ) {
	var args = {
		pegTokenizer: this,
		env: this.env,
		pegIncludes: pegIncludes,
		startRule: "url"
	};
	return this.tokenize( text, null, args );
};

/**
 * Tokenize table cell attributes
 */
PegTokenizer.prototype.tokenizeTableCellAttributes = function( text ) {
	var args = {
		pegTokenizer: this,
		env: this.env,
		pegIncludes: pegIncludes,
		startRule: "single_cell_table_args"
	};
	return this.tokenize( text, null, args );
};

if (typeof module === "object") {
	module.exports.PegTokenizer = PegTokenizer;
}
