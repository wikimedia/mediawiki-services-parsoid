<?php

namespace Test\Parsoid\Ext;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Tokens\KV;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Ext\ParsoidExtensionAPI
 */
class ParsoidExtensionAPITest extends TestCase {

	/** @covers ::normalizeWhiteSpaceInArgs */
	public function testNormalizeOnly() {
		$extArgs = [
			new KV( 'name', 'foo  bar' ),
			new KV( 'details', ' foo  bar bar' ),
			new KV( 'follow', 'foo foo bar  ' )
		];

		$extApi = new ParsoidExtensionAPI( new MockEnv( [] ), [] );
		$extApi->normalizeWhiteSpaceInArgs( $extArgs, [ 'only' => [ 'details', 'follow' ] ] );
		$this->assertSame(
			json_encode( [
				new KV( 'name', 'foo  bar' ),
				new KV( 'details', 'foo bar bar' ),
				new KV( 'follow', 'foo foo bar' )
			] ),
			json_encode( $extArgs )
		);
	}

	/** @covers ::normalizeWhiteSpaceInArgs */
	public function testNormalizeExcept() {
		$extArgs = [
			new KV( 'name', 'foo  bar' ),
			new KV( 'details', ' foo  bar bar' ),
			new KV( 'follow', 'foo foo bar  ' )
		];

		$extApi = new ParsoidExtensionAPI( new MockEnv( [] ), [] );
		$extApi->normalizeWhiteSpaceInArgs( $extArgs, [ 'except' => [ 'details', 'follow' ] ] );
		$this->assertSame(
			json_encode( [
				new KV( 'name', 'foo bar' ),
				new KV( 'details', ' foo  bar bar' ),
				new KV( 'follow', 'foo foo bar  ' )
			] ),
			json_encode( $extArgs ),
		);
	}

	/** @covers ::normalizeWhiteSpaceInArgs */
	public function testNormalizeBoth() {
		$extArgs = [
			new KV( 'name', 'foo  bar' ),
			new KV( 'details', ' foo  bar bar' ),
			new KV( 'follow', 'foo foo bar  ' )
		];
		$before = json_encode( $extArgs );
		$extApi = new class( new MockEnv( [] ), [] ) extends ParsoidExtensionAPI {
			public bool $warned = false;

			public function log( string $prefix, ...$args ): void {
				if ( $prefix === 'warn' ) {
					$this->warned = true;
				}
			}
		};
		// These options are mutually exclusive and raise a warning
		$extApi->normalizeWhiteSpaceInArgs( $extArgs, [ 'except' => [ 'details' ], 'only' => [ 'follow' ] ] );
		$this->assertSame(
			$before,
			json_encode( $extArgs )
		);
		$this->assertTrue( $extApi->warned );
	}

	/** @covers ::normalizeWhiteSpaceInArgs */
	public function testNormalizeAll() {
		$extArgs = [
			new KV( 'name', 'foo  bar' ),
			new KV( 'details', ' foo  bar bar' ),
			new KV( 'follow', 'foo foo bar  ' )
		];

		$extApi = new ParsoidExtensionAPI( new MockEnv( [] ), [] );
		$extApi->normalizeWhiteSpaceInArgs( $extArgs );
		$this->assertSame(
			json_encode( [
				new KV( 'name', 'foo bar' ),
				new KV( 'details', 'foo bar bar' ),
				new KV( 'follow', 'foo foo bar' )
			] ),
			json_encode( $extArgs )
		);
	}

}
