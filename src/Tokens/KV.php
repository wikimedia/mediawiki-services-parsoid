<?php
// phpcs:disable MediaWiki.Commenting.FunctionComment.DefaultNullTypeParam -- T218324, T218816
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * Represents a Key-value pair.
 */
class KV implements JsonCodecable, \JsonSerializable {
	use JsonCodecableTrait;

	/**
	 * Commonly a string, but where the key might be templated,
	 * this can be an array of tokens even.
	 *
	 * @var string|Token|array<Token|string>
	 */
	public $k;

	/** @var string|Token|array<Token|string>|KV[] */
	public $v;

	/** Wikitext source offsets */
	public ?KVSourceRange $srcOffsets;

	/** Wikitext source */
	public ?string $ksrc;

	/** Wikitext source */
	public ?string $vsrc;

	/**
	 * @param string|Token|array<Token|string> $k
	 *     Commonly a string, but where the key might be templated,
	 *     this can be an array of tokens even.
	 * @param string|Token|array<Token|string>|KV[] $v
	 *     The value: string, token, of an array of tokens
	 * @param ?KVSourceRange $srcOffsets wikitext source offsets
	 * @param ?string $ksrc
	 * @param ?string $vsrc
	 */
	public function __construct(
		$k, $v, ?KVSourceRange $srcOffsets = null, ?string $ksrc = null,
		?string $vsrc = null
	) {
		$this->k = $k;
		$this->v = $v;
		$this->srcOffsets = $srcOffsets;
		$this->ksrc = $ksrc;
		$this->vsrc = $vsrc;
	}

	public function __clone() {
		// Deep clone non-primitive properties
		foreach ( [ 'k', 'v' ] as $f ) {
			if ( is_array( $this->$f ) ) {
				$this->$f = Utils::cloneArray( $this->$f );
			} elseif ( is_object( $this->$f ) ) {
				$this->$f = clone $this->$f;
			}
		}
		if ( $this->srcOffsets !== null ) {
			$this->srcOffsets = clone $this->srcOffsets;
		}
	}

	/**
	 * BUG: When there are multiple matching attributes, Sanitizer lets the last one win
	 * whereas this method is letting the first one win. This can introduce subtle bugs!
	 *
	 * Lookup a string key in a KV array and return the first matching KV object
	 *
	 * @param KV[]|null $kvs
	 * @param string $key
	 * @return ?KV
	 */
	public static function lookupKV( ?array $kvs, string $key ): ?KV {
		if ( $kvs === null ) {
			return null;
		}

		foreach ( $kvs as $kv ) {
			// PORT-FIXME: JS trim() will remove non-ASCII spaces (such as NBSP) too,
			// while PHP's won't. Does that matter?
			if ( is_string( $kv->k ) && trim( $kv->k ) === $key ) {
				return $kv;
			}
		}

		return null;
	}

	/**
	 * Lookup a string key (first occurrence) in a KV array
	 * and return the value of the KV object
	 *
	 * @param KV[]|null $kvs
	 * @param string $key
	 * @return string|Token|array<Token|string>|null
	 */
	public static function lookup( ?array $kvs, string $key ) {
		$kv = self::lookupKV( $kvs, $key );
		// PORT_FIXME: Potential bug lurking here ... if $kv->v is an array
		// this will return a copy, which if modified will not reflect
		// in the original KV object.
		return $kv->v ?? null;
	}

	/**
	 * Return the key portion of the KV's source offsets, or else null
	 * if no source offsets are known.
	 * @return SourceRange|null
	 */
	public function keyOffset(): ?SourceRange {
		// @phan-suppress-next-line PhanCoalescingNeverNull $this->srcOffsets is nullable
		return $this->srcOffsets->key ?? null;
	}

	/**
	 * Return the value portion of the KV's source offsets, or else null
	 * if no source offsets are known.
	 * @return SourceRange|null
	 */
	public function valueOffset(): ?SourceRange {
		// @phan-suppress-next-line PhanCoalescingNeverNull $this->srcOffsets is nullable
		return $this->srcOffsets->value ?? null;
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		$ret = [ "k" => $this->k, "v" => $this->v ];
		if ( $this->srcOffsets ) {
			$ret["srcOffsets"] = $this->srcOffsets;
		}
		if ( isset( $this->ksrc ) ) {
			$ret["ksrc"] = $this->ksrc;
		}
		if ( isset( $this->vsrc ) ) {
			$ret["vsrc"] = $this->vsrc;
		}
		return $ret;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		return $this->jsonSerialize();
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self(
			$json['k'], $json['v'],
			$json['srcOffsets'] ?? null,
			$json['ksrc'] ?? null,
			$json['vsrc'] ?? null
		);
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		switch ( $keyName ) {
			case 'k':
			case 'v':
				// Hint these as "array of Token" which is the most common
				// thing after "string".
				return Hint::build( Token::class, Hint::INHERITED, Hint::LIST );
			case 'srcOffsets':
				return Hint::build( KVSourceRange::class, Hint::USE_SQUARE );
			default:
				return null;
		}
	}
}
