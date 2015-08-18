/**
 * Tokenizer for wikitext, using PEG.js and a separate PEG grammar file
 * (pegTokenizer.pegjs.txt)
 *
 * Use along with a HTML5TreeBuilder and the DOMPostProcessor(s) for HTML
 * output.
 *
 */
'use strict';
require('./core-upgrade.js');

var PEG = require('pegjs');
var path = require('path');
var fs = require('fs');
var events = require('events');
var util = require('util');
var JSUtils = require('./jsutils.js').JSUtils;


// allow dumping compiled tokenizer to disk, for debugging.
var PARSOID_DUMP_TOKENIZER = process.env.PARSOID_DUMP_TOKENIZER || false;
// allow dumping tokenizer rules (only) to disk, for linting.
var PARSOID_DUMP_TOKENIZER_RULES = process.env.PARSOID_DUMP_TOKENIZER_RULES || false;

/**
 * Includes passed to the tokenizer, so that it does not need to require those
 * on each call. They are available as pegArgs.pegIncludes, and are unpacked
 * in the head of pegTokenizer.pegjs.txt.
 */
var pegIncludes = {
	DOMUtils: require('./mediawiki.DOMUtils.js').DOMUtils,
	Util: require('./mediawiki.Util.js').Util,
	defines: require('./mediawiki.parser.defines.js'),
	tu: require('./mediawiki.tokenizer.utils.js'),
	constants: require('./mediawiki.wikitext.constants.js').WikitextConstants,
	// defined below to satisfy JSHint
	PegTokenizer: null,
};

/**
 * @class
 * @extends EventEmitter
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {Object} options
 */
function PegTokenizer(env, options) {
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
	var pegSrcPath = path.join(__dirname, 'pegTokenizer.pegjs.txt');
	this.src = fs.readFileSync(pegSrcPath, 'utf8');

	// FIXME: Don't report infinite loops, i.e. repeated subexpressions which
	// can match the empty string, since our grammar gives several false
	// positives (or perhaps true positives).
	delete PEG.compiler.passes.check.reportInfiniteLoops;

	function cacheRuleHook(opts) {
		var maxVisitCount = 20;
		return {
			start: [
				[
					'var checkCache = visitCounts[', opts.startPos,
					'] > ', maxVisitCount, ';',
				].join(''),
				'var cached, bucket, key;',
				'if (checkCache) {',
				[
					'  key = (', opts.variantIndex, '+',
					opts.variantCount, '*', opts.ruleIndex,
					').toString() + stops.key;',
				].join(''),
				[
					'  bucket = ', opts.startPos, ';',
				].join(''),
				'  if ( !peg$cache[bucket] ) { peg$cache[bucket] = {}; }',
				'  cached = peg$cache[bucket][key];',
				'} else {',
				'  visitCounts[' + opts.startPos + ']++;',
				'}',
			].join('\n'),
			hitCondition: 'cached',
			nextPos: 'cached.nextPos',
			result: 'cached.result',
			store: [
				'if (checkCache) {',
				[
					'  peg$cache[bucket][key] = {nextPos: ', opts.endPos, ', ',
					'result: ', opts.result, '};',
				].join(''),
				'}',
			].join('\n'),
		};
	}

	function cacheInitHook(opts) {
		return [
			'var peg$cache = {};',
			'var visitCounts = new Uint8Array(input.length);',
		].join('\n');
	}

	if (PARSOID_DUMP_TOKENIZER_RULES) {
		var visitor = require('pegjs/lib/compiler/visitor');
		var ast = PEG.parser.parse(this.src);
		// Current code style seems to use spaces in the tokenizer.
		var tab = '    ';
		// Add some jscs overrides and define globals.
		var rulesSource = '/* jscs:disable disallowMultipleVarDecl, validateIndentation, requireCamelCaseOrUpperCaseIdentifiers */\n';
		rulesSource += "'use strict';\n";
		rulesSource += 'var options, location, input, text, peg$cache, peg$currPos;\n';
		// Prevent redefinitions of variables involved in choice expressions
		var seen = new Set();
		var addVar = function(name) {
			if (!seen.has(name)) {
				rulesSource += tab + 'var ' + name + ' = null;\n';
				seen.add(name);
			}
		};
		// Collect all the code blocks in the AST.
		var dumpCode = function(node) {
			if (node.code) {
				// remove trailing whitespace for single-line predicates
				var code = node.code.replace(/[ \t]+$/, '');
				// wrap with a function, to prevent spurious errors caused
				// by redeclarations or multiple returns in a block.
				rulesSource += tab + '(function() {\n' + code + '\n' +
					tab + '})();\n';
			}
		};
		var visit = visitor.build({
			initializer: function(node) {
				if (node.code) {
					rulesSource += node.code + '\n';
				}
			},
			semantic_and: dumpCode,
			semantic_node: dumpCode,
			rule: function(node) {
				rulesSource += 'function rule_' + node.name + '() {\n';
				seen.clear();
				visit(node.expression);
				rulesSource += '}\n';
			},
			labeled: function(node) {
				addVar(node.label);
				visit(node.expression);
			},
			named: function(node) {
				addVar(node.name);
				visit(node.expression);
			},
			action: function(node) {
				visit(node.expression);
				dumpCode(node);
			},
		});
		visit(ast);
		// Write rules to file.
		var rulesFilename = __dirname + '/mediawiki.tokenizer.rules.js';
		fs.writeFileSync(rulesFilename, rulesSource, 'utf8');
	}

	var tokenizerSource = PEG.buildParser(this.src, {
		cache: true,
		trackLineAndColumn: false,
		output: "source",
		cacheRuleHook: cacheRuleHook,
		cacheInitHook: cacheInitHook,
		allowedStartRules: [
			"start",
			"table_start_tag",
			"url",
			"single_cell_table_args",
			"table_attributes",
			"generic_newline_attributes",
			"tplarg_or_template_or_bust",
		],
		allowedStreamRules: [
			"start_async",
		],
	});

	if (!PARSOID_DUMP_TOKENIZER) {
		// eval is not evil in the case of a grammar-generated tokenizer.
		/* jshint evil:true */
		PegTokenizer.prototype.tokenizer = new Function('return ' + tokenizerSource)();
	} else {
		// Optionally save & require the tokenizer source
		tokenizerSource =
			'/* jshint -W100, -W040, -W052 */\n' +
			'require(\'./core-upgrade.js\');\n' +
			'module.exports = ' + tokenizerSource;
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
PegTokenizer.prototype.process = function(text) {
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
PegTokenizer.prototype.processSync = function(text) {
	this._processText(text, true);
};

/*
 * The main worker. Sets up event emission ('chunk' and 'end' events).
 * Consumers are supposed to register with PegTokenizer before calling
 * process().
 */
PegTokenizer.prototype._processText = function(text, fullParse) {
	if (!this.tokenizer) {
		this.initTokenizer();
	}

	// ensure we're processing text
	text = String(text || "");

	// Some input normalization: force a trailing newline
	// if ( text.substring(text.length - 1) !== "\n" ) {
	// 	text += "\n";
	// }

	var chunkCB = this.emit.bind(this, 'chunk');

	// Kick it off!
	var pipelineOffset = this.offsets.startOffset || 0;
	var args = {
		cb: chunkCB,
		pegTokenizer: this,
		pipelineOffset: pipelineOffset,
		env: this.env,
		pegIncludes: pegIncludes,
	};
	if (fullParse) {
		args.startRule = "start";
		try {
			this.tokenizer.tokenize(text, args);
		} catch (e) {
			this.env.log("fatal", e);
			return;
		}
		this.onEnd();
	} else {
		args.startRule = "start_async";
		args.stream = true;

		var iterator;
		var pegTokenizer = this;

		var tokenizeChunk = function() {
			var next;
			try {
				next = iterator.next();
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

		try {
			iterator = this.tokenizer.tokenize(text, args);
		} catch (e) {
			this.env.log("fatal", e);
			return;
		}
		tokenizeChunk();
	}
};


PegTokenizer.prototype.onEnd = function() {
	// Reset source offsets
	this.offsets.startOffset = undefined;
	this.offsets.endOffset = undefined;
	this.emit('end');
};

/**
 * Tokenize via a rule passed in as an arg.
 * The text is tokenized synchronously in one shot.
 */
PegTokenizer.prototype.tokenize = function(text, rule, args, throwErr, sol) {
	if (!this.tokenizer) {
		this.initTokenizer();
	}

	try {
		// Some rules use callbacks: start, tlb, toplevelblock.
		// All other rules return tokens directly.
		var toks = [];
		if (!args) {
			args = {
				cb: function(r) { toks = JSUtils.pushArray(toks, r); },
				pegTokenizer: this,
				pipelineOffset: this.offsets.startOffset || 0,
				env: this.env,
				pegIncludes: pegIncludes,
				startRule: rule || 'start',
				sol: sol,
			};
		}
		var retToks = this.tokenizer.tokenize(text, args);

		if (Array.isArray(retToks) && retToks.length > 0) {
			toks = JSUtils.pushArray(toks, retToks);
		}
		return toks;
	} catch (e) {
		if (throwErr) {
			throw e;  // don't suppress errors
		} else {
			// console.warn("Input: " + text);
			// console.warn("Rule : " + rule);
			// console.warn("ERROR: " + e);
			// console.warn("Stack: " + e.stack);
			return false;
		}
	}
};

/**
 * Tokenize a URL
 */
PegTokenizer.prototype.tokenizeURL = function(text) {
	var args = {
		pegTokenizer: this,
		env: this.env,
		pegIncludes: pegIncludes,
		startRule: 'url',
	};
	return this.tokenize(text, null, args);
};

/**
 * Tokenize table cell attributes
 */
PegTokenizer.prototype.tokenizeTableCellAttributes = function(text) {
	var args = {
		pegTokenizer: this,
		env: this.env,
		pegIncludes: pegIncludes,
		startRule: 'single_cell_table_args',
	};
	return this.tokenize(text, null, args);
};

if (require.main === module) {
	PARSOID_DUMP_TOKENIZER = true;
	PARSOID_DUMP_TOKENIZER_RULES = true;
	new PegTokenizer().initTokenizer();
} else if (typeof module === "object") {
	module.exports.PegTokenizer = PegTokenizer;
	module.exports.pegIncludes = pegIncludes;
}
