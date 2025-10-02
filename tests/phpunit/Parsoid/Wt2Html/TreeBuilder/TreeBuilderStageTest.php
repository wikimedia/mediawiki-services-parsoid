<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Wt2Html\TreeBuilder;

use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Wt2Html\TreeBuilder\TreeBuilderStage;

class TreeBuilderStageTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers \Wikimedia\Parsoid\Wt2Html\TreeBuilder\TreeBuilderStage
	 * @dataProvider provideTreeBuilder
	 */
	public function testTreeBuilder( array $tokens, string $expected ) {
		$mockEnv = new MockEnv( [] );
		$tb = new TreeBuilderStage( $mockEnv );
		$tb->resetState( [ 'toplevel' => true ] );
		$tb->processChunk( $tokens );
		$body = $tb->finalizeDOM();
		$this->assertEquals(
			$expected, ContentUtils::ppToXML( $body, [ 'innerXML' => true ] )
		);
	}

	public static function provideTreeBuilder(): array {
		return [
			[
				[
					new TagTk( 'p' ),
					'Testing 123',
					new EndTagTk( 'p' ),
					new EOFTk()
				],
				'<p data-parsoid="{}">Testing 123</p>'
			]
		];
	}

}
