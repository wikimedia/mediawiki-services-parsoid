<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Wt2Html\TT;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Core\DOMCompat;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\Core\SourceRange;
use Wikimedia\Parsoid\Ext\AnnotationStripper;
use Wikimedia\Parsoid\Ext\ExtensionTagHandler;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;
use Wikimedia\Parsoid\Wt2Html\TT\ExtensionHandler;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Wt2Html\TT\ExtensionHandler
 */
class ExtensionHandlerTest extends TestCase {

	private function createTag( $name = 'testtag' ): TagTk {
		$tag = new TagTk( 'extension' );
		$tag->addAttribute( 'name', $name );
		$tag->addAttribute( 'options', [
			new KV( 'totrim', '  this should  be trimmed ' ),
			new KV( 'tonorm', '  this should  be normalized ' ),
			new KV( 'keep', '  this should  stay as is ' ),
			new KV( 'default', '  this is handled  by default ' ),
			new KV( [ new TagTk( 'i' ), 'plop', new EndTagTk( 'i' ) ],
				' this should not crash  and is handled by default ' )
		] );
		$inner = 'test <strip1>one</strip1> <strip2>two</strip2> test';
		$source = "<$name>$inner</$name>";
		$tag->addAttribute( 'source', $source );
		$tag->dataParsoid = new DataParsoid();
		$tag->dataParsoid->extTagOffsets = new DomSourceRange(
			0, strlen( $source ), strlen( $name ) + 2, strlen( $name ) + 3
		);
		$tag->dataParsoid->tsr = new SourceRange( 0, 0 );
		$tag->dataParsoid->src = $source;
		return $tag;
	}

	/**
	 * @covers ::normalizeExtOptions
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
							"wt2html" => [
								"attributeWSNormalizationDefault" => "trim",
								"attributeWSNormalization" => [
									'totrim' => 'trim',
									'tonorm' => 'normalize',
									'keep' => 'keepspaces',
								],
							],
						],
						"handler" => [
							"factory" => [ self::class, 'dummyHandler' ],
							"args" => [
								// Expected body content
								'test <strip1>one</strip1> <strip2>two</strip2> test'
							],
						],
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

	public static function dummyHandler( ?string $expectedContent = null ) {
		return new class( $expectedContent ) extends ExtensionTagHandler {
			public function __construct( private ?string $expectedContent ) {
			}

			public function sourceToDom(
				ParsoidExtensionAPI $extApi, string $content, array $args
			) {
				// This call has side effects on the KVs in args
				Sanitizer::sanitizeTagAttrs( $extApi->getSiteConfig(), 'pre', null, $args );
				if ( $this->expectedContent !== null ) {
					TestCase::assertEquals( $this->expectedContent, $content );
				}
				$df = $extApi->getTopLevelDoc()->createDocumentFragment();
				DOMCompat::append( $df, $content );
				return $df;
			}
		};
	}

	public static function makeStripper( string $which ) {
		return new class( $which ) implements AnnotationStripper {
			public function __construct( private string $tagName ) {
			}

			/** @inheritDoc */
			public function stripAnnotations( string $s ): string {
				$t = $this->tagName;
				return preg_replace( "|<$t>.*?</$t>|", '', $s );
			}
		};
	}

	/** @covers ::stripAnnotations */
	public function testAnnotationStripper() {
		$tag = $this->createTag();

		$siteConfig = new MockSiteConfig( [] );
		$siteConfig->registerExtensionModule(
			[
				'name' => 'testextension',
				"tags" => [
					[
						"name" => "testtag",
						"options" => [
							'hasWikitextInput' => false,
						],
						"handler" => [
							"factory" => [ self::class, 'dummyHandler' ],
							"args" => [
								// Expected body content
								'test   test'
							],
						],
					]
				],
				"annotations" => [
					'tagNames' => [ 'strip1' ],
					'annotationStripper' => [
						'factory' => [ self::class, 'makeStripper' ],
						'args' => [ 'strip1' ],
					],
				],
			]
		);
		$siteConfig->registerExtensionModule(
			[
				'name' => 'teststripper',
				"annotations" => [
					'tagNames' => [ 'strip2' ],
					'annotationStripper' => [
						'factory' => [ self::class, 'makeStripper' ],
						'args' => [ 'strip2' ],
					],
				],
			]
		);

		$thp = new TokenHandlerPipeline( new MockEnv( [ 'siteConfig' => $siteConfig ] ), [], 'test' );
		$thp->setFrame( $this->createMock( Frame::class ) );
		$extensionHandler = new ExtensionHandler( $thp, [] );
		$extensionHandler->onTag( $tag );
	}

}
