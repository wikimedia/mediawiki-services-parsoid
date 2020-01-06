<?php
declare( strict_types = 1 );

namespace MWParsoid\Rest\Handler;

use Composer\Semver\Semver;
use Config;
use ConfigException;
use ExtensionRegistry;
use Liuggio\StatsdClient\Factory\StatsdDataFactoryInterface;
use LogicException;
use MediaWiki\MediaWikiServices;
use MediaWiki\Rest\Response;
use MediaWiki\Rest\Handler;
use MediaWiki\Rest\HttpException;
use MobileContext;
use MWParsoid\Config\PageConfigFactory;
use MWParsoid\Rest\FormatHelper;
use MWParsoid\ParsoidServices;
use Parsoid\ClientError;
use Parsoid\PageBundle;
use Parsoid\Parsoid;
use Parsoid\ResourceLimitExceededException;
use Parsoid\SelserData;
use Parsoid\Tokens\Token;
use Parsoid\Config\Env;
use Parsoid\Config\DataAccess;
use Parsoid\Config\PageConfig;
use Parsoid\Config\SiteConfig;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\Timing;
use Parsoid\Wt2Html\PegTokenizer;
use RequestContext;
use Title;
use UIDGenerator;
use Wikimedia\Http\HttpAcceptParser;
use Wikimedia\Message\DataMessageValue;
use Wikimedia\ParamValidator\ValidationException;

/**
 * Base class for Parsoid handlers.
 */
abstract class ParsoidHandler extends Handler {
	// TODO logging, timeouts(?), CORS
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

	/** @var StatsdDataFactoryInterface A statistics aggregator */
	protected $metrics;

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
			$parsoidServices->getParsoidDataAccess()
		);
	}

	/**
	 * @param Config $config
	 * @param SiteConfig $siteConfig
	 * @param PageConfigFactory $pageConfigFactory
	 * @param DataAccess $dataAccess
	 */
	public function __construct(
		Config $config,
		SiteConfig $siteConfig,
		PageConfigFactory $pageConfigFactory,
		DataAccess $dataAccess
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
		$this->metrics = $siteConfig->metrics();
	}

	/** @inheritDoc */
	public function checkPreconditions() {
		// Execute this since this sets up state
		// needed for other functionality.
		parent::checkPreconditions();

		// Disable precondition checks by ignoring the return value above.
		// Parsoid/JS doesn't implement these checks.
		// See https://phabricator.wikimedia.org/T238849#5683035 for a discussion.
		return null;
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

		throw new ValidationException(
			new DataMessageValue( 'mwparsoid-invalid-domain', [], 'invalid-domain', [
				'expected' => $expectedDomain,
				'actual' => $domain,
			] ),
			'domain', $domain, []
		);
	}

	/**
	 * Get the parsed body by content-type
	 *
	 * @return array
	 */
	protected function getParsedBody(): array {
		$request = $this->getRequest();
		list( $contentType ) = explode( ';', $request->getHeader( 'Content-Type' )[0] ?? '', 2 );
		switch ( $contentType ) {
			case 'application/x-www-form-urlencoded':
			case 'multipart/form-data':
				return $request->getPostParams();
			case 'application/json':
				return json_decode( $request->getBody()->getContents(), true );
			default:
				throw new HttpException( 'Unsupported Media Type', 415 );
		}
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

		// Porting note: this is the equivalent of the v3Middle middleware.
		$request = $this->getRequest();
		$body = ( $request->getMethod() === 'POST' ) ? $this->getParsedBody() : [];
		$opts = array_merge( $body, array_intersect_key( $request->getPathParams(),
			[ 'from' => true, 'format' => true ] ) );
		$attribs = [
			'titleMissing' => empty( $request->getPathParams()['title'] ),
			'pageName' => $request->getPathParam( 'title' ) ?? '',
			'oldid' => $request->getPathParam( 'revision' ) ?? null,
			// "body_only" flag to return just the body (instead of the entire HTML doc)
			// We would like to deprecate use of this flag: T181657
			'body_only' => $request->getQueryParams()['body_only'] ?? $body['body_only'] ?? null,
			'errorEnc' => FormatHelper::ERROR_ENCODING[$opts['format']] ?? 'plain',
			'iwp' => wfWikiID(), // PORT-FIXME verify
			'subst' => (bool)( $request->getQueryParams()['subst'] ?? $body['subst'] ?? null ),
			'scrubWikitext' => (bool)( $body['scrub_wikitext']
				?? $request->getQueryParams()['scrub_wikitext']
				?? $body['scrubWikitext']
				?? $request->getQueryParams()['scrubWikitext']
				?? false ),
			'offsetType' => $body['offsetType']
				?? $request->getQueryParams()['offsetType']
				// Lint requests should return UCS2 offsets by default
				?? ( $opts['format'] === FormatHelper::FORMAT_LINT ? 'ucs2' : 'byte' ),
			'pagelanguage' => $request->getHeaderLine( 'Content-Language' ) ?: null,
		];

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
			'scrubWikitext' => $attribs['scrubWikitext'],
			'offsetType' => $attribs['offsetType'],
			'cookie' => $request->getHeaderLine( 'Cookie' ),
			'reqId' => $request->getHeaderLine( 'X-Request-Id' ),
			'userAgent' => $request->getHeaderLine( 'User-Agent' ),
			'htmlVariantLanguage' => $request->getHeaderLine( 'Accept-Language' ) ?: null,
		];
		$attribs['opts'] = $opts;

		if ( empty( $this->parsoidSettings['debugApi'] ) ) {
			$this->assertDomainIsCorrect( $attribs['envOptions']['domain'] );
		}

		$this->requestAttributes = $attribs;
		return $this->requestAttributes;
	}

	/**
	 * FIXME: Combine with FormatHelper::parseContentTypeHeader
	 */
	const NEW_SPEC = '#^https://www.mediawiki.org/wiki/Specs/(HTML|pagebundle)/(\d+\.\d+\.\d+)$#D';

	/**
	 * Combines:
	 *  routes.acceptable
	 *  apiUtils.validateAndSetOutputContentVersion
	 *  apiUtils.parseProfile
	 *
	 * @param Env $env
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @return bool
	 */
	protected function acceptable( Env $env, array $attribs ): bool {
		$request = $this->getRequest();
		$format = $attribs['opts']['format'];

		if ( $format === FormatHelper::FORMAT_WIKITEXT ) {
			return true;
		}

		$acceptHeader = $request->getHeader( 'Accept' );
		if ( !$acceptHeader ) {
			return true;
		}

		$parser = new HttpAcceptParser();
		$acceptableTypes = $parser->parseAccept( $acceptHeader[0] );  // FIXME: Multiple headers valid?
		if ( !$acceptableTypes ) {
			return true;
		}

		// `acceptableTypes` is already sorted by quality.
		foreach ( $acceptableTypes as $t ) {
			$type = "{$t['type']}/{$t['subtype']}";
			$profile = $t['params']['profile'] ?? null;
			if (
				( $format === FormatHelper::FORMAT_HTML && $type === 'text/html' ) ||
				( $format === FormatHelper::FORMAT_PAGEBUNDLE && $type === 'application/json' )
			) {
				if ( $profile ) {
					preg_match( self::NEW_SPEC, $profile, $matches );
					if ( $matches && strtolower( $matches[1] ) === $format ) {
						$contentVersion = $env->resolveContentVersion( $matches[2] );
						if ( $contentVersion ) {
							$env->setOutputContentVersion( $contentVersion );
							return true;
						} else {
							continue;
						}
					} else {
						continue;
					}
				} else {
					return true;
				}
			} elseif (
				( $type === '*/*' ) ||
				( $format === FormatHelper::FORMAT_HTML && $type === 'text/*' )
			) {
				return true;
			}
		}

		return false;
	}

	/**
	 * @param string $title The page to be transformed
	 * @param int|null $revision The revision to be transformed
	 * @param string|null $wikitextOverride
	 *   Custom wikitext to use instead of the real content of the page.
	 * @param string|null $pagelanguageOverride
	 * @return PageConfig
	 */
	protected function createPageConfig(
		string $title, ?int $revision, string $wikitextOverride = null,
		string $pagelanguageOverride = null
	): PageConfig {
		$title = $title ? Title::newFromText( $title ) : Title::newMainPage();
		if ( !$title ) {
			// TODO use proper validation
			throw new LogicException( 'Title not found!' );
		}
		$user = RequestContext::getMain()->getUser();
		return $this->pageConfigFactory->create(
			$title, $user, $revision, $wikitextOverride, $pagelanguageOverride,
			$this->parsoidSettings
		);
	}

	/**
	 * @param string $title The page to be transformed
	 * @param int|null $revision The revision to be transformed
	 * @param bool $titleShouldExist return null if the title/revision doesn't
	 *   exist.
	 * @param string|null $wikitextOverride
	 *   Custom wikitext to use instead of the real content of the page.
	 * @param string|null $pagelanguageOverride
	 * @return Env|null
	 */
	protected function createEnv(
		string $title, ?int $revision, bool $titleShouldExist,
		string $wikitextOverride = null,
		string $pagelanguageOverride = null
	): ?Env {
		$pageConfig = $this->createPageConfig(
			$title, $revision, $wikitextOverride, $pagelanguageOverride
		);
		if ( $titleShouldExist && $pageConfig->getRevisionContent() === null ) {
			return null; // T234549
		}
		$options = [ 'titleShouldExist' => $titleShouldExist ];
		// NOTE: These settings are mostly ignored since this Env is only used
		// in this file.
		foreach ( [ 'traceFlags', 'dumpFlags' ] as $opt ) {
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
				$wikitext = substr( $wikitext, 0, $tsr->start + $tsrIncr )
					. '{{subst:' . substr( $wikitext, $tsr->start + $tsrIncr + 2 );
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
		$domain = $attribs['envOptions']['domain'];
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
		$this->metrics->increment( 'redirectToOldid.' . $format );

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
		$metrics = $this->metrics;
		$timing = Timing::start( $metrics );

		if ( Semver::satisfies( $env->getOutputContentVersion(),
			'!=' . ENV::AVAILABLE_VERSIONS[0] ) ) {
			$metrics->increment( 'wt2html.parse.version.notdefault' );
		}

		if ( $wikitext === null && !$oldid ) {
			// Redirect to the latest revid
			return $this->createRedirectToOldidResponse( $env, $attribs );
		}

		$pageConfig = $env->getPageConfig();

		if ( $doSubst ) {
			if ( $format !== FormatHelper::FORMAT_HTML ) {
				return $this->getResponseFactory()->createHttpError( 501, [
					'message' => 'Substitution is only supported for the HTML format.',
				] );
			}
			$wikitext = $this->substTopLevelTemplates( $env, $attribs['pageName'], $wikitext );
			$pageConfig = $this->createPageConfig(
				$attribs['pageName'], (int)$attribs['oldid'], $wikitext
			);
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
				return $this->createRedirectResponse( "", $request->getQueryParams() );
			}
		}

		$reqOpts = array_merge( [
			'pageBundle' => $needsPageBundle,
			// When substing, set data-parsoid to be discarded, so that the subst'ed
			// content is considered new when it comes back.
			'discardDataParsoid' => $doSubst,
			'outputContentVersion' => $env->getOutputContentVersion(),
		], $attribs['envOptions'] );

		// VE, the only client using body_only property,
		// doesn't want section tags when this flag is set.
		// (T181226)
		if ( $attribs['body_only'] ) {
			$reqOpts['wrapSections'] = false;
			$reqOpts['body_only'] = true;
		}

		if ( $wikitext === null && $oldid ) {
			$reqOpts['pageWithOldid'] = true;
		}

		// XXX: Not necessary, since it's in the pageConfig
		// if ( isset( $attribs['pagelanguage'] ) ) {
		// 	$reqOpts['pagelanguage'] = $attribs['pagelanguage'];
		// }

		$mstr = !empty( $reqOpts['pageWithOldid'] ) ? 'pageWithOldid' : 'wt';
		$timing->end( "wt2html.$mstr.init" );
		$metrics->timing(
			"wt2html.$mstr.size.input",
			# Should perhaps be strlen instead (or cached!): T239841
			mb_strlen( $env->getPageMainContent() )
		);
		$parseTiming = Timing::start( $metrics );

		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );

		if ( $format === FormatHelper::FORMAT_LINT ) {
			try {
				$lints = $parsoid->wikitext2lint( $pageConfig, $reqOpts );
			} catch ( ClientError $e ) {
				return $this->getResponseFactory()->createHttpError( 400, [
					'message' => $e->getMessage(),
				] );
			} catch ( ResourceLimitExceededException $e ) {
				return $this->getResponseFactory()->createHttpError( 413, [
					'message' => $e->getMessage(),
				] );
			}
			$response = $this->getResponseFactory()->createJson( $lints );
		} else {
			try {
				$out = $parsoid->wikitext2html(
					$pageConfig, $reqOpts, $headers
				);
			} catch ( ClientError $e ) {
				return $this->getResponseFactory()->createHttpError( 400, [
					'message' => $e->getMessage(),
				] );
			} catch ( ResourceLimitExceededException $e ) {
				return $this->getResponseFactory()->createHttpError( 413, [
					'message' => $e->getMessage(),
				] );
			}
			if ( $needsPageBundle ) {
				$response = $this->getResponseFactory()->createJson( $out->responseData() );
				FormatHelper::setContentType( $response, FormatHelper::FORMAT_PAGEBUNDLE,
					$out->version );
			} else {
				$response = $this->getResponseFactory()->create();
				FormatHelper::setContentType( $response, FormatHelper::FORMAT_HTML,
					$env->getOutputContentVersion() );
				$response->getBody()->write( $out );
				$response->setHeader( 'Content-Language', $headers['content-language'] );
				$response->addHeader( 'Vary', $headers['vary'] );
			}
			if ( $request->getMethod() === 'GET' ) {
				$tid = UIDGenerator::newUUIDv1();
				$response->addHeader( 'Etag', "W/\"{$oldid}/{$tid}\"" );
			}
		}

		$parseTiming->end( "wt2html.$mstr.parse" );
		$metrics->timing( "wt2html.$mstr.size.output", $response->getBody()->getSize() );
		$timing->end( 'wt2html.total' );

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
		$envOptions = $attribs['envOptions'];
		$metrics = $this->metrics;

		// Performance Timing options
		$timing = Timing::start( $metrics );

		$doc = DOMUtils::parseHTML( $html );

		// send domparse time, input size and init time to statsd/Graphite
		// init time is the time elapsed before serialization
		// init.domParse, a component of init time, is the time elapsed
		// from html string to DOM tree
		$timing->end( 'html2wt.init.domparse' );
		# Should perhaps be strlen instead (or cached!): T239841
		$metrics->timing( 'html2wt.size.input', mb_strlen( $html ) );
		$timing->end( 'html2wt.init' );

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
					$metrics->increment(
						"downgrade.from.{$downgrade['from']}.to.{$downgrade['to']}" );
					$oldDoc = $env->createDocument( $original['html']['body'] );
					$origPb = new PageBundle( '', $original['data-parsoid']['body'] ?? null,
						$original['data-mw']['body'] ?? null );
					if ( !$origPb->validate( $vOriginal, $errorMessage ) ) {
						return $this->getResponseFactory()->createHttpError( 400,
							[ 'message' => $errorMessage ] );
					}
					$downgradeTiming = Timing::start( $metrics );
					FormatHelper::downgrade( $downgrade['from'], $downgrade['to'], $oldDoc, $origPb );
					$downgradeTiming->end( 'downgrade.time' );
					$oldBody = DOMCompat::getBody( $oldDoc );
				} else {
					$err = "Modified ({$vEdited}) and original ({$vOriginal}) html are of "
						. 'different type, and no path to downgrade.';
					$env->log( 'fatal/request', $err );
					return $this->getResponseFactory()->createHttpError( 400, [ 'message' => $err ] );
				}
			}
		}

		$metrics->increment(
			'html2wt.original.version.' . $env->getInputContentVersion()
		);
		if ( !$vEdited ) {
			$metrics->increment( 'html2wt.original.version.notinline' );
		}

		// Pass along the determined original version
		$envOptions['inputContentVersion'] = $env->getInputContentVersion();

		// If available, the modified data-mw blob is applied, while preserving
		// existing inline data-mw.  But, no data-parsoid application, since
		// that's internal, we only expect to find it in its original,
		// unmodified form.
		if ( $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE && isset( $opts['data-mw'] )
			&& Semver::satisfies( $env->getInputContentVersion(), '^999.0.0' )
		) {
			// `opts` isn't a revision, but we'll find a `data-mw` there.
			$pb = new PageBundle( '',
				[ 'ids' => [] ],  // So it validates
				$opts['data-mw']['body'] ?? null );
			if ( !$pb->validate( $env->getInputContentVersion(), $errorMessage ) ) {
				return $this->getResponseFactory()->createHttpError( 400,
					[ 'message' => $errorMessage ] );
			}
			DOMDataUtils::applyPageBundle( $doc, $pb );
		}

		$oldhtml = null;

		if ( $original ) {
			if ( $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE ) {
				// Apply the pagebundle to the parsed doc.  This supports the
				// simple edit scenarios where data-mw might not necessarily
				// have been retrieved.
				if ( !$origPb ) {
					$origPb = new PageBundle( '', $original['data-parsoid']['body'] ?? null,
						$original['data-mw']['body'] ?? null );
				}

				// FIXME: This is a temporary protection while Parsoid/JS and
				// Parsoid/PHP are both in production.  Afterwards, we should
				// restore this as a 406.
				$offsetType = $envOptions['offsetType'] ?? 'byte';
				$origOffsetType = $origPb->parsoid['offsetType'] ?? '';
				if ( $origOffsetType !== $offsetType ) {
					return $this->getResponseFactory()->createHttpError( 421, [
						'message' => 'DSR offsetType mismatch: ' .
							$origOffsetType . ' vs ' . $offsetType,
					] );
				}

				$pb = $origPb;
				// However, if a modified data-mw was provided,
				// original data-mw is omitted to avoid losing deletions.
				if ( isset( $opts['data-mw'] )
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

		if ( $hasOldId && !empty( $this->parsoidSettings['useSelser'] ) ) {
			if ( !$env->getPageConfig()->getRevisionContent() ) {
				return $this->getResponseFactory()->createHttpError( 409, [
					'message' => 'Could not find previous revision. Has the page been locked / deleted?'
				] );
			}

			// FIXME: T234548/T234549 - $env->getPageMainContent() is deprecated:
			// should use $env->topFrame->getSrcText()
			$selserData = new SelserData( $env->getPageMainContent(), $oldhtml );
		} else {
			$selserData = null;
		}

		$html = ContentUtils::toXML( $doc );
		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );

		try {
			$wikitext = $parsoid->html2wikitext( $env->getPageConfig(), $html, [
				'scrubWikitext' => $envOptions['scrubWikitext'],
				'inputContentVersion' => $envOptions['inputContentVersion'],
				'offsetType' => $envOptions['offsetType'],
				'titleShouldExist' => $hasOldId
			], $selserData );
		} catch ( ClientError $e ) {
			return $this->getResponseFactory()->createHttpError( 400, [
				'message' => $e->getMessage(),
			] );
		} catch ( ResourceLimitExceededException $e ) {
			return $this->getResponseFactory()->createHttpError( 413, [
				'message' => $e->getMessage(),
			] );
		}

		$timing->end( 'html2wt.total' );
		# Should perhaps be strlen instead (or cached!): T239841
		$metrics->timing( 'html2wt.size.output', mb_strlen( $wikitext ) );

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
		$request = $this->getRequest();
		$opts = $attribs['opts'];

		$revision = $opts['previous'] ?? $opts['original'] ?? null;
		if ( !isset( $revision['html'] ) ) {
			$env->log( 'fatal/request', 'Missing revision html.' );
			return $this->getResponseFactory()->createHttpError( 400, [
				'message' => 'Missing revision html.',
			] );
		}

		$vOriginal = FormatHelper::parseContentTypeHeader(
			$revision['html']['headers']['content-type'] ?? '' );
		if ( $vOriginal === null ) {
			$env->log( 'fatal/request', 'Content-type of revision html is missing.' );
			return $this->getResponseFactory()->createHttpError( 400, [
				'message' => 'Content-type of revision html is missing.',
			] );
		}
		$env->setInputContentVersion( $vOriginal );

		$this->metrics->increment(
			'pb2pb.original.version.' . $env->getInputContentVersion()
		);

		if ( !empty( $opts['updates'] ) ) {
			// If we're only updating parts of the original version, it should
			// satisfy the requested content version, since we'll be returning
			// that same one.
			// FIXME: Since this endpoint applies the acceptable middleware,
			// `getOutputContentVersion` is not what's been passed in, but what
			// can be produced.  Maybe that should be selectively applied so
			// that we can update older versions where it makes sense?
			// Uncommenting below implies that we can only update the latest
			// version, since carrot semantics is applied in both directions.
			// if ( !Semver::satisfies(
			// 	$env->getInputContentVersion(),
			// 	"^{$env->getOutputContentVersion()}"
			// ) ) {
			// 	return $this->getResponseFactory()->createHttpError( 415, [
			// 		'message' => 'We do not know how to do this conversion.',
			// 	] );
			// }
			if ( !empty( $opts['updates']['redlinks'] ) ) {
				// Q(arlolra): Should redlinks be more complex than a bool?
				// See gwicke's proposal at T114413#2240381
				return $this->updateRedLinks( $env, $attribs, $revision );
			} elseif ( isset( $opts['updates']['variant'] ) ) {
				return $this->languageConversion( $env, $attribs, $revision );
			} else {
				return $this->getResponseFactory()->createHttpError( 400, [
					'message' => 'Unknown transformation.',
				] );
			}
		}

		// TODO(arlolra): subbu has some sage advice in T114413#2365456 that
		// we should probably be more explicit about the pb2pb conversion
		// requested rather than this increasingly complex fallback logic.
		$downgrade = FormatHelper::findDowngrade(
			$env->getInputContentVersion(),
			$env->getOutputContentVersion()
		);
		if ( $downgrade ) {
			$doc = $env->createDocument( $revision['html']['body'] );
			$pb = new PageBundle(
				'',
				$revision['data-parsoid']['body'] ?? null,
				$revision['data-mw']['body'] ?? null
			);
			if ( !$pb->validate( $env->getInputContentVersion(), $errorMessage ) ) {
				return $this->getResponseFactory()->createHttpError(
					400,
					[ 'message' => $errorMessage ]
				);
			}
			$out = FormatHelper::returnDowngrade( $downgrade, $env, $doc, $pb, $attribs );
			$response = $this->getResponseFactory()->createJson( $out->responseData() );
			FormatHelper::setContentType(
				$response, FormatHelper::FORMAT_PAGEBUNDLE, $out->version
			);
			return $response;
		// Ensure we only reuse from semantically similar content versions.
		} elseif ( Semver::satisfies( $env->getOutputContentVersion(),
			'^' . $env->getInputContentVersion() ) ) {
			return $this->wt2html( $env, $attribs, null );
		} else {
			$env->log( 'fatal/request', 'We do not know how to do this conversion.' );
			return $this->getResponseFactory()->createHttpError( 415, [
				'message' => 'We do not know how to do this conversion.',
			] );
		}
	}

	/**
	 * Update red links on a document.
	 *
	 * @param Env $env
	 * @param array $attribs
	 * @param array $revision
	 * @return Response
	 */
	protected function updateRedLinks( Env $env, array $attribs, array $revision ) {
		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );
		$pageConfig = $env->getPageConfig();

		$html = $parsoid->html2html(
			$pageConfig, 'redlinks', $revision['html']['body'], [], $headers
		);

		$out = new PageBundle(
			$html,
			$revision['data-parsoid']['body'] ?? null,
			$revision['data-mw']['body'] ?? null,
			$env->getInputContentVersion(),
			$headers
		);
		if ( !$out->validate( $env->getInputContentVersion(), $errorMessage ) ) {
			return $this->getResponseFactory()->createHttpError(
				400,
				[ 'message' => $errorMessage ]
			);
		}
		$response = $this->getResponseFactory()->createJson( $out->responseData() );
		FormatHelper::setContentType(
			$response, FormatHelper::FORMAT_PAGEBUNDLE, $out->version
		);
		return $response;
	}

	/**
	 * Do variant conversion on a document.
	 *
	 * @param Env $env
	 * @param array $attribs
	 * @param array $revision
	 * @return Response
	 */
	protected function languageConversion( Env $env, array $attribs, array $revision ) {
		$opts = $attribs['opts'];
		$source = $opts['updates']['variant']['source'] ?? null;
		$target = $opts['updates']['variant']['target'] ??
			$attribs['envOptions']['htmlVariantLanguage'];

		if ( !$target ) {
			return $this->getResponseFactory()->createHttpError(
				400, [ 'message' => 'Target variant is required.' ]
			);
		}

		if ( !$env->langConverterEnabled() ) {
			return $this->getResponseFactory()->createHttpError(
				400, [ 'message' => 'LanguageConversion is not enabled on this article.' ]
			);
		}

		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );
		$pageConfig = $env->getPageConfig();

		$html = $parsoid->html2html(
			$pageConfig, 'variant', $revision['html']['body'],
			[
				'variant' => [
					'source' => $source,
					'target' => $target,
				]
			],
			$headers
		);

		$out = new PageBundle(
			$html,
			$revision['data-parsoid']['body'] ?? null,
			$revision['data-mw']['body'] ?? null,
			$env->getInputContentVersion(),
			$headers
		);

		$response = $this->getResponseFactory()->createJson( $out->responseData() );
		FormatHelper::setContentType(
			$response, FormatHelper::FORMAT_PAGEBUNDLE, $out->version
		);
		return $response;
	}
}
