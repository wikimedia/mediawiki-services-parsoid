/**
 * Stub of Parsoid/JS tokenizer with code-generation skeleton
 * left behind for generating Parsoid/PHP peg parser.
 */

'use strict';

require('../../core-upgrade.js');

var PEG = require('wikipeg');
var path = require('path');
var fs = require('fs');
var JSUtils = require('../utils/jsutils.js').JSUtils;

/**
 * @class
 */
function PegTokenizer() {}

PegTokenizer.prototype.readSource = function(opts = {}) {
	const pegSrcPath = path.join(__dirname, '../../src/Wt2Html/Grammar.pegphp');
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
			key = `json_encode([${ keyParts.join(', ') }])`;
		}
		const storeRefs = opts.storeRefs.map(function(part) {
			return '  ' + part;
		}).join(',\n');
		return {
			start: [
				`$key = ${ key };`,
				'$bucket = $this->currPos;',
				`$cached = $this->cache[$bucket][$key] ?? null;`,
				'if ($cached) {',
				'  $this->currPos = $cached->nextPos;',
				opts.loadRefs,
				'  return $cached->result;',
				'}',
				opts.saveRefs,
			].join('\n'),
			store: [
				`$this->cache[$bucket][$key] = new ${ opts.className }CacheEntry(`,
				'  $this->currPos,',
				`  ${ opts.result + (opts.storeRefs.length > 0 ? ',' : '') }`,
				storeRefs,
				`);`
			].join('\n')
		};
	}

	var options = {
		cache: true,
		trackLineAndColumn: false,
		output: "source",
		language: "php",
		cacheRuleHook: phpCacheRuleHook,
		cacheInitHook: null,
		className: 'Wikimedia\\Parsoid\\Wt2Html\\' + (compileOpts.className || 'Grammar'),
		allowedStartRules: [
			"start",
			"table_start_tag",
			"url",
			"row_syntax_table_args",
			"table_attributes",
			"generic_newline_attributes",
			"tplarg_or_template_or_bust",
			"extlink",
			"list_item",
		],
		allowedStreamRules: [
			"start_async",
		],
		trace: !!compileOpts.trace,
		headerComment: compileOpts.headerComment,
	};

	return compiler.compile(this.parseTokenizer(compileOpts), passes, options);
};

module.exports = {
	PegTokenizer: PegTokenizer
};
