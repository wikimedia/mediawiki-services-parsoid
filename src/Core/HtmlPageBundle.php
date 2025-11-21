<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Composer\Semver\Semver;
use Wikimedia\Parsoid\Config\SiteConfig;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Wt2Html\XHtmlSerializer;

/**
 * An "HTML page bundle" stores an HTML string with separated data-parsoid and
 * (optionally) data-mw content.  The data-parsoid and data-mw content
 * is indexed by the id attributes on individual nodes.  This content
 * needs to be loaded before the data-parsoid and/or data-mw
 * information can be used.
 *
 * Note that the parsoid/mw properties of the page bundle are in "serialized
 * array" form; that is, they are flat arrays appropriate for json-encoding
 * and do not contain DataParsoid or DataMw objects.
 *
 * See DomPageBundle for a similar structure used where the HTML string
 * has been parsed into a DOM.
 */
class HtmlPageBundle extends BasePageBundle {

	public function __construct(
		/** The document, as an HTML string. */
		public string $html,
		?array $parsoid = null, ?array $mw = null,
		?string $version = null, ?array $headers = null,
		?string $contentmodel = null,
		/** @var array<string,string> Additional named HTML fragments. */
		public array $fragments = [],
	) {
		parent::__construct(
			parsoid: $parsoid,
			mw: $mw,
			version: $version,
			headers: $headers,
			contentmodel: $contentmodel,
		);
	}

	public static function newEmpty(
		string $html,
		?string $version = null,
		?array $headers = null,
		?string $contentmodel = null
	): self {
		return new self(
			$html,
			[
				'counter' => -1,
				'ids' => [],
			],
			[
				'ids' => [],
			],
			$version,
			$headers,
			$contentmodel
		);
	}

	/**
	 * @phpcs:ignore Generic.Files.LineLength.TooLong
	 * @return array{contentmodel: string, html: array{headers: array, body: string}, data-parsoid: array{headers: array{content-type: string}, body: ?array{counter?: int, offsetType?: 'byte'|'char'|'ucs2', ids: array<string, array>}}, data-mw?: array{headers: array{content-type: string}, body: ?array{ids: array<string, array>}}}
	 */
	public function responseData(): array {
		$version = $this->version ?? '0.0.0';
		$responseData = [
			'contentmodel' => $this->contentmodel ?? '',
			'html' => [
				'headers' => array_merge( [
					'content-type' => 'text/html; charset=utf-8; '
						. 'profile="https://www.mediawiki.org/wiki/Specs/HTML/'
						. $version . '"',
				], $this->headers ?? [] ),
				'body' => $this->html,
			],
			'data-parsoid' => [
				'headers' => [
					'content-type' => 'application/json; charset=utf-8; '
						. 'profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/'
						. $version . '"',
				],
				'body' => $this->parsoid,
			],
		];
		if ( Semver::satisfies( $version, '^999.0.0' ) ) {
			$responseData['data-mw'] = [
				'headers' => [
					'content-type' => 'application/json; charset=utf-8; ' .
						'profile="https://www.mediawiki.org/wiki/Specs/data-mw/' .
						$version . '"',
				],
				'body' => $this->mw,
			];
		}
		return $responseData;
	}

	/**
	 * Convert a DomPageBundle to an HtmlPageBundle.
	 *
	 * This serializes the DOM from the DomPageBundle, with the given $options.
	 * The options can also provide defaults for content version, headers,
	 * content model, and offsetType if they weren't already set in the
	 * DomPageBundle.
	 *
	 * @param DomPageBundle $dpb
	 * @param array $options XHtmlSerializer options
	 * @return self
	 */
	public static function fromDomPageBundle( DomPageBundle $dpb, array $options = [] ): self {
		$fragments = array_map(
			static fn ( $f ) => XHtmlSerializer::serialize( $f, $options )['html'],
			$dpb->fragments
		);
		$node = $dpb->doc;
		if ( $options['body_only'] ?? false ) {
			$node = DOMCompat::getBody( $dpb->doc );
			$options += [ 'innerXML' => true ];
		}
		$out = XHtmlSerializer::serialize( $node, $options )['html'];
		$pb = new self(
			$out,
			$dpb->parsoid,
			$dpb->mw,
			$dpb->version ?? $options['contentversion'] ?? null,
			$dpb->headers ?? $options['headers'] ?? null,
			$dpb->contentmodel ?? $options['contentmodel'] ?? null,
			$fragments,
		);
		if ( isset( $options['offsetType'] ) ) {
			$pb->parsoid['offsetType'] ??= $options['offsetType'];
		}
		return $pb;
	}

	/**
	 * Convert this HtmlPageBundle to "single document" form, where page bundle
	 * information is embedded in the <head> of the document.
	 * @param array $options XHtmlSerializer options
	 * @return string an HTML string
	 */
	public function toSingleDocumentHtml( array $options = [] ): string {
		return DomPageBundle::fromHtmlPageBundle( $this )
			->toSingleDocumentHtml( $options );
	}

	/**
	 * Convert this HtmlPageBundle to "inline attribute" form, where page bundle
	 * information is represented as inline JSON-valued attributes.
	 * @param array $options XHtmlSerializer options
	 * @param array<string,string>|null &$fragments Additional fragments from the
	 *  page bundle which will also be serialized to HTML strings.
	 *  This is an output parameter.
	 * @param ?SiteConfig $siteConfig
	 * @return string an HTML string
	 */
	public function toInlineAttributeHtml(
		array $options = [],
		?array &$fragments = null,
		?SiteConfig $siteConfig = null
	): string {
		return DomPageBundle::fromHtmlPageBundle( $this )
			->toInlineAttributeHtml( $options, $fragments, $siteConfig );
	}

	// JsonCodecable -------------

	/** @inheritDoc */
	public function toJsonArray(): array {
		$result = [
			'html' => $this->html,
		] + parent::toJsonArray();
		if ( $this->fragments ) {
			$result['fragments'] = $this->fragments;
		}
		return $result;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): self {
		return new self(
			html: $json['html'] ?? '',
			parsoid: $json['parsoid'] ?? null,
			mw: $json['mw'] ?? null,
			version: $json['version'] ?? null,
			headers: $json['headers'] ?? null,
			contentmodel: $json['contentmodel'] ?? null,
			fragments: $json['fragments'] ?? [],
		);
	}
}
class_alias( HtmlPageBundle::class, PageBundle::class );
