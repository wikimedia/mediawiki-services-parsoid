<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

class BasePageBundle implements JsonCodecable {
	use JsonCodecableTrait;

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
		?array $parsoid = null, ?array $mw = null,
		?string $version = null, ?array $headers = null,
		?string $contentmodel = null
	) {
		$this->parsoid = $parsoid;
		$this->mw = $mw;
		$this->version = $version;
		$this->headers = $headers;
		$this->contentmodel = $contentmodel;
	}

	public function toJsonArray(): array {
		return [
			'parsoid' => $this->parsoid,
			'mw' => $this->mw,
			'version' => $this->version,
			'headers' => $this->headers,
			'contentmodel' => $this->contentmodel,
		];
	}

	public static function newFromJsonArray( array $json ): BasePageBundle {
		if ( isset( $json['counters']['nodedata'] ) ) {
			$json['parsoid']['counter'] = $json['counters']['nodedata'];
		}
		return new BasePageBundle(
			$json['parsoid'] ?? null,
			$json['mw'] ?? null,
			$json['version'] ?? null,
			$json['headers'] ?? null,
			$json['contentmodel'] ?? null
		);
	}
}
