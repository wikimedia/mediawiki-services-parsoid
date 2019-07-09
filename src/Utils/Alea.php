<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

class Alea {

	// From http://baagoe.com/en/RandomMusings/javascript/
	// Archived at:
	// https://web.archive.org/web/20120619002808/http://baagoe.org/en/wiki/Better_random_numbers_for_javascript
	// https://web.archive.org/web/20120502223108/http://baagoe.com/en/RandomMusings/javascript/

	private $s0, $s1, $s2;
	private $c;
	private $args;

	/**
	 * Create a new pseudo-random number generator.
	 * @param mixed ...$args Seeds for the PRNG.  Can be anything which can be
	 *   converted to a string with 'strval'.
	 */
	public function __construct( ...$args ) {
		// Johannes Baagøe <baagoe@baagoe.com>, 2010
		$s0 = 0;
		$s1 = 0;
		$s2 = 0;
		$c = 1;

		if ( count( $args ) == 0 ) {
			$args = [ gettimeofday( true ) ];
		}
		$mash = new Mash();
		$s0 = $mash->mash( ' ' );
		$s1 = $mash->mash( ' ' );
		$s2 = $mash->mash( ' ' );

		foreach ( $args as $a ) {
			$s0 -= $mash->mash( $a );
			if ( $s0 < 0 ) {
				$s0 += 1;
			}
			$s1 -= $mash->mash( $a );
			if ( $s1 < 0 ) {
				$s1 += 1;
			}
			$s2 -= $mash->mash( $a );
			if ( $s2 < 0 ) {
				$s2 += 1;
			}
		}

		$this->s0 = $s0;
		$this->s1 = $s1;
		$this->s2 = $s2;
		$this->c = $c;
		$this->args = $args;
	}

	/**
	 * Get a float with 32 bits of randomness.
	 * @return float
	 */
	public function random(): float {
		$t = 2091639 * $this->s0 + $this->c * 2.3283064365386963e-10; // 2^-32
		$this->s0 = $this->s1;
		$this->s1 = $this->s2;
		$this->c = (int)$t;
		$this->s2 = $t - ( $this->c );
		return $this->s2;
	}

	/**
	 * Get a random 32-bit unsigned integer.
	 * @return int
	 */
	public function uint32(): int {
		return intval( $this->random() * 0x100000000 ); // 2^32
	}

	/**
	 * Get a float with the full 53 bits of randomness.
	 * @return float
	 */
	public function fract53(): float {
		return $this->random() +
			( $this->random() * 0x200000 | 0 ) * 1.1102230246251565e-16; // 2^-53
	}

	public static function version() : string {
		return 'Alea 0.9';
	}

	public function args(): array {
		return $this->args;
	}

	// coverslide's additions to sync state between two generators

	/**
	 * @return array The exported state of this PRNG.
	 */
	public function exportState(): array {
		return [ $this->s0, $this->s1, $this->s2, $this->c ];
	}

	/**
	 * @param array $i The exported state of some other Alea PRNG.
	 */
	public function importState( array $i ): void {
		$this->s0 = $i[ 0 ];
		$this->s1 = $i[ 1 ];
		$this->s2 = $i[ 2 ];
		$this->c = $i[ 3 ];
	}

	/**
	 * Create a new generator synced with some exported state.
	 *
	 * @param array $i The exported state of some other Alea PRNG.
	 * @return Alea a new Alea PRNG.
		*/
	public static function createWithState( array $i ) : Alea {
		$random = new Alea();
		$random->importState( $i );
		return $random;
	}
}
