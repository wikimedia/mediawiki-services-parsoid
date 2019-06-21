<?php
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Wt2Html;

use Parsoid\Tests\MockEnv;
use Parsoid\Tokens\EndTagTk;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\TagTk;
use Parsoid\Utils\DOMCompat;
use Parsoid\Wt2Html\HTML5TreeBuilder;

class HTML5TreeBuilderTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers \Parsoid\Wt2Html\HTML5TreeBuilder
	 * @dataProvider provideTreeBuilder
	 */
	public function testTreeBuilder( $tokens, $expected ) {
		$mockEnv = new MockEnv( [] );
		$tb = new HTML5TreeBuilder( $mockEnv );
		$tb->processChunk( $tokens );
		$doc = $tb->finalizeDOM();
		$body = DOMCompat::getBody( $doc );
		$this->assertEquals( $expected, DOMCompat::getInnerHTML( $body ) );
	}

	public function provideTreeBuilder() {
		return [
			[
				[
					new TagTk( 'p' ),
					'Testing 123',
					new EndTagTk( 'p' ),
					new EOFTk()
				],
				'<p data-object-id="0"><meta typeof="mw:StartTag" data-stag="p:1" data-object-id="1"/>Testing 123</p><meta data-object-id="3" typeof="mw:EndTag" data-etag="p"/>'
			]
		];
	}

}
