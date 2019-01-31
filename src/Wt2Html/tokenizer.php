<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Tokenizer for wikitext, using {@link https://pegjs.org/ PEG.js} and a
 * separate PEG grammar file
 * (pegTokenizer.pegjs)
 *
 * Use along with a {@link module:wt2html/HTML5TreeBuilder} and the
 * {@link DOMPostProcessor}(s) for HTML output.
 * @module
 */

namespace Parsoid;

use Parsoid\PEG as PEG;
use Parsoid\fs as fs;
use Parsoid\events as events;
use Parsoid\util as util;

$JSUtils = require '../utils/jsutils.js'::JSUtils;

// allow dumping compiled tokenizer to disk, for debugging.
$PARSOID_DUMP_TOKENIZER = $process->env->PARSOID_DUMP_TOKENIZER || false;
// allow dumping tokenizer rules (only) to disk, for linting.
$PARSOID_DUMP_TOKENIZER_RULES = $process->env->PARSOID_DUMP_TOKENIZER_RULES || false;

/**
 * Includes passed to the tokenizer, so that it does not need to require those
 * on each call. They are available as pegArgs.pegIncludes, and are unpacked
 * in the head of pegTokenizer.pegjs.
 * @namespace
 * @private
 */
$pegIncludes = [
	'constants' => require '../config/WikitextConstants.js'::WikitextConstants,
	'ContentUtils' => require '../utils/ContentUtils.js'::ContentUtils,
	'DOMDataUtils' => require '../utils/DOMDataUtils.js'::DOMDataUtils,
	'DOMUtils' => require '../utils/DOMUtils.js'::DOMUtils,
	'JSUtils' => $JSUtils,
	// defined below to satisfy JSHint
	'PegTokenizer' => null,
	'TokenTypes' => require '../tokens/TokenTypes.js' ,
	'TokenUtils' => require '../utils/TokenUtils.js'::TokenUtils,
	'tu' => require './tokenizer.utils.js' ,
	'Util' => require '../utils/Util.js'::Util,
	'WTUtils' => require '../utils/WTUtils.js'::WTUtils
];

/**
 * @class
 * @extends EventEmitter
 * @param {MWParserEnvironment} env
 * @param {Object} options
 */
function PegTokenizer( $env, $options ) {
	call_user_func( [ $events, 'EventEmitter' ] );
	$this->env = $env;
	// env can be null during code linting
	$traceFlags = ( $env ) ? $env->conf->parsoid->traceFlags : null;
	$this->traceTime = $traceFlags && $traceFlags->has( 'time' );
	$this->options = $options || [];
	$this->offsets = [];
}

$pegIncludes::PegTokenizer = $PegTokenizer;

// Inherit from EventEmitter
util::inherits( $PegTokenizer, events\EventEmitter );

PegTokenizer::prototype::src = '';

PegTokenizer::prototype::initTokenizer = function () use ( &$path, &$fs, &$PEG, &$PARSOID_DUMP_TOKENIZER_RULES, &$PARSOID_DUMP_TOKENIZER ) {
	$env = $this->env;

	// Construct a singleton static tokenizer.
	$pegSrcPath = implode( $__dirname, $path );
	$this->src = fs::readFileSync( $pegSrcPath, 'utf8' );

	// FIXME: Don't report infinite loops, i.e. repeated subexpressions which
	// can match the empty string, since our grammar gives several false
	// positives (or perhaps true positives).
	unset( PEG::compiler::passes->check->reportInfiniteLoops );

	function cacheRuleHook( $opts ) {
		$maxVisitCount = 20;
		return [
			'start' => implode(

				"\n", [
					implode(

						'', [
							'var checkCache = visitCounts[', $opts->startPos,
							'] > ', $maxVisitCount, ';'
						]
					),
					'var cached, bucket, key;',
					'if (checkCache) {',
					implode(

						'', [
							'  key = (', $opts->variantIndex, '+',
							$opts->variantCount, '*', $opts->ruleIndex,
							').toString() + stops.key;'
						]
					),
					implode(

						'', [
							'  bucket = ', $opts->startPos, ';'
						]
					),
					'  if ( !peg$cache[bucket] ) { peg$cache[bucket] = {}; }',
					'  cached = peg$cache[bucket][key];',
					'} else {',
					'  visitCounts[' . $opts->startPos . ']++;',
					'}'
				]
			),
			'hitCondition' => 'cached',
			'nextPos' => 'cached.nextPos',
			'result' => 'cached.result',
			'store' => implode(

				"\n", [
					'if (checkCache) {',
					implode(

						'', [
							'  peg$cache[bucket][key] = { nextPos: ', $opts->endPos, ', ',
							'result: ',
							( $env && $env->immutable ) ? implode(

								'', [
									'JSUtils.deepFreeze(', $opts->result, ')'
								]
							) : $opts->result,
							' };'
						]
					),
					'}'
				]
			)
		];
	}

	function cacheInitHook( $opts ) {
		return implode(

			"\n", [
				'var peg$cache = {};',
				'var visitCounts = new Uint8Array(input.length);'
			]
		);
	}

	if ( $PARSOID_DUMP_TOKENIZER_RULES ) {
		$visitor = require 'pegjs/lib/compiler/visitor';
		$ast = PEG::parser::parse( $this->src );
		// Current code style seems to use spaces in the tokenizer.
		$tab = '    ';
		// Add some eslint overrides and define globals.
		$rulesSource = "/* eslint-disable indent,camelcase,no-unused-vars */\n";
		$rulesSource += "\n'use strict';\n\n";
		$rulesSource += "var options, location, input, text, peg\$cache, peg\$currPos;\n";
		// Prevent redefinitions of variables involved in choice expressions
		$seen = new Set();
		$addVar = function ( $name ) use ( &$seen, &$tab ) {
			if ( !$seen->has( $name ) ) {
				$rulesSource += $tab . 'var ' . $name . " = null;\n";
				$seen->add( $name );
			}
		};
		// Collect all the code blocks in the AST.
		$dumpCode = function ( $node ) use ( &$tab ) {
			if ( $node->code ) {
				// remove trailing whitespace for single-line predicates
				$code = preg_replace( '/[ \t]+$/', '', $node->code, 1 );
				// wrap with a function, to prevent spurious errors caused
				// by redeclarations or multiple returns in a block.
				$rulesSource += $tab . "(function() {\n" . $code . "\n"
. $tab . "})();\n";
			}
		};
		$visit = $visitor->build( [
				'initializer' => function ( $node ) {
					if ( $node->code ) {
						$rulesSource += $node->code . "\n";
					}
				},
				'semantic_and' => $dumpCode,
				'semantic_node' => $dumpCode,
				'rule' => function ( $node ) use ( &$seen, &$visit ) {
					$rulesSource += 'function rule_' . $node->name . "() {\n";
					$seen->clear();
					$visit( $node->expression );
					$rulesSource += "}\n";
				},
				'labeled' => function ( $node ) use ( &$addVar, &$visit ) {
					$addVar( $node->label );
					$visit( $node->expression );
				},
				'named' => function ( $node ) use ( &$addVar, &$visit ) {
					$addVar( $node->name );
					$visit( $node->expression );
				},
				'action' => function ( $node ) use ( &$visit, &$dumpCode ) {
					$visit( $node->expression );
					$dumpCode( $node );
				}
			]
		);
		$visit( $ast );
		// Write rules to file.
		$rulesFilename = implode( $__dirname, $path );
		fs::writeFileSync( $rulesFilename, $rulesSource, 'utf8' );
	}

	$tokenizerSource = PEG::buildParser( $this->src, [
			'cache' => true,
			'trackLineAndColumn' => false,
			'output' => 'source',
			'cacheRuleHook' => $cacheRuleHook,
			'cacheInitHook' => $cacheInitHook,
			'allowedStartRules' => [
				'start',
				'table_start_tag',
				'url',
				'row_syntax_table_args',
				'table_attributes',
				'generic_newline_attributes',
				'tplarg_or_template_or_bust',
				'extlink'
			],
			'allowedStreamRules' => [
				'start_async'
			]
		]
	);

	if ( !$PARSOID_DUMP_TOKENIZER ) {
		// eval is not evil in the case of a grammar-generated tokenizer.
		PegTokenizer::prototype::tokenizer = new function( 'return ' . $tokenizerSource )(); // eslint-disable-line
	} else {
		// Optionally save & require the tokenizer source
		$tokenizerSource =
		"require('../../core-upgrade.js');\n"
. 'module.exports = ' . $tokenizerSource;
		// write tokenizer to a file.
		$tokenizerFilename = implode( $__dirname, $path );
		fs::writeFileSync( $tokenizerFilename, $tokenizerSource, 'utf8' );
		PegTokenizer::prototype::tokenizer = require $tokenizerFilename;
	}
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
PegTokenizer::prototype::process = function ( $text, $sol ) {
	$this->tokenizeAsync( $text, $sol );
};

/**
 * Debugging aid: Set pipeline id.
 */
PegTokenizer::prototype::setPipelineId = function ( $id ) {
	$this->pipelineId = $id;
};

/**
 * Set start and end offsets of the source that generated this DOM.
 */
PegTokenizer::prototype::setSourceOffsets = function ( $start, $end ) {
	$this->offsets->startOffset = $start;
	$this->offsets->endOffset = $end;
};

PegTokenizer::prototype::_tokenize = function ( $text, $args ) {
	$ret = $this->tokenizer->parse( $text, $args );
	return $ret;
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
PegTokenizer::prototype::tokenizeAsync = function ( $text, $sol ) use ( &$pegIncludes, &$JSUtils ) {
	if ( !$this->tokenizer ) {
		$this->initTokenizer();
	}

	// ensure we're processing text
	$text = String( $text || '' );

	$chunkCB = function ( $tokens ) {return $this->emit( 'chunk', $tokens );
 };

	// Kick it off!
	$pipelineOffset = $this->offsets->startOffset || 0;
	$args = [
		'cb' => $chunkCB,
		'pegTokenizer' => $this,
		'pipelineOffset' => $pipelineOffset,
		'pegIncludes' => $pegIncludes,
		'sol' => $sol
	];

	$args->startRule = 'start_async';
	$args->stream = true;

	$iterator = null;
	$pegTokenizer = $this;

	$tokenizeChunk = function () use ( &$JSUtils, &$iterator, &$pegTokenizer, &$text, &$args, &$tokenizeChunk ) {
		$next = null;
		try {
			$start = null;
			if ( $this->traceTime ) {
				$start = JSUtils::startTime();
			}
			if ( $iterator === null ) {
				$iterator = $pegTokenizer->_tokenize( $text, $args );
			}
			$next = $iterator->next();
			if ( $this->traceTime ) {
				$this->env->bumpTimeUse( 'PEG-async', JSUtils::elapsedTime( $start ), 'PEG' );
			}
		} catch ( Exception $e ) {
			$pegTokenizer->env->log( 'fatal', $e );
			return;
		}

		if ( $next->done ) {
			$pegTokenizer->onEnd();
		} else {
			setImmediate( $tokenizeChunk );
		}
	};

	$tokenizeChunk();
};

PegTokenizer::prototype::onEnd = function () {
	// Reset source offsets
	$this->setSourceOffsets();
	$this->emit( 'end' );
};

/**
 * Tokenize via a rule passed in as an arg.
 * The text is tokenized synchronously in one shot.
 *
 * @param {string} text
 * @param {Object} [args]
 * @return {Array}
 */
PegTokenizer::prototype::tokenizeSync = function ( $text, $args ) use ( &$JSUtils, &$pegIncludes ) {
	if ( !$this->tokenizer ) {
		$this->initTokenizer();
	}
	$toks = [];
	$args = Object::assign( [
			'pipelineOffset' => $this->offsets->startOffset || 0,
			'startRule' => 'start',
			'sol' => true
		], $args, [
			// Some rules use callbacks: start, tlb, toplevelblock.
			// All other rules return tokens directly.
			'cb' => function ( $r ) use ( &$JSUtils ) { $toks = JSUtils::pushArray( $toks, $r );
   },
			'pegTokenizer' => $this,
			'pegIncludes' => $pegIncludes
		]
	);
	$start = null;
	if ( $this->traceTime ) {
		$start = JSUtils::startTime();
	}
	$retToks = $this->_tokenize( $text, $args );
	if ( $this->traceTime ) {
		$this->env->bumpTimeUse( 'PEG-sync', JSUtils::elapsedTime( $start ), 'PEG' );
	}
	if ( is_array( $retToks ) && count( $retToks ) > 0 ) {
		$toks = JSUtils::pushArray( $toks, $retToks );
	}
	return $toks;
};

/**
 * Tokenizes a string as a rule, otherwise returns an `Error`
 */
PegTokenizer::prototype::tokenizeAs = function ( $text, $rule, $sol ) {
	try {
		$args = [
			'startRule' => $rule,
			'sol' => $sol,
			'pipelineOffset' => 0
		];
		return $this->tokenizeSync( $text, $args );
	} catch ( Exception $e ) {
		// console.warn("Input: " + text);
		// console.warn("Rule : " + rule);
		// console.warn("ERROR: " + e);
		// console.warn("Stack: " + e.stack);
		return ( $e instanceof $Error ) ? $e : new Error( $e );
	}
};

/**
 * Tokenize a URL.
 * @param {string} text
 * @return {boolean}
 */
PegTokenizer::prototype::tokenizesAsURL = function ( $text ) {
	$e = $this->tokenizeAs( $text, 'url', /* sol */true );
	return !( $e instanceof $Error );
};

/**
 * Tokenize an extlink.
 * @param {string} text
 * @param {boolean} sol
 */
PegTokenizer::prototype::tokenizeExtlink = function ( $text, $sol ) {
	return $this->tokenizeAs( $text, 'extlink', $sol );
};

/**
 * Tokenize table cell attributes.
 */
PegTokenizer::prototype::tokenizeTableCellAttributes = function ( $text, $sol ) {
	return $this->tokenizeAs( $text, 'row_syntax_table_args', $sol );
};

if ( $require->main === $module ) {
	$PARSOID_DUMP_TOKENIZER = true;
	$PARSOID_DUMP_TOKENIZER_RULES = true;
	new PegTokenizer()->initTokenizer();
} elseif ( gettype( $module ) === 'object' ) {
	$module->exports->PegTokenizer = $PegTokenizer;
	$module->exports->pegIncludes = $pegIncludes;
}
