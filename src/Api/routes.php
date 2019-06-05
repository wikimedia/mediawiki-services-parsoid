<?php // lint >= 99.9
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\childProcess as childProcess;
use Parsoid\uuid as uuid;
use Parsoid\Negotiator as Negotiator;
use Parsoid\semver as semver;

use Parsoid\pkg as pkg;
use Parsoid\apiUtils as apiUtils;

$ContentUtils = require '../utils/ContentUtils.js'::ContentUtils;
$DOMDataUtils = require '../utils/DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require '../utils/DOMUtils.js'::DOMUtils;
$MWParserEnv = require '../config/MWParserEnvironment.js'::MWParserEnvironment;
$Promise = require '../utils/promise.js';
$LogData = require '../logger/LogData.js'::LogData;
$TemplateRequest = require '../mw/ApiRequest.js'::TemplateRequest;

/**
 * Create the API routes.
 * @param {ParsoidConfig} parsoidConfig
 * @param {Logger} processLogger
 * @param {Object} parsoidOptions
 * @param {Function} parse
 */
$module->exports = function /* routes */( $parsoidConfig, $processLogger, $parsoidOptions, $parse ) use ( &$apiUtils, &$uuid, &$Promise, &$MWParserEnv, &$LogData, &$Negotiator, &$pkg, &$childProcess, &$corepath, &$semver, &$TemplateRequest, &$DOMUtils, &$DOMDataUtils, &$ContentUtils ) {
	$routes = [];
	$metrics = $parsoidConfig->metrics;

	// This helper is only to be used in middleware, before an environment
	// is setup.  The logger doesn't emit the expected location info.
	// You probably want `apiUtils.fatalRequest` instead.
	$errOut = function ( $res, $text, $httpStatus ) use ( &$processLogger, &$apiUtils ) {
		$processLogger->log( 'fatal/request', $text );
		apiUtils::errorResponse( $res, $text, $httpStatus || 404 );
	};

	// Middlewares

	$errorEncoding = new Map( Object::entries( [
				'pagebundle' => 'json',
				'html' => 'html',
				'wikitext' => 'plain',
				'lint' => 'json'
			]
		)
	);

	$validGets = new Set( [ 'wikitext', 'html', 'pagebundle' ] );

	$wikitextTransforms = [ 'html', 'pagebundle' ];
	if ( $parsoidConfig->linting ) { $wikitextTransforms[] = 'lint';
 }

	$validTransforms = new Map( Object::entries( [
				'wikitext' => $wikitextTransforms,
				'html' => [ 'wikitext' ],
				'pagebundle' => [ 'wikitext', 'pagebundle' ]
			]
		)
	);

	$routes->v3Middle = function ( $req, $res, $next ) use ( &$errorEncoding, &$validGets, &$errOut, &$validTransforms, &$parsoidConfig ) {
		$res->locals->titleMissing = !$req->params->title;
		$res->locals->pageName = $req->params->title || '';
		$res->locals->oldid = $req->params->revision || null;

		// "body_only" flag to return just the body (instead of the entire HTML doc)
		// We would like to deprecate use of this flag: T181657
		$res->locals->body_only = (bool)$req->query->body_only || $req->body->body_only;

		$opts = Object::assign( [
				'from' => $req->params->from,
				'format' => $req->params->format
			], $req->body
		);

		$res->locals->errorEnc = $errorEncoding->get( $opts->format ) || 'plain';

		if ( $req->method === 'GET' || $req->method === 'HEAD' ) {
			if ( !$validGets->has( $opts->format ) ) {
				return $errOut( $res, 'Invalid page format: ' . $opts->format );
			}
		} elseif ( $req->method === 'POST' ) {
			$transforms = $validTransforms->get( $opts->from );
			if ( $transforms === null || !$transforms->includes( $opts->format ) ) {
				return $errOut( $res, 'Invalid transform: ' . $opts->from . '/to/' . $opts->format );
			}
		} else {
			return $errOut( $res, 'Request method not supported.' );
		}

		$iwp = $parsoidConfig->getPrefixFor( $req->params->domain );
		if ( !$iwp ) {
			return $errOut( $res, 'Invalid domain: ' . $req->params->domain );
		}
		$res->locals->iwp = $iwp;

		// "subst" flag to perform {{subst:}} template expansion
		$res->locals->subst = (bool)( $req->query->subst || $req->body->subst );
		// This is only supported for the html format
		if ( $res->locals->subst && $opts->format !== 'html' ) {
			return $errOut( $res, 'Substitution is only supported for the HTML format.', 501 );
		}

		if ( $req->method === 'POST' ) {
			$original = $opts->original || [];
			if ( $original->revid ) {
				$res->locals->oldid = $original->revid;
			}
			if ( $original->title ) {
				$res->locals->titleMissing = false;
				$res->locals->pageName = $original->title;
			}
		}

		if ( $req->headers[ 'content-language' ] ) {
			$res->locals->pagelanguage = $req->headers[ 'content-language' ];
		}

		$res->locals->envOptions = [
			// We use `prefix` but ought to use `domain` (T206764)
			'prefix' => $res->locals->iwp,
			'domain' => $req->params->domain,
			'pageName' => $res->locals->pageName,
			'cookie' => $req->headers->cookie,
			'reqId' => $req->headers[ 'x-request-id' ],
			'userAgent' => $req->headers[ 'user-agent' ],
			'htmlVariantLanguage' => $req->headers[ 'accept-language' ] || null
		];

		$res->locals->opts = $opts;
		$next();
	};

	$activeRequests = new Map();
	$routes->updateActiveRequests = function ( $req, $res, $next ) use ( &$parsoidConfig, &$uuid, &$activeRequests, &$processLogger ) {
		if ( $parsoidConfig->useWorker ) { return $next();
  }
		$buf = Buffer::alloc( 16 );
		uuid::class( null, $buf );
		$id = $buf->toString( 'hex' );
		$location = $res->locals->iwp . '/' . $res->locals->pageName
. ( ( $res->locals->oldid ) ? '?oldid=' . $res->locals->oldid : '' );
		$activeRequests->set( $id, [
				'location' => $location,
				'timeout' => setTimeout( function () use ( &$processLogger, &$location ) {
						// This is pretty harsh but was, in effect, what we were doing
						// before with the cpu timeouts.  Shoud be removed with
						// T123446 and T110961.
						$processLogger->log( 'fatal', 'Timed out processing: ' . $location );
						// `processLogger` is async; give it some time to deliver the msg.
						setTimeout( function () { $process->exit( 1 );
			   }, 100 );
				}, $parsoidConfig->timeouts->request
				)
			]
		);
		$current = [];
		$activeRequests->forEach( function ( $val ) use ( &$current ) {
				$current[] = $val->location;
		}
		);
		$process->emit( 'service_status', $current );
		$res->once( 'finish', function () use ( &$activeRequests, &$id ) {
				clearTimeout( $activeRequests->get( $id )->timeout );
				$activeRequests->delete( $id );
		}
		);
		$next();
	};

	// FIXME: Preferably, a parsing environment would not be constructed
	// outside of the parser and used here in the http api.  It should be
	// noted that only the properties associated with the `envOptions` are
	// used in the actual parse.
	$routes->parserEnvMw = function ( $req, $res, $next ) use ( &$Promise, &$apiUtils, &$MWParserEnv, &$parsoidConfig, &$processLogger, &$LogData ) {
		$errBack = /* async */function ( $logData ) use ( &$res, &$Promise, &$apiUtils ) {
			if ( !$res->headersSent ) {
				$socket = $res->socket;
				if ( $res->finished || ( $socket && !$socket->writable ) ) {

					/* too late to send an error response, alas */
				} else { /* too late to send an error response, alas */

					try {
						/* await */ new Promise( function ( $resolve, $reject ) use ( &$res, &$apiUtils, &$logData ) {
								$res->once( 'finish', $resolve );
								apiUtils::errorResponse( $res, $logData->fullMsg(), $logData->flatLogObject()->httpStatus );
						}
						);
					} catch ( Exception $e ) {
						$console->error( $e->stack || $e );
						$res->end();
						throw $e;
					}
				}
			}
		};
		MWParserEnv::getParserEnv( $parsoidConfig, $res->locals->envOptions )->
		then( function ( $env ) use ( &$errBack, &$res, &$next ) {
				$env->logger->registerBackend( /* RegExp */ '/fatal(\/.*)?/', $errBack );
				$res->locals->env = $env;
				$next();
		}
		)->
		catch( function ( $err ) use ( &$processLogger, &$errBack, &$LogData, &$req ) {
				$processLogger->log( 'fatal/request', $err );
				// Workaround how logdata flatten works so that the error object is
				// recursively flattened and a stack trace generated for this.
				return $errBack( new LogData( 'error', [ 'error:', $err, 'path:', $req->path ] ) );
		}
		)->done();
	};

	$routes->acceptable = function ( $req, $res, $next ) use ( &$Negotiator, &$apiUtils ) {
		$env = $res->locals->env;
		$opts = $res->locals->opts;

		if ( $opts->format === 'wikitext' ) {
			return $next();
		}

		// Parse accept header
		$negotiator = new Negotiator( $req );
		$acceptableTypes = $negotiator->mediaTypes( null, [
				'detailed' => true
			]
		);

		// Validate and set the content version
		if ( !apiUtils::validateAndSetOutputContentVersion( $res, $acceptableTypes ) ) {
			$text = array_reduce( $env->availableVersions, function ( $prev, $curr ) {
					switch ( $opts->format ) {
						case 'html':
						$prev += $apiUtils->htmlContentType( $curr );
						break;
						case 'pagebundle':
						$prev += $apiUtils->pagebundleContentType( $curr );
						break;
						default:
						Assert::invariant( false, "Unexpected format: {$opts->format}" );
					}
					return "{$prev}\n";
			}, "Not acceptable.\n"
			);
			return apiUtils::fatalRequest( $env, $text, 406 );
		}

		$next();
	};

	// Routes

	$routes->home = function ( $req, $res ) use ( &$apiUtils, &$parsoidConfig ) {
		apiUtils::renderResponse( $res, 'home', [ 'dev' => $parsoidConfig->devAPI ] );
	};

	// robots.txt: no indexing.
	$routes->robots = function ( $req, $res ) use ( &$apiUtils ) {
		apiUtils::plainResponse( $res, "User-agent: *\nDisallow: /\n" );
	};

	// Return Parsoid version based on package.json + git sha1 if available
	$versionCache = null;
	$routes->version = function ( $req, $res ) use ( &$versionCache, &$Promise, &$pkg, &$childProcess, &$corepath, &$apiUtils ) {
		if ( !$versionCache ) {
			$versionCache = Promise::resolve( [
					'name' => pkg::name,
					'version' => pkg::version
				]
			)->then( function ( $v ) use ( &$Promise, &$childProcess, &$corepath ) {
					return Promise::promisify(
						childProcess::execFile, [ 'stdout', 'stderr' ], childProcess::class
					)( 'git', [ 'rev-parse', 'HEAD' ], [
							'cwd' => implode( $__dirname, $corepath )
						]
					)->then( function ( $out ) use ( &$v ) {
							$v->sha = array_slice( $out->stdout, 0, -1 );
							return $v;
					}, function ( $err ) use ( &$v ) { // eslint-disable-line
							/* ignore the error, maybe this isn't a git checkout */
							return $v;
					}
					);
			}
			);
		}
		return $versionCache->then( function ( $v ) use ( &$apiUtils, &$res ) {
				apiUtils::jsonResponse( $res, $v );
		}
		);
	};

	// v3 Routes

	// Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.

	$wt2html = /* async */function ( $req, $res, $wt, $reuseExpansions ) use ( &$metrics, &$semver, &$MWParserEnv, &$TemplateRequest, &$apiUtils, &$parsoidConfig, &$parse, &$parsoidOptions ) {
		$env = $res->locals->env;
		$opts = $res->locals->opts;
		$oldid = $res->locals->oldid;
		$target = $env->normalizeAndResolvePageTitle();

		$pageBundle = (bool)( $res->locals->opts && $res->locals->opts->format === 'pagebundle' );

		// Performance Timing options
		// Performance Timing options
		$startTimers = new Map();

		if ( $metrics ) {
			// init refers to time elapsed before parsing begins
			$startTimers->set( 'wt2html.init', time() );
			$startTimers->set( 'wt2html.total', time() );
			if ( semver::neq( $env->outputContentVersion, MWParserEnv::prototype::availableVersions[ 0 ] ) ) {
				$metrics->increment( 'wt2html.parse.version.notdefault' );
			}
		}

		if ( gettype( $wt ) !== 'string' && !$oldid ) {
			// Redirect to the latest revid
			/* await */ TemplateRequest::setPageSrcInfo( $env, $target );
			return apiUtils::redirectToOldid( $req, $res );
		}

		// Calling this `wikitext` so that it's easily distinguishable.
		// It may be modified by substTopLevelTemplates.
		// Calling this `wikitext` so that it's easily distinguishable.
		// It may be modified by substTopLevelTemplates.
		$wikitext = null;
		$doSubst = ( gettype( $wt ) === 'string' && $res->locals->subst );
		if ( $doSubst ) {
			$wikitext = /* await */ apiUtils::substTopLevelTemplates( $env, $target, $wt );
		} else {
			$wikitext = $wt;
		}

		// Follow redirects if asked
		// Follow redirects if asked
		if ( $parsoidConfig->devAPI && $req->query->follow_redirects ) {
			// Get localized redirect matching regexp
			$reSrc = $env->conf->wiki->getMagicWordMatcher( 'redirect' )->source;
			$reSrc = '^[ \t\n\r\0\x0b]*'
. substr( $reSrc, 1, count( $reSrc ) - 1/*CHECK THIS*/ ) . // Strip ^ and $
				'[ \t\n\r\x0c]*(?::[ \t\n\r\x0c]*)?'
. '\[\[([^\]]+)\]\]';
			$re = new RegExp( $reSrc, 'i' );
			$s = $wikitext;
			if ( gettype( $wikitext ) !== 'string' ) {
				/* await */ TemplateRequest::setPageSrcInfo( $env, $target, $oldid );
				$s = $env->page->src;
			}
			$redirMatch = preg_match( $re, $s );
			if ( $redirMatch ) {
				return apiUtils::_redirectToPage( $redirMatch[ 2 ], $req, $res );
			}
		}

		$envOptions = Object::assign( [
				'pageBundle' => $pageBundle,
				// Set data-parsoid to be discarded, so that the subst'ed
				// content is considered new when it comes back.
				'discardDataParsoid' => $doSubst
			], $res->locals->envOptions
		);

		// VE, the only client using body_only property,
		// doesn't want section tags when this flag is set.
		// (T181226)
		// VE, the only client using body_only property,
		// doesn't want section tags when this flag is set.
		// (T181226)
		if ( $res->locals->body_only ) {
			$envOptions->wrapSections = false;
		}

		if ( gettype( $wikitext ) === 'string' ) {
			// Don't cache requests when wt is set in case somebody uses
			// GET for wikitext parsing
			apiUtils::setHeader( $res, 'Cache-Control', 'private,no-cache,s-maxage=0' );
		} elseif ( $oldid ) {
			$envOptions->pageWithOldid = true;
			if ( $req->headers->cookie ) {
				// Don't cache requests with a session.
				apiUtils::setHeader( $res, 'Cache-Control', 'private,no-cache,s-maxage=0' );
			}
			// Indicate the MediaWiki revision in a header as well for
			// ease of extraction in clients.
			// Indicate the MediaWiki revision in a header as well for
			// ease of extraction in clients.
			apiUtils::setHeader( $res, 'content-revision-id', $oldid );
		} else {
			Assert::invariant( false, 'Should be unreachable' );
		}

		if ( $metrics ) {
			$mstr = ( $envOptions->pageWithOldid ) ? 'pageWithOldid' : 'wt';
			$metrics->endTiming( "wt2html.{$mstr}.init", $startTimers->get( 'wt2html.init' ) );
			$startTimers->set( "wt2html.{$mstr}.parse", time() );
		}

		$out = /* await */ $parse( [
				'input' => $wikitext,
				'mode' => 'wt2html',
				'parsoidOptions' => $parsoidOptions,
				'envOptions' => $envOptions,
				'oldid' => $oldid,
				'contentmodel' => $opts->contentmodel,
				'outputContentVersion' => $env->outputContentVersion,
				'body_only' => $res->locals->body_only,
				'cacheConfig' => true,
				'reuseExpansions' => $reuseExpansions,
				'pagelanguage' => $res->locals->pagelanguage
			]
		);
		if ( $opts->format === 'lint' ) {
			apiUtils::jsonResponse( $res, $out->lint );
		} else {
			apiUtils::wt2htmlRes( $res, $out->html, $out->pb, $out->contentmodel, $out->headers, $env->outputContentVersion );
		}
		$html = $out->html;
		if ( $metrics ) {
			if ( $startTimers->has( 'wt2html.wt.parse' ) ) {
				$metrics->endTiming(
					'wt2html.wt.parse', $startTimers->get( 'wt2html.wt.parse' )
				);
				$metrics->timing( 'wt2html.wt.size.output', count( $metrics ) );
			} elseif ( $startTimers->has( 'wt2html.pageWithOldid.parse' ) ) {
				$metrics->endTiming(
					'wt2html.pageWithOldid.parse',
					$startTimers->get( 'wt2html.pageWithOldid.parse' )
				);
				$metrics->timing( 'wt2html.pageWithOldid.size.output', count( $metrics ) );
			}
			$metrics->endTiming( 'wt2html.total', $startTimers->get( 'wt2html.total' ) );
		}
	};

	$html2wt = /* async */function ( $req, $res, $html ) use ( &$apiUtils, &$metrics, &$DOMUtils, &$semver, &$DOMDataUtils, &$ContentUtils, &$parsoidConfig, &$parse, &$parsoidOptions ) {
		$env = $res->locals->env;
		$opts = $res->locals->opts;

		$envOptions = Object::assign( [
				'scrubWikitext' => apiUtils::shouldScrub( $req, $env->scrubWikitext )
			], $res->locals->envOptions
		);

		// Performance Timing options
		// Performance Timing options
		$startTimers = new Map();

		if ( $metrics ) {
			$startTimers->set( 'html2wt.init', time() );
			$startTimers->set( 'html2wt.total', time() );
			$startTimers->set( 'html2wt.init.domparse', time() );
		}

		$doc = DOMUtils::parseHTML( $html );

		// send domparse time, input size and init time to statsd/Graphite
		// init time is the time elapsed before serialization
		// init.domParse, a component of init time, is the time elapsed
		// from html string to DOM tree
		// send domparse time, input size and init time to statsd/Graphite
		// init time is the time elapsed before serialization
		// init.domParse, a component of init time, is the time elapsed
		// from html string to DOM tree
		if ( $metrics ) {
			$metrics->endTiming( 'html2wt.init.domparse',
				$startTimers->get( 'html2wt.init.domparse' )
			);
			$metrics->timing( 'html2wt.size.input', count( $metrics ) );
			$metrics->endTiming( 'html2wt.init', $startTimers->get( 'html2wt.init' ) );
		}

		$original = $opts->original;
		$oldBody = null;
$origPb = null;

		// Get the content version of the edited doc, if available
		// Get the content version of the edited doc, if available
		$vEdited = DOMUtils::extractInlinedContentVersion( $doc );

		// Check for version mismatches between original & edited doc
		// Check for version mismatches between original & edited doc
		if ( !( $original && $original->html ) ) {
			$env->inputContentVersion = $vEdited || $env->inputContentVersion;
		} else {
			$vOriginal = apiUtils::versionFromType( $original->html );
			if ( $vOriginal === null ) {
				return apiUtils::fatalRequest( $env, 'Content-type of original html is missing.', 400 );
			}
			if ( $vEdited === null ) {
				// If version of edited doc is unavailable we assume
				// the edited doc is derived from the original doc.
				// No downgrade necessary
				$env->inputContentVersion = $vOriginal;
			} elseif ( $vEdited === $vOriginal ) {
				// No downgrade necessary
				$env->inputContentVersion = $vOriginal;
			} else {
				$env->inputContentVersion = $vEdited;
				// We need to downgrade the original to match the the edited doc's version.
				// We need to downgrade the original to match the the edited doc's version.
				$downgrade = apiUtils::findDowngrade( $vOriginal, $vEdited );
				if ( $downgrade && $opts->from === 'pagebundle' ) { // Downgrades are only for pagebundle
					$oldDoc = null;
					( ( ( function () use ( &$apiUtils, &$downgrade, &$metrics, &$env, &$original, &$vOriginal ) { $temp0 = apiUtils::doDowngrade( $downgrade, $metrics, $env, $original, $vOriginal );
$oldDoc = $temp0->doc;
$origPb = $temp0->pb;
return null;
		   } ) )() );
					$oldBody = $oldDoc->body;
				} else {
					return apiUtils::fatalRequest( $env,
						"Modified ({$vEdited}) and original ({$vOriginal}) html are of different type, and no path to downgrade.",
						400
					);
				}
			}
		}

		if ( $metrics ) {
			$ver = ( $env->hasOwnProperty( 'inputContentVersion' ) ) ? $env->inputContentVersion : 'default';
			$metrics->increment( 'html2wt.original.version.' . $ver );
			if ( !$vEdited ) { $metrics->increment( 'html2wt.original.version.notinline' );
   }
		}

		// Pass along the determined original version to the worker
		// Pass along the determined original version to the worker
		$envOptions->inputContentVersion = $env->inputContentVersion;

		$pb = null;

		// If available, the modified data-mw blob is applied, while preserving
		// existing inline data-mw.  But, no data-parsoid application, since
		// that's internal, we only expect to find it in its original,
		// unmodified form.
		// If available, the modified data-mw blob is applied, while preserving
		// existing inline data-mw.  But, no data-parsoid application, since
		// that's internal, we only expect to find it in its original,
		// unmodified form.
		if ( $opts->from === 'pagebundle' && $opts[ 'data-mw' ]
&& semver::satisfies( $env->inputContentVersion, '^999.0.0' )
		) {
			// `opts` isn't a revision, but we'll find a `data-mw` there.
			$pb = apiUtils::extractPageBundle( $opts );
			$pb->parsoid = [ 'ids' => [] ]; // So it validates
			// So it validates
			apiUtils::validatePageBundle( $pb, $env->inputContentVersion );
			DOMDataUtils::applyPageBundle( $doc, $pb );
		}

		$oldhtml = null;
		$oldtext = null;

		if ( $original ) {
			if ( $opts->from === 'pagebundle' ) {
				// Apply the pagebundle to the parsed doc.  This supports the
				// simple edit scenarios where data-mw might not necessarily
				// have been retrieved.
				if ( !$origPb ) { $origPb = apiUtils::extractPageBundle( $original );
	   }
				$pb = $origPb;
				// However, if a modified data-mw was provided,
				// original data-mw is omitted to avoid losing deletions.
				// However, if a modified data-mw was provided,
				// original data-mw is omitted to avoid losing deletions.
				if ( $opts[ 'data-mw' ]
&& semver::satisfies( $env->inputContentVersion, '^999.0.0' )
				) {
					// Don't modify `origPb`, it's used below.
					$pb = [ 'parsoid' => $pb->parsoid, 'mw' => [ 'ids' => [] ] ];
				}
				apiUtils::validatePageBundle( $pb, $env->inputContentVersion );
				DOMDataUtils::applyPageBundle( $doc, $pb );

				// TODO(arlolra): data-parsoid is no longer versioned
				// independently, but we leave this for backwards compatibility
				// until content version <= 1.2.0 is deprecated.  Anything new
				// should only depend on `env.inputContentVersion`.
				// TODO(arlolra): data-parsoid is no longer versioned
				// independently, but we leave this for backwards compatibility
				// until content version <= 1.2.0 is deprecated.  Anything new
				// should only depend on `env.inputContentVersion`.
				$envOptions->dpContentType = ( $original[ 'data-parsoid' ]->headers || [] )[ 'content-type' ];
			}

			// If we got original src, set it
			// If we got original src, set it
			if ( $original->wikitext ) {
				// Don't overwrite env.page.meta!
				$oldtext = $original->wikitext->body;
			}

			// If we got original html, parse it
			// If we got original html, parse it
			if ( $original->html ) {
				if ( !$oldBody ) { $oldBody = DOMUtils::parseHTML( $original->html->body )->body;
	   }
				if ( $opts->from === 'pagebundle' ) {
					apiUtils::validatePageBundle( $origPb, $env->inputContentVersion );
					DOMDataUtils::applyPageBundle( $oldBody->ownerDocument, $origPb );
				}
				$oldhtml = ContentUtils::toXML( $oldBody );
			}
		}

		// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
		//   "Both it and the oldid parameter are needed for
		//    clean round-tripping of HTML retrieved earlier with"
		// So, no oldid => no selser
		// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
		//   "Both it and the oldid parameter are needed for
		//    clean round-tripping of HTML retrieved earlier with"
		// So, no oldid => no selser
		$hasOldId = (bool)$res->locals->oldid;
		$useSelser = $hasOldId && $parsoidConfig->useSelser;

		$selser = null;
		if ( $useSelser ) {
			$selser = [ 'oldtext' => $oldtext, 'oldhtml' => $oldhtml ];
		}

		$out = /* await */ $parse( [
				'input' => ContentUtils::toXML( $doc ),
				'mode' => ( $useSelser ) ? 'selser' : 'html2wt',
				'parsoidOptions' => $parsoidOptions,
				'envOptions' => $envOptions,
				'oldid' => $res->locals->oldid,
				'selser' => $selser,
				'contentmodel' => $opts->contentmodel
|| ( $opts->original && $opts->original->contentmodel ),
				'cacheConfig' => true
			]
		);
		if ( $metrics ) {
			$metrics->endTiming(
				'html2wt.total', $startTimers->get( 'html2wt.total' )
			);
			$metrics->timing( 'html2wt.size.output', count( $metrics ) );
		}
		apiUtils::plainResponse(
			$res, $out->wt, null, apiUtils::wikitextContentType( $env )
		);
	};

	$languageConversion = /* async */function ( $res, $revision, $contentmodel ) use ( &$apiUtils, &$TemplateRequest, &$parse, &$parsoidOptions ) {
		$env = $res->locals->env;
		$opts = $res->locals->opts;

		$target = $opts->updates->variant->target || $res->locals->envOptions->htmlVariantLanguage;
		$source = $opts->updates->variant->source;

		if ( gettype( $target ) !== 'string' ) {
			return apiUtils::fatalRequest( $env, 'Target variant is required.', 400 );
		}
		if ( !( $source === null || $source === null || gettype( $source ) === 'string' ) ) {
			return apiUtils::fatalRequest( $env, 'Bad source variant.', 400 );
		}

		$pb = apiUtils::extractPageBundle( $revision );
		// We deliberately don't validate the page bundle, since language
		// conversion can be done w/o data-parsoid or data-mw

		// XXX handle x-roundtrip
		// env.htmlVariantLanguage = target;
		// env.wtVariantLanguage = source;
		// We deliberately don't validate the page bundle, since language
		// conversion can be done w/o data-parsoid or data-mw

		// XXX handle x-roundtrip
		// env.htmlVariantLanguage = target;
		// env.wtVariantLanguage = source;

		if ( $res->locals->pagelanguage ) {
			$env->page->pagelanguage = $res->locals->pagelanguage;
		} elseif ( $revision->revid ) {
			// fetch pagelanguage from original pageinfo
			/* await */ TemplateRequest::setPageSrcInfo( $env, $revision->title, $revision->revid );
		} else {
			return apiUtils::fatalRequest( $env, 'Unknown page language.', 400 );
		}

		if ( $env->langConverterEnabled() ) {
			$temp1 = /* await */ $parse( [
					'input' => $revision->html->body,
					'mode' => 'variant',
					'parsoidOptions' => $parsoidOptions,
					'envOptions' => $res->locals->envOptions,
					'oldid' => $res->locals->oldid,
					'contentmodel' => $contentmodel,
					'body_only' => $res->locals->body_only,
					'cacheConfig' => true,
					'pagelanguage' => $env->page->pagelanguage,
					'variant' => [ 'source' => $source, 'target' => $target ]
				]
			);
$html = $temp1->html;
$headers = $temp1->headers;

			// Since this an update, return the `inputContentVersion` as the `outputContentVersion`
			// Since this an update, return the `inputContentVersion` as the `outputContentVersion`
			apiUtils::wt2htmlRes( $res, $html, $pb, $contentmodel, $headers, $env->inputContentVersion );
		} else {
			// Return 400 if you request LanguageConversion for a page which
			// didn't set `Vary: Accept-Language`.
			$err = new Error( 'LanguageConversion is not enabled on this article.' );
			$err->httpStatus = 400;
			$err->suppressLoggingStack = true;
			throw $err;
		}
	};

	/**
	 * Update red links on a document.
	 *
	 * @param {Response} res
	 * @param {Object} revision
	 * @param {string} [contentmodel]
	 */
	$updateRedLinks = /* async */function ( $res, $revision, $contentmodel ) use ( &$apiUtils, &$parsoidConfig, &$parse, &$parsoidOptions ) {
		$env = $res->locals->env;

		$pb = apiUtils::extractPageBundle( $revision );
		apiUtils::validatePageBundle( $pb, $env->inputContentVersion );

		if ( $parsoidConfig->useBatchAPI ) {
			$temp2 = /* await */ $parse( [
					'input' => $revision->html->body,
					'mode' => 'redlinks',
					'parsoidOptions' => $parsoidOptions,
					'envOptions' => $res->locals->envOptions,
					'oldid' => $res->locals->oldid,
					'contentmodel' => $contentmodel,
					'body_only' => $res->locals->body_only,
					'cacheConfig' => true
				]
			);
$html = $temp2->html;
$headers = $temp2->headers;

			// Since this an update, return the `inputContentVersion` as the `outputContentVersion`
			// Since this an update, return the `inputContentVersion` as the `outputContentVersion`
			apiUtils::wt2htmlRes( $res, $html, $pb, $contentmodel, $headers, $env->inputContentVersion );
		} else {
			$err = new Error( 'Batch API is not enabled.' );
			$err->httpStatus = 500;
			$err->suppressLoggingStack = true;
			throw $err;
		}
	};

	$pb2pb = /* async */function ( $req, $res ) use ( &$apiUtils, &$metrics, &$updateRedLinks, &$languageConversion, &$semver, &$DOMUtils, &$DOMDataUtils, &$ContentUtils, &$wt2html ) { // eslint-disable-line require-yield
		$env = $res->locals->env;
		$opts = $res->locals->opts;

		$revision = $opts->previous || $opts->original;
		if ( !$revision || !$revision->html ) {
			return apiUtils::fatalRequest( $env, 'Missing revision html.', 400 );
		}

		$env->inputContentVersion = apiUtils::versionFromType( $revision->html );
		if ( $env->inputContentVersion === null ) {
			return apiUtils::fatalRequest( $env, 'Content-type of revision html is missing.', 400 );
		}
		if ( $metrics ) {
			$metrics->increment( 'pb2pb.original.version.' . $env->inputContentVersion );
		}

		$contentmodel = ( $revision && $revision->contentmodel );

		if ( $opts->updates && ( $opts->updates->redlinks || $opts->updates->variant ) ) {
			// If we're only updating parts of the original version, it should
			// satisfy the requested content version, since we'll be returning
			// that same one.
			// FIXME: Since this endpoint applies the acceptable middleware,
			// `env.inputContentVersion` is not what's been passed in, but what
			// can be produced.  Maybe that should be selectively applied so
			// that we can update older versions where it makes sense?
			// Uncommenting below implies that we can only update the latest
			// version, since carrot semantics is applied in both directions.
			// if (!semver.satisfies(env.inputContentVersion, '^' + env.outputContentVersion)) {
			// 	return apiUtils.fatalRequest(env, 'We do not know how to do this conversion.', 415);
			// }
			Assert::invariant( $revision === $opts->original );
			if ( $opts->updates->redlinks ) {
				// Q(arlolra): Should redlinks be more complex than a bool?
				// See gwicke's proposal at T114413#2240381
				return $updateRedLinks( $res, $revision, $contentmodel );
			} elseif ( $opts->updates->variant ) {
				return $languageConversion( $res, $revision, $contentmodel );
			}
			Assert::invariant( false, 'Should not be reachable.' );
		}

		// TODO(arlolra): subbu has some sage advice in T114413#2365456 that
		// we should probably be more explicit about the pb2pb conversion
		// requested rather than this increasingly complex fallback logic.
		// TODO(arlolra): subbu has some sage advice in T114413#2365456 that
		// we should probably be more explicit about the pb2pb conversion
		// requested rather than this increasingly complex fallback logic.

		$downgrade = apiUtils::findDowngrade( $env->inputContentVersion, $env->outputContentVersion );
		if ( $downgrade ) {
			Assert::invariant( $revision === $opts->original );
			return apiUtils::returnDowngrade( $downgrade, $metrics, $env, $revision, $res, $contentmodel );
			// Ensure we only reuse from semantically similar content versions.
		} else { // Ensure we only reuse from semantically similar content versions.
		if ( semver::satisfies( $env->outputContentVersion, '^' . $env->inputContentVersion ) ) {
			$doc = DOMUtils::parseHTML( $revision->html->body );
			$pb = apiUtils::extractPageBundle( $revision );
			apiUtils::validatePageBundle( $pb, $env->inputContentVersion );
			DOMDataUtils::applyPageBundle( $doc, $pb );
			$reuseExpansions = [
				'updates' => $opts->updates,
				'html' => ContentUtils::toXML( $doc )
			];
			// Kick off a reparse making use of old expansions
			// Kick off a reparse making use of old expansions
			return $wt2html( $req, $res, null, $reuseExpansions );
		} else {
			return apiUtils::fatalRequest( $env, 'We do not know how to do this conversion.', 415 );
		}
		}
	};

	// GET requests
	$routes->v3Get = /* async */function ( $req, $res ) use ( &$TemplateRequest, &$apiUtils, &$wt2html ) {
		$opts = $res->locals->opts;
		$env = $res->locals->env;

		if ( $opts->format === 'wikitext' ) {
			try {
				$target = $env->normalizeAndResolvePageTitle();
				$oldid = $res->locals->oldid;
				/* await */ TemplateRequest::setPageSrcInfo( $env, $target, $oldid );
				if ( !$oldid ) {
					return apiUtils::redirectToOldid( $req, $res );
				}
				if ( $env->page->meta && $env->page->meta->revision && $env->page->meta->revision->contentmodel ) {
					apiUtils::setHeader( $res, 'x-contentmodel', $env->page->meta->revision->contentmodel );
				}
				apiUtils::plainResponse( $res, $env->page->src, null, apiUtils::wikitextContentType( $env ) );
			} catch ( Exception $e ) {
				apiUtils::errorHandler( $env, $e );
			}
		} else {
			return apiUtils::errorWrapper( $env, $wt2html( $req, $res ) );
		}
	};

	// POST requests
	$routes->v3Post = /* async */function ( $req, $res ) use ( &$apiUtils, &$wt2html, &$html2wt, &$pb2pb ) { // eslint-disable-line require-yield
		$opts = $res->locals->opts;
		$env = $res->locals->env;

		if ( $opts->from === 'wikitext' ) {
			// Accept wikitext as a string or object{body,headers}
			$wikitext = $opts->wikitext;
			if ( gettype( $wikitext ) !== 'string' && $opts->wikitext ) {
				$wikitext = $opts->wikitext->body;
				// We've been given a pagelanguage for this page.
				// We've been given a pagelanguage for this page.
				if ( $opts->wikitext->headers && $opts->wikitext->headers[ 'content-language' ] ) {
					$res->locals->pagelanguage = $opts->wikitext->headers[ 'content-language' ];
				}
			}
			// We've been given source for this page
			// We've been given source for this page
			if ( gettype( $wikitext ) !== 'string' && $opts->original && $opts->original->wikitext ) {
				$wikitext = $opts->original->wikitext->body;
				// We've been given a pagelanguage for this page.
				// We've been given a pagelanguage for this page.
				if ( $opts->original->wikitext->headers && $opts->original->wikitext->headers[ 'content-language' ] ) {
					$res->locals->pagelanguage = $opts->original->wikitext->headers[ 'content-language' ];
				}
			}
			// Abort if no wikitext or title.
			// Abort if no wikitext or title.
			if ( gettype( $wikitext ) !== 'string' && $res->locals->titleMissing ) {
				return apiUtils::fatalRequest( $env, 'No title or wikitext was provided.', 400 );
			}
			return apiUtils::errorWrapper( $env, $wt2html( $req, $res, $wikitext ) );
		} else {
			if ( $opts->format === 'wikitext' ) {
				// html is required for serialization
				if ( $opts->html === null ) {
					return apiUtils::fatalRequest( $env, 'No html was supplied.', 400 );
				}
				// Accept html as a string or object{body,headers}
				// Accept html as a string or object{body,headers}
				$html = ( gettype( $opts->html ) === 'string' ) ?
				$opts->html : ( $opts->html->body || '' );
				return apiUtils::errorWrapper( $env, $html2wt( $req, $res, $html ) );
			} else {
				return apiUtils::errorWrapper( $env, $pb2pb( $req, $res ) );
			}
		}
	};

	return $routes;
};
