<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Fragments;

use Wikimedia\JsonCodec\JsonCodec;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Fragments\HtmlPFragment;
use Wikimedia\Parsoid\Fragments\PFragment;
use Wikimedia\Parsoid\Fragments\WikitextPFragment;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Fragments\WikitextPFragment
 */
class WikitextPFragmentTest extends PFragmentTestCase {

	/**
	 * @covers ::isEmpty
	 * @covers ::newFromWt
	 * @covers ::newFromLiteral
	 * @covers ::concat
	 * @covers ::asDom
	 * @covers ::containsMarker
	 */
	public function testConcat() {
		$wt1 = WikitextPFragment::newFromLiteral( "[x]", new DomSourceRange( 0, 3, null, null ) );
		$wt2 = $this->wtFragment( "abc", 3 );
		$wt3 = $this->wtFragment( "[[Title]]", 6 );
		$f = WikitextPFragment::concat( $wt1, $wt2, $wt3 );
		$this->assertFalse( $f->isEmpty() );
		$this->assertFalse( $f->containsMarker() );

		$ext = $this->newExtensionAPI();
		$df = $f->asDom( $ext );
		$this->assertSame(
			'[x]abcTitle',
			$df->textContent
		);
	}

	/**
	 * @covers ::newFromSplitWt
	 * @covers ::trim
	 */
	public function testTrim() {
		// Check that trimming whitespace around a fragment returns the
		// fragment (and not a wikitext wrapper around it)
		$html = HtmlPFragment::newFromHtmlString( "<b>foo</b>", null );
		$f = WikitextPFragment::newFromSplitWt( [
			"  ",
			$html,
			"\t ",
		] );
		$trimmed = $f->trim();
		$this->assertSame( $html, $trimmed );
	}

	/**
	 * @covers ::newFromSplitWt
	 * @covers ::toJsonArray
	 * @covers ::newFromJsonArray
	 * @covers ::jsonClassHintFor
	 * @covers ::asHtmlString
	 * @covers ::containsMarker
	 * @covers ::killMarkers
	 */
	public function testCodec() {
		$f = WikitextPFragment::newFromSplitWt( [
			"begin",
			HtmlPFragment::newFromHtmlString( "<b>foo</b>", null ),
			"end"
		], new DomSourceRange( 0, 8, null, null ) );
		$this->assertTrue( $f->containsMarker() );

		$codec = new JsonCodec();
		$hint = PFragment::hint();
		$json = $codec->toJsonString( $f, $hint );
		$this->assertSame( '{"wt":["begin",{"html":"\u003Cb\u003Efoo\u003C/b\u003E"},"end"],"dsr":[0,8,null,null]}', $json );

		$f = $codec->newFromJsonString( $json, $hint );
		$ext = $this->newExtensionAPI();
		$this->assertSame( '<p data-parsoid=\'{"dsr":[0,8,0,0]}\'>begin<b data-parsoid="{}">foo</b>end</p>', $f->asHtmlString( $ext ) );
		$this->assertSame( 'beginend', $f->killMarkers() );
	}
}
