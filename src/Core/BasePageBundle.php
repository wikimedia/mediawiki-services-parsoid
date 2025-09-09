<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;

/**
 * A page bundle stores metadata and separated data-parsoid and
 * data-mw content.  The data-parsoid and data-mw content is indexed
 * by the id attributes on individual nodes.  This content needs to
 * be loaded before the data-parsoid and/or data-mw information can be
 * used.
 *
 * Note that the parsoid/mw properties of the page bundle are in "serialized
 * array" form; that is, they are flat arrays appropriate for json-encoding
 * and do not contain DataParsoid or DataMw objects.
 *
 * See DomPageBundle and HtmlPageBundle for similar structures which include
 * the actual HTML/DOM content.
 */
class BasePageBundle implements JsonCodecable {
	use JsonCodecableTrait;

	public function __construct(
		/**
		 * A map from ID to the array serialization of DataParsoid for the Node
		 * with that ID.
		 *
		 * @var ?array{counter?:int,offsetType?:'byte'|'ucs2'|'char',ids:array<string,array>}
		 */
		public ?array $parsoid = null,
		/**
		 * A map from ID to the array serialization of DataMw for the Node
		 * with that ID.
		 *
		 * @var ?array{ids:array<string,array>}
		 */
		public ?array $mw = null,
		/**
		 * @var ?string
		 */
		public ?string $version = null,
		/**
		 * A map of HTTP headers: both name and value should be strings.
		 * @var ?array<string,string>
		 */
		public ?array $headers = null,
		/** @var ?string */
		public ?string $contentmodel = null,
	) {
	}

	/**
	 * Build an HtmlPageBundle by adding HTML string contents to this
	 * base page bundle.
	 * @param string $html The main document HTML
	 * @param array<string,string> $fragments Additional named HTML fragments
	 * @return HtmlPageBundle
	 */
	public function withHtml( string $html, array $fragments = [] ): HtmlPageBundle {
		return new HtmlPageBundle(
			html: $html,
			fragments: $fragments,
			parsoid: $this->parsoid,
			mw: $this->mw,
			version: $this->version,
			headers: $this->headers,
			contentmodel: $this->contentmodel,
		);
	}

	/**
	 * Build an DomPageBundle by adding DOM contents to this
	 * base page bundle.
	 * @param Document $doc The owner Document
	 * @param array<string,DocumentFragment> $fragments Additional named
	 *   DocumentFragments
	 * @return DomPageBundle
	 */
	public function withDocument( Document $doc, array $fragments = [] ): DomPageBundle {
		return new DomPageBundle(
			doc: $doc,
			fragments: $fragments,
			parsoid: $this->parsoid,
			mw: $this->mw,
			version: $this->version,
			headers: $this->headers,
			contentmodel: $this->contentmodel,
		);
	}

	/**
	 * Build a BasePageBundle with just the metadata from another page bundle.
	 */
	public function toBasePageBundle(): BasePageBundle {
		return new BasePageBundle(
			parsoid: $this->parsoid,
			mw: $this->mw,
			version: $this->version,
			headers: $this->headers,
			contentmodel: $this->contentmodel,
		);
	}

	// JsonCodecable -------------

	/** @inheritDoc */
	public function toJsonArray(): array {
		return [
			'parsoid' => $this->parsoid,
			'mw' => $this->mw,
			'version' => $this->version,
			'headers' => $this->headers,
			'contentmodel' => $this->contentmodel,
		];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): BasePageBundle {
		return new BasePageBundle(
			parsoid: $json['parsoid'] ?? null,
			mw: $json['mw'] ?? null,
			version: $json['version'] ?? null,
			headers: $json['headers'] ?? null,
			contentmodel: $json['contentmodel'] ?? null
		);
	}
}
