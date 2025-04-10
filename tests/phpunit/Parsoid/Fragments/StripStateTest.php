<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Fragments;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodec;
use Wikimedia\Parsoid\Fragments\HtmlPFragment;
use Wikimedia\Parsoid\Fragments\PFragment;
use Wikimedia\Parsoid\Fragments\StripState;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Fragments\StripState
 */
class StripStateTest extends PFragmentTestCase {

	/**
	 * @covers ::new
	 * @covers ::isEmpty
	 * @covers ::addWtItem
	 * @covers ::containsStripMarker
	 * @covers ::startsWithStripMarker
	 * @covers ::endsWithStripMarker
	 * @covers ::splitWt
	 */
	public function testBasicOperation() {
		$ss = StripState::new();
		$this->assertTrue( $ss->isEmpty() );
		$marker = $ss->addWtItem( HtmlPFragment::newFromHtmlString( 'foo', null ) );
		$this->assertFalse( $ss->isEmpty() );

		$this->assertFalse( StripState::containsStripMarker( '' ) );
		$this->assertTrue( StripState::containsStripMarker( $marker ) );
		$this->assertTrue( StripState::containsStripMarker( "foo $marker" ) );
		$this->assertTrue( StripState::containsStripMarker( "$marker bar" ) );
		$this->assertTrue( StripState::containsStripMarker( "foo $marker bar" ) );

		$this->assertFalse( StripState::startsWithStripMarker( '' ) );
		$this->assertTrue( StripState::startsWithStripMarker( $marker ) );
		$this->assertFalse( StripState::startsWithStripMarker( "foo $marker" ) );
		$this->assertTrue( StripState::startsWithStripMarker( "$marker bar" ) );
		$this->assertFalse( StripState::startsWithStripMarker( "foo $marker bar" ) );

		$this->assertFalse( StripState::endsWithStripMarker( '' ) );
		$this->assertTrue( StripState::endsWithStripMarker( $marker ) );
		$this->assertTrue( StripState::endsWithStripMarker( "foo $marker" ) );
		$this->assertFalse( StripState::endsWithStripMarker( "$marker bar" ) );
		$this->assertFalse( StripState::endsWithStripMarker( "foo $marker bar" ) );

		$split = $ss->splitWt( "foo $marker bar" );
		$this->assertSame( 'foo ', $split[0] );
		$this->assertTrue( $split[1] instanceof HtmlPFragment );
		$this->assertSame( ' bar', $split[2] );
		$this->assertCount( 3, $split );
		$this->assertSame( [
			'foo ',
			[ 'html' => 'foo' ],
			' bar',
		], self::ser( $split ) );
	}

	/**
	 * @covers ::new
	 * @covers ::addWtItem
	 * @covers ::splitWt
	 * @covers ::__clone
	 * @covers ::addAllFrom
	 */
	public function testClone() {
		$ss = StripState::new();
		$foo = $ss->addWtItem( HtmlPFragment::newFromHtmlString( 'foo', null ) );
		$bar = $ss->addWtItem( HtmlPFragment::newFromHtmlString( 'bar', null ) );
		$wt = "a $foo b $bar c";
		$split = $ss->splitWt( $wt );
		$this->assertSame( [
			'a ',
			[ 'html' => 'foo' ],
			' b ',
			[ 'html' => 'bar' ],
			' c',
		], self::ser( $split ) );

		$ss2 = clone $ss;
		$this->assertSame( $split, $ss->splitWt( $wt ) );
		$this->assertSame( $split, $ss2->splitWt( $wt ) );

		$x = $ss->addWtItem( HtmlPFragment::newFromHtmlString( 'x', null ) );
		$y = $ss2->addWtItem( HtmlPFragment::newFromHtmlString( 'y', null ) );
		$this->assertTrue( $x !== $y );

		$this->assertSame( [
			'',
			[ 'html' => 'foo' ],
			'',
			[ 'html' => 'bar' ],
			'',
			[ 'html' => 'x' ],
			''
		], self::ser( $ss->splitWt( "$foo$bar$x" ) ) );

		$this->assertSame( [
			'',
			[ 'html' => 'foo' ],
			'',
			[ 'html' => 'bar' ],
			'',
			[ 'html' => 'y' ],
			''
		], self::ser( $ss2->splitWt( "$foo$bar$y" ) ) );

		$ss->addAllFrom( $ss2 );
		$this->assertSame( [
			'',
			[ 'html' => 'x' ],
			'',
			[ 'html' => 'y' ],
			'',
		], self::ser( $ss->splitWt( "$x$y" ) ) );
	}

	/**
	 * @covers ::new
	 * @covers ::addWtItem
	 * @covers ::splitWt
	 * @covers ::merge
	 */
	public function testMerge() {
		$ss1 = StripState::new();
		$x = $ss1->addWtItem( HtmlPFragment::newFromHtmlString( 'x', null ) );

		$ss2 = StripState::new();
		$y = $ss2->addWtItem( HtmlPFragment::newFromHtmlString( 'y', null ) );

		$ss3 = StripState::new();
		$z = $ss3->addWtItem( HtmlPFragment::newFromHtmlString( 'z', null ) );
		$a = $ss3->addWtItem( HtmlPFragment::newFromHtmlString( 'a', null ) );

		$ss = StripState::merge( $ss1, $ss2, $ss3 );
		$this->assertSame( [
			'a:',
			[ 'html' => 'a' ],
			' x:',
			[ 'html' => 'x' ],
			' y:',
			[ 'html' => 'y' ],
			' z:',
			[ 'html' => 'z' ],
			'',
		], self::ser( $ss->splitWt( "a:$a x:$x y:$y z:$z" ) ) );
	}

	private static function ser( array $split ): array {
		$codec = new JsonCodec();
		return $codec->toJsonArray(
			$split,
			Hint::build( PFragment::class, Hint::INHERITED, Hint::LIST )
		);
	}
}
