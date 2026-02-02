<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Composer\Semver\Semver;
use Wikimedia\Assert\Assert;
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
		 * Records the max counter values for different counter types
		 * @var ?array{nodedata?:int,annotation?:int,transclusion?:int}
		 */
		public ?array $counters = null,
		public ?string $version = null,
		/**
		 * A map of HTTP headers: both name and value should be strings.
		 * @var ?array<string,string>
		 */
		public ?array $headers = null,
		public ?string $contentmodel = null,
	) {
		Assert::invariant(
			!isset( $parsoid['counter'] ), "counter removed in Parsoid 0.23"
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
			counters: $this->counters,
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
			counters: $this->counters,
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
			counters: $this->counters,
			version: $this->version,
			headers: $this->headers,
			contentmodel: $this->contentmodel,
		);
	}

	// JsonCodecable -------------

	/** @inheritDoc */
	public function toJsonArray(): array {
		// Roll-back compatibility with Parsoid < 0.23
		$parsoid = $this->parsoid + [
			'counter' => $this->counters['nodedata'],
		];
		return [
			'parsoid' => $parsoid,
			'mw' => $this->mw,
			'counters' => $this->counters,
			'version' => $this->version,
			'headers' => $this->headers,
			'contentmodel' => $this->contentmodel,
		];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): BasePageBundle {
		// Backward compatibility with Parsoid < 0.23
		$json['counters'] ??= [
			'nodedata' => $json['parsoid']['counter'] ?? -1,
			'annotation' => -1,
			'transclusion' => -1,
		];
		if ( isset( $json['parsoid']['counter'] ) ) {
			unset( $json['parsoid']['counter'] );
		}
		return new BasePageBundle(
			parsoid: $json['parsoid'] ?? null,
			mw: $json['mw'] ?? null,
			counters: $json['counters'] ?? null,
			version: $json['version'] ?? null,
			headers: $json['headers'] ?? null,
			contentmodel: $json['contentmodel'] ?? null
		);
	}
}
