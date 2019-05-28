<?php

namespace Test\Parsoid\Ext\Pre;

use Parsoid\Ext\Pre\Pre;
use Parsoid\Tests\MockEnv;
use Parsoid\Utils\DOMCompat;
use PHPUnit\Framework\TestCase;
use Parsoid\Config\ParsoidExtensionAPI;

class PreTest extends TestCase {

	/**
	 * @covers \Parsoid\Ext\Pre\Pre::toDOM
	 */
	public function testToDOM() {
		$pre = new Pre();
		$env = new MockEnv( [] );
		$extApi = new ParsoidExtensionAPI( $env );
		$doc = $pre->toDOM( $extApi, 'abcd', [] );
		$pre = DOMCompat::querySelector( $doc, 'pre' );
		$this->assertNotNull( $pre );
		$this->assertSame( 'abcd', $pre->textContent );
	}

}
