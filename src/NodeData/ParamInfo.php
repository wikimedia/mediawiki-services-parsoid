<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Tokens\KVSourceRange;

class ParamInfo implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * The parameter key
	 */
	public string $k;

	/**
	 * The key source wikitext, if different from $k
	 */
	public ?string $keyWt = null;

	/**
	 * The parameter value source wikitext
	 */
	public ?string $valueWt = null;

	public ?KVSourceRange $srcOffsets = null;

	public bool $named = false;

	/**
	 * @var string[]|null
	 */
	public ?array $spc = null;

	public ?string $html = null;

	public function __construct( string $key, ?KVSourceRange $srcOffsets = null ) {
		$this->k = $key;
		$this->srcOffsets = $srcOffsets;
	}

	/**
	 * Create an object from unserialized data-parsoid.pi
	 * @param array $data
	 * @return self
	 */
	public static function newFromJsonArray( array $data ): ParamInfo {
		$info = new self( $data['k'] ?? '' );
		$info->named = $data['named'] ?? false;
		$info->spc = $data['spc'] ?? null;
		return $info;
	}

	/**
	 * Serialize for data-parsoid.pi. The rest of the data is temporary, it is
	 * not needed across requests.
	 *
	 * @return array
	 */
	public function toJsonArray(): array {
		$ret = [ 'k' => $this->k ];
		if ( $this->named ) {
			$ret['named'] = true;
		}
		if ( $this->spc ) {
			$ret['spc'] = $this->spc;
		}
		return $ret;
	}
}
