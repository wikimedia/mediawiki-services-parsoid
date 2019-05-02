<?php // lint >= 99.9
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * This file exports the stuff required by external extensions.
 *
 * @module
 */

namespace Parsoid;

use Parsoid\semver as semver;
use Parsoid\parsoidJson as parsoidJson;
use Parsoid\Promise as Promise;
use Parsoid\ContentUtils as ContentUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\PipelineUtils as PipelineUtils;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\Util as Util;
use Parsoid\WTUtils as WTUtils;
use Parsoid\Sanitizer as Sanitizer;
use Parsoid\SanitizerConstants as SanitizerConstants;

/**
 * Create a parsing pipeline to parse wikitext.
 *
 * @param {Object} state
 * @param {Object} state.manager
 * @param {string} wikitext
 * @param {Array} srcOffsets
 * @param {Object} parseOpts
 * @param parseOpts.extTag
 * @param parseOpts.extTagOpts
 * @param parseOpts.inTemplate
 * @param parseOpts.inlineContext
 * @param parseOpts.inPHPBlock
 * @param {boolean} sol
 * @return {Document}
 */
$parseWikitextToDOM = /* async */function ( $state, $wikitext, $srcOffsets, $parseOpts, $sol ) use ( &$PipelineUtils ) {
	$doc = null;
	if ( !$wikitext ) {
		$doc = $state->env->createDocument();
	} else {
		// Parse content to DOM and pass DOM-fragment token back to the main pipeline.
		// The DOM will get unwrapped and integrated  when processing the top level document.
		$opts = [
			// Full pipeline for processing content
			'pipelineType' => 'text/x-mediawiki/full',
			'pipelineOpts' => [
				'expandTemplates' => true,
				'extTag' => $parseOpts->extTag,
				'extTagOpts' => $parseOpts->extTagOpts,
				'inTemplate' => $parseOpts->inTemplate,
				'inlineContext' => $parseOpts->inlineContext,
				// FIXME: Hack for backward compatibility
				// support for extensions that rely on this behavior.
				'inPHPBlock' => $parseOpts->inPHPBlock
			],
			'srcOffsets' => $srcOffsets,
			'sol' => $sol
		];
		// Actual processing now
		// Actual processing now
		$doc = /* await */ PipelineUtils::promiseToProcessContent( $state->env, $state->frame, $wikitext, $opts );
	}
	return $doc;
};

/**
 * FIXME: state is only required for performance reasons so that
 * we can overlap extension wikitext parsing with main pipeline.
 * Otherwise, we can simply parse this sync in an independent pipeline
 * without any state.
 *
 * @param {Object} state
 * @param {Array} extArgs
 * @param {string} leadingWS
 * @param {string} wikitext
 * @param {Object} parseOpts
 * @return {Document}
 */
$parseTokenContentsToDOM = /* async */function ( $state, $extArgs, $leadingWS, $wikitext, $parseOpts ) use ( &$parseWikitextToDOM, &$DOMUtils, &$Sanitizer, &$DOMDataUtils ) {
	$dataAttribs = $state->extToken->dataAttribs;
	$extTagOffsets = $dataAttribs->extTagOffsets;
	$srcOffsets = [ $extTagOffsets[ 1 ] + count( $leadingWS ), $extTagOffsets[ 2 ] ];

	$doc = /* await */ $parseWikitextToDOM( $state, $wikitext, $srcOffsets, $parseOpts, /* sol */true );

	// Create a wrapper and migrate content into the wrapper
	// Create a wrapper and migrate content into the wrapper
	$wrapper = $doc->createElement( $parseOpts->wrapperTag );
	DOMUtils::migrateChildren( $doc->body, $wrapper );
	$doc->body->appendChild( $wrapper );

	// Sanitize argDict.attrs and set on the wrapper
	// Sanitize argDict.attrs and set on the wrapper
	Sanitizer::applySanitizedArgs( $state->env, $wrapper, $extArgs );

	// Mark empty content DOMs
	// Mark empty content DOMs
	if ( !$wikitext ) {
		DOMDataUtils::getDataParsoid( $wrapper )->empty = true;
	}

	if ( $state->extToken->dataAttribs->selfClose ) {
		DOMDataUtils::getDataParsoid( $wrapper )->selfClose = true;
	}

	return $doc;
};

$module->exports = [
	'versionCheck' => function ( $requestedVersion ) use ( &$semver, &$parsoidJson, &$ContentUtils, &$DOMDataUtils, &$DOMUtils, &$parseTokenContentsToDOM, &$parseWikitextToDOM, &$Promise, &$Sanitizer, &$SanitizerConstants, &$TokenUtils, &$Util, &$WTUtils ) {
		// Throw exception if the supplied major/minor version is
		// incompatible with the currently running Parsoid.
		if ( !semver::satisfies( parsoidJson::version, $requestedVersion ) ) {
			throw new Error(
				'Parsoid version ' . parsoidJson::version . ' is inconsistent '
. 'with required version ' . $requestedVersion
			);
		}

		// Return the exports to support chaining.  We could also elect
		// to return a slightly different version of the exports here if
		// we wanted to support multiple API versions.
		return [
			// XXX we may wish to export a subset of Util/DOMUtils/defines
			// and explicitly mark the exported functions as "stable", ie
			// we need to bump Parsoid's major version if the exported
			// functions are changed.
			'addMetaData' => require '../wt2html/DOMPostProcessor.js'::DOMPostProcessor::addMetaData,
			'ContentUtils' => ContentUtils::class,
			'DOMDataUtils' => DOMDataUtils::class,
			'DOMUtils' => DOMUtils::class,
			'JSUtils' => require '../utils/jsutils.js'::JSUtils,
			'parseTokenContentsToDOM' => $parseTokenContentsToDOM,
			'parseWikitextToDOM' => $parseWikitextToDOM,
			'Promise' => Promise::class,
			'Sanitizer' => Sanitizer::class,
			'SanitizerConstants' => SanitizerConstants::class,
			'TemplateRequest' => require '../mw/ApiRequest.js'::TemplateRequest,
			'TokenTypes' => require '../tokens/TokenTypes.js' ,
			'TokenUtils' => TokenUtils::class,
			'Util' => Util::class,
			'WTUtils' => WTUtils::class
		];
	}
];
