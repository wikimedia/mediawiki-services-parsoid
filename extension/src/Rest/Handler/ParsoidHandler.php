<?php
/**
 * Copyright (C) 2011-2020 Wikimedia Foundation and others.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */
declare( strict_types = 1 );

namespace MWParsoid\Rest\Handler;

use Composer\Semver\Semver;
use ExtensionRegistry;
use Liuggio\StatsdClient\Factory\StatsdDataFactoryInterface;
use LogicException;
use MediaWiki\MediaWikiServices;
use MediaWiki\Rest\Handler;
use MediaWiki\Rest\HttpException;
use MediaWiki\Rest\Response;
use MediaWiki\Rest\ResponseException;
use MediaWiki\Revision\RevisionAccessException;
use MobileContext;
use MWParsoid\Config\PageConfigFactory;
use MWParsoid\ParsoidServices;
use MWParsoid\Rest\FormatHelper;
use RequestContext;
use Title;
use UIDGenerator;
use Wikimedia\Http\HttpAcceptParser;
use Wikimedia\Message\DataMessageValue;
use Wikimedia\ParamValidator\ValidationException;
use Wikimedia\Parsoid\Config\DataAccess;
use Wikimedia\Parsoid\Config\PageConfig;
use Wikimedia\Parsoid\Config\SiteConfig;
use Wikimedia\Parsoid\Core\ClientError;
use Wikimedia\Parsoid\Core\PageBundle;
use Wikimedia\Parsoid\Core\ResourceLimitExceededException;
use Wikimedia\Parsoid\Core\SelserData;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Timing;

/**
 * Base class for Parsoid handlers.
 */
abstract class ParsoidHandler extends Handler {
	// TODO logging, timeouts(?), CORS
	// TODO content negotiation (routes.js routes.acceptable)
	// TODO handle MaxConcurrentCallsError (pool counter?)

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
		// @phan-suppress-next-line PhanTypeInstantiateAbstractStatic
		return new static(
			$services->getMainConfig()->get( 'ParsoidSettings' ),
			$parsoidServices->getParsoidSiteConfig(),
			$parsoidServices->getParsoidPageConfigFactory(),
			$parsoidServices->getParsoidDataAccess()
		);
	}

	/**
	 * @param array $parsoidSettings
	 * @param SiteConfig $siteConfig
	 * @param PageConfigFactory $pageConfigFactory
	 * @param DataAccess $dataAccess
	 */
	public function __construct(
		array $parsoidSettings,
		SiteConfig $siteConfig,
		PageConfigFactory $pageConfigFactory,
		DataAccess $dataAccess
	) {
		$this->parsoidSettings = $parsoidSettings;
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
		$server = \RequestContext::getMain()->getConfig()->get( 'Server' );
		$expectedDomain = wfParseUrl( $server )['host'] ?? null;
		if ( !$expectedDomain ) {
			throw new LogicException( 'Cannot parse $wgServer' );
		}
		if ( strcasecmp( $expectedDomain, $domain ) === 0 ) {
			return;
		}

		// TODO probably the better
		if ( $this->extensionRegistry->isLoaded( 'MobileFrontend' ) ) {
			$mobileServer = MobileContext::singleton()->getMobileUrl( $server );
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
				$json = json_decode( $request->getBody()->getContents(), true );
				if ( !is_array( $json ) ) {
					throw new HttpException( 'Payload does not JSON decode to an array.', 400 );
				}
				return $json;
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

		$request = $this->getRequest();
		$body = ( $request->getMethod() === 'POST' ) ? $this->getParsedBody() : [];
		$opts = array_merge( $body, array_intersect_key( $request->getPathParams(),
			[ 'from' => true, 'format' => true ] ) );
		'@phan-var array<string,array|bool|string> $opts'; // @var array<string,array|bool|string> $opts
		$attribs = [
			'titleMissing' => empty( $request->getPathParams()['title'] ),
			'pageName' => $request->getPathParam( 'title' ) ?? '',
			'oldid' => $request->getPathParam( 'revision' ),
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
		if ( $attribs['oldid'] !== null ) {
			if ( $attribs['oldid'] === '' ) {
				$attribs['oldid'] = null;
			} else {
				$attribs['oldid'] = (int)$attribs['oldid'];
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
			// Semver::satisfies checks below expect a valid outputContentVersion value.
			// Better to set it here instead of adding the default value at every check.
			'outputContentVersion' => Parsoid::defaultHTMLVersion(),
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
	private const NEW_SPEC =
		'#^https://www.mediawiki.org/wiki/Specs/(HTML|pagebundle)/(\d+\.\d+\.\d+)$#D';

	/**
	 * This method checks if we support the requested content formats
	 * As a side-effect, it updates $attribs to set outputContentVersion
	 * that Parsoid should generate based on request headers.
	 *
	 * @param array &$attribs Request attributes from getRequestAttributes()
	 * @return bool
	 */
	protected function acceptable( array &$attribs ): bool {
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
						$contentVersion = Parsoid::resolveContentVersion( $matches[2] );
						if ( $contentVersion ) {
							// $attribs mutated here!
							$attribs['envOptions']['outputContentVersion'] = $contentVersion;
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
	 * @param ?int $revision The revision to be transformed
	 * @param ?string $wikitextOverride
	 *   Custom wikitext to use instead of the real content of the page.
	 * @param ?string $pagelanguageOverride
	 * @return PageConfig
	 */
	protected function createPageConfig(
		string $title, ?int $revision, ?string $wikitextOverride = null,
		?string $pagelanguageOverride = null
	): PageConfig {
		$title = $title ? Title::newFromText( $title ) : Title::newMainPage();
		if ( !$title ) {
			// TODO use proper validation
			throw new LogicException( 'Title not found!' );
		}
		$user = RequestContext::getMain()->getUser();
		// Note: Parsoid by design isn't supposed to use the user
		// context right now, and all user state is expected to be
		// introduced as a post-parse transform.  So although we pass a
		// User here, it only currently affects the output in obscure
		// corner cases; see PageConfigFactory::create() for more.
		return $this->pageConfigFactory->create(
			$title, $user, $revision, $wikitextOverride, $pagelanguageOverride,
			$this->parsoidSettings
		);
	}

	/**
	 * Redirect to another Parsoid URL (e.g. canonization)
	 * @param string $path Target URL
	 * @param array $queryParams Query parameters
	 * @return Response
	 */
	protected function createRedirectResponse(
		string $path, array $queryParams = []
	): Response {
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
	 * Try to create a PageConfig object. If we get an exception (because content
	 * may be missing or inaccessible), throw an appropriate HTTP response object
	 * for callers to handle.
	 *
	 * @param array $attribs
	 * @param ?string $wikitext
	 * @param bool $html2WtMode
	 * @return PageConfig
	 * @throws HttpException
	 */
	protected function tryToCreatePageConfig(
		array $attribs, ?string $wikitext = null, bool $html2WtMode = false
	): PageConfig {
		$oldid = $attribs['oldid'];

		try {
			$pageConfig = $this->createPageConfig(
				$attribs['pageName'], $oldid, $wikitext,
				$attribs['pagelanguage']
			);
		} catch ( RevisionAccessException $exception ) {
			throw new HttpException( 'The specified revision is deleted or suppressed.', 404 );
		}

		$hasOldId = ( $attribs['oldid'] !== null );
		if ( ( !$html2WtMode || $hasOldId ) && $pageConfig->getRevisionContent() === null ) {
			// T234549
			throw new HttpException(
				'The specified revision does not exist.', 404
			);
		}

		if ( !$html2WtMode && $wikitext === null && !$hasOldId ) {
			// Redirect to the latest revid
			throw new ResponseException(
				$this->createRedirectToOldidResponse( $pageConfig, $attribs )
			);
		}

		// All good!
		return $pageConfig;
	}

	/**
	 * Expand the current URL with the latest revision number and redirect there.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @return Response
	 */
	protected function createRedirectToOldidResponse(
		PageConfig $pageConfig, array $attribs
	): Response {
		$domain = $attribs['envOptions']['domain'];
		$format = $this->getRequest()->getPathParam( 'format' );
		$target = $pageConfig->getTitle();
		$encodedTarget = PHPUtils::encodeURIComponent( $target );
		$revid = $pageConfig->getRevisionId();

		if ( $revid === null ) {
			throw new LogicException( 'Expected page to have a revision id.' );
		}

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
	 * Spec'd in https://phabricator.wikimedia.org/T75955 and the API tests.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @param ?string $wikitext Wikitext to transform (or null to use the
	 *   page specified in the request attributes).
	 * @return Response
	 */
	protected function wt2html(
		PageConfig $pageConfig, array $attribs, ?string $wikitext = null
	) {
		$request = $this->getRequest();
		$opts = $attribs['opts'];
		$format = $opts['format'];
		$oldid = $attribs['oldid'];

		$needsPageBundle = ( $format === FormatHelper::FORMAT_PAGEBUNDLE );
		$doSubst = ( $wikitext !== null && $attribs['subst'] );

		// Performance Timing options
		// init refers to time elapsed before parsing begins
		$metrics = $this->metrics;
		$timing = Timing::start( $metrics );

		if ( Semver::satisfies( $attribs['envOptions']['outputContentVersion'],
			'!=' . Parsoid::defaultHTMLVersion() ) ) {
			$metrics->increment( 'wt2html.parse.version.notdefault' );
		}

		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );

		if ( $doSubst ) {
			if ( $format !== FormatHelper::FORMAT_HTML ) {
				throw new HttpException(
					'Substitution is only supported for the HTML format.', 501
				);
			}
			$wikitext = $parsoid->substTopLevelTemplates(
				$pageConfig, $wikitext
			);
			$pageConfig = $this->createPageConfig(
				$attribs['pageName'], $attribs['oldid'], $wikitext
			);
		}

		if (
			!empty( $this->parsoidSettings['devAPI'] ) &&
			( $request->getQueryParams()['follow_redirects'] ?? false )
		) {
			$content = $pageConfig->getRevisionContent();
			$redirectTarget = $content ? $content->getRedirectTarget() : null;
			if ( $redirectTarget ) {
				$redirectInfo = $this->dataAccess->getPageInfo(
					$pageConfig, [ $redirectTarget ]
				);
				$encodedTarget = PHPUtils::encodeURIComponent( $redirectTarget );
				$redirectPath =
					"/{$attribs['envOptions']['domain']}/v3/page/$encodedTarget/wikitext";
				if ( $redirectInfo['revId'] ) {
					$redirectPath .= '/' . $redirectInfo['revId'];
				}
				throw new ResponseException(
					$this->createRedirectResponse( "", $request->getQueryParams() )
				);
			}
		}

		$reqOpts = array_merge( [
			'pageBundle' => $needsPageBundle,
			// When substing, set data-parsoid to be discarded, so that the subst'ed
			// content is considered new when it comes back.
			'discardDataParsoid' => $doSubst,
			'contentmodel' => $opts['contentmodel'] ?? null,
		], $attribs['envOptions'] );

		// VE, the only client using body_only property,
		// doesn't want section tags when this flag is set.
		// (T181226)
		if ( $attribs['body_only'] ) {
			$reqOpts['wrapSections'] = false;
			$reqOpts['body_only'] = true;
		}

		if ( $wikitext === null && $oldid !== null ) {
			$reqOpts['logLinterData'] = true;
			$mstr = 'pageWithOldid';
		} else {
			$mstr = 'wt';
		}

		// XXX: Not necessary, since it's in the pageConfig
		// if ( isset( $attribs['pagelanguage'] ) ) {
		// 	$reqOpts['pagelanguage'] = $attribs['pagelanguage'];
		// }

		$timing->end( "wt2html.$mstr.init" );
		$metrics->timing(
			"wt2html.$mstr.size.input",
			# Should perhaps be strlen instead (or cached!): T239841
			mb_strlen( $pageConfig->getPageMainContent() )
		);
		$parseTiming = Timing::start( $metrics );

		if ( $format === FormatHelper::FORMAT_LINT ) {
			try {
				$lints = $parsoid->wikitext2lint( $pageConfig, $reqOpts );
			} catch ( ClientError $e ) {
				throw new HttpException( $e->getMessage(), 400 );
			} catch ( ResourceLimitExceededException $e ) {
				throw new HttpException( $e->getMessage(), 413 );
			}
			$response = $this->getResponseFactory()->createJson( $lints );
		} else {
			try {
				$out = $parsoid->wikitext2html(
					$pageConfig, $reqOpts, $headers
				);
			} catch ( ClientError $e ) {
				throw new HttpException( $e->getMessage(), 400 );
			} catch ( ResourceLimitExceededException $e ) {
				throw new HttpException( $e->getMessage(), 413 );
			}
			if ( $needsPageBundle ) {
				$response = $this->getResponseFactory()->createJson( $out->responseData() );
				FormatHelper::setContentType( $response, FormatHelper::FORMAT_PAGEBUNDLE,
					$out->version );
			} else {
				$response = $this->getResponseFactory()->create();
				FormatHelper::setContentType( $response, FormatHelper::FORMAT_HTML,
					$attribs['envOptions']['outputContentVersion'] );
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
		} elseif ( $oldid !== null ) {
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
	 *
	 * @param PageConfig $pageConfig
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @param string $html HTML to transform
	 * @return Response
	 */
	protected function html2wt(
		PageConfig $pageConfig, array $attribs, string $html
	) {
		$request = $this->getRequest();
		$opts = $attribs['opts'];
		$envOptions = $attribs['envOptions'];
		$metrics = $this->metrics;

		// Performance Timing options
		$timing = Timing::start( $metrics );

		try {
			$doc = DOMUtils::parseHTML( $html, true );
		} catch ( ClientError $e ) {
			throw new HttpException( $e->getMessage(), 400 );
		}

		// Should perhaps be strlen instead (or cached!): T239841
		$htmlSize = mb_strlen( $html );

		// Send input size to statsd/Graphite
		$metrics->timing( 'html2wt.size.input', $htmlSize );

		$original = $opts['original'] ?? null;
		$oldBody = null;
		$origPb = null;

		// Get the content version of the edited doc, if available
		$vEdited = DOMUtils::extractInlinedContentVersion( $doc );

		// Check for version mismatches between original & edited doc
		if ( !isset( $original['html'] ) ) {
			$envOptions['inputContentVersion'] = $vEdited ?? Parsoid::defaultHTMLVersion();
		} else {
			$vOriginal = FormatHelper::parseContentTypeHeader(
				$original['html']['headers']['content-type'] ?? '' );
			if ( $vOriginal === null ) {
				throw new HttpException(
					'Content-type of original html is missing.', 400
				);
			}
			if ( $vEdited === null ) {
				// If version of edited doc is unavailable we assume
				// the edited doc is derived from the original doc.
				// No downgrade necessary
				$envOptions['inputContentVersion'] = $vOriginal;
			} elseif ( $vEdited === $vOriginal ) {
				// No downgrade necessary
				$envOptions['inputContentVersion'] = $vOriginal;
			} else {
				$envOptions['inputContentVersion'] = $vEdited;
				// We need to downgrade the original to match the the edited doc's version.
				$downgrade = Parsoid::findDowngrade( $vOriginal, $vEdited );
				// Downgrades are only for pagebundle
				if ( $downgrade && $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE ) {
					$metrics->increment(
						"downgrade.from.{$downgrade['from']}.to.{$downgrade['to']}"
					);
					$origPb = new PageBundle(
						$original['html']['body'],
						$original['data-parsoid']['body'] ?? null,
						$original['data-mw']['body'] ?? null
					);
					$this->validatePb( $origPb, $vOriginal );
					$downgradeTiming = Timing::start( $metrics );
					Parsoid::downgrade( $downgrade, $origPb );
					$downgradeTiming->end( 'downgrade.time' );
					$oldBody = DOMCompat::getBody( DOMUtils::parseHTML( $origPb->html ) );
				} else {
					throw new HttpException(
						"Modified ({$vEdited}) and original ({$vOriginal}) html are of "
						. 'different type, and no path to downgrade.', 400
					);
				}
			}
		}

		$metrics->increment(
			'html2wt.original.version.' . $envOptions['inputContentVersion']
		);
		if ( !$vEdited ) {
			$metrics->increment( 'html2wt.original.version.notinline' );
		}

		// If available, the modified data-mw blob is applied, while preserving
		// existing inline data-mw.  But, no data-parsoid application, since
		// that's internal, we only expect to find it in its original,
		// unmodified form.
		if ( $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE && isset( $opts['data-mw'] )
			&& Semver::satisfies( $envOptions['inputContentVersion'], '^999.0.0' )
		) {
			// `opts` isn't a revision, but we'll find a `data-mw` there.
			$pb = new PageBundle( '',
				[ 'ids' => [] ],  // So it validates
				$opts['data-mw']['body'] ?? null );
			$this->validatePb( $pb, $envOptions['inputContentVersion'] );
			PageBundle::apply( $doc, $pb );
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

				// Verify that the top-level parsoid object either doesn't contain
				// offsetType, or that it matches the conversion that has been
				// explicitly requested.
				if ( isset( $origPb->parsoid['offsetType'] ) ) {
					$offsetType = $envOptions['offsetType'] ?? 'byte';
					$origOffsetType = $origPb->parsoid['offsetType'];
					if ( $origOffsetType !== $offsetType ) {
						throw new HttpException(
							'DSR offsetType mismatch: ' .
							$origOffsetType . ' vs ' . $offsetType, 406
						);
					}
				}

				$pb = $origPb;
				// However, if a modified data-mw was provided,
				// original data-mw is omitted to avoid losing deletions.
				if ( isset( $opts['data-mw'] )
					&& Semver::satisfies( $envOptions['inputContentVersion'], '^999.0.0' )
				) {
					// Don't modify `origPb`, it's used below.
					$pb = new PageBundle( '', $pb->parsoid, [ 'ids' => [] ] );
				}
				$this->validatePb( $pb, $envOptions['inputContentVersion'] );
				PageBundle::apply( $doc, $pb );
			}

			// If we got original html, parse it
			if ( isset( $original['html'] ) ) {
				if ( !$oldBody ) {
					$oldBody = DOMCompat::getBody( DOMUtils::parseHTML( $original['html']['body'] ) );
				}
				if ( $opts['from'] === FormatHelper::FORMAT_PAGEBUNDLE ) {
					$this->validatePb( $origPb, $envOptions['inputContentVersion'] );
					PageBundle::apply( $oldBody->ownerDocument, $origPb );
				}
				$oldhtml = ContentUtils::toXML( $oldBody );
			}
		}

		// As per https://www.mediawiki.org/wiki/Parsoid/API#v1_API_entry_points
		//   "Both it and the oldid parameter are needed for
		//    clean round-tripping of HTML retrieved earlier with"
		// So, no oldid => no selser
		$hasOldId = ( $attribs['oldid'] !== null );

		if ( $hasOldId && !empty( $this->parsoidSettings['useSelser'] ) ) {
			if ( !$pageConfig->getRevisionContent() ) {
				throw new HttpException(
					'Could not find previous revision. Has the page been locked / deleted?', 409
				);
			}

			// FIXME: T234548/T234549 - $pageConfig->getPageMainContent() is deprecated:
			// should use $env->topFrame->getSrcText()
			$selserData = new SelserData( $pageConfig->getPageMainContent(), $oldhtml );
		} else {
			$selserData = null;
		}

		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );

		$timing->end( 'html2wt.init' );

		try {
			$wikitext = $parsoid->dom2wikitext( $pageConfig, $doc, [
				'scrubWikitext' => $envOptions['scrubWikitext'],
				'inputContentVersion' => $envOptions['inputContentVersion'],
				'offsetType' => $envOptions['offsetType'],
				'contentmodel' => $opts['contentmodel'] ?? null,
				'htmlSize' => $htmlSize,
			], $selserData );
		} catch ( ClientError $e ) {
			throw new HttpException( $e->getMessage(), 400 );
		} catch ( ResourceLimitExceededException $e ) {
			throw new HttpException( $e->getMessage(), 413 );
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
	 *
	 * @param array<string,array|string> $attribs
	 * @return Response
	 * @throws HttpException
	 */
	protected function pb2pb( array $attribs ) {
		$request = $this->getRequest();
		$opts = $attribs['opts'];

		$revision = $opts['previous'] ?? $opts['original'] ?? null;
		if ( !isset( $revision['html'] ) ) {
			throw new HttpException(
				'Missing revision html.', 400
			);
		}

		$vOriginal = FormatHelper::parseContentTypeHeader(
			$revision['html']['headers']['content-type'] ?? '' );
		if ( $vOriginal === null ) {
			throw new HttpException(
				'Content-type of revision html is missing.', 400
			);
		}
		$attribs['envOptions']['inputContentVersion'] = $vOriginal;
		'@phan-var array<string,array|string> $attribs'; // @var array<string,array|string> $attribs

		$this->metrics->increment(
			'pb2pb.original.version.' . $attribs['envOptions']['inputContentVersion']
		);

		if ( !empty( $opts['updates'] ) ) {
			// FIXME: Handling missing revisions uniformly for all update types
			// is not probably the right thing to do but probably okay for now.
			// This might need revisiting as we add newer types.
			$pageConfig = $this->tryToCreatePageConfig( $attribs, null, true );
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
			// 	$attribs['envOptions']['inputContentVersion'],
			// 	"^{$attribs['envOptions']['outputContentVersion']}"
			// ) ) {
			//  throw new HttpException(
			// 		'We do not know how to do this conversion.', 415
			// 	);
			// }
			if ( !empty( $opts['updates']['redlinks'] ) ) {
				// Q(arlolra): Should redlinks be more complex than a bool?
				// See gwicke's proposal at T114413#2240381
				return $this->updateRedLinks( $pageConfig, $attribs, $revision );
			} elseif ( isset( $opts['updates']['variant'] ) ) {
				return $this->languageConversion( $pageConfig, $attribs, $revision );
			} else {
				throw new HttpException(
					'Unknown transformation.', 400
				);
			}
		}

		// TODO(arlolra): subbu has some sage advice in T114413#2365456 that
		// we should probably be more explicit about the pb2pb conversion
		// requested rather than this increasingly complex fallback logic.
		$downgrade = Parsoid::findDowngrade(
			$attribs['envOptions']['inputContentVersion'],
			$attribs['envOptions']['outputContentVersion']
		);
		if ( $downgrade ) {
			$pb = new PageBundle(
				$revision['html']['body'],
				$revision['data-parsoid']['body'] ?? null,
				$revision['data-mw']['body'] ?? null
			);
			$this->validatePb( $pb, $attribs['envOptions']['inputContentVersion'] );
			Parsoid::downgrade( $downgrade, $pb );

			if ( !empty( $attribs['body_only'] ) ) {
				$doc = DOMUtils::parseHTML( $pb->html );
				$body = DOMCompat::getBody( $doc );
				$pb->html = ContentUtils::toXML( $body, [
					'innerXML' => true,
				] );
			}

			$response = $this->getResponseFactory()->createJson( $pb->responseData() );
			FormatHelper::setContentType(
				$response, FormatHelper::FORMAT_PAGEBUNDLE, $pb->version
			);
			return $response;
		// Ensure we only reuse from semantically similar content versions.
		} elseif ( Semver::satisfies( $attribs['envOptions']['outputContentVersion'],
			'^' . $attribs['envOptions']['inputContentVersion'] ) ) {
			$pageConfig = $this->tryToCreatePageConfig( $attribs );
			return $this->wt2html( $pageConfig, $attribs );
		} else {
			throw new HttpException(
				'We do not know how to do this conversion.', 415
			);
		}
	}

	/**
	 * Update red links on a document.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $attribs
	 * @param array $revision
	 * @return Response
	 */
	protected function updateRedLinks(
		PageConfig $pageConfig, array $attribs, array $revision
	) {
		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );

		$pb = new PageBundle(
			$revision['html']['body'],
			$revision['data-parsoid']['body'] ?? null,
			$revision['data-mw']['body'] ?? null,
			$attribs['envOptions']['inputContentVersion'],
			$revision['html']['headers'] ?? null,
			$revision['contentmodel'] ?? null
		);

		$out = $parsoid->pb2pb(
			$pageConfig, 'redlinks', $pb, []
		);

		$this->validatePb( $out, $attribs['envOptions']['inputContentVersion'] );

		$response = $this->getResponseFactory()->createJson( $out->responseData() );
		FormatHelper::setContentType(
			$response, FormatHelper::FORMAT_PAGEBUNDLE, $out->version
		);
		return $response;
	}

	/**
	 * Do variant conversion on a document.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $attribs
	 * @param array $revision
	 * @return Response
	 * @throws HttpException
	 */
	protected function languageConversion(
		PageConfig $pageConfig, array $attribs, array $revision
	) {
		$opts = $attribs['opts'];
		$source = $opts['updates']['variant']['source'] ?? null;
		$target = $opts['updates']['variant']['target'] ??
			$attribs['envOptions']['htmlVariantLanguage'];

		if ( !$target ) {
			throw new HttpException(
				'Target variant is required.', 400
			);
		}

		if ( !$this->siteConfig->langConverterEnabledForLanguage(
			$pageConfig->getPageLanguage()
		) ) {
			throw new HttpException(
				'LanguageConversion is not enabled on this article.', 400
			);
		}

		$parsoid = new Parsoid( $this->siteConfig, $this->dataAccess );

		$pb = new PageBundle(
			$revision['html']['body'],
			$revision['data-parsoid']['body'] ?? null,
			$revision['data-mw']['body'] ?? null,
			$attribs['envOptions']['inputContentVersion'],
			$revision['html']['headers'] ?? null,
			$revision['contentmodel'] ?? null
		);
		$out = $parsoid->pb2pb(
			$pageConfig, 'variant', $pb,
			[
				'variant' => [
					'source' => $source,
					'target' => $target,
				]
			]
		);

		$response = $this->getResponseFactory()->createJson( $out->responseData() );
		FormatHelper::setContentType(
			$response, FormatHelper::FORMAT_PAGEBUNDLE, $out->version
		);
		return $response;
	}

	/** @inheritDoc */
	abstract public function execute(): Response;

	/**
	 * Validate a PageBundle against the given contentVersion, and throw
	 * an HttpException if it does not match.
	 * @param PageBundle $pb
	 * @param string $contentVersion
	 * @throws HttpException
	 */
	private function validatePb( PageBundle $pb, string $contentVersion ): void {
		if ( !$pb->validate( $contentVersion, $errorMessage ) ) {
			throw new HttpException( $errorMessage, 400 );
		}
	}

}
