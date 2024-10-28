<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Composer\Semver\Semver;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Wt2Html\XMLSerializer;

/**
 * A page bundle stores an HTML string with separated data-parsoid and
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
class PageBundle implements JsonCodecable {
	use JsonCodecableTrait;

	/** The document, as an HTML string. */
	public string $html;

	/**
	 * A map from ID to the array serialization of DataParsoid for the Node
	 * with that ID.
	 *
	 * @var null|array{counter?:int,offsetType?:'byte'|'ucs2'|'char',ids:array<string,array>}
	 */
	public $parsoid;

	/**
	 * A map from ID to the array serialization of DataMw for the Node
	 * with that ID.
	 *
	 * @var null|array{ids:array<string,array>}
	 */
	public $mw;

	/** @var ?string */
	public $version;

	/**
	 * A map of HTTP headers: both name and value should be strings.
	 * @var array<string,string>|null
	 */
	public $headers;

	/** @var string|null */
	public $contentmodel;

	public function __construct(
		string $html, ?array $parsoid = null, ?array $mw = null,
		?string $version = null, ?array $headers = null,
		?string $contentmodel = null
	) {
		$this->html = $html;
		$this->parsoid = $parsoid;
		$this->mw = $mw;
		$this->version = $version;
		$this->headers = $headers;
		$this->contentmodel = $contentmodel;
	}

	public static function newEmpty(
		string $html,
		?string $version = null,
		?array $headers = null,
		?string $contentmodel = null
	): self {
		return new PageBundle(
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
	 * Check if this pagebundle is valid.
	 * @param string $contentVersion Document content version to validate against.
	 * @param ?string &$errorMessage Error message will be returned here.
	 * @return bool
	 */
	public function validate(
		string $contentVersion, ?string &$errorMessage = null
	) {
		if ( !$this->parsoid || !isset( $this->parsoid['ids'] ) ) {
			$errorMessage = 'Invalid data-parsoid was provided.';
			return false;
		} elseif ( Semver::satisfies( $contentVersion, '^999.0.0' )
			&& ( !$this->mw || !isset( $this->mw['ids'] ) )
		) {
			$errorMessage = 'Invalid data-mw was provided.';
			return false;
		}
		return true;
	}

	/**
	 * @return array
	 */
	public function responseData() {
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
	 * Convert a DomPageBundle to a PageBundle.
	 *
	 * This serializes the DOM from the DomPageBundle, with the given $options.
	 * The options can also provide defaults for content version, headers,
	 * content model, and offsetType if they weren't already set in the
	 * DomPageBundle.
	 *
	 * @param DomPageBundle $dpb
	 * @param array $options XMLSerializer options
	 * @return PageBundle
	 */
	public static function fromDomPageBundle( DomPageBundle $dpb, array $options = [] ): PageBundle {
		$node = $dpb->doc;
		if ( $options['body_only'] ?? false ) {
			$node = DOMCompat::getBody( $dpb->doc );
			$options += [ 'innerXML' => true ];
		}
		$out = XMLSerializer::serialize( $node, $options );
		$pb = new PageBundle(
			$out['html'],
			$dpb->parsoid,
			$dpb->mw,
			$dpb->version ?? $options['contentversion'] ?? null,
			$dpb->headers ?? $options['headers'] ?? null,
			$dpb->contentmodel ?? $options['contentmodel'] ?? null
		);
		if ( isset( $options['offsetType'] ) ) {
			$pb->parsoid['offsetType'] ??= $options['offsetType'];
		}
		return $pb;
	}

	/**
	 * Convert this PageBundle to "single document" form, where page bundle
	 * information is embedded in the <head> of the document.
	 * @param array $options XMLSerializer options
	 * @return string an HTML string
	 */
	public function toSingleDocumentHtml( array $options = [] ): string {
		return DomPageBundle::fromPageBundle( $this )
			->toSingleDocumentHtml( $options );
	}

	/**
	 * Convert this PageBundle to "inline attribute" form, where page bundle
	 * information is represented as inline JSON-valued attributes.
	 * @param array $options XMLSerializer options
	 * @return string an HTML string
	 */
	public function toInlineAttributeHtml( array $options = [] ): string {
		return DomPageBundle::fromPageBundle( $this )
			->toInlineAttributeHtml( $options );
	}

	// JsonCodecable -------------

	/** @inheritDoc */
	public function toJsonArray(): array {
		return [
			'html' => $this->html,
			'parsoid' => $this->parsoid,
			'mw' => $this->mw,
			'version' => $this->version,
			'headers' => $this->headers,
			'contentmodel' => $this->contentmodel,
		];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): PageBundle {
		return new PageBundle(
			$json['html'] ?? '',
			$json['parsoid'] ?? null,
			$json['mw'] ?? null,
			$json['version'] ?? null,
			$json['headers'] ?? null,
			$json['contentmodel'] ?? null
		);
	}
}
