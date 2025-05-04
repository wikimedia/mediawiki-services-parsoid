<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Fragments;

use Wikimedia\JsonCodec\JsonClassCodec;
use Wikimedia\JsonCodec\JsonCodec;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Fragments\DomPFragment;
use Wikimedia\Parsoid\Fragments\HtmlPFragment;
use Wikimedia\Parsoid\Fragments\LiteralStringPFragment;
use Wikimedia\Parsoid\Fragments\PFragment;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Fragments\DomPFragment
 */
class DomPFragmentTest extends PFragmentTestCase {

	/**
	 * @covers ::isEmpty
	 * @covers ::castFromPFragment
	 * @covers ::concat
	 * @covers ::asDom
	 * @dataProvider provideRelease
	 */
	public function testConcat( bool $release ) {
		$ext = $this->newExtensionAPI();
		$dom1 = DomPFragment::castFromPFragment( $ext, HtmlPFragment::newFromHtmlString( '<b>a', null ) );
		$dom2 = DomPFragment::castFromPFragment( $ext, LiteralStringPFragment::newFromLiteral( 'b&c', null ) );
		$dom3 = DomPFragment::castFromPFragment( $ext, HtmlPFragment::newFromHtmlString( 'd</b>', null ) );
		$f = DomPFragment::concat( $ext, $release, $dom1, $dom2, $dom3 );
		$this->assertFalse( $f->isEmpty() );
		$this->assertTrue( $f->isValid() );
		$df = $f->asDom( $ext );
		$this->assertMatchesRegularExpression(
			'|<b data-object-id="\d">a</b>b&amp;cd|',
			DOMCompat::getInnerHTML( $df )
		);
		// Check that fragments have been released properly
		$this->assertSame( !$release, $dom1->isValid() );
		$this->assertSame( !$release, $dom2->isValid() );
		$this->assertSame( !$release, $dom3->isValid() );
	}

	public static function provideRelease() {
		yield 'no release' => [ false ];
		yield 'with release' => [ true ];
	}

	/**
	 * @covers ::newFromDocumentFragment
	 * @covers ::toJsonArray
	 * @covers ::newFromJsonArray
	 * @covers ::jsonClassHintFor
	 * @covers ::asHtmlString
	 */
	public function testCodec() {
		$ext = $this->newExtensionAPI();
		$df = $ext->getTopLevelDoc()->createDocumentFragment();
		DOMUtils::setFragmentInnerHTML( $df, "<b>foo</b>" );
		$f = DomPFragment::newFromDocumentFragment( $df, null );
		$codec = new JsonCodec();
		$codec->addCodecFor( DocumentFragment::class, new class( $ext ) implements JsonClassCodec {
			private ParsoidExtensionAPI $ext;

			public function __construct( ParsoidExtensionAPI $ext ) {
				$this->ext = $ext;
			}

			public function toJsonArray( $obj ): array {
				return [
					'html' => ContentUtils::ppToXML( $obj, [
						'innerXML' => true,
						'fragment' => true,
					] ),
				];
			}

			public function newFromJsonArray( string $className, array $json ) {
				return ContentUtils::createAndLoadDocumentFragment(
					$this->ext->getTopLevelDoc(),
					$json['html'],
					[ 'markNew' => true ]
				);
			}

			public function jsonClassHintFor( string $className, string $keyName ) {
				return null;
			}
		} );
		$hint = PFragment::hint();
		$json = $codec->toJsonString( $f, $hint );
		$f = $codec->newFromJsonString( $json, $hint );
		$this->assertSame( '<b data-parsoid="{}">foo</b>', $f->asHtmlString( $ext ) );
	}

	/**
	 * @covers ::newFromDocumentFragment
	 * @covers ::toJsonArray
	 * @covers ::newFromJsonArray
	 * @covers ::jsonClassHintFor
	 * @covers ::asHtmlString
	 */
	public function testIsEmpty() {
		$ext = $this->newExtensionAPI();
		$df = $ext->getTopLevelDoc()->createDocumentFragment();
		$f = DomPFragment::newFromDocumentFragment( $df, null );
		$this->assertTrue( $f->isEmpty() );
	}
}
