<?php

namespace Test\Parsoid\Html2Wt;

use Parsoid\Html2Wt\SingleLineContext;
use PHPUnit\Framework\TestCase;

class SingleLineContextTest extends TestCase {

	/**
	 * @covers \Parsoid\Html2Wt\SingleLineContext
	 */
	public function testEnforced() {
		$ctx = new SingleLineContext();
		$this->assertFalse( $ctx->enforced() );
		$ctx->enforce();
		$this->assertTrue( $ctx->enforced() );
		$ctx->enforce();
		$this->assertTrue( $ctx->enforced() );
		$ctx->disable();
		$this->assertFalse( $ctx->enforced() );
		$ctx->disable();
		$this->assertFalse( $ctx->enforced() );
		$ctx->enforce();
		$this->assertTrue( $ctx->enforced() );
		$ctx->pop();
		$this->assertFalse( $ctx->enforced() );
		$ctx->pop();
		$this->assertFalse( $ctx->enforced() );
		$ctx->pop();
		$this->assertTrue( $ctx->enforced() );
	}

}
