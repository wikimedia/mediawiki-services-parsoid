<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Closure;
use Wikimedia\Parsoid\Core\Source;
use Wikimedia\Parsoid\Utils\Utils;

class PipelineContentCache {
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
	/**
	 * Should the value be cloned before caching and on a cache hit?
	 * If a callable is passed, it is used to clone the value.
	 * @var Closure|bool
	 */
	private $cloneValue;

	public function __construct( int $repeatThreshold, bool|Closure $cloneValue ) {
		$this->repeatThreshold = $repeatThreshold;
		$this->cloneValue = $cloneValue;
		$this->cache = [];
		$this->counts = [];
	}

	/**
	 * $key might be a hashed string and $sentinelValue exists to prevent
	 * false positive hits, where necessary. Cache users are responsible
	 * for managing this appropriately.
	 */
	public function cache( string $key, array $value, ?Source $source = null, ?string $sentinelValue = null ): void {
		$this->counts[$key] = ( $this->counts[$key] ?? 0 ) + 1;
		if ( $this->counts[$key] > $this->repeatThreshold ) {
			if ( $this->cloneValue instanceof Closure ) {
				$value = ( $this->cloneValue )( $value );
			} elseif ( $this->cloneValue ) {
				$value = Utils::cloneArray( $value );
			}
			$this->cache[$key] = [
				'sentinel' => $sentinelValue,
				'source' => $source,
				'value' => $value
			];
		}
	}

	public function lookup( string $key, ?string $sentinelValue = null ): ?array {
		$res = $this->cache[$key] ?? null;
		if ( $res && $res['sentinel'] === $sentinelValue ) {
			if ( $this->cloneValue instanceof Closure ) {
				$res['value'] = ( $this->cloneValue )( $res['value'] );
			} elseif ( $this->cloneValue ) {
				$res['value'] = Utils::cloneArray( $res['value'] );
			}
			return $res;
		} else {
			return null;
		}
	}
}
