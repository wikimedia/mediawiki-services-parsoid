<?php
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$ParserEnv = require './config/MWParserEnvironment.js'::MWParserEnvironment;
$LanguageConverter = require './language/LanguageConverter'::LanguageConverter;
$ParsoidConfig = require './config/ParsoidConfig.js'::ParsoidConfig;
$TemplateRequest = require './mw/ApiRequest.js'::TemplateRequest;
$ContentUtils = require './utils/ContentUtils.js'::ContentUtils;
$DOMDataUtils = require './utils/DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require './utils/DOMUtils.js'::DOMUtils;
$Promise = require './utils/promise.js';
$JSUtils = require './utils/jsutils.js'::JSUtils;

$_toHTML = null;
$_fromHTML = null;

/**
 * Transform content-model to html
 * (common-case will be wikitext -> html)
 *
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {string} str
 *
 * @return {Promise} Assuming we're ending at html
 *   @return {string} return.html
 *   @return {Array} return.lint The lint buffer
 *   @return {string} return.contentmodel
 *   @return {Object} return.headers HTTP language-related headers
 *   @return {string} return.headers.content-language Page language or variant
 *   @return {string} return.headers.vary Indicates whether variant conversion
 *     was done or could be done
 *   @return {Object} [return.pb] If pageBundle was requested
 */
$_toHTML = /* async */function ( $obj, $env, $str ) use ( &$ContentUtils, &$DOMUtils ) {
	// `str` will be `undefined` when we fetched page source and info,
	// which we don't want to overwrite.
	if ( $str !== null ) {
		$env->setPageSrcInfo( $str );
	}
	$handler = $env->getContentHandler( $obj->contentmodel );
	$doc = /* await */ $handler->toHTML( $env );
	$out = null;
	if ( $env->pageBundle ) {
		$out = ContentUtils::extractDpAndSerialize( ( $obj->body_only ) ? $doc->body : $doc, [
				'innerXML' => $obj->body_only
			]
		);
	} else {
		$out = [
			'html' => ContentUtils::toXML( ( $obj->body_only ) ? $doc->body : $doc, [
					'innerXML' => $obj->body_only
				]
			)
		];
	}

	if ( $env->conf->parsoid->linting ) {
		$out->lint = $env->lintLogger->buffer;
		/* await */ $env->log( 'end/parse' ); // wait for linter logging to complete
	}// wait for linter logging to complete

	$out->contentmodel = ( $obj->contentmodel || $env->page->getContentModel() );
	$out->headers = DOMUtils::findHttpEquivHeaders( $doc );
	return $out;
};

/**
 * Transform html to requested content-model
 *
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {string} html
 * @param {Object} pb
 *
 * @return {Promise} Assuming we're ending at wt
 *   @return {string} return.wt
 */
$_fromHTML = /* async */function ( $obj, $env, $html, $pb ) use ( &$DOMDataUtils ) {
	$useSelser = ( $obj->selser !== null );
	$doc = $env->createDocument( $html );
	$pb = $pb || DOMDataUtils::extractPageBundle( $doc );
	if ( $useSelser && $env->page->dom ) {
		$pb = $pb || DOMDataUtils::extractPageBundle( $env->page->dom->ownerDocument );
		if ( $pb ) {
			DOMDataUtils::applyPageBundle( $env->page->dom->ownerDocument, $pb );
		}
	}
	if ( $pb ) {
		DOMDataUtils::applyPageBundle( $doc, $pb );
	}
	$handler = $env->getContentHandler( $obj->contentmodel );
	$out = /* await */ $handler->fromHTML( $env, $doc->body, $useSelser );
	return [ 'wt' => $out ];
};

/**
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {string} html
 */
$_languageConversion = function ( $obj, $env, $html ) use ( &$LanguageConverter, &$ContentUtils, &$DOMUtils ) {
	$doc = $env->createDocument( $html );
	// Note that `maybeConvert` could still be a no-op, in case the
	// __NOCONTENTCONVERT__ magic word is present, or the targetVariant
	// is a base language code or otherwise invalid.
	LanguageConverter::maybeConvert(
		$env, $doc, $obj->variant->target, $obj->variant->source
	);
	// Ensure there's a <head>
	if ( !$doc->head ) {
		$doc->documentElement->
		insertBefore( $doc->createElement( 'head' ), $doc->body );
	}
	// Update content-language and vary headers.
	$ensureHeader = function ( $h ) use ( &$doc ) {
		$el = $doc->querySelector( "meta[http-equiv=\"{$h}\"i]" );
		if ( !$el ) {
			$el = $doc->createElement( 'meta' );
			$el->setAttribute( 'http-equiv', $h );
			$doc->head->appendChild( $el );
		}
		return $el;
	};
	$ensureHeader( 'content-language' )->
	setAttribute( 'content', $env->htmlContentLanguage() );
	$ensureHeader( 'vary' )->
	setAttribute( 'content', $env->htmlVary() );
	// Serialize & emit.
	return [
		'html' => ContentUtils::toXML( ( $obj->body_only ) ? $doc->body : $doc, [
				'innerXML' => $obj->body_only
			]
		),
		'headers' => DOMUtils::findHttpEquivHeaders( $doc )
	];
};

$_updateRedLinks = /* async */function ( $obj, $env, $html ) use ( &$ContentUtils, &$DOMUtils ) {
	$doc = $env->createDocument( $html );
	// Note: this only works if the configured wiki has the ParsoidBatchAPI
	// extension installed.
	// Note: this only works if the configured wiki has the ParsoidBatchAPI
	// extension installed.
	/* await */ ContentUtils::addRedLinks( $env, $doc );
	// No need to `ContentUtils.extractDpAndSerialize`, it wasn't applied.
	// No need to `ContentUtils.extractDpAndSerialize`, it wasn't applied.
	return [
		'html' => ContentUtils::toXML( ( $obj->body_only ) ? $doc->body : $doc, [
				'innerXML' => $obj->body_only
			]
		),
		'headers' => DOMUtils::findHttpEquivHeaders( $doc )
	];
};

/**
 * Map of JSON.stringified parsoidOptions to ParsoidConfig
 */
$configCache = new Map();

/**
 * Parse wikitext (or html) to html (or wikitext).
 *
 * @param {Object} obj
 * @param {string} obj.input The string to parse
 * @param {string} obj.mode The mode to use
 * @param {Object} obj.parsoidOptions Will be Object.assign'ed to ParsoidConfig
 * @param {Object} obj.envOptions Will be Object.assign'ed to the env
 * @param {boolean} [obj.cacheConfig] Cache the constructed ParsoidConfig
 * @param {boolean} [obj.body_only] Only return the <body> children (T181657)
 * @param {Number} [obj.oldid]
 * @param {Object} [obj.selser]
 * @param {Object} [obj.pb]
 * @param {string} [obj.contentmodel]
 * @param {string} [obj.outputContentVersion]
 * @param {Object} [obj.reuseExpansions]
 * @param {string} [obj.pagelanguage]
 * @param {Object} [obj.variant]
 * @param {Function} [cb] Optional node-style callback
 *
 * @return {Promise}
 */
$module->exports = Promise::async( function ( $obj ) use ( &$JSUtils, &$configCache, &$ParsoidConfig, &$ParserEnv, &$_languageConversion, &$_updateRedLinks, &$ContentUtils, &$_fromHTML, &$_toHTML, &$TemplateRequest ) {
		$start = JSUtils::startTime();

		// Enforce the contraints of passing to a worker
		$obj = json_decode( json_encode( $obj ) );

		$hash = json_encode( $obj->parsoidOptions );
		$parsoidConfig = null;
		if ( $obj->cacheConfig && $configCache->has( $hash ) ) {
			$parsoidConfig = $configCache->get( $hash );
		} else {
			$parsoidConfig = new ParsoidConfig( null, $obj->parsoidOptions );
			if ( $obj->cacheConfig ) {
				$configCache->set( $hash, $parsoidConfig );
				// At present, we don't envision using the cache with multiple
				// configurations.  Prevent it from growing unbounded inadvertently.
				Assert::invariant( $configCache->size === 1, 'Config properties changed.' );
			}
		}

		$env = /* await */ ParserEnv::getParserEnv( $parsoidConfig, $obj->envOptions );
		$env->startTime = $start;
		$s1 = JSUtils::startTime();
		$env->bumpTimeUse( 'Setup Environment', $s1 - $start, 'Init' );
		$env->log( 'info', 'started ' . $obj->mode );
		try {

			if ( $obj->oldid ) {
				$env->page->meta->revision->revid = $obj->oldid;
			}

			$out = null;
			if ( $obj->mode === 'variant' ) {
				$env->page->pagelanguage = $obj->pagelanguage;
				return $_languageConversion( $obj, $env, $obj->input );
			} elseif ( $obj->mode === 'redlinks' ) {
				return $_updateRedLinks( $obj, $env, $obj->input );
			} elseif ( [ 'html2wt', 'html2html', 'selser' ]->includes( $obj->mode ) ) {
				// Selser
				$selser = $obj->selser;
				if ( $selser !== null ) {
					if ( $selser->oldtext !== null ) {
						$env->setPageSrcInfo( $selser->oldtext );
					}
					if ( $selser->oldhtml ) {
						$env->page->dom = $env->createDocument( $selser->oldhtml )->body;
					}
					if ( $selser->domdiff ) {
						// FIXME: need to load diff markers from attributes
						$env->page->domdiff = [
							'isEmpty' => false,
							'dom' => ContentUtils::ppToDOM( $env, $selser->domdiff )
						];
						throw new Error( 'this is broken' );
					}
				}
				$html = $obj->input;
				$env->bumpSerializerResourceUse( 'htmlSize', count( $env ) );
				$out = /* await */ $_fromHTML( $obj, $env, $html, $obj->pb );
				return ( $obj->mode === 'html2html' ) ? $_toHTML( $obj, $env, $out->wt ) : $out;
			} else { /* wt2html, wt2wt */
				// The content version to output
				if ( $obj->outputContentVersion ) {
					$env->setOutputContentVersion( $obj->outputContentVersion );
				}

				if ( $obj->reuseExpansions ) {
					$env->cacheReusableExpansions( $obj->reuseExpansions );
				}

				$wt = $obj->input;

				// Always fetch page info if we have an oldid
				if ( $obj->oldid || $wt === null ) {
					$target = $env->normalizeAndResolvePageTitle();
					/* await */ TemplateRequest::setPageSrcInfo( $env, $target, $obj->oldid );
					$env->bumpTimeUse( 'Pre-parse (source fetch)', JSUtils::elapsedTime( $s1 ), 'Init' );
					// Ensure that we don't env.page.reset() when calling
					// env.setPageSrcInfo(wt) in _toHTML()
					if ( $wt !== null ) {
						$env->page->src = $wt;
						$wt = null;
					}
				}

				$wikitextSize = ( $wt !== null ) ? count( $wt ) : count( $env->page->src );
				$env->bumpParserResourceUse( 'wikitextSize', $wikitextSize );
				if ( $parsoidConfig->metrics ) {
					$mstr = ( $obj->envOptions->pageWithOldid ) ? 'pageWithOldid' : 'wt';
					$parsoidConfig->metrics->timing( "wt2html.{$mstr}.size.input", $wikitextSize );
				}

				// Explicitly setting the pagelanguage can override the fetched one
				if ( $obj->pagelanguage ) {
					$env->page->pagelanguage = $obj->pagelanguage;
				}

				$out = /* await */ $_toHTML( $obj, $env, $wt );
				return ( $obj->mode === 'wt2html' ) ? $out : $_fromHTML( $obj, $env, $out->html );
			}
		} finally {
			$end = JSUtils::elapsedTime( $start );
			/* await */ $env->log( 'info', "completed {$obj->mode} in {$end}ms" );
		}
}, 1
);
