/**
 * Tokenizer for wikitext, using WikiPEG and a
 * separate PEG grammar file
 * (pegTokenizer.pegjs)
 *
 * Use along with a {@link module:wt2html/HTML5TreeBuilder} and the
 * {@link DOMPostProcessor}(s) for HTML output.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var PEG = require('wikipeg');
var path = require('path');
var fs = require('fs');
var events = require('events');
var util = require('util');
var JSUtils = require('../utils/jsutils.js').JSUtils;

/**
 * Includes passed to the tokenizer, so that it does not need to require those
 * on each call. They are available as pegArgs.pegIncludes, and are unpacked
 * in the head of pegTokenizer.pegjs.
 * @namespace
 * @private
 */
var pegIncludes = {
	constants: require('../config/WikitextConstants.js').WikitextConstants,
	ContentUtils: require('../utils/ContentUtils.js').ContentUtils,
	DOMDataUtils: require('../utils/DOMDataUtils.js').DOMDataUtils,
	DOMUtils: require('../utils/DOMUtils.js').DOMUtils,
	JSUtils: JSUtils,
	// defined below to satisfy JSHint
	PegTokenizer: null,
	TokenTypes: require('../tokens/TokenTypes.js'),
	TokenUtils: require('../utils/TokenUtils.js').TokenUtils,
	tu: require('./tokenizer.utils.js'),
	Util: require('../utils/Util.js').Util,
	WTUtils: require('../utils/WTUtils.js').WTUtils,
};

/**
 * @class
 * @extends EventEmitter
 * @param {MWParserEnvironment} env
 * @param {Object} options
 */
function PegTokenizer(env, options) {
	events.EventEmitter.call(this);
	this.env = env;
	// env can be null during code linting
	var traceFlags = env ? env.conf.parsoid.traceFlags : null;
	this.traceTime = traceFlags && traceFlags.has('time');
	this.options = options || {};
	this.offsets = {};
}

pegIncludes.PegTokenizer = PegTokenizer;

// Inherit from EventEmitter
util.inherits(PegTokenizer, events.EventEmitter);


PegTokenizer.prototype.readSource = function(opts = {}) {
	var pegSrcPath;
	if (opts.php) {
		pegSrcPath = path.join(__dirname, '../../src/Wt2Html/Grammar.pegphp');
	} else {
		pegSrcPath = path.join(__dirname, 'pegTokenizer.pegjs');
	}
	return fs.readFileSync(pegSrcPath, 'utf8');
};

PegTokenizer.prototype.parseTokenizer = function(compileOpts = {}) {
	var src = this.readSource(compileOpts);
	return PEG.parser.parse(src);
};

PegTokenizer.prototype.compileTokenizer = function(ast, compileOpts = {}) {
	var compiler = PEG.compiler;
	var env = this.env;

	// Don't report infinite loops, i.e. repeated subexpressions which
	// can match the empty string, since our grammar gives several false
	// positives (or perhaps true positives).
	var passes = {
		check: [
			compiler.passes.check.reportMissingRules,
			compiler.passes.check.reportLeftRecursion,
		],
		transform: [
			compiler.passes.transform.analyzeParams,
		],
		generate: [
			compiler.passes.generate.astToCode
		],
	};

	function jsCacheRuleHook(opts) {
		var keyParts = [
			opts.variantIndex + opts.variantCount * (opts.ruleIndex + opts.ruleCount)
		];
		if (opts.params.length) {
			keyParts = keyParts.concat(opts.params);
		}
		var key;
		if (keyParts.length === 1) {
			key = keyParts[0];
		} else {
			key = '[' + keyParts.join(', ') + '].map(String).join(":")';
		}

		var maxVisitCount = 20;
		var cacheBits = {};
		cacheBits.start =
			[
				[
					'var checkCache = visitCounts[', opts.startPos,
					'] > ', maxVisitCount, ';',
				].join(''),
				'var cached, bucket, key;',
				'if (checkCache) {',
				[
					'  key = ' + key + ';',
				].join(''),
				[
					'  bucket = ', opts.startPos, ';',
				].join(''),
				'  if ( !peg$cache[bucket] ) { peg$cache[bucket] = {}; }',
				'  cached = peg$cache[bucket][key];',
				'  if (cached) {',
				'    peg$currPos = cached.nextPos;'
			]
			.concat(opts.loadRefs)
			.concat([
				'    return cached.result;',
				'  }',
			]).concat(opts.saveRefs)
			.concat([
				'} else {',
				'  visitCounts[' + opts.startPos + ']++;'
			])
			.concat(['}'])
			.join('\n');

		var result;
		if (env && env.immutable) {
			result = 'JSUtils.deepFreeze(' + opts.result + ')';
		} else {
			result = opts.result;
		}
		cacheBits.store =
			['if (checkCache) {']
			.concat([
				'  cached = peg$cache[bucket][key] = {',
				'    nextPos: ' + opts.endPos + ','
			]);
		cacheBits.store = cacheBits.store.concat(
			[
				'    result: ' + result + ',',
				'  };',
			]).concat(opts.storeRefs)
			.concat(['}'])
			.join('\n');

		return cacheBits;
	}

	function phpCacheRuleHook(opts) {
		let keyParts = [
			opts.variantIndex + opts.variantCount * (opts.ruleIndex + opts.ruleCount),
		];
		if (opts.params.length) {
			keyParts = keyParts.concat(opts.params);
		}
		let key;
		if (keyParts.length === 1) {
			key = keyParts[0];
		} else {
			key = `json_encode([${keyParts.join(', ')}])`;
		}
		return {
			start: [
				`$key = ${key};`,
				'$bucket = $this->currPos;',
				`$cached = $this->cache[$bucket][$key] ?? null;`,
				'if ($cached) {',
				'  $this->currPos = $cached[\'nextPos\'];',
				opts.loadRefs,
				'  return $cached[\'result\'];',
				'}',
				opts.saveRefs,
			].join('\n'),
			store: [
				`$cached = ['nextPos' => $this->currPos, 'result' => ${opts.result}];`,
				opts.storeRefs,
				`$this->cache[$bucket][$key] = $cached;`
			].join('\n')
		};
	}

	function jsCacheInitHook(opts) {
		return [
			'var peg$cache = {};',
			'var visitCounts = new Uint8Array(input.length);',
		].join('\n');
	}

	var php = !!compileOpts.php;

	var options = {
		cache: true,
		trackLineAndColumn: false,
		output: "source",
		language: php ? "php" : "javascript",
		cacheRuleHook: php ? phpCacheRuleHook : jsCacheRuleHook,
		cacheInitHook: php ? null : jsCacheInitHook,
		className: php ? 'Parsoid\\Wt2Html\\Grammar' : null,
		allowedStartRules: [
			"start",
			"table_start_tag",
			"url",
			"row_syntax_table_args",
			"table_attributes",
			"generic_newline_attributes",
			"tplarg_or_template_or_bust",
			"extlink",
		],
		allowedStreamRules: [
			"start_async",
		],
		trace: !!compileOpts.trace,
	};

	return compiler.compile(this.parseTokenizer(compileOpts), passes, options);
};

PegTokenizer.prototype.initTokenizer = function() {
	var tokenizerSource = this.compileTokenizer(this.parseTokenizer());
	// eval is not evil in the case of a grammar-generated tokenizer.
	PegTokenizer.prototype.tokenizer = new Function('return ' + tokenizerSource)();  // eslint-disable-line
};

/**
 * Process text.  The text is tokenized in chunks and control
 * is yielded to the event loop after each top-level block is
 * tokenized enabling the tokenized chunks to be processed at
 * the earliest possible opportunity.
 *
 * @param {string} text
 * @param {boolean} sol Whether text should be processed in start-of-line
 *   context.
 */
PegTokenizer.prototype.process = function(text, sol) {
	this.tokenizeAsync(text, sol);
};

/**
 * Debugging aid: Set pipeline id.
 */
PegTokenizer.prototype.setPipelineId = function(id) {
	this.pipelineId = id;
};

/**
 * Set start and end offsets of the source that generated this DOM.
 */
PegTokenizer.prototype.setSourceOffsets = function(start, end) {
	this.offsets.startOffset = start;
	this.offsets.endOffset = end;
};

PegTokenizer.prototype._tokenize = function(text, args) {
	var ret = this.tokenizer.parse(text, args);
	return ret;
};

/**
 * The main worker. Sets up event emission ('chunk' and 'end' events).
 * Consumers are supposed to register with PegTokenizer before calling
 * process().
 *
 * @param {string} text
 * @param {boolean} sol Whether text should be processed in start-of-line
 *   context.
 */
PegTokenizer.prototype.tokenizeAsync = function(text, sol) {
	if (!this.tokenizer) {
		this.initTokenizer();
	}

	// ensure we're processing text
	text = String(text || "");
	this.env.log('trace/pre-peg', this.pipelineId, () => JSON.stringify(text));

	var chunkCB = tokens => this.emit('chunk', tokens);

	// Kick it off!
	var pipelineOffset = this.offsets.startOffset || 0;
	var args = {
		cb: chunkCB,
		pegTokenizer: this,
		pipelineOffset: pipelineOffset,
		pegIncludes: pegIncludes,
		sol: sol,
	};

	args.startRule = "start_async";
	args.stream = true;

	var iterator;
	var pegTokenizer = this;

	var tokenizeChunk = () => {
		var next;
		try {
			let start;
			if (this.traceTime) {
				start = JSUtils.startTime();
			}
			if (iterator === undefined) {
				iterator = pegTokenizer._tokenize(text, args);
			}
			next = iterator.next();
			if (this.traceTime) {
				this.env.bumpTimeUse("PEG-async", JSUtils.elapsedTime(start), 'PEG');
			}
		} catch (e) {
			pegTokenizer.env.log("fatal", e);
			return;
		}

		if (next.done) {
			pegTokenizer.onEnd();
		} else {
			setImmediate(tokenizeChunk);
		}
	};

	tokenizeChunk();
};


PegTokenizer.prototype.onEnd = function() {
	// Reset source offsets
	this.setSourceOffsets();
	this.emit('end');
};

/**
 * Tokenize via a rule passed in as an arg.
 * The text is tokenized synchronously in one shot.
 *
 * @param {string} text
 * @param {Object} [args]
 * @return {Array}
 */
PegTokenizer.prototype.tokenizeSync = function(text, args) {
	if (!this.tokenizer) {
		this.initTokenizer();
	}
	var toks = [];
	args = Object.assign({
		pipelineOffset: this.offsets.startOffset || 0,
		startRule: 'start',
		sol: true,
	}, {
		// Some rules use callbacks: start, tlb, toplevelblock.
		// All other rules return tokens directly.
		cb: function(r) { toks = JSUtils.pushArray(toks, r); },
		pegTokenizer: this,
		pegIncludes: pegIncludes,
	}, args);
	let start;
	if (this.traceTime) {
		start = JSUtils.startTime();
	}
	var retToks = this._tokenize(text, args);
	if (this.traceTime) {
		this.env.bumpTimeUse("PEG-sync", JSUtils.elapsedTime(start), 'PEG');
	}
	if (Array.isArray(retToks) && retToks.length > 0) {
		toks = JSUtils.pushArray(toks, retToks);
	}
	return toks;
};

/**
 * Tokenizes a string as a rule, otherwise returns an `Error`
 */
PegTokenizer.prototype.tokenizeAs = function(text, rule, sol) {
	try {
		const args = {
			startRule: rule,
			sol: sol,
			pipelineOffset: 0,
		};
		return this.tokenizeSync(text, args);
	} catch (e) {
		// console.warn("Input: " + text);
		// console.warn("Rule : " + rule);
		// console.warn("ERROR: " + e);
		// console.warn("Stack: " + e.stack);
		return (e instanceof Error) ? e : new Error(e);
	}
};

/**
 * Tokenize a URL.
 * @param {string} text
 * @return {boolean}
 */
PegTokenizer.prototype.tokenizesAsURL = function(text) {
	const e = this.tokenizeAs(text, 'url', /* sol */true);
	return !(e instanceof Error);
};

/**
 * Tokenize an extlink.
 * @param {string} text
 * @param {boolean} sol
 */
PegTokenizer.prototype.tokenizeExtlink = function(text, sol) {
	return this.tokenizeAs(text, 'extlink', sol);
};

/**
 * Tokenize table cell attributes.
 */
PegTokenizer.prototype.tokenizeTableCellAttributes = function(text, sol) {
	return this.tokenizeAs(text, 'row_syntax_table_args', sol);
};

module.exports = {
	PegTokenizer: PegTokenizer,
	pegIncludes: pegIncludes,
};
