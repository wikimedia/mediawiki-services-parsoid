<?php
declare( strict_types = 1 );

namespace MWParsoid\Rest\Handler;

use Composer\Semver\Semver;
use Config;
use ConfigException;
use ExtensionRegistry;
use IBufferingStatsdDataFactory;
use LogicException;
use MediaWiki\MediaWikiServices;
use MediaWiki\Rest\Response;
use MediaWiki\Rest\Handler;
use MobileContext;
use MWParsoid\Config\DataAccess;
use MWParsoid\Config\PageConfigFactory;
use MWParsoid\Config\SiteConfig;
use MWParsoid\Rest\FormatHelper;
use Parsoid\Config\Env;
use MWParsoid\ParsoidServices;
use Parsoid\PageBundle;
use Parsoid\Parsoid;
use Parsoid\Selser;
use Parsoid\Tokens\Token;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Wt2Html\PegTokenizer;
use RequestContext;
use Title;
use Wikimedia\ParamValidator\ValidationException;

/**
 * Base class for Parsoid handlers.
 */
abstract class ParsoidHandler extends Handler {
	// TODO logging, metrics, timeouts(?), CORS
	// TODO content negotiation (routes.js routes.acceptable)
	// TODO handle MaxConcurrentCallsError (pool counter?)

	/** @var Config */
	protected $config;

	/** @var array Parsoid-specific settings array from $config */
	private $parsoidSettings;

	/** @var SiteConfig */
	protected $siteConfig;

	/** @var PageConfigFactory */
	protected $pageConfigFactory;

	/** @var DataAccess */
	protected $dataAccess;

	/** @var ExtensionRegistry */
	protected $extensionRegistry;

	/** @var IBufferingStatsdDataFactory */
	protected $statsdDataFactory;

	/** @var array */
	private $requestAttributes;

	/**
	 * @return static
	 */
	public static function factory(): ParsoidHandler {
		$services = MediaWikiServices::getInstance();
		$parsoidServices = new ParsoidServices( $services );
		return new static(
			$services->getMainConfig(),
			$parsoidServices->getParsoidSiteConfig(),
			$parsoidServices->getParsoidPageConfigFactory(),
			$parsoidServices->getParsoidDataAccess(),
			// FIXME this will prefix stats with 'MediaWiki.' which is probably unwanted
			$services->getStatsdDataFactory()
		);
	}

	/**
	 * @param Config $config
	 * @param SiteConfig $siteConfig
	 * @param PageConfigFactory $pageConfigFactory
	 * @param DataAccess $dataAccess
	 * @param IBufferingStatsdDataFactory $statsdDataFactory
	 */
	public function __construct(
		Config $config,
		SiteConfig $siteConfig,
		PageConfigFactory $pageConfigFactory,
		DataAccess $dataAccess,
		IBufferingStatsdDataFactory $statsdDataFactory
	) {
		$this->config = $config;
		try {
			$this->parsoidSettings = $this->config->get( 'ParsoidSettings' );
		} catch ( ConfigException $e ) {
			// If the config option isn't defined, use defaults
			$this->parsoidSettings = [];
		}
		$this->siteConfig = $siteConfig;
		$this->pageConfigFactory = $pageConfigFactory;
		$this->dataAccess = $dataAccess;
		$this->extensionRegistry = ExtensionRegistry::getInstance();
		$this->statsdDataFactory = $statsdDataFactory;
	}

	/**
	 * Verify that the {domain} path parameter matches the actual domain.
	 * @param string $domain Domain name parameter to validate
	 */
	protected function assertDomainIsCorrect( $domain ): void {
		// We are cutting some corners here (IDN, non-ASCII casing)
		// since domain name support is provisional.
		// TODO use a proper validator instead
		$wgServer = \RequestContext::getMain()->getConfig()->get( 'Server' );
		$expectedDomain = wfParseUrl( $wgServer )['host'] ?? null;
		if ( !$expectedDomain ) {
			throw new LogicException( 'Cannot parse $wgServer' );
		}
		if ( strcasecmp( $expectedDomain, $domain ) === 0 ) {
			return;
		}

		// TODO probably the better
		if ( $this->extensionRegistry->isLoaded( 'MobileFrontend' ) ) {
			$mobileServer = MobileContext::singleton()->getMobileUrl( $wgServer );
			$expectedMobileDomain = wfParseUrl( $mobileServer )['host'] ?? null;
			if ( strcasecmp( $expectedMobileDomain, $domain ) === 0 ) {
				return;
			}
		}

		throw new ValidationException( 'domain', $domain, [], 'mwparsoid-invalid-domain', [] );
	}

	/**
	 * Rough equivalent of req.local from Parsoid-JS.
	 * FIXME most of these should be replaced with more native ways of handling the request.
	 * @return array
	 */
	protected function &getRequestAttributes(): array {
		if ( $this->requestAttributes ) {
			return $this->requestAttributes;
		}

		// TODO validate format
		// Porting note: this is the equivalent of the v3Middle middleware.
		$request = $this->getRequest();
		$body = json_decode( $request->getBody()->getContents(), true ) ?? [];
		$opts = array_merge( $body, array_intersect_key( $request->getPathParams(),
			[ 'from' => true, 'format' => true ] ) );
		$attribs = [
			'titleMissing' => !isset( $request->getPathParams()['title'] ),
			'pageName' => $request->getPathParam( 'title' ) ?? null,
			'oldid' => $request->getPathParam( 'revision' ) ?? null,
			// "body_only" flag to return just the body (instead of the entire HTML doc)
			// We would like to deprecate use of this flag: T181657
			'body_only' => $request->getQueryParams()['body_only'] ?? $body['body_only'] ?? null,
			'errorEnc' => FormatHelper::ERROR_ENCODING[$opts['format']] ?? 'plain',
			'iwp' => wfWikiID(), // PORT-FIXME verify
			'subst' => (bool)( $request->getQueryParams()['subst'] ?? $body['subst'] ?? null ),
		];

		if ( !empty( $attribs['subst'] ) && $opts['format'] !== FormatHelper::FORMAT_HTML ) {
			// FIXME use validation
			throw new LogicException( 'Substitution is only supported for the HTML format.' );
		}

		if ( $request->getMethod() === 'POST' ) {
			if ( isset( $opts['original']['revid'] ) ) {
				$attribs['oldid'] = $opts['original']['revid'];
			}
			if ( isset( $opts['original']['title'] ) ) {
				$attribs['titleMissing'] = false;
				$attribs['pageName'] = $opts['original']['title'];
			}
		}

		$attribs['envOptions'] = [
			// We use `prefix` but ought to use `domain` (T206764)
			'prefix' => $attribs['iwp'],
			'domain' => $request->getPathParam( 'domain' ),
			'pageName' => $attribs['pageName'],
			'cookie' => $request->getHeaderLine( 'Cookie' ),
			'reqId' => $request->getHeaderLine( 'X-Request-Id' ),
			'userAgent' => $request->getHeaderLine( 'User-Agent' ),
			'htmlVariantLanguage' => $request->getHeaderLine( 'Accept-Language' ) ?: null,
		];
		$attribs['opts'] = $opts;

		$this->assertDomainIsCorrect( $attribs['envOptions']['domain'] );

		$this->requestAttributes = $attribs;
		return $this->requestAttributes;
	}

	/**
	 * @param string|null $title The page to be transformed
	 * @param int|null $revision The revision to be transformed
	 * @return Env
	 */
	protected function createEnv( ?string $title, ?int $revision ): Env {
		$title = !is_null( $title ) ? Title::newFromText( $title ) : Title::newMainPage();
		if ( !$title ) {
			// TODO use proper validation
			throw new LogicException( 'Title not found!' );
		}
		$user = RequestContext::getMain()->getUser();
		$pageConfig = $this->pageConfigFactory->create( $title, $user, $revision );
		$options = [];
		foreach ( [ 'wrapSections', 'scrubWikitext', 'traceFlags', 'dumpFlags' ] as $opt ) {
			if ( isset( $this->parsoidSettings[$opt] ) ) {
				$options[$opt] = $this->parsoidSettings[$opt];
			}
		}
		return new Env( $this->siteConfig, $pageConfig, $this->dataAccess, $options );
	}

	/**
	 * To support the 'subst' API parameter, we need to prefix each
	 * top-level template with 'subst'. To make sure we do this for the
	 * correct templates, tokenize the starting wikitext and use that to
	 * detect top-level templates. Then, substitute each starting '{{' with
	 * '{{subst' using the template token's tsr.
	 *
	 * @param Env $env
	 * @param string $target The page being parsed
	 * @param string $wikitext
	 * @return string
	 */
	protected function substTopLevelTemplates( Env $env, $target, $wikitext ): string {
		$tokenizer = new PegTokenizer( $env );
		$tokens = $tokenizer->tokenizeSync( $wikitext );
		$tsrIncr = 0;
		foreach ( $tokens as $token ) {
			/** @var Token $token */
			if ( $token->getName() === 'template' ) {
				$tsr = $token->dataAttribs->tsr;
				$wikitext = substr( $wikitext, 0, $tsr[0] + $tsrIncr )
					. '{{subst:' . substr( $wikitext, $tsr[0] + $tsrIncr + 2 );
				$tsrIncr += 6;
			}
		}
		// Now pass it to the MediaWiki API with onlypst set so that it
		// subst's the templates.
		return $this->dataAccess->doPst( $env->getPageConfig(), $wikitext );
	}

	/**
	 * Redirect to another Parsoid URL (e.g. canonization)
	 * @param string $path Target URL
	 * @param array $queryParams Query parameters
	 * @return Response
	 */
	protected function createRedirectResponse( string $path, array $queryParams = [] ): Response {
		// porting note: this is  more or less the equivalent of apiUtils.redirect()

		// FIXME there should be a better way to do this
		global $wgRestPath;
		$path = wfExpandUrl( "$wgRestPath$path", PROTO_CURRENT );

		// FIXME this should not be necessary in the REST entry point
		unset( $queryParams['title'] );

		if ( $queryParams ) {
			$path .= ( strpos( $path, '?' ) === false ? '?' : '&' )
				. http_build_query( $queryParams, '', '&', PHP_QUERY_RFC3986 );
		}
		if ( $this->getRequest()->getMethod() === 'POST' ) {
			$response = $this->getResponseFactory()->createTemporaryRedirect( $path );
		} else {
			$response = $this->getResponseFactory()->createLegacyTemporaryRedirect( $path );
		}
		$response->setHeader( 'Cache-Control', 'private,no-cache,s-maxage=0' );
		return $response;
	}

	/**
	 * Expand the current URL with the latest revision number and redirect there.
	 * Will return an error response if the page does not exist.
	 * @param Env $env
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @return Response
	 */
	protected function createRedirectToOldidResponse( Env $env, array $attribs ): Response {
		// porting note: this is  more or less the equivalent of apiUtils.redirectToOldid()
		$domain = $this->getRequestAttributes()['envOptions']['domain'];
		$format = $this->getRequest()->getPathParam( 'format' );
		$target = $env->getPageConfig()->getTitle();
		$encodedTarget = PHPUtils::encodeURIComponent( $target );
		$revid = $env->getPageConfig()->getRevisionId();

		if ( $revid === null ) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => 'Page not found.',
			] );
		}

		$env->log( 'info', 'redirecting to revision', $revid, 'for', $format );
		$this->statsdDataFactory->increment( 'redirectToOldid.' . $format );

		if ( $this->getRequest()->getMethod() === 'POST' ) {
			$from = $this->getRequest()->getPathParam( 'from' );
			$newPath = "/$domain/v3/transform/$from/to/$format/$encodedTarget/$revid";
		} else {
			$newPath = "/$domain/v3/page/$format/$encodedTarget/$revid";
		}
		return $this->createRedirectResponse( $newPath, $this->getRequest()->getQueryParams() );
	}

	/**
	 * Wikitext -> HTML helper.
	 * Porting note: this is the rough equivalent of routes.wt2html.
	 * Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.
	 * @param Env $env
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @param string|null $wikitext Wikitext to transform (or null to use the page specified in
	 *   the request attributes).
	 * @return Response
	 */
	protected function wt2html( Env $env, array $attribs, string $wikitext = null ) {
		$request = $this->getRequest();
		$format = $attribs['opts']['format'];
		$oldid = $attribs['oldid'];

		$needsPageBundle = ( $format === FormatHelper::FORMAT_PAGEBUNDLE );
		$doSubst = ( $wikitext !== null && $attribs['subst'] );

		// Performance Timing options
		// init refers to time elapsed before parsing begins
		$startTimers = [
			'wt2html.init' => time(),
			'wt2html.total' => time(),
		];
		if ( Semver::satisfies( $env->getOutputContentVersion(),
			'!=' . ENV::AVAILABLE_VERSIONS[0] ) ) {
			$this->statsdDataFactory->increment( 'wt2html.parse.version.notdefault' );
		}

		if ( $wikitext === null && !$oldid ) {
			// Redirect to the latest revid
			return $this->createRedirectToOldidResponse( $env, $attribs );
		}

		if ( $doSubst ) {
			$wikitext = $this->substTopLevelTemplates( $env, $attribs['pageName'], $wikitext );
		}

		if ( !empty( $this->parsoidSettings['devAPI'] ) &&
			( $request->getQueryParams()['follow_redirects'] ?? false ) ) {
			$content = $env->getPageConfig()->getRevisionContent();
			$redirectTarget = $content ? $content->getRedirectTarget() : null;
			if ( $redirectTarget ) {
				$redirectInfo =
					$redirectTarget ? $this->dataAccess->getPageInfo( $env->getPageConfig(),
						[ $redirectTarget ] ) : null;
				$encodedTarget = PHPUtils::encodeURIComponent( $redirectTarget );
				$redirectPath =
					"/{$attribs['envOptions']['domain']}/v3/page/$encodedTarget/wikitext";
				if ( $redirectInfo['revId'] ) {
					$redirectPath .= '/' . $redirectInfo['revId'];
				}
				$env->log( 'info', 'redirecting to ', $redirectPath );
				$this->createRedirectResponse( "", $request->getQueryParams() );
			}
		}

		$reqOpts = array_merge( [
			'pageBundle' => $needsPageBundle,
			// When substing, set data-parsoid to be discarded, so that the subst'ed
			// content is considered new when it comes back.
			'discardDataParsoid' => $doSubst,
			'outputVersion' => $env->getOutputContentVersion(),
		], $attribs['envOptions'] );

		// VE, the only client using body_only property,
		// doesn't want section tags when this flag is set.
		// (T181226)
		if ( $attribs['body_only'] ) {
			$reqOpts['wrapSections'] = false;
			$reqOpts['bodyOnly'] = true;
		}

		if ( $wikitext !== null && $oldid ) {
			$reqOpts['pageWithOldid'] = true;
		}

		if ( $format === FormatHelper::FORMAT_LINT ) {
			$reqOpts['lint'] = true;
		}

		$mstr = !empty( $reqOpts['pageWithOldid'] ) ? 'pageWithOldid' : 'wt';
		$this->statsdDataFactory->timing( "wt2html.$mstr.init", time() - $startTimers['wt2html.init'] );
		$startTimers["wt2html.$mstr.parse"] = time();

		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );
		// PORT-FIXME where does $wikitext go?
		$pageBundle = $parsoid->wikitext2html( $env->getPageConfig(), $reqOpts );
		if ( $format === FormatHelper::FORMAT_LINT ) {
			// If linting, $pageBundle is actually an array of linting results
			$response = $this->getResponseFactory()->createJson( $pageBundle );
		} else {
			if ( $needsPageBundle ) {
				$responseData = [
					'contentmodel' => '',
					'html' => [
						'headers' => [
							'content-type' => 'text/html; charset=utf-8; '
								. 'profile="https://www.mediawiki.org/wiki/Specs/HTML/'
								. $env->getOutputContentVersion() . '"',
							// PORT-FIXME out.headers?
						],
						'body' => $pageBundle->html,
					],
					'data-parsoid' => [
						'headers' => [
							'content-type' => 'application/json; charset=utf-8; '
								. 'profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/'
								. $env->getOutputContentVersion() . '"',
						],
						'body' => $pageBundle->parsoid,
					],
				];
				if ( Semver::satisfies( $env->getOutputContentVersion(), '^999.0.0' ) ) {
					$responseData['data-mw'] = [
						'headers' => [
							'content-type' => 'application/json; charset=utf-8; ' .
								'profile="https://www.mediawiki.org/wiki/Specs/data-mw/' .
								$env->getOutputContentVersion() . '"',
						],
						'body' => $pageBundle->mw,
					];
				}
				$response = $this->getResponseFactory()->createJson( $responseData );
				FormatHelper::setContentType( $response, FormatHelper::FORMAT_PAGEBUNDLE,
					$env->getOutputContentVersion() );
			} else {
				$response = $this->getResponseFactory()->create();
				FormatHelper::setContentType( $response, FormatHelper::FORMAT_HTML,
					$env->getOutputContentVersion() );
				$response->getBody()->write( $pageBundle->html );

				// FIXME Parsoid-JS only does this when out.headers is empty. We have no out, though.
				$response->setHeader( 'Content-Language', 'en' );
				$response->addHeader( 'Vary', 'Accept' );
			}
		}

		$this->statsdDataFactory->timing( "wt2html.$mstr.parse",
			time() - $startTimers["wt2html.$mstr.parse"] );
		$this->statsdDataFactory->timing( "wt2html.$mstr.size.output", $response->getBody()->getSize() );
		$this->statsdDataFactory->timing( 'wt2html.total', time() - $startTimers['wt2html.total'] );

		if ( $wikitext !== null ) {
			// Don't cache requests when wt is set in case somebody uses
			// GET for wikitext parsing
			$response->setHeader( 'Cache-Control', 'private,no-cache,s-maxage=0' );
		} elseif ( $oldid ) {
			// FIXME this should be handled in core (cf OutputPage::sendCacheControl)
			if ( $request->getHeaderLine( 'Cookie' ) ||
				$request->getHeaderLine( 'Authorization' ) ) {
				// Don't cache requests with a session.
				$response->setHeader( 'Cache-Control', 'private,no-cache,s-maxage=0' );
			}
			// Indicate the MediaWiki revision in a header as well for
			// ease of extraction in clients.
			$response->setHeader( 'Content-Revision-Id', $oldid );
		} else {
			throw new LogicException( 'Should be unreachable' );
		}
		return $response;
	}

	/**
	 * HTML -> wikitext helper.
	 * Porting note: this is the rough equivalent of routes.html2wt.
	 * @param Env $env
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @param string|null $html HTMLto transform (or null to use the page specified in
	 *   the request attributes).
	 * @return Response
	 */
	protected function html2wt( Env $env, array $attribs, string $html = null ) {
		$request = $this->getRequest();
		$opts = $attribs['opts'];
		// FIXME make this accept JSON properties and handle via the validation framework
		$scrubWikitext = $request->getPostParams()['scrub_wikitext']
			?? $request->getQueryParams()['scrub_wikitext']
			?? $request->getPostParams()['scrubWikitext']
			?? $request->getQueryParams()['scrubWikitext']
			?? $this->parsoidSettings['scrubWikitext']
			?? false;
		$envOptions = array_merge( [
			'scrubWikitext' => $scrubWikitext,
		], $attribs['envOptions'] );

		// Performance Timing options
		$startTimers = [
			'html2wt.init' => time(),
			'html2wt.total' => time(),
			'html2wt.init.domparse' => time(),
		];

		$doc = DOMUtils::parseHTML( $html );

		// send domparse time, input size and init time to statsd/Graphite
		// init time is the time elapsed before serialization
		// init.domParse, a component of init time, is the time elapsed
		// from html string to DOM tree
		$this->statsdDataFactory->timing( 'html2wt.init.domparse',
			time() - $startTimers['html2wt.init.domparse'] );
		$this->statsdDataFactory->timing( 'html2wt.size.input', strlen( $html ) );
		$this->statsdDataFactory->timing( 'html2wt.init', time() - $startTimers['html2wt.init'] );

		$original = $opts['original'] ?? null;
		$oldBody = null;
		$origPb = null;

		// Get the content version of the edited doc, if available
		$vEdited = DOMUtils::extractInlinedContentVersion( $doc );

		// Check for version mismatches between original & edited doc
		if ( !isset( $original['html'] ) ) {
			$env->setInputContentVersion( $vEdited ?? $env->getInputContentVersion() );
		} else {
			$vOriginal = FormatHelper::parseContentTypeHeader(
				$original['html']['headers']['content-type'] ?? '' );
			if ( $vOriginal === null ) {
				$env->log( 'fatal/request', 'Content-type of original html is missing.' );
				return $this->getResponseFactory()->createHttpError( 400, [
					'message' => 'Content-type of original html is missing.',
				] );
			}
			if ( $vEdited === null ) {
				// If version of edited doc is unavailable we assume
				// the edited doc is derived from the original doc.
				// No downgrade necessary
				$env->setInputContentVersion( $vOriginal );
			} elseif ( $vEdited === $vOriginal ) {
				// No downgrade necessary
				$env->setInputContentVersion( $vOriginal );
			} else {
				$env->setInputContentVersion( $vEdited );
				// We need to downgrade the original to match the the edited doc's version.
				$downgrade = FormatHelper::findDowngrade( $vOriginal, $vEdited );
				// Downgrades are only for pagebundle
				if ( $downgrade && $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE ) {
					$this->statsdDataFactory->increment(
						"downgrade.from.{$downgrade['from']}.to.${$downgrade['to']}" );
					$oldDoc = $env->createDocument( $original['html']['body'] );
					$origPb = new PageBundle( '', $original['data-parsoid']['body'] ?? null,
						$original['data-mw']['body'] ?? null );
					if ( !$origPb->validate( $vOriginal, $errorMessage ) ) {
						return $this->getResponseFactory()->createHttpError( 400,
							[ 'message' => $errorMessage ] );
					}
					$downgradeStart = microtime( true );
					FormatHelper::downgrade( $downgrade['from'], $downgrade['to'], $oldDoc, $origPb );
					$this->statsdDataFactory->timing( 'downgrade.time', microtime( true ) - $downgradeStart );
					$oldBody = DOMCompat::getBody( $oldDoc );
				} else {
					$err = "Modified ({$vEdited}) and original ({$vOriginal}) html are of "
						. 'different type, and no path to downgrade.';
					$env->log( 'fatal/request', $err );
					return $this->getResponseFactory()->createHttpError( 400, [ 'message' => $err ] );
				}
			}
		}

		$this->statsdDataFactory->increment( 'html2wt.original.version.'
			. $env->getInputContentVersion() );
		if ( !$vEdited ) {
			$this->statsdDataFactory->increment( 'html2wt.original.version.notinline' );
		}

		$pb = new PageBundle( '', null, null );
		// If available, the modified data-mw blob is applied, while preserving
		// existing inline data-mw.  But, no data-parsoid application, since
		// that's internal, we only expect to find it in its original,
		// unmodified form.
		if ( $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE && isset( $opts[ 'data-mw' ] )
			&& Semver::satisfies( $env->getInputContentVersion(), '^999.0.0' )
		) {
			// `opts` isn't a revision, but we'll find a `data-mw` there.
			$pb = new PageBundle( '', $opts['data-parsoid']['body'] ?? null,
				$opts['data-mw']['body'] ?? null );
			$pb->parsoid = [ 'ids' => [] ]; // So it validates
			if ( !$pb->validate( $env->getInputContentVersion(), $errorMessage ) ) {
				return $this->getResponseFactory()->createHttpError( 400,
					[ 'message' => $errorMessage ] );
			}
			DOMDataUtils::applyPageBundle( $doc, $pb );
		}

		$oldhtml = null;
		$oldtext = null;

		if ( $original ) {
			if ( $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE ) {
				// Apply the pagebundle to the parsed doc.  This supports the
				// simple edit scenarios where data-mw might not necessarily
				// have been retrieved.
				if ( !$origPb ) {
					$origPb = new PageBundle( '', $original['data-parsoid']['body'] ?? null,
						$original['data-mw']['body'] ?? null );
				}
				$pb = $origPb;
				// However, if a modified data-mw was provided,
				// original data-mw is omitted to avoid losing deletions.
				if ( isset( $opts[ 'data-mw' ] )
					&& Semver::satisfies( $env->getInputContentVersion(), '^999.0.0' )
				) {
					// Don't modify `origPb`, it's used below.
					$pb = new PageBundle( '', $pb->parsoid, [ 'ids' => [] ] );
				}
				if ( !$pb->validate( $env->getInputContentVersion(), $errorMessage ) ) {
					return $this->getResponseFactory()->createHttpError( 400,
						[ 'message' => $errorMessage ] );
				}
				DOMDataUtils::applyPageBundle( $doc, $pb );

				// TODO(arlolra): data-parsoid is no longer versioned
				// independently, but we leave this for backwards compatibility
				// until content version <= 1.2.0 is deprecated.  Anything new
				// should only depend on `env.inputContentVersion`.
				$envOptions['dpContentType'] = $original[ 'data-parsoid' ]['headers'][ 'content-type' ] ?? null;
			}

			// If we got original src, set it
			if ( isset( $original['wikitext'] ) ) {
				// Don't overwrite env.page.meta!
				$oldtext = $original['wikitext']['body'];
			}

			// If we got original html, parse it
			if ( isset( $original['html'] ) ) {
				if ( !$oldBody ) {
					$oldBody = DOMCompat::getBody( DOMUtils::parseHTML( $original['html']['body'] ) );
				}
				if ( $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE ) {
					if ( !$origPb->validate( $env->getInputContentVersion(), $errorMessage ) ) {
						return $this->getResponseFactory()->createHttpError( 400,
							[ 'message' => $errorMessage ] );
					}
					DOMDataUtils::applyPageBundle( $oldBody->ownerDocument, $origPb );
				}
				$oldhtml = ContentUtils::toXML( $oldBody );
			}
		}

		// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
		//   "Both it and the oldid parameter are needed for
		//    clean round-tripping of HTML retrieved earlier with"
		// So, no oldid => no selser
		$hasOldId = (bool)$attribs['oldid'];
		$useSelser = $hasOldId && $oldtext !== null && !empty( $this->parsoidSettings['useSelser'] );
		$selser = null;
		if ( $useSelser ) {
			$selser = new Selser( $oldtext, $oldhtml );
		}

		$pb->html = ContentUtils::toXML( $doc );

		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );
		$wikitext = $parsoid->html2wikitext( $env->getPageConfig(), $pb, [
			// PORT-FIXME where do the rest of $envOptions go? where does the content model go?
			'scrubWikitext' => $envOptions['scrubWikitext'],
		], $selser );

		$this->statsdDataFactory->timing( 'html2wt.total', time() - $startTimers['html2wt.total'] );
		$this->statsdDataFactory->timing( 'html2wt.size.output', strlen( $wikitext ) );

		$response = $this->getResponseFactory()->create();
		FormatHelper::setContentType( $response, FormatHelper::FORMAT_WIKITEXT );
		$response->getBody()->write( $wikitext );
		return $response;
	}

	/**
	 * Pagebundle -> pagebundle helper.
	 * Porting note: this is the rough equivalent of routes.pb2pb.
	 * @param Env $env
	 * @param array $attribs
	 * @return Response
	 */
	protected function pb2pb( Env $env, array $attribs ) {
		throw new LogicException( 'Not implemented yet' );
	}

}
