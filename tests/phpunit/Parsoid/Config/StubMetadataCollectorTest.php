<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Config;

use Wikimedia\Parsoid\Config\StubMetadataCollector;
use Wikimedia\Parsoid\Core\MergeStrategy;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;

/**
 * @covers \Wikimedia\Parsoid\Config\StubMetadataCollector
 */
class StubMetadataCollectorTest extends \PHPUnit\Framework\TestCase {

	public function testAppendExtensionData() {
		$metadata = new StubMetadataCollector( new MockSiteConfig( [] ) );
		$metadata->appendExtensionData( 'mykey', 'foo' );
		$metadata->appendExtensionData( 'mykey', 'bar', MergeStrategy::UNION );
		$metadata->appendExtensionData( 'mykey', 'foo', MergeStrategy::UNION );
		$metadata->appendExtensionData( 'mykey', 3, MergeStrategy::UNION );
		$metadata->appendExtensionData( 'counter', 1, MergeStrategy::COUNTER );
		$metadata->appendExtensionData( 'counter', 43, MergeStrategy::COUNTER );
		$metadata->appendExtensionData( 'counter', 3, MergeStrategy::COUNTER );
		$metadata->appendExtensionData( 'counter', -5, MergeStrategy::COUNTER );

		$this->assertEqualsCanonicalizing(
			[ 'foo', 'bar', 3 ], $metadata->getExtensionData( 'mykey' )
		);
		$this->assertSame(
			42, $metadata->getExtensionData( 'counter' )
		);
	}
}
