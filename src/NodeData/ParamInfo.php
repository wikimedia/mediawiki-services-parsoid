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
	 * @var string
	 */
	public $k;

	/**
	 * The key source wikitext, if different from $k
	 * @var string|null
	 */
	public $keyWt;

	/**
	 * The parameter value source wikitext
	 * @var string|null
	 */
	public $valueWt;

	/**
	 * @var KVSourceRange|null
	 */
	public $srcOffsets;

	/**
	 * @var bool
	 */
	public $named = false;

	/**
	 * @var string[]|null
	 */
	public $spc;

	/** @var string|null */
	public $html;

	/**
	 * @param string $key
	 * @param KVSourceRange|null $srcOffsets
	 */
	public function __construct( $key, $srcOffsets = null ) {
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
