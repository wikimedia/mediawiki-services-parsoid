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

$JSUtils = require '../utils/jsutils.js'::JSUtils;

$ParserPipeline = null; // forward declaration
$globalPipelineId = 0;


/**
 * Wrap some stages into a pipeline. The last member of the pipeline is
 * supposed to emit events, while the first is supposed to support a process()
 * method that sets the pipeline in motion.
 * @class
 */
$ParserPipeline = function ( $type, $stages, $env ) use ( &$JSUtils ) {
	$this->pipeLineType = $type;
	$this->stages = $stages;
	$this->first = $stages[ 0 ];
	$this->last = JSUtils::lastItem( $stages );
	$this->env = $env;
};

/**
 * Applies the function across all stages and transformers registered at each stage.
 * @private
 */
ParserPipeline::prototype::_applyToStage = function ( $fn, $args ) {
	// Apply to each stage
	$this->stages->forEach( function ( $stage ) use ( &$fn ) {
			if ( $stage[ $fn ] && $stage[ $fn ]->constructor === $Function ) {
				call_user_func_array( [ $stage, 'fn' ], $args );
			}
			// Apply to each registered transformer for this stage
			if ( $stage->transformers ) {
				$stage->transformers->forEach( function ( $t ) use ( &$fn ) {
						if ( $t[ $fn ] && $t[ $fn ]->constructor === $Function ) {
							call_user_func_array( [ $t, 'fn' ], $args );
						}
				}
				);
			}
	}
	);
};

/**
 * This is useful for debugging.
 */
ParserPipeline::prototype::setPipelineId = function ( $id ) {
	$this->id = $id;
	$this->_applyToStage( 'setPipelineId', [ $id ] );
};

/**
 * This is primarily required to reset native extensions
 * which might have be shared globally per parsing environment
 * (unlike pipeline stages and transformers that exist one per
 * pipeline). So, cannot rely on 'end' event to reset pipeline
 * because there will be one 'end' event per pipeline.
 *
 * Ex: cite needs to maintain a global sequence across all
 * template transclusion pipelines, extension, and top-level
 * pipelines.
 *
 * This lets us reuse pipelines to parse unrelated top-level pages
 * Ex: parser tests. Currently only parser tests exercise
 * this functionality.
 */
ParserPipeline::prototype::resetState = function ( $opts ) {
	$this->_applyToStage( 'resetState', [ $opts ] );
};

/**
 * Set source offsets for the source that this pipeline will process.
 *
 * This lets us use different pipelines to parse fragments of the same page
 * Ex: extension content (found on the same page) is parsed with a different
 * pipeline than the top-level page.
 *
 * Because of this, the source offsets are not [0, page.length) always
 * and needs to be explicitly initialized
 */
ParserPipeline::prototype::setSourceOffsets = function ( $start, $end ) {
	$this->_applyToStage( 'setSourceOffsets', [ $start, $end ] );
};

/**
 * Feed input tokens to the first pipeline stage.
 *
 * @param {Array|string} input tokens
 * @param {boolean} sol Whether tokens should be processed in start-of-line
 *   context.
 */
ParserPipeline::prototype::process = function ( $input, $sol ) {
	try {
		return $this->first->process( $input, $sol );
	} catch ( Exception $err ) {
		$this->env->log( 'fatal', $err );
	}
};

/**
 * Feed input tokens to the first pipeline stage.
 */
ParserPipeline::prototype::processToplevelDoc = function ( $input ) use ( &$JSUtils ) {
	// Reset pipeline state once per top-level doc.
	// This clears state from any per-doc global state
	// maintained across all pipelines used by the document.
	// (Ex: Cite state)
	$this->resetState( [ 'toplevel' => true ] );
	if ( !$this->env->startTime ) {
		$this->env->startTime = JSUtils::startTime();
	}
	$this->env->log( 'trace/time', 'Starting parse at ', $this->env->startTime );
	$this->process( $input, /* sol */true );
};

/**
 * Set the frame on the last pipeline stage (normally the
 * AsyncTokenTransformManager).
 */
ParserPipeline::prototype::setFrame = function ( $frame, $title, $args ) {
	return $this->_applyToStage( 'setFrame', [ $frame, $title, $args ] );
};

/**
 * Register the first pipeline stage with the last stage from a separate pipeline.
 */
ParserPipeline::prototype::addListenersOn = function ( $stage ) {
	return $this->first->addListenersOn( $stage );
};

// Forward the EventEmitter API to this.last
ParserPipeline::prototype::on = function ( $ev, $cb ) {
	return $this->last->on( $ev, $cb );
};
ParserPipeline::prototype::once = function ( $ev, $cb ) {
	return $this->last->once( $ev, $cb );
};
ParserPipeline::prototype::addListener = function ( $ev, $cb ) {
	return $this->last->addListener( $ev, $cb );
};
ParserPipeline::prototype::removeListener = function ( $ev, $cb ) {
	return $this->last->removeListener( $ev, $cb );
};
ParserPipeline::prototype::setMaxListeners = function ( $n ) {
	return $this->last->setMaxListeners( $n );
};
ParserPipeline::prototype::listeners = function ( $ev ) {
	return $this->last->listeners( $ev );
};
ParserPipeline::prototype::removeAllListeners = function ( $event ) {
	$this->last->removeAllListeners( $event );
};
