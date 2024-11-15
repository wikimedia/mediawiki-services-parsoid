<?php
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Utils;

use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\PageBundle;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Wt2Html\XMLSerializer;

/**
 * @coversDefaultClass  \Wikimedia\Parsoid\Utils\DOMDataUtils
 */
class DOMDataUtilsTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers ::injectPageBundle
	 */
	public function testInjectPageBundle() {
		// Note that injectPageBundle does not need a "prepared" document.
		$doc = DOMUtils::parseHTML( "Hello, world" );
		DOMDataUtils::injectPageBundle( $doc,
			PageBundle::newEmpty( '' )
		);
		// Note that we use the 'native' getElementById, not
		// DOMCompat::getElementById, in order to test T232390
		$el = $doc->getElementById( 'mw-pagebundle' );
		$this->assertNotNull( $el );
		$this->assertEquals( 'script', DOMCompat::nodeName( $el ) );
	}

	/**
	 * @covers ::storeInPageBundle
	 */
	public function testStoreInPageBundle() {
		$dpb = DomPageBundle::fromPageBundle( PageBundle::newEmpty(
			"<p>Hello, world</p>"
		) );
		DOMDataUtils::prepareDoc( $dpb->doc );
		$p = DOMCompat::querySelector( $dpb->doc, 'p' );
		DOMDataUtils::storeInPageBundle( $dpb, $p, (object)[
			'parsoid' => [ 'go' => 'team' ],
			'mw' => [ 'test' => 'me' ],
		], DOMDataUtils::usedIdIndex( $p ) );
		$id = DOMCompat::getAttribute( $p, 'id' ) ?? '';
		$this->assertNotEquals( '', $id );
		// Use the 'native' getElementById, not DOMCompat::getElementById,
		// in order to test T232390.
		$el = $dpb->doc->getElementById( $id );
		$this->assertEquals( $p, $el );
	}

	/**
	 * @covers ::extractPageBundle
	 */
	public function testExtractPageBundle() {
		$html = <<<'EOF'
<html>
  <head>
    <script id="mw-pagebundle" type="application/x-mw-pagebundle">
      {"parsoid":
      {"counter":1,"ids":{"mwAA":{"dsr":[0,13,0,0]},
      "mwAQ":{"dsr":[0,12,0,0]}},"offsetType":"byte"},"mw":{"ids":[]}}
    </script>
  </head>
  <body><p id="mwAQ">Hello, world</p>
EOF;
		$doc = DOMUtils::parseHTML( $html );
		$pb = DOMDataUtils::extractPageBundle( $doc );
		self::assertIsArray( $pb->parsoid['ids'] );
	}

	// Tests for rich attribute support

	/**
	 * @covers ::getAttributeObject
	 */
	public function testRichAttributeMissing() {
		$doc = ContentUtils::createAndLoadDocument( "<p>Hello, world</p>" );
		$p = DOMCompat::querySelector( $doc, 'p' );

		// Reserved HTML attribute
		$attr = 'class';
		$this->assertNull( DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() ) );

		// Private parsoid attribute
		$attr = 'data-mw-foo';
		$this->assertNull( DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() ) );
	}

	/**
	 * @covers ::getAttributeObject
	 */
	public function testRichAttributeBackCompat1() {
		$doc = ContentUtils::createAndLoadDocument(
			"<p foo='flattened!' data-mw='{\"attribs\":[[\"foo\",{\"bar\":42}]]}'>Hello, world</p>"
		);
		$p = DOMCompat::querySelector( $doc, 'p' );

		// Reserved HTML attribute
		$attr = 'foo';
		$rd = DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() );
		$this->assertInstanceOf( SampleRichData::class, $rd );
		$this->assertEquals( 42, $rd->foo );

		// Remove attribute, and data-mw.attribs should go away
		DOMDataUtils::removeAttributeObject( $p, $attr );

		// Reserialize
		DOMDataUtils::visitAndStoreDataAttribs( $p, [ 'discardDataParsoid' => true ] );
		$html = XMLSerializer::serialize( $p )['html'];
		$this->assertSame(
			'<p>Hello, world</p>',
			$html
		);
	}

	/**
	 * @covers ::getAttributeObject
	 */
	public function testRichAttributeBackCompat2() {
		$doc = ContentUtils::createAndLoadDocument(
			"<p foo='flattened!' data-mw='{\"attribs\":[[\"foo\",{\"bar\":42}],[{\"txt\":\"bar\",\"html\":\"&lt;b>bar&lt;/b>\"},{\"html\":\"xyz\"}]]}'>Hello, world</p>"
		);
		$p = DOMCompat::querySelector( $doc, 'p' );

		// Reserved HTML attribute
		$attr = 'foo';
		$rd = DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() );
		$this->assertInstanceOf( SampleRichData::class, $rd );
		$this->assertEquals( 42, $rd->foo );

		// Remove attribute but legacy value in data-mw.attribs should be
		// unaffected.
		DOMDataUtils::removeAttributeObject( $p, $attr );

		// Reserialize
		DOMDataUtils::visitAndStoreDataAttribs( $p, [ 'discardDataParsoid' => true ] );
		$html = XMLSerializer::serialize( $p )['html'];
		$this->assertSame(
			'<p' .
			' data-mw=\'{"attribs":[[{"txt":"bar","html":"&lt;b>bar&lt;/b>"},{"html":"xyz"}]]}\'' .
			'>Hello, world</p>',
			$html
		);
	}

	/**
	 * @covers ::getAttributeObject
	 * @covers ::getAttributeObjectDefault
	 */
	public function testRichAttributeObject() {
		$rd = [];
		$doc = ContentUtils::createAndLoadDocument( "<p>Hello, world</p>" );
		$p = DOMCompat::querySelector( $doc, 'p' );

		$attrNames = [ 'foo', 'data-mw-foo' ];
		foreach ( $attrNames as $attr ) {

			$this->assertNull( DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() ) );

			// Default value sets as a side-effect
			// Save this object for the second half of the test
			$rd[$attr] = DOMDataUtils::getAttributeObjectDefault( $p, $attr, SampleRichData::hint() );
			$this->assertInstanceOf( SampleRichData::class, $rd[$attr] );
			$this->assertEquals( 'default', $rd[$attr]->foo );
			// No default value this time.
			$rd2 = DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() );
			$this->assertSame( $rd[$attr], $rd2 );
			// Object is live
			$rd[$attr]->foo = 'car';
			$rd3 = DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() );
			$this->assertInstanceOf( SampleRichData::class, $rd3 );
			$this->assertEquals( 'car', $rd3->foo );
		}

		// Serialize and deserialize
		DOMDataUtils::visitAndStoreDataAttribs( $p, [ 'discardDataParsoid' => true ] );
		$html = XMLSerializer::serialize( $p )['html'];
		$this->assertSame(
			'<p' .
			' foo="flattened!"' .
			' typeof="mw:ExpandedAttrs"' .
			' data-mw=\'{"attribs":[["foo",{"bar":"car"}]]}\'' .
			' data-mw-foo=\'{"bar":"car"}\'' .
			'>' .
			'Hello, world</p>',
			$html
		);
		$doc = ContentUtils::createAndLoadDocument( $html );
		$p = DOMCompat::querySelector( $doc, 'p' );

		// Values should be preserved!
		foreach ( $attrNames as $attr ) {
			$rd4 = DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() );
			$this->assertInstanceOf( SampleRichData::class, $rd4 );
			$this->assertEquals( 'car', $rd4->foo );
			// (although object identity is not)
			$this->assertNotSame( $rd[$attr], $rd4 );
		}
	}

	/**
	 * @covers ::getAttributeObject
	 * @covers ::getAttributeObjectDefault
	 */
	public function testRichAttributeObjectNested() {
		$doc = ContentUtils::createAndLoadDocument( "<p>Hello, world</p>" );
		$p = DOMCompat::querySelector( $doc, 'p' );
		$this->assertNull( DOMDataUtils::getAttributeObject( $p, 'data-mw-foo', SampleRichData::hint() ) );

		// Set a rich data property that contains a nested SampleRichData object as
		// property.
		$rd = new SampleNestedRichData( new SampleRichData( 'nested!' ) );
		DOMDataUtils::setAttributeObject( $p, 'data-mw-foo', $rd );
		// Sanity check
		$rd2 = DOMDataUtils::getAttributeObject( $p, 'data-mw-foo', SampleNestedRichData::class );
		$this->assertInstanceOf( SampleNestedRichData::class, $rd2 );
		$this->assertInstanceOf( SampleRichData::class, $rd2->foo );

		// Serialize and deserialize
		DOMDataUtils::visitAndStoreDataAttribs( $p, [ 'discardDataParsoid' => true ] );
		$html = XMLSerializer::serialize( $p )['html'];
		$this->assertSame(
			'<p data-mw-foo=\'{"rich":{"bar":"nested!"}}\'>Hello, world</p>',
			$html
		);
		DOMDataUtils::loadDataAttribs( $p, [] );

		// Values should be preserved!
		$rd3 = DOMDataUtils::getAttributeObject( $p, 'data-mw-foo', SampleNestedRichData::class );
		$this->assertInstanceOf( SampleNestedRichData::class, $rd3 );
		$this->assertInstanceOf( SampleRichData::class, $rd3->foo );
		$this->assertEquals( 'nested!', $rd3->foo->foo );
		// (although object identity is not)
		$this->assertNotSame( $rd, $rd3 );
		$this->assertNotSame( $rd->foo, $rd3->foo );
	}
}
