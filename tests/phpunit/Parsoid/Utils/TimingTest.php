<?php

namespace Test\Parsoid\Utils;

use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\Timing;

class TimingTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers \Wikimedia\Parsoid\Utils\Timing::fakeTiming
	 */
	public function testFakeTiming() {
		$siteConfig = new MockSiteConfig( [] );
		$timing = Timing::fakeTiming( $siteConfig, 1000 );
		$timing->end( 'example.statsd.key', 'example', [] );
		$this->assertContains( [ 'timing', 'example.statsd.key', 1000.0 ], $siteConfig->metrics()->log );
		$this->assertContains( [ 'timing', 'example', 1000.0 ], $siteConfig->metrics()->log );
	}
}
