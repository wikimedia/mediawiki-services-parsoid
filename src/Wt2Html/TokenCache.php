<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Wikimedia\Parsoid\Utils\Utils;

class TokenCache {
	/**
	 * @var array<string,array>
	 */
	private array $cache;
	/**
	 * Track how often a cacheable string is seen - used to reduce caching overheads
	 * by requiring a repeat threshold.
	 * @var array<string,int>
	 */
	private array $counts;
	/** How many times should a value be seen before it is cached? */
	private int $repeatThreshold;
	/** Should the value be cloned before caching and on a cache hit? */
	private bool $cloneValue;

	public function __construct( int $repeatThreshold, bool $cloneValue ) {
		$this->repeatThreshold = $repeatThreshold;
		$this->cloneValue = $cloneValue;
		$this->cache = [];
		$this->counts = [];
	}

	public function cache( string $key, array $value, ?string $sentinelValue = null ): void {
		$this->counts[$key] = ( $this->counts[$key] ?? 0 ) + 1;
		if ( $this->counts[$key] > $this->repeatThreshold ) {
			if ( $this->cloneValue ) {
				$value = Utils::cloneArray( $value );
			}
			$this->cache[$key] = [
				'sentinel' => $sentinelValue,
				'value' => $value
			];
		}
	}

	public function lookup( string $key, ?string $sentinelValue = null ): ?array {
		$res = $this->cache[$key] ?? null;
		if ( $res && $res['sentinel'] === $sentinelValue ) {
			$value = $res['value'];
			if ( $this->cloneValue ) {
				$value = Utils::cloneArray( $value );
			}
			return $value;
		} else {
			return null;
		}
	}
}
