<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Wt2Html;

use Wikimedia\Parsoid\Wt2Html\TokenCache;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Wt2Html\TokenCache
 */
class TokenCacheTest extends \PHPUnit\Framework\TestCase {
	/**
	 * @covers ::cache
	 * @covers ::lookup
	 */
	public function testCache() {
		$val = [ 1 ];

		// zero repeat threshold --> always cache
		$c = new TokenCache( 0, false );
		$c->cache( "a", $val );
		$this->assertSame( $val, $c->lookup( "a" ) );

		// repeat threshold two --> cache on 3rd occurrence
		$c = new TokenCache( 2, false );
		$c->cache( "a", $val );
		$this->assertNull( $c->lookup( "a" ) );
		$c->cache( "a", $val );
		$this->assertNull( $c->lookup( "a" ) );
		$c->cache( "a", $val );
		$this->assertSame( $val, $c->lookup( "a" ) );

		// sentinel values should be used to protect against cachekey collisions
		$c = new TokenCache( 0, false );
		$c->cache( "a", $val, "sentinel" );
		$this->assertNull( $c->lookup( "a" ) );
		$this->assertNull( $c->lookup( "a", "randomstring" ) );
		$this->assertSame( $val, $c->lookup( "a", "sentinel" ) );

		// Test cloning of cached values
		$val = [ new \stdClass ];

		// No cloning of cached values
		$c = new TokenCache( 0, false );
		$c->cache( "a", $val );
		$cachedVal = $c->lookup( "a" );
		$this->assertSame( $val, $cachedVal );

		// cloning of cached values
		$c = new TokenCache( 0, true );
		$c->cache( "a", $val );
		$cachedVal = $c->lookup( "a" );
		$this->assertNotSame( $val, $cachedVal );
		$this->assertEquals( $val, $cachedVal );
	}
}
