<?php

namespace Parsoid\Utils;

/**
 * A helper class to make it easier to compute timing metrics.
 */
class Timing {
	/**
	 * This is typically a StatsdDataFactoryInterface, but really could be
	 * anything which has a `timing()` method.  Set it to `null` to disable
	 * metrics.
	 */
	private $metrics;
	/* @var float */
	private $startTime;

	private function __construct( $metrics ) {
		$this->metrics = $metrics;
		$this->startTime = $metrics ? self::millis() : 0; /* will not be used */
	}

	/**
	 * Return the current number of milliseconds since the epoch, as a float.
	 * @return float
	 */
	public static function millis(): float {
		return 1000 * microtime( true );
	}

	/**
	 * End this timing measurement, reporting it under the given `name`.
	 * @param string $name
	 */
	public function end( string $name ): void {
		if ( $this->metrics ) {
			$this->metrics->timing( $name, self::millis() - $this->startTime );
		}
	}

	/**
	 * Start a timing measurement, logging it to the given `$metrics` object
	 * (which just needs to have a `timing()` method).
	 * @param object|null $metrics
	 * @return Timing
	 */
	public static function start( $metrics ): Timing {
		return new Timing( $metrics );
	}
}
