<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Utils;

use Parsoid\Utils\Alea;

/**
 * @coversDefaultClass Parsoid\Utils\Alea
 */
class AleaTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers ::__construct()
	 * @covers ::random()
	 */
	public function testTwoSeededValuesAreTheSame() {
		// make sure two seeded values are the same

		$prng1 = new Alea( 1 );
		$prng2 = new Alea( 3 );
		$prng3 = new Alea( 1 );

		$a = $prng1->random();
		$b = $prng2->random();
		$c = $prng3->random();

		$this->assertEquals( $a, $c, 'return values of the same seed' );
		$this->assertNotEquals( $a, $b, 'return values of different seed' );

		// test return values directly
		$this->assertEquals(
			$prng1->random(), $prng3->random(), 'same seed called again'
		);

		$this->assertNotEquals(
			$prng1->random(), $prng2->random(), 'different seed again'
		);
		$this->assertNotEquals(
			$prng1->random(), $prng3->random(), 'prng1 called more times than prng3'
		);
		$this->assertNotEquals(
			$prng2->random(), $prng3->random(), 'prng3 called again'
		);

		$this->assertEquals(
			$prng1->random(), $prng3->random(), 'call counts equal again'
		);
	}

	/**
	 * @covers ::__construct()
	 * @covers ::random()
	 */
	public function testKnownValues1() {
		$prng1 = new Alea( 12345 );

		// predefined numbers
		$values = [
			0.27138191112317145,
			0.19615925149992108,
			0.6810678059700876,
		];

		$this->assertEquals( $prng1->random(), $values[ 0 ], 'check value 1' );
		$this->assertEquals( $prng1->random(), $values[ 1 ], 'check value 2' );
		$this->assertEquals( $prng1->random(), $values[ 2 ], 'check value 3' );
	}

	/**
	 * @covers ::__construct()
	 * @covers ::random()
	 */
	public function testKnownValues2() {
		// First example from Johannes' website
		$prng1 = new Alea( 'my', 3, 'seeds' );

		// predefined numbers
		$values = [
			0.30802189325913787,
			0.5190450621303171,
			0.43635262292809784,
		];

		$this->assertEquals( $prng1->random(), $values[ 0 ], 'check value 1' );
		$this->assertEquals( $prng1->random(), $values[ 1 ], 'check value 2' );
		$this->assertEquals( $prng1->random(), $values[ 2 ], 'check value 3' );
	}

	/**
	 * @covers ::__construct()
	 * @covers ::random()
	 */
	public function testKnownValues3() {
		// Second example from Johannes' website
		$prng1 = new Alea( 1277182878230 );

		// predefined numbers
		$values = [
			0.6198398587293923,
			0.8385338634252548,
			0.3644848605617881,
		];

		$this->assertEquals( $prng1->random(), $values[ 0 ], 'check value 1' );
		$this->assertEquals( $prng1->random(), $values[ 1 ], 'check value 2' );
		$this->assertEquals( $prng1->random(), $values[ 2 ], 'check value 3' );
	}

	/**
	 * @covers ::__construct()
	 * @covers ::uint32()
	 */
	public function testUint32() {
		$prng1 = new Alea( 12345 );

		// predefined numbers
		$values = [
			1165576433,
			842497570,
			2925163953,
		];

		$this->assertEquals( $prng1->uint32(), $values[ 0 ], 'check value 1' );
		$this->assertEquals( $prng1->uint32(), $values[ 1 ], 'check value 2' );
		$this->assertEquals( $prng1->uint32(), $values[ 2 ], 'check value 3' );
	}

	/**
	 * @covers ::__construct()
	 * @covers ::uint32()
	 */
	public function testUint32_2() {
		// Third example from Johannes' website
		$prng1 = new Alea( '' );

		// predefined numbers
		$values = [
			715789690,
			2091287642,
			486307,
		];

		$this->assertEquals( $prng1->uint32(), $values[ 0 ], 'check value 1' );
		$this->assertEquals( $prng1->uint32(), $values[ 1 ], 'check value 2' );
		$this->assertEquals( $prng1->uint32(), $values[ 2 ], 'check value 3' );
	}

	/**
	 * @covers ::__construct()
	 * @covers ::fract53()
	 */
	public function testFract53() {
		$prng1 = new Alea( 12345 );

		// predefined numbers
		$values = [
			0.27138191116884325,
			0.6810678062004586,
			0.3407802057882554,
		];

		$this->assertEquals( $prng1->fract53(), $values[ 0 ], 'check value 1' );
		$this->assertEquals( $prng1->fract53(), $values[ 1 ], 'check value 2' );
		$this->assertEquals( $prng1->fract53(), $values[ 2 ], 'check value 3' );
	}

	/**
	 * @covers ::__construct()
	 * @covers ::fract53()
	 */
	public function testFract53_2() {
		// Fourth example from Johannes' website
		$prng1 = new Alea( '' );

		// predefined numbers
		$values = [
			0.16665777435687268,
			0.00011322738143160205,
			0.17695781631176488,
		];

		$this->assertEquals( $prng1->fract53(), $values[ 0 ], 'check value 1' );
		$this->assertEquals( $prng1->fract53(), $values[ 1 ], 'check value 2' );
		$this->assertEquals( $prng1->fract53(), $values[ 2 ], 'check value 3' );
	}

	/**
	 * @covers ::__construct()
	 * @covers ::importState()
	 * @covers ::exportState()
	 * @covers ::createWithState()
	 */
	public function testImportState() {
		// Import with Alea::importState()

		$prng1 = new Alea( 200 );

		// generate a few numbers
		$prng1->random();
		$prng1->random();
		$prng1->random();

		$e = $prng1->exportState();

		$prng4 = Alea::createWithState( $e );

		$this->assertEquals( $prng1->random(), $prng4->random(), 'synced prngs, call 1' );
		$this->assertEquals( $prng1->random(), $prng4->random(), 'synced prngs, call 2' );
		$this->assertEquals( $prng1->random(), $prng4->random(), 'synced prngs, call 3' );
	}

	/**
	 * @covers ::__construct()
	 * @covers ::importState()
	 * @covers ::exportState()
	 */
	public function testResyncTwoDifferingPrngs() {
		// Resync two differring prngs with Alea::importState()
		$prng1 = new Alea( 200000 );
		$prng2 = new Alea( 9000 );

		// generate a few numbers

		$this->assertNotEquals(
			$prng1->random(), $prng2->random(), 'just generating randomness, call 1'
		);
		$this->assertNotEquals(
			$prng1->random(), $prng2->random(), 'just generating randomness, call 2'
		);
		$this->assertNotEquals(
			$prng1->random(), $prng2->random(), 'just generating randomness, call 3'
		);

		// sync prng2 to prng1
		$prng2->importState( $prng1->exportState() );

		$this->assertEquals(
			$prng1->random(), $prng2->random(), 'imported prng, call 1'
		);
		$this->assertEquals(
			$prng1->random(), $prng2->random(), 'imported prng, call 2'
		);
		$this->assertEquals(
			$prng1->random(), $prng2->random(), 'imported prng, call 3'
		);

		// let's test they still sync up if called non-sequentially
		$prng1->random();
		$prng1->random();

		$a1 = $prng1->random();
		$b1 = $prng1->random();
		$c1 = $prng1->random();

		$prng2->random();
		$prng2->random();

		$a2 = $prng2->random();
		$b2 = $prng2->random();
		$c2 = $prng2->random();

		$this->assertEquals( $a1, $a2, 'return values should sync based on number of calls, call 1' );
		$this->assertEquals( $b1, $b2, 'return values should sync based on number of calls, call 2' );
		$this->assertEquals( $c1, $c2, 'return values should sync based on number of calls, call 3' );
	}
}
