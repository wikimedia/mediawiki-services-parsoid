<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Tokenizer for wikitext, using WikiPEG and a
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

PegTokenizer::prototype::readSource = function () use ( &$path, &$fs ) {
	$pegSrcPath = implode( $__dirname, $path );
	return fs::readFileSync( $pegSrcPath, 'utf8' );
};

PegTokenizer::prototype::parseTokenizer = function () use ( &$PEG ) {
	$src = $this->readSource();
	return PEG::parser::parse( $src );
};

PegTokenizer::prototype::compileTokenizer = function ( $ast ) use ( &$PEG ) {
	$compiler = PEG::compiler;
	$env = $this->env;

	// Don't report infinite loops, i.e. repeated subexpressions which
	// can match the empty string, since our grammar gives several false
	// positives (or perhaps true positives).
	$passes = [
		'check' => [
			$compiler->passes->check->reportMissingRules,
			$compiler->passes->check->reportLeftRecursion
		],
		'transform' => [
			$compiler->passes->transform->analyzeParams
		],
		'generate' => [
			$compiler->passes->generate->astToRegAllocJS
		]
	];

	function cacheRuleHook( $opts ) use ( &$env ) {
		$keyParts = [
			$opts->variantIndex + $opts->variantCount * ( $opts->ruleIndex + $opts->ruleCount )
		];
		if ( count( $opts->params ) ) {
			$keyParts = $keyParts->concat( $opts->params );
		}
		$key = null;
		if ( count( $keyParts ) === 1 ) {
			$key = $keyParts[ 0 ];
		} else {
			$key = '[' . implode( ', ', $keyParts ) . '].join(":")';
		}

		$maxVisitCount = 20;
		$cacheBits = [];
		$cacheBits->start =
		implode(

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
						'  key = ' . $key . ';'
					]
				),
				implode(

					'', [
						'  bucket = ', $opts->startPos, ';'
					]
				),
				'  if ( !peg$cache[bucket] ) { peg$cache[bucket] = {}; }',
				'  cached = peg$cache[bucket][key];',
				'  if (cached) {',
				'    peg$currPos = cached.nextPos;'
			]->
			concat( $opts->loadRefs )->
			concat( [
					'    return cached.result;',
					'  }'
				]
			)->concat( $opts->saveRefs )->
			concat( [
					'} else {',
					'  visitCounts[' . $opts->startPos . ']++;'
				]
			)->
			concat( [ '}' ] )
		);

		$result = null;
		if ( $env && $env->immutable ) {
			$result = 'JSUtils.deepFreeze(' . $opts->result . ')';
		} else {
			$result = $opts->result;
		}
		$cacheBits->store =
		[ 'if (checkCache) {' ]->
		concat( [
				'  cached = peg$cache[bucket][key] = {',
				'    nextPos: ' . $opts->endPos . ','
			]
		);
		if ( count( $opts->storeRefs ) ) {
			$cacheBits->store[] = '    refs: {},';
		}
		$cacheBits->store = implode(

			"\n", $cacheBits->store->concat(
				[
					'    result: ' . $result . ',',
					'  };'
				]
			)->concat( $opts->storeRefs )->
			concat( [ '}' ] )
		);

		return $cacheBits;
	}

	function cacheInitHook( $opts ) {
		return implode(

			"\n", [
				'var peg$cache = {};',
				'var visitCounts = new Uint8Array(input.length);'
			]
		);
	}

	$options = [
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
		],
		'trace' => false
	];

	return $compiler->compile( $this->parseTokenizer(), $passes, $options );
};

PegTokenizer::prototype::initTokenizer = function () {
	$tokenizerSource = $this->compileTokenizer( $this->parseTokenizer() );
	// eval is not evil in the case of a grammar-generated tokenizer.
	PegTokenizer::prototype::tokenizer = new function( 'return ' . $tokenizerSource )(); // eslint-disable-line
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

$module->exports = [
	'PegTokenizer' => $PegTokenizer,
	'pegIncludes' => $pegIncludes
];
