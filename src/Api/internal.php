<?php
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\apiUtils as apiUtils;

$ContentUtils = require '../utils/ContentUtils.js'::ContentUtils;
$DOMUtils = require '../utils/DOMUtils.js'::DOMUtils;
$Diff = require '../utils/Diff.js'::Diff;
$JSUtils = require '../utils/jsutils.js'::JSUtils;
$Util = require '../utils/Util.js'::Util;
$TemplateRequest = require '../mw/ApiRequest.js'::TemplateRequest;

$roundTripDiff = function ( $env, $req, $res, $useSelser, $doc ) use ( &$ContentUtils, &$Util, &$Diff ) {
	// Re-parse the HTML to uncover foster-parenting issues
	$doc = $env->createDocument( $doc->outerHTML );

	$handler = $env->getContentHandler();
	return $handler->fromHTML( $env, $doc->body, $useSelser )->then( function ( $out ) use ( &$doc, &$ContentUtils, &$Util, &$Diff, &$env, &$req ) {
			// Strip selser trigger comment
			$out = preg_replace( '/<!--rtSelserEditTestComment-->\n*$/', '', $out, 1 );

			// Emit base href so all relative urls resolve properly
			$headNodes = '';
			for ( $hNode = $doc->head->firstChild;  $hNode;  $hNode = $hNode->nextSibling ) {
				if ( strtolower( $hNode->nodeName ) === 'base' ) {
					$headNodes += ContentUtils::toXML( $hNode );
					break;
				}
			}

			$bodyNodes = '';
			for ( $bNode = $doc->body->firstChild;  $bNode;  $bNode = $bNode->nextSibling ) {
				$bodyNodes += ContentUtils::toXML( $bNode );
			}

			$htmlSpeChars = Util::escapeHtml( $out );
			$patch = Diff::convertChangesToXML( Diff::diffLines( $env->page->src, $out ) );

			return [
				'headers' => $headNodes,
				'bodyNodes' => $bodyNodes,
				'htmlSpeChars' => $htmlSpeChars,
				'patch' => $patch,
				'reqUrl' => $req->url
			];
	}
	);
};

$rtResponse = function ( $env, $req, $res, $data ) use ( &$apiUtils, &$JSUtils ) {
	apiUtils::renderResponse( $res, 'roundtrip', $data );
	$env->log( 'info', 'completed in ' . JSUtils::elapsedTime( $res->locals->start ) . 'ms' );
};

/**
 * @func
 * @param {ParsoidConfig} parsoidConfig
 * @param {Logger} processLogger
 */
$module->exports = function ( $parsoidConfig, $processLogger ) use ( &$apiUtils, &$TemplateRequest, &$roundTripDiff, &$rtResponse, &$DOMUtils, &$ContentUtils ) {
	$internal = [];

	// Middlewares

	$internal->middle = function ( $req, $res, $next ) use ( &$parsoidConfig, &$processLogger, &$apiUtils ) {
		$res->locals->errorEnc = 'plain';
		$iwp = $req->params->prefix || $parsoidConfig->defaultWiki || '';
		if ( !$parsoidConfig->mwApiMap->has( $iwp ) ) {
			$text = 'Invalid prefix: ' . $iwp;
			$processLogger->log( 'fatal/request', new Error( $text ) );
			return apiUtils::errorResponse( $res, $text, 404 );
		}
		$res->locals->iwp = $iwp;
		$res->locals->pageName = $req->params->title || '';
		$res->locals->oldid = $req->body->oldid || $req->query->oldid || null;
		// "body" flag to return just the body (instead of the entire HTML doc)
		$res->locals->body_only = (bool)( $req->query->body || $req->body->body );
		// "subst" flag to perform {{subst:}} template expansion
		$res->locals->subst = (bool)( $req->query->subst || $req->body->subst );
		$res->locals->envOptions = [
			'prefix' => $res->locals->iwp,
			'pageName' => $res->locals->pageName
		];
		$next();
	};

	// Routes

	// Form-based HTML DOM -> wikitext interface for manual testing.
	$internal->html2wtForm = function ( $req, $res ) use ( &$parsoidConfig, &$apiUtils ) {
		$domain = $parsoidConfig->mwApiMap->get( $res->locals->iwp )->domain;
		$action = '/' . $domain . '/v3/transform/html/to/wikitext/' . $res->locals->pageName;
		if ( $req->query->hasOwnProperty( 'scrub_wikitext' ) ) {
			$action += '?scrub_wikitext=' . $req->query->scrub_wikitext;
		}
		apiUtils::renderResponse( $res, 'form', [
				'title' => 'Your HTML DOM:',
				'action' => $action,
				'name' => 'html'
			]
		);
	};

	// Form-based wikitext -> HTML DOM interface for manual testing
	$internal->wt2htmlForm = function ( $req, $res ) use ( &$parsoidConfig, &$apiUtils ) {
		$domain = $parsoidConfig->mwApiMap->get( $res->locals->iwp )->domain;
		apiUtils::renderResponse( $res, 'form', [
				'title' => 'Your wikitext:',
				'action' => '/' . $domain . '/v3/transform/wikitext/to/html/' . $res->locals->pageName,
				'name' => 'wikitext'
			]
		);
	};

	// Round-trip article testing.  Default to scrubbing wikitext here.  Can be
	// overridden with qs param.
	$internal->roundtripTesting = function ( $req, $res ) use ( &$apiUtils, &$TemplateRequest, &$roundTripDiff, &$rtResponse ) {
		$env = $res->locals->env;
		$env->scrubWikitext = apiUtils::shouldScrub( $req, true );

		$target = $env->normalizeAndResolvePageTitle();

		$oldid = null;
		if ( $req->query->oldid ) {
			$oldid = $req->query->oldid;
		}

		return TemplateRequest::setPageSrcInfo( $env, $target, $oldid )->then( function () use ( &$env ) {
				$env->log( 'info', 'started parsing' );
				return $env->getContentHandler()->toHTML( $env );
		}
		)->
		then( function ( $doc ) use ( &$roundTripDiff, &$env, &$req, &$res ) {return $roundTripDiff( $env, $req, $res, false, $doc );
  } )->
		then( function ( $data ) use ( &$rtResponse, &$env, &$req, &$res ) {return $rtResponse( $env, $req, $res, $data );
  } )->
		catch( function ( $err ) use ( &$env ) {
				$env->log( 'fatal/request', $err );
		}
		);
	};

	// Round-trip article testing with newline stripping for editor-created HTML
	// simulation.  Default to scrubbing wikitext here.  Can be overridden with qs
	// param.
	$internal->roundtripTestingNL = function ( $req, $res ) use ( &$apiUtils, &$TemplateRequest, &$roundTripDiff, &$DOMUtils, &$rtResponse ) {
		$env = $res->locals->env;
		$env->scrubWikitext = apiUtils::shouldScrub( $req, true );

		$target = $env->normalizeAndResolvePageTitle();

		$oldid = null;
		if ( $req->query->oldid ) {
			$oldid = $req->query->oldid;
		}

		return TemplateRequest::setPageSrcInfo( $env, $target, $oldid )->then( function () use ( &$env ) {
				$env->log( 'info', 'started parsing' );
				return $env->getContentHandler()->toHTML( $env );
		}
		)->then( function ( $doc ) use ( &$roundTripDiff, &$env, &$req, &$res, &$DOMUtils ) {
				// strip newlines from the html
				$html = preg_replace( '/[\r\n]/', '', $doc->innerHTML );
				return $roundTripDiff( $env, $req, $res, false, DOMUtils::parseHTML( $html ) );
		}
		)->
		then( function ( $data ) use ( &$rtResponse, &$env, &$req, &$res ) {return $rtResponse( $env, $req, $res, $data );
  } )->
		catch( function ( $err ) use ( &$env ) {
				$env->log( 'fatal/request', $err );
		}
		);
	};

	// Round-trip article testing with selser over re-parsed HTML.  Default to
	// scrubbing wikitext here.  Can be overridden with qs param.
	$internal->roundtripSelser = function ( $req, $res ) use ( &$apiUtils, &$TemplateRequest, &$DOMUtils, &$ContentUtils, &$roundTripDiff, &$rtResponse ) {
		$env = $res->locals->env;
		$env->scrubWikitext = apiUtils::shouldScrub( $req, true );

		$target = $env->normalizeAndResolvePageTitle();

		$oldid = null;
		if ( $req->query->oldid ) {
			$oldid = $req->query->oldid;
		}

		return TemplateRequest::setPageSrcInfo( $env, $target, $oldid )->then( function () use ( &$env ) {
				$env->log( 'info', 'started parsing' );
				return $env->getContentHandler()->toHTML( $env );
		}
		)->then( function ( $doc ) use ( &$DOMUtils, &$ContentUtils, &$roundTripDiff, &$env, &$req, &$res ) {
				$doc = DOMUtils::parseHTML( ContentUtils::toXML( $doc ) );
				$comment = $doc->createComment( 'rtSelserEditTestComment' );
				$doc->body->appendChild( $comment );
				return $roundTripDiff( $env, $req, $res, true, $doc );
		}
		)->
		then( function ( $data ) use ( &$rtResponse, &$env, &$req, &$res ) {return $rtResponse( $env, $req, $res, $data );
  } )->
		catch( function ( $err ) use ( &$env ) {
				$env->log( 'fatal/request', $err );
		}
		);
	};

	// Form-based round-tripping for manual testing
	$internal->getRtForm = function ( $req, $res ) use ( &$apiUtils ) {
		apiUtils::renderResponse( $res, 'form', [
				'title' => 'Your wikitext:',
				'name' => 'content'
			]
		);
	};

	// Form-based round-tripping for manual testing.  Default to scrubbing wikitext
	// here.  Can be overridden with qs param.
	$internal->postRtForm = function ( $req, $res ) use ( &$apiUtils, &$roundTripDiff, &$rtResponse ) {
		$env = $res->locals->env;
		$env->scrubWikitext = apiUtils::shouldScrub( $req, true );

		$env->setPageSrcInfo( $req->body->content );
		$env->log( 'info', 'started parsing' );

		return $env->getContentHandler()->toHTML( $env )->
		then( function ( $doc ) use ( &$roundTripDiff, &$env, &$req, &$res ) {return $roundTripDiff( $env, $req, $res, false, $doc );
  } )->
		then( function ( $data ) use ( &$rtResponse, &$env, &$req, &$res ) {return $rtResponse( $env, $req, $res, $data );
  } )->
		catch( function ( $err ) use ( &$env ) {
				$env->log( 'fatal/request', $err );
		}
		);
	};

	return $internal;
};
