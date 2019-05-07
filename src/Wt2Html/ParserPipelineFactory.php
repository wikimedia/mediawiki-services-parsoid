<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * This module assembles parser pipelines from parser stages with
 * asynchronous communnication between stages based on events. Apart from the
 * default pipeline which converts WikiText to HTML DOM, it also provides
 * sub-pipelines for the processing of template transclusions.
 *
 * See http://www.mediawiki.org/wiki/Parsoid and
 * http://www.mediawiki.org/wiki/Parsoid/Token_stream_transformations
 * for illustrations of the pipeline architecture.
 * @module
 */

namespace Parsoid;

use Parsoid\Promise as Promise;

$PegTokenizer = require './tokenizer.js'::PegTokenizer;
$TokenTransformManager = require './TokenTransformManager.js';
$ExtensionHandler = require './tt/ExtensionHandler.js'::ExtensionHandler;
$NoIncludeOnly = require './tt/NoIncludeOnly.js';
$QuoteTransformer = require './tt/QuoteTransformer.js'::QuoteTransformer;
$TokenStreamPatcher = require './tt/TokenStreamPatcher.js'::TokenStreamPatcher;
$PreHandler = require './tt/PreHandler.js'::PreHandler;
$ParagraphWrapper = require './tt/ParagraphWrapper.js'::ParagraphWrapper;
$SanitizerHandler = require './tt/Sanitizer.js'::SanitizerHandler;
$TemplateHandler = require './tt/TemplateHandler.js'::TemplateHandler;
$AttributeExpander = require './tt/AttributeExpander.js'::AttributeExpander;
$ListHandler = require './tt/ListHandler.js'::ListHandler;
$WikiLinkHandler = require './tt/WikiLinkHandler.js'::WikiLinkHandler;
$ExternalLinkHandler = require './tt/ExternalLinkHandler.js'::ExternalLinkHandler;
$BehaviorSwitchHandler = require './tt/BehaviorSwitchHandler.js'::BehaviorSwitchHandler;
$LanguageVariantHandler = require './tt/LanguageVariantHandler.js'::LanguageVariantHandler;
$DOMFragmentBuilder = require './tt/DOMFragmentBuilder.js'::DOMFragmentBuilder;
$HTML5TreeBuilder = require './HTML5TreeBuilder.js'::HTML5TreeBuilder;
$DOMPostProcessor = require './DOMPostProcessor.js'::DOMPostProcessor;
$JSUtils = require '../utils/jsutils.js'::JSUtils;

$SyncTokenTransformManager = TokenTransformManager\SyncTokenTransformManager;
$AsyncTokenTransformManager = TokenTransformManager\AsyncTokenTransformManager;
$IncludeOnly = NoIncludeOnly\IncludeOnly;
$NoInclude = NoIncludeOnly\NoInclude;
$OnlyInclude = NoIncludeOnly\OnlyInclude;

$ParserPipeline = null; // forward declaration
$globalPipelineId = 0;

/**
 * @class
 * @param {MWParserEnvironment} env
 */
function ParserPipelineFactory( $env ) {
	$this->pipelineCache = [];
	$this->env = $env;
}

/**
 * Recipe for parser pipelines and -subpipelines, depending on input types.
 *
 * Token stream transformations to register by type and per phase. The
 * possible ranks for individual transformation registrations are [0,1)
 * (excluding 1.0) for sync01, [1,2) for async12 and [2,3) for sync23.
 *
 * Should perhaps be moved to {@link MWParserEnvironment}, so that all
 * configuration can be found in a single place.
 */
ParserPipelineFactory::prototype::recipes = [
	// The full wikitext pipeline
	'text/x-mediawiki/full' => [
		// Input pipeline including the tokenizer
		'text/x-mediawiki',
		// Final synchronous token transforms and DOM building / processing
		'tokens/x-mediawiki/expanded'
	],

	// A pipeline from wikitext to expanded tokens. The input pipeline for
	// wikitext.
	'text/x-mediawiki' => [
		[ $PegTokenizer, [] ],
		'tokens/x-mediawiki'
	],

	// Synchronous per-input and async token stream transformations. Produces
	// a fully expanded token stream ready for consumption by the
	// tokens/expanded pipeline.
	'tokens/x-mediawiki' => [
		// Synchronous in-order per input
		[
			$SyncTokenTransformManager,
			[ 1, 'tokens/x-mediawiki' ],
			[
				// PHASE RANGE: [0,1)
				$OnlyInclude, // 0.01
				$IncludeOnly, // 0.02
				$NoInclude
			]
		], // 0.03

		/*
		* Asynchronous out-of-order per input. Each async transform can only
		* operate on a single input token, but can emit multiple output
		* tokens. If multiple tokens need to be collected per-input, then a
		* separate collection transform in sync01 can be used to wrap the
		* collected tokens into a single one later processed in an async12
		* transform.
		*/
		[
			$AsyncTokenTransformManager,
			[ 2, 'tokens/x-mediawiki' ],
			[
				// PHASE RANGE: [1,2)
				$TemplateHandler, // 1.1
				$ExtensionHandler, // 1.11

				// Expand attributes after templates to avoid expanding unused branches
				// No expansion of quotes, paragraphs etc in attributes, as in
				// PHP parser- up to text/x-mediawiki/expanded only.
				$AttributeExpander, // 1.12

				// now all attributes expanded to tokens or string

				// more convenient after attribute expansion
				$WikiLinkHandler, // 1.15
				$ExternalLinkHandler, // 1.15
				$LanguageVariantHandler, // 1.16

				// This converts dom-fragment-token tokens all the way to DOM
				// and wraps them in DOMFragment wrapper tokens which will then
				// get unpacked into the DOM by a dom-fragment unpacker.
				$DOMFragmentBuilder
			]
		]
	], // 1.99

	// Final stages of main pipeline, operating on fully expanded tokens of
	// potentially mixed origin.
	'tokens/x-mediawiki/expanded' => [
		// Synchronous in-order on fully expanded token stream (including
		// expanded templates etc). In order to support mixed input (from
		// wikitext and plain HTML, say) all applicable transforms need to be
		// included here. Input-specific token types avoid any runtime
		// overhead for unused transforms.
		[
			$SyncTokenTransformManager,
			// PHASE RANGE: [2,3)
			[ 3, 'tokens/x-mediawiki/expanded' ],
			[
				$TokenStreamPatcher, // 2.001 -- 2.003
				// add <pre>s
				$PreHandler, // 2.051 -- 2.054
				$QuoteTransformer, // 2.1
				// add before transforms that depend on behavior switches
				// examples: toc generation, edit sections
				$BehaviorSwitchHandler, // 2.14

				$ListHandler, // 2.49
				$SanitizerHandler, // 2.90, 2.91
				// Wrap tokens into paragraphs post-sanitization so that
				// tags that converted to text by the sanitizer have a chance
				// of getting wrapped into paragraphs.  The sanitizer does not
				// require the existence of p-tags for its functioning.
				$ParagraphWrapper
			]
		], // 2.95 -- 2.97

		// Build a tree out of the fully processed token stream
		[ $HTML5TreeBuilder, [] ],

		/*
		 * Final processing on the HTML DOM.
		 */

		/*
		 * Generic DOM transformer.
		 * This performs a lot of post-processing of the DOM
		 * (Template wrapping, broken wikitext/html detection, etc.)
		 */
		[ $DOMPostProcessor, [] ]
	]
];

$supportedOptions = new Set( [
		// If true, templates found in content will have its contents expanded
		'expandTemplates',

		// If true, indicates pipeline is processing the expanded content of a
		// template or its arguments
		'inTemplate',

		// If true, indicates that we are in a <includeonly> context
		// (in current usage, isInclude === inTemplate)
		'isInclude',

		// The extension tag that is being processed (Ex: ref, references)
		// (in current usage, only used for native tag implementation)
		'extTag',

		// Extension-specific options
		'extTagOpts',

		// Content being parsed is used in an inline context
		'inlineContext',

		// FIXME: Related to PHP parser doBlockLevels side effect.
		// Primarily exists for backward compatibility reasons.
		// Might eventually go away in favor of something else.
		'inPHPBlock',

		// Are we processing content of attributes?
		// (in current usage, used for transcluded attr. keys/values)
		'attrExpansion'
	]
);

// Default options processing
$defaultOptions = function ( $options ) use ( &$supportedOptions ) {
	if ( !$options ) { $options = [];
 }

	Object::keys( $options )->forEach( function ( $k ) use ( &$supportedOptions ) {
			Assert::invariant( $supportedOptions->has( $k ), 'Invalid cacheKey option: ' . $k );
	}
	);

	// default: not an include context
	if ( $options->isInclude === null ) {
		$options->isInclude = false;
	}

	// default: wrap templates
	if ( $options->expandTemplates === null ) {
		$options->expandTemplates = true;
	}

	return $options;
};

/**
 * Generic pipeline creation from the above recipes.
 */
ParserPipelineFactory::prototype::makePipeline = function ( $type, $options ) use ( &$defaultOptions, &$ParserPipeline ) {
	// SSS FIXME: maybe there is some built-in method for this already?
	$options = $defaultOptions( $options );

	$pipelineConfig = $this->env->conf->parsoid->pipelineConfig;
	$phpComponents = $pipelineConfig && $pipelineConfig->wt2html;
	$phpTokenTransformers = $phpComponents && $phpComponents::TT || null;

	$recipe = $this->recipes[ $type ];
	if ( !$recipe ) {
		$console->trace();
		throw 'Error while trying to construct pipeline for ' . $type;
	}
	$stages = [];
	$PHPBuffer = null;
$PHPTokenTransformer = null;
$PHPPipelineStage = null;
	for ( $i = 0,  $l = count( $recipe );  $i < $l;  $i++ ) {
		// create the stage
		$stageData = $recipe[ $i ];
		$stage = null;

		if ( $stageData->constructor === $String ) {
			// Points to another subpipeline, get it recursively
			// Clone options object and clear cache type
			$newOpts = Object::assign( [], $options );
			$stage = $this->makePipeline( $stageData, $newOpts );
		} else {
			Assert::invariant( count( $stageData[ 1 ] ) <= 2 );

			if ( $phpComponents
&& $phpComponents[ $stageData[ 0 ]->name ]
|| $phpComponents[ $stageData[ 0 ]->name + $stageData[ 1 ][ 0 ] ]
			) {
				if ( !$PHPPipelineStage ) {
					$PHPPipelineStage = require '../../tests/porting/hybrid/PHPPipelineStage.js'::PHPPipelineStage;
				}
				$stage = new PHPPipelineStage( $this->env, $options, $this, $stageData[ 0 ]->name );
				$stage->phaseEndRank = $stageData[ 1 ][ 0 ];
				$stage->pipelineType = $stageData[ 1 ][ 1 ];
				// If you run a higher level pipeline component in PHP, we are forcing
				// all sub-transforms to run in PHP as well. Just keeps things simpler.
				// This only affects stages 1,2,3 involving the Sync or Async Token Transformers.
				if ( count( $stageData ) >= 3 ) {
					$stage->transformers = array_map( $stageData[ 2 ], function ( $T ) {return T::name;
		   } );
				}
			} else {
				$stage = new ( $stageData[ 0 ] )( $this->env, $options, $this, $stageData[ 1 ][ 0 ], $stageData[ 1 ][ 1 ] );
				if ( count( $stageData ) >= 3 ) {
					// FIXME: This code here adds the 'transformers' property to every stage
					// behind the back of that stage.  There are two alternatives to this:
					//
					// 1. Add 'recordTransformer' and 'getTransformers' functions to every stage.
					// But, seems excessive compared to current approach where the stages
					// aren't concerned with unnecessary details of state maintained for
					// the purposes of top-level orchestration.
					// 2. Alternatively, we could also maintain this information as a separate
					// object rather than tack it onto '.transformers' property of each stage.
					// this.stageTransformers = [
					// [stage1-transformers],
					// [stage2-transformers],
					// ...
					// ];

					$stage->transformers = [];
					// Create (and implicitly register) transforms
					$transforms = $stageData[ 2 ];
					for ( $j = 0;  $j < count( $transforms );  $j++ ) {
						$T = $transforms[ $j ];
						if ( $phpTokenTransformers && $phpTokenTransformers[ T::name ] ) {
							// Run the PHP version of this token transformation
							if ( !$PHPBuffer ) {
								// Add a buffer before the first PHP transformer
								$PHPBuffer = require '../../tests/porting/hybrid/PHPBuffer.js'::PHPBuffer;
								$PHPTokenTransformer = require '../../tests/porting/hybrid/PHPTokenTransformer.js'::PHPTokenTransformer;
								$stage->transformers[] = new PHPBuffer( $stage, $options );
							}
							$stage->transformers[] = new PHPTokenTransformer( $this->env, $stage, T::name, $options );
						} else {
							$stage->transformers[] = new T( $stage, $options );
						}
					}
				}
			}
		}

		// connect with previous stage
		if ( $i ) {
			$stage->addListenersOn( $stages[ $i - 1 ] );
		}
		$stages[] = $stage;
	}

	return new ParserPipeline(
		$type,
		$stages,
		$this->env
	);
};

function getCacheKey( $cacheKey, $options ) {
	$cacheKey = $cacheKey || '';
	if ( !$options->isInclude ) {
		$cacheKey += '::noInclude';
	}
	if ( !$options->expandTemplates ) {
		$cacheKey += '::noExpand';
	}
	if ( $options->inlineContext ) {
		$cacheKey += '::inlineContext';
	}
	if ( $options->inPHPBlock ) {
		$cacheKey += '::inPHPBlock';
	}
	if ( $options->inTemplate ) {
		$cacheKey += '::inTemplate';
	}
	if ( $options->attrExpansion ) {
		$cacheKey += '::attrExpansion';
	}
	if ( $options->extTag ) {
		$cacheKey += '::' . $options->extTag;
		// FIXME: This is not the best strategy. But, instead of
		// premature complexity, let us see how extensions want to
		// use this and then figure out what constraints are needed.
		if ( $options->extTagOpts ) {
			$cacheKey += '::' . json_encode( $options->extTagOpts );
		}
	}
	return $cacheKey;
}

/**
 * @param {string} src
 * @param {Function} [cb]
 * @return {Promise}
 */
ParserPipelineFactory::prototype::parse = function ( $src, $cb ) use ( &$Promise ) {
	return new Promise( function ( $resolve, $reject ) use ( &$src ) {
			// Now go ahead with the actual parsing
			$parser = $this->getPipeline( 'text/x-mediawiki/full' );
			$parser->once( 'document', $resolve );
			$parser->processToplevelDoc( $src );
	}
	)->nodify( $cb );
};

/**
 * Get a subpipeline (not the top-level one) of a given type.
 *
 * Subpipelines are cached as they are frequently created.
 */
ParserPipelineFactory::prototype::getPipeline = function ( $type, $options ) use ( &$defaultOptions, &$globalPipelineId ) {
	$options = $defaultOptions( $options );

	$cacheKey = getCacheKey( $type, $options );
	if ( !$this->pipelineCache[ $cacheKey ] ) {
		$this->pipelineCache[ $cacheKey ] = [];
	}

	$pipe = null;
	if ( count( $this->pipelineCache[ $cacheKey ] ) ) {
		$pipe = array_pop( $this->pipelineCache[ $cacheKey ] );
		$pipe->resetState();
		// Clear both 'end' and 'document' handlers
		$pipe->removeAllListeners( 'end' );
		$pipe->removeAllListeners( 'document' );
		// Also remove chunk listeners, although ideally that would already
		// happen in resetState. We'd need to avoid doing so when called from
		// processToplevelDoc though, so lets do it here for now.
		$pipe->removeAllListeners( 'chunk' );
	} else {
		$pipe = $this->makePipeline( $type, $options );
	}
	// add a cache callback
	$returnPipeline = function () use ( &$cacheKey, &$pipe ) {return $this->returnPipeline( $cacheKey, $pipe );
 };
	// Token pipelines emit an 'end' event
	$pipe->addListener( 'end', $returnPipeline );
	// Document pipelines emit a final 'document' even instead
	$pipe->addListener( 'document', $returnPipeline );

	// Debugging aid: Assign unique id to the pipeline
	$pipe->setPipelineId( $globalPipelineId++ );

	return $pipe;
};

/**
 * Callback called by a pipeline at the end of its processing. Returns the
 * pipeline to the cache.
 */
ParserPipelineFactory::prototype::returnPipeline = function ( $cacheKey, $pipe ) {
	// Clear all listeners, but do so after all other handlers have fired
	// pipe.on('end', function() { pipe.removeAllListeners( ) });
	$cache = $this->pipelineCache[ $cacheKey ];
	if ( !$cache ) {
		$cache = $this->pipelineCache[ $cacheKey ] = [];
	}
	if ( count( $cache ) < 100 ) {
		$cache[] = $pipe;
	}
};
