<?php

namespace MWParsoid\Rest;

use Composer\Semver\Semver;
use DOMDocument;
use InvalidArgumentException;
use MediaWiki\Rest\ResponseInterface;
use Parsoid\PageBundle;
use Parsoid\Config\Env;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;

/**
 * Format-related REST API helper.
 * Probably should be turned into an object encapsulating format and content version at some point.
 */
class FormatHelper {

	const FORMAT_WIKITEXT = 'wikitext';
	const FORMAT_HTML = 'html';
	const FORMAT_PAGEBUNDLE = 'pagebundle';
	const FORMAT_LINT = 'lint';

	const ERROR_ENCODING = [
		self::FORMAT_WIKITEXT => 'plain',
		self::FORMAT_HTML => 'html',
		self::FORMAT_PAGEBUNDLE => 'json',
		self::FORMAT_LINT => 'json',
	];

	const VALID_PAGE = [
		self::FORMAT_WIKITEXT, self::FORMAT_HTML, self::FORMAT_PAGEBUNDLE
	];

	const VALID_TRANSFORM = [
		self::FORMAT_WIKITEXT => [ self::FORMAT_HTML, self::FORMAT_PAGEBUNDLE, self::FORMAT_LINT ],
		self::FORMAT_HTML => [ self::FORMAT_WIKITEXT ],
		self::FORMAT_PAGEBUNDLE => [ self::FORMAT_WIKITEXT, self::FORMAT_PAGEBUNDLE ],
	];

	private const DOWNGRADES = [
		[ 'from' => '999.0.0', 'to' => '2.0.0', 'func' => 'downgrade999to2' ],
	];

	/**
	 * Get the content type appropriate for a given response format.
	 * @param string $format One of the FORMAT_* constants
	 * @param string|null $contentVersion Output version, only for HTML and pagebundle
	 *   formats. See Env::getcontentVersion().
	 * @return string
	 */
	public static function getContentType( string $format, string $contentVersion = null ): string {
		if ( $format !== self::FORMAT_WIKITEXT && !$contentVersion ) {
			throw new InvalidArgumentException( '$contentVersion is required for this format' );
		}

		switch ( $format ) {
			case self::FORMAT_WIKITEXT:
				$contentType = 'text/plain';
				// PORT-FIXME in the original the version number is from MWParserEnvironment.wikitextVersion
				// but it did not seem to be used anywhere
				$profile = 'https://www.mediawiki.org/wiki/Specs/wikitext/1.0.0';
				break;
			case self::FORMAT_HTML:
				$contentType = 'text/html';
				$profile = 'https://www.mediawiki.org/wiki/Specs/HTML/' . $contentVersion;
				break;
			case self::FORMAT_PAGEBUNDLE:
				$contentType = 'application/json';
				$profile = 'https://www.mediawiki.org/wiki/Specs/pagebundle/' . $contentVersion;
				break;
			default:
				throw new InvalidArgumentException( "Invalid format $format" );
		}
		return "$contentType; charset=utf-8; profile=\"$profile\"";
	}

	/**
	 * Set the Content-Type header appropriate for a given response format.
	 * @param ResponseInterface $response
	 * @param string $format One of the FORMAT_* constants
	 * @param string|null $contentVersion Output version, only for HTML and pagebundle
	 *   formats. See Env::getcontentVersion().
	 */
	public static function setContentType(
		ResponseInterface $response, string $format, string $contentVersion = null
	): void {
		$response->setHeader( 'Content-Type', self::getContentType( $format, $contentVersion ) );
	}

	/**
	 * Parse a Content-Type header and return the format type and version.
	 * Mostly the inverse of getContentType() but also accounts for legacy formats.
	 * @param string $contentTypeHeader The value of the Content-Type header.
	 * @param string|null &$format Format type will be set here (as a FORMAT_* constant).
	 * @return string|null Format version, or null if it couldn't be identified.
	 * @see Env::getInputContentVersion()
	 */
	public static function parseContentTypeHeader(
		string $contentTypeHeader, string &$format = null
	): ?string {
		$newProfileSyntax = 'https://www.mediawiki.org/wiki/Specs/(HTML|pagebundle)/';
		$oldProfileSyntax = 'mediawiki.org/specs/(html)/';
		$profileRegex = "#\bprofile=\"(?:$newProfileSyntax|$oldProfileSyntax)(\d+\.\d+\.\d+)\"#";
		preg_match( $profileRegex, $contentTypeHeader, $m );
		if ( $m ) {
			switch ( $m[1] ?: $m[2] ) {
				case 'HTML':
				case 'html':
					$format = self::FORMAT_HTML;
				case 'pagebundle':
					$format = self::FORMAT_PAGEBUNDLE;
			}
			return $m[3];
		}
		return null;
	}

	/**
	 * Check whether a given content version can be downgraded to the requested content version.
	 * @param string $from Current content version
	 * @param string $to Requested content version
	 * @return string[]|null The downgrade that will fulfill the request, as
	 *   [ 'from' => <old version>, 'to' => <new version> ], or null if it can't be fulfilled.
	 */
	public static function findDowngrade( string $from, string $to ): ?array {
		foreach ( self::DOWNGRADES as list( 'from' => $dgFrom, 'to' => $dgTo ) ) {
			if ( Semver::satisfies( $from, "^$dgFrom" ) && Semver::satisfies( $to, "^$dgTo" ) ) {
				return [ 'from' => $dgFrom, 'to' => $dgTo ];
			}
		}
		return null;
	}

	/**
	 * Downgrade a document to an older content version.
	 * @param string $from Value returned by findDowngrade().
	 * @param string $to Value returned by findDowngrade().
	 * @param DOMDocument $doc
	 * @param PageBundle $pageBundle
	 */
	public static function downgrade(
		string $from, string $to, DOMDocument $doc, PageBundle $pageBundle
	): void {
		foreach ( self::DOWNGRADES as list( 'from' => $dgFrom, 'to' => $dgTo, 'func' => $dgFunc ) ) {
			if ( $from === $dgFrom && $to === $dgTo ) {
				call_user_func( [ 'self', $dgFunc ], $doc, $pageBundle );
				return;
			}
		}
		throw new InvalidArgumentException( "Unsupported downgrade: $from -> $to" );
	}

	/**
	 * Downgrade and return content
	 *
	 * @param string[] $downgrade
	 * @param Env $env
	 * @param DOMDocument $doc
	 * @param PageBundle $pb
	 * @param array $attribs
	 * @return PageBundle
	 */
	public static function returnDowngrade(
		array $downgrade, Env $env, DOMDocument $doc, PageBundle $pb,
		array $attribs
	): PageBundle {
		self::downgrade( $downgrade['from'], $downgrade['to'], $doc, $pb );
		// Match the http-equiv meta to the content-type header
		$meta = DOMCompat::querySelector( $doc, 'meta[property="mw:html:version"]' );
		if ( $meta ) {
			$meta->setAttribute( 'content', $env->getOutputContentVersion() );
		}
		// No need to `ContentUtils.extractDpAndSerialize`, it wasn't applied.
		$body_only = !empty( $attribs['body_only'] );
		$node = $body_only ? DOMCompat::getBody( $doc ) : $doc;
		$pb->html = ContentUtils::toXML( $node, [
			'innerXML' => $body_only,
		] );
		$pb->version = $env->getOutputContentVersion();
		return $pb;
	}

	/**
	 * Downgrade the given document and pagebundle from 999.x to 2.x.
	 * @param DOMDocument $doc
	 * @param PageBundle $pageBundle
	 */
	private static function downgrade999to2( DOMDocument $doc, PageBundle $pageBundle ) {
		// Effectively, skip applying data-parsoid.  Note that if we were to
		// support a pb2html downgrade, we'd need to apply the full thing,
		// but that would create complications where ids would be left behind.
		// See the comment in around `DOMDataUtils::applyPageBundle`
		$newPageBundle = new PageBundle( $pageBundle->html, [ 'ids' => [] ], $pageBundle->mw );
		DOMDataUtils::applyPageBundle( $doc, $newPageBundle );
		// Now, modify the pagebundle to the expected form.  This is important
		// since, at least in the serialization path, the original pb will be
		// applied to the modified content and its presence could cause lost
		// deletions.
		$pageBundle->mw = [ 'ids' => [] ];
	}

}
