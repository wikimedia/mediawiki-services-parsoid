<?php

namespace Test\Parsoid\Ext\Pre;

use Parsoid\Ext\Pre\Pre;
use Parsoid\Tests\MockEnv;
use Parsoid\Utils\DOMCompat;
use Parsoid\Wt2Html\TT\ParserState;
use PHPUnit\Framework\TestCase;

class PreTest extends TestCase {

	/**
	 * @covers \Parsoid\Ext\Pre\Pre::toDOM
	 */
	public function testToDOM() {
		$pre = new Pre();
		$state = new ParserState();
		$state->env = new MockEnv( [] );
		$doc = $pre->toDOM( $state, 'abcd', [] );
		$pre = DOMCompat::querySelector( $doc, 'pre' );
		$this->assertNotNull( $pre );
		$this->assertSame( 'abcd', $pre->textContent );
	}

}
