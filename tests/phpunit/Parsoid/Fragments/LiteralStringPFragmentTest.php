<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Fragments;

use Wikimedia\JsonCodec\JsonCodec;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Fragments\LiteralStringPFragment;
use Wikimedia\Parsoid\Fragments\PFragment;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Fragments\LiteralStringPFragment
 */
class LiteralStringPFragmentTest extends PFragmentTestCase {

	/**
	 * @covers ::isEmpty
	 * @covers ::newFromLiteral
	 * @covers ::asDom
	 */
	public function testConcat() {
		$f = LiteralStringPFragment::newFromLiteral( "[x]&amp;", new DomSourceRange( 0, 3, null, null ) );
		$this->assertFalse( $f->isEmpty() );

		$ext = $this->newExtensionAPI();
		$df = $f->asDom( $ext );
		$this->assertSame(
			'[x]&amp;',
			$df->textContent
		);
	}

	/**
	 * @covers ::newFromLiteral
	 * @covers ::toJsonArray
	 * @covers ::newFromJsonArray
	 * @covers ::jsonClassHintFor
	 * @covers ::asHtmlString
	 */
	public function testCodec() {
		$f = LiteralStringPFragment::newFromLiteral( '"', new DomSourceRange( 0, 1, null, null ) );

		$codec = new JsonCodec();
		$hint = PFragment::hint();
		$json = $codec->toJsonString( $f, $hint );
		$this->assertSame( '{"lit":"\\"","dsr":[0,1,null,null]}', $json );

		$f = $codec->newFromJsonString( $json, $hint );
		$ext = $this->newExtensionAPI();
		$this->assertSame( '&quot;', $f->asHtmlString( $ext ) );
	}
}
