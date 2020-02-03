<?php

namespace Test\Parsoid\Ext\Pre;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Config\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Ext\Pre\Pre;
use Wikimedia\Parsoid\Tests\MockEnv;
use Wikimedia\Parsoid\Utils\DOMCompat;

class PreTest extends TestCase {

	/**
	 * @covers \Wikimedia\Parsoid\Ext\Pre\Pre::toDOM
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
