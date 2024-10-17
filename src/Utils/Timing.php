<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\SiteConfig;

/**
 * A helper class to make it easier to compute timing metrics.
 */
class Timing {
	/**
	 * This is typically a StatsdDataFactoryInterface, but really could be
	 * anything which has a `timing()` method.  Set it to `null` to disable
	 * metrics.
	 *
	 * @var ?object
	 */
	private ?object $metrics;

	/**
	 * @var float
	 */
	private float $startTime;

	/**
	 * @var ?SiteConfig
	 */
	private ?SiteConfig $siteConfig;

	private ?float $elapsed;

	private function __construct( ?object $configOrMetrics, ?float $elapsed = null ) {
		if ( $configOrMetrics instanceof SiteConfig ) {
			$this->siteConfig = $configOrMetrics;
			$this->metrics = $configOrMetrics->metrics();
		} else {
			$this->siteConfig = null;
			$this->metrics = $configOrMetrics;
		}
		$this->startTime = self::millis();
		$this->elapsed = $elapsed;
	}

	/**
	 * Return the current number of milliseconds since the epoch, as a float.
	 */
	public static function millis(): float {
		return 1000 * microtime( true );
	}

	/**
	 * End this timing measurement, reporting it under the given `name`.
	 * @param ?string $statsdCompat
	 * @param ?string $name
	 * @param ?array $labels
	 * @return float Number of milliseconds reported
	 */
	public function end(
		?string $statsdCompat = null,
		?string $name = null,
		?array $labels = []
	): float {
		if ( $this->elapsed === null ) {
			$this->elapsed = self::millis() - $this->startTime;
		}
		if ( $this->metrics ) {
			Assert::invariant( $statsdCompat !== null, 'Recording metric without a key.' );
			$this->metrics->timing( $statsdCompat, $this->elapsed );
		}
		if ( $this->siteConfig ) {
			// Note that observeTiming takes a value in *milliseconds*
			// despite the name of the metric ending in `_seconds`
			$this->siteConfig->observeTiming( $name, $this->elapsed, $labels );
		}
		return $this->elapsed;
	}

	/**
	 * Override elapsed time of a timing instance
	 * @param SiteConfig $siteConfig
	 * @param float $value Value to measure in the metrics (milliseconds if timing)
	 * @return Timing
	 */
	public static function fakeTiming( SiteConfig $siteConfig, float $value ): Timing {
		return new Timing( $siteConfig, $value );
	}

	/**
	 * Start a timing measurement, logging it to the given `$metrics` object
	 * (which just needs to have a `timing()` method).
	 * @param ?object $configOrMetrics
	 * @return Timing
	 */
	public static function start( ?object $configOrMetrics = null ): Timing {
		return new Timing( $configOrMetrics );
	}
}
