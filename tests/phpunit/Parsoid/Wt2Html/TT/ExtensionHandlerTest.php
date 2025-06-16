<?php

namespace Test\Parsoid\Wt2Html\TT;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Ext\Pre\Pre;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;
use Wikimedia\Parsoid\Wt2Html\TT\ExtensionHandler;

class ExtensionHandlerTest extends TestCase {

	private function createTag(): TagTk {
		$tag = new TagTk( 'extension' );
		$tag->addAttribute( 'name', 'testtag' );
		$tag->addAttribute( 'options', [
			new KV( 'totrim', '  this should  be trimmed ' ),
			new KV( 'tonorm', '  this should  be normalized ' ),
			new KV( 'keep', '  this should  stay as is ' ),
			new KV( 'default', '  this is handled  by default ' ),
			new KV( [ new TagTk( 'i' ), 'plop', new EndTagTk( 'i' ) ],
				' this should not crash  and is handled by default ' )
		] );
		$tag->addAttribute( 'source', '<section>' );
		$tag->dataParsoid = new DataParsoid();
		$tag->dataParsoid->extTagOffsets = new DomSourceRange( 0, 0, 0, 0 );
		$tag->dataParsoid->tsr = new SourceRange( 0, 0 );
		$tag->dataParsoid->src = '';
		return $tag;
	}

	/**
	 * @covers \Wikimedia\Parsoid\Wt2Html\TT\ExtensionHandler::normalizeExtOptions
	 */
	public function testExtensionNormalization() {
		$tag = $this->createTag();

		$siteConfig = new MockSiteConfig( [] );
		$siteConfig->registerExtensionModule(
			[
				'name' => 'testextension',
				"tags" => [
					[
						"name" => "testtag",
						"options" => [
						"wt2html" =>
							[
								"attributeWSNormalizationDefault" => "trim",
								"attributeWSNormalization" =>
									[ 'totrim' => 'trim', 'tonorm' => 'normalize', 'keep' => 'keepspaces' ]
							]
						],
						// This handler isn't actually used by this test
						"handler" => [ "class" => Pre::class ]
					]
				]
			]
		);

		$thp = new TokenHandlerPipeline( new MockEnv( [ 'siteConfig' => $siteConfig ] ), [], 'test' );
		$thp->setFrame( $this->createMock( Frame::class ) );
		$extensionHandler = new ExtensionHandler( $thp, [] );

		$extensionHandler->onTag( $tag );
		$res = $tag->getAttributeV( 'options' );
		$this->assertEquals( [
			new KV( 'totrim', 'this should  be trimmed' ),
			new KV( 'tonorm', 'this should be normalized' ),
			new KV( 'keep', '  this should  stay as is ' ),
			new KV( 'default', 'this is handled  by default' ),
			new KV( 'plop', 'this should not crash  and is handled by default' )
		], $res );
	}

}
