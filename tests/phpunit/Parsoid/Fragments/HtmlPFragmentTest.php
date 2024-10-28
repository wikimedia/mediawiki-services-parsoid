<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Fragments;

use Wikimedia\JsonCodec\JsonCodec;
use Wikimedia\Parsoid\Fragments\HtmlPFragment;
use Wikimedia\Parsoid\Fragments\PFragment;
use Wikimedia\Parsoid\Utils\DOMCompat;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Fragments\HtmlPFragment
 */
class HtmlPFragmentTest extends PFragmentTestCase {

	/**
	 * @covers ::isEmpty
	 * @covers ::newFromHtmlString
	 * @covers ::concat
	 * @covers ::asDom
	 */
	public function testConcat() {
		$ext = $this->newExtensionAPI();
		$html1 = HtmlPFragment::newFromHtmlString( '<b>', null );
		$html2 = HtmlPFragment::newFromHtmlString( 'foo', null );
		$html3 = HtmlPFragment::newFromHtmlString( '</b>', null );
		$f = HtmlPFragment::concat( $ext, $html1, $html2, $html3 );
		$this->assertFalse( $f->isEmpty() );
		$df = $f->asDom( $ext );
		$this->assertMatchesRegularExpression( '|<b data-object-id="\d">foo</b>|', DOMCompat::getInnerHTML( $df ) );
	}

	/**
	 * @covers ::newFromHtmlString
	 * @covers ::toJsonArray
	 * @covers ::newFromJsonArray
	 * @covers ::jsonClassHintFor
	 * @covers ::asHtmlString
	 */
	public function testCodec() {
		$ext = $this->newExtensionAPI();
		$html1 = HtmlPFragment::newFromHtmlString( '<b>', null );
		$html2 = HtmlPFragment::newFromHtmlString( 'foo', null );
		$html3 = HtmlPFragment::newFromHtmlString( '</b>', null );
		$f = HtmlPFragment::concat( $ext, $html1, $html2, $html3 );
		$codec = new JsonCodec();
		$hint = PFragment::hint();
		$json = $codec->toJsonString( $f, $hint );
		$f = $codec->newFromJsonString( $json, $hint );
		$this->assertSame( '<b>foo</b>', $f->asHtmlString( $ext ) );
	}
}
