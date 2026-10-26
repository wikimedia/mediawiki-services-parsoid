<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Mocks;

/**
 * For use by /bin/parse.php --metrics
 */
class MockMetrics {
	public array $log = [];

	/**
	 * @param string|array $key
	 * @param float $time Time in ms
	 */
	public function timing( $key, $time ) {
		$this->log[] = [ 'timing', $key, $time ];
	}

	public function histogram( string $key, float $value, array $buckets, array $labels ) {
		$this->log[] = [ 'histogram', $key, $value, $buckets, $labels ];
	}

	/**
	 * @param string|array $key
	 */
	public function increment( $key ) {
		$this->log[] = [ 'increment', $key ];
	}
}
