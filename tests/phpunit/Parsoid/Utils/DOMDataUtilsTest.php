<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Utils;

use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\HtmlPageBundle;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Wt2Html\XHtmlSerializer;

/**
 * @coversDefaultClass  \Wikimedia\Parsoid\Utils\DOMDataUtils
 */
class DOMDataUtilsTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers ::storeInPageBundle
	 */
	public function testStoreInPageBundle() {
		$dpb = DomPageBundle::fromHtmlPageBundle( HtmlPageBundle::newEmpty(
			"<p>Hello, world</p>"
		) );
		DOMDataUtils::prepareDoc( $dpb->doc );
		$p = DOMCompat::querySelector( $dpb->doc, 'p' );
		DOMDataUtils::storeInPageBundle( $dpb, $p, (object)[
			'parsoid' => [ 'go' => 'team' ],
			'mw' => [ 'test' => 'me' ],
		], DOMDataUtils::usedIdIndex( new MockSiteConfig( [] ), $p->ownerDocument ) );
		$id = DOMCompat::getAttribute( $p, 'id' ) ?? '';
		$this->assertNotEquals( '', $id );
		// Use the 'native' getElementById, not DOMCompat::getElementById,
		// in order to test T232390.
		$el = $dpb->doc->getElementById( $id );
		$this->assertEquals( $p, $el );
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
		$this->assertNull( DOMDataUtils::getAttributeDom( $p, $attr ) );

		// Private parsoid attribute
		$attr = 'data-mw-foo';
		$this->assertNull( DOMDataUtils::getAttributeObject( $p, $attr, SampleRichData::hint() ) );
		$this->assertNull( DOMDataUtils::getAttributeDom( $p, $attr ) );
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
		$html = XHtmlSerializer::serialize( $p )['html'];
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
		$html = XHtmlSerializer::serialize( $p )['html'];
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
		$html = XHtmlSerializer::serialize( $p )['html'];
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

		// Set a rich data property that contains a nested DocumentFragment as
		// property.
		$frag = $doc->createDocumentFragment();
		DOMUtils::setFragmentInnerHTML( $frag, "Nested and <b>bold</b>!" );
		$rdD = new SampleNestedRichData( null, $frag );
		DOMDataUtils::setAttributeObject( $p, 'data-mw-bar', $rdD );
		// Sanity check
		$rd2 = DOMDataUtils::getAttributeObject( $p, 'data-mw-bar', SampleNestedRichData::class );
		$this->assertInstanceOf( SampleNestedRichData::class, $rd2 );
		$this->assertSame( $frag, $rd2->df );

		// Serialize and deserialize
		DOMDataUtils::visitAndStoreDataAttribs( $p, [ 'discardDataParsoid' => true ] );
		$html = XHtmlSerializer::serialize( $p )['html'];
		$this->assertSame(
			'<p data-mw-foo=\'{"rich":{"bar":"nested!"}}\' data-mw-bar=\'{"html":{"_h":"Nested and &lt;b>bold&lt;/b>!"}}\'>Hello, world</p>',
			$html
		);

		DOMDataUtils::visitAndLoadDataAttribs( $p, [] );

		// Values should be preserved!
		$rd3 = DOMDataUtils::getAttributeObject( $p, 'data-mw-foo', SampleNestedRichData::class );
		$this->assertInstanceOf( SampleNestedRichData::class, $rd3 );
		$this->assertInstanceOf( SampleRichData::class, $rd3->foo );
		$this->assertEquals( 'nested!', $rd3->foo->foo );

		$rd4 = DOMDataUtils::getAttributeObject( $p, 'data-mw-bar', SampleNestedRichData::class );
		$this->assertInstanceOf( SampleNestedRichData::class, $rd4 );
		$this->assertInstanceOf( DocumentFragment::class, $rd4->df );
		$this->assertMatchesRegularExpression(
			"|Nested and <b data-object-id=\"\d\">bold</b>!|",
			DOMUtils::getFragmentInnerHTML( $rd4->df )
		);
		// (although object identity is not)
		$this->assertNotSame( $rd, $rd3 );
		$this->assertNotSame( $rd->foo, $rd3->foo );
		$this->assertNotSame( $rdD, $rd4 );
		$this->assertNotSame( $rdD->df, $rd4->df );
	}

	/**
	 * @covers ::getAttributeDom
	 * @covers ::getAttributeDomDefault
	 * @covers ::removeAttributeDom
	 */
	public function testRichAttributeDom() {
		$f = [];
		$doc = ContentUtils::createAndLoadDocument( "<p>Hello, world</p>" );
		$p = DOMCompat::querySelector( $doc, 'p' );
		$attrNames = [ 'title', 'data-mw-foo' ];
		foreach ( $attrNames as $attr ) {
			$this->assertNull( DOMDataUtils::getAttributeDom( $p, $attr ) );
			// Default value sets as a side-effect
			$frag = DOMDataUtils::getAttributeDomDefault( $p, $attr );
			$this->assertInstanceOf( DocumentFragment::class, $frag );
			$this->assertNull( $frag->firstChild );
			// Save this fragment for the second half of the test
			$f[$attr] = $frag;
			// No default value this time.
			$frag2 = DOMDataUtils::getAttributeDom( $p, $attr );
			$this->assertSame( $frag, $frag2 );
			// Object is live
			DOMUtils::setFragmentInnerHTML( $frag, "This is pretty <b>bold</b>!" );
			$frag3 = DOMDataUtils::getAttributeDom( $p, $attr );
			$this->assertInstanceOf( DocumentFragment::class, $frag3 );
			$this->assertNotNull( $frag3->firstChild );
			$this->assertEquals( "This is pretty <b>bold</b>!", DOMUtils::getFragmentInnerHTML( $frag3 ) );
			// A "simple" dom fragment (ie, plain string value)
			// Note that I'm setting the value here using inner HTML just so
			// I don't have to create an inner Text node, but as a result the
			// value I set needs to be HTML entity-encoded.
			$frag4 = DOMDataUtils::getAttributeDomDefault( $p, $attr . '2' );
			DOMUtils::setFragmentInnerHTML( $frag4, 'rock &amp; roll' );
			$this->assertEquals( 'rock & roll', $frag4->firstChild->nodeValue );
			$this->assertEquals( 'rock &amp; roll', DOMCompat::getInnerHTML( $frag4 ) );
			// If I set the "internal" value of the Text node directly, I
			// don't have to HTML encode the value, but it would be HTML
			// encoded properly during serialization to HTML.
			$frag4->firstChild->nodeValue = 'ebb & flow';
			$this->assertEquals( 'ebb & flow', $frag4->firstChild->nodeValue );
			$this->assertEquals( 'ebb &amp; flow', DOMCompat::getInnerHTML( $frag4 ) );
		}
		// Serialize and deserialize (both serializations)
		foreach ( [ true, false ] as $useFragmentBank ) {
			$html = DomPageBundle::fromLoadedDocument( $doc, [
				'useFragmentBank' => $useFragmentBank,
				'discardDataParsoid' => true,
				'siteConfig' => new MockSiteConfig( [] ),
			] )->toInlineAttributeHtml();
			$this->assertSame(
				$useFragmentBank ?
				"<!DOCTYPE html>\n<html><head>" .
				'<template data-tid="g/SsaX6L">This is pretty <b>bold</b>!</template>' .
				'<template data-tid="ie1lOoOR">ebb &amp; flow</template>' .
				'<template data-tid="g/SsaX6L-1">This is pretty <b>bold</b>!</template>' .
				'<template data-tid="ie1lOoOR-1">ebb &amp; flow</template>' .
				'</head><body><p ' .
				'title="This is pretty bold!" ' .
				'typeof="mw:ExpandedAttrs" ' .
				'title2="ebb &amp; flow" ' .
				'data-mw=\'{"attribs":[["title",{"_t":"g/SsaX6L"}],["title2",{"_t":"ie1lOoOR"}]]}\' ' .
				'data-mw-foo=\'{"_t":"g/SsaX6L-1"}\' ' .
				'data-mw-foo2=\'{"_t":"ie1lOoOR-1"}\'>' .
				'Hello, world</p>' .
				'</body></html>' :

				"<!DOCTYPE html>\n<html><head></head><body>" .
				'<p ' .
				'typeof="mw:ExpandedAttrs" ' .
				'title="This is pretty bold!" ' .
				'title2="ebb &amp; flow" ' .
				'data-mw=\'{"attribs":[' .
				'["title",{"_h":"This is pretty &lt;b>bold&lt;/b>!"}],' .
				'["title2",{"_h":"ebb &amp;amp; flow"}]]}\' ' .
				'data-mw-foo=\'{"_h":"This is pretty &lt;b>bold&lt;/b>!"}\' ' .
				'data-mw-foo2=\'{"_h":"ebb &amp;amp; flow"}\'>' .
				'Hello, world</p>' .
				'</body></html>',
				$html
			);
			$doc = ContentUtils::createAndLoadDocument( $html );
			$p = DOMCompat::querySelector( $doc, 'p' );
			foreach ( $attrNames as $attr ) {
				// Values should be preserved!
				$frag5 = DOMDataUtils::getAttributeDom( $p, $attr );
				$this->assertInstanceOf( DocumentFragment::class, $frag5 );
				$this->assertNotNull( $frag5->firstChild );
				$this->assertSame( 1, preg_match(
					"|This is pretty <b data-object-id=\"\\d+\">bold</b>!|",
					DOMUtils::getFragmentInnerHTML( $frag5 )
				) );
				// (although object identity is not)
				$this->assertNotSame( $f[$attr], $frag5 );
				// "Upgrade" of plain string value.
				$frag6 = DOMDataUtils::getAttributeDom( $p, $attr . '2' );
				$this->assertInstanceOf( DocumentFragment::class, $frag6 );
				$this->assertNotNull( $frag6->firstChild );
				$this->assertEquals(
					"ebb &amp; flow",
					DOMUtils::getFragmentInnerHTML( $frag6 )
				);
				// Still live
				$meta = $doc->createElement( "meta" );
				$frag6->appendChild( $meta );
				$this->assertEquals(
					"ebb &amp; flow<meta/>",
					DOMUtils::getFragmentInnerHTML( $frag6 )
				);
				// reset for next serialization
				$f[$attr] = $frag5;
				$meta->parentNode->removeChild( $meta );
			}
		}
		// Verify that nested document fragments work as well
		foreach ( $attrNames as $attr ) {
			$frag3 = DOMDataUtils::getAttributeDom( $p, $attr );
			// Inner fragment can itself have embedded HTML
			$b = DOMCompat::querySelector( $frag3, 'b' );
			foreach ( $attrNames as $attr2 ) {
				$frag3b = DOMDataUtils::getAttributeDomDefault( $b, $attr2 );
				DOMUtils::setFragmentInnerHTML( $frag3b, '<b>be bold</b>' );
				$this->assertEquals(
					'<b>be bold</b>',
					DOMUtils::getFragmentInnerHTML( DOMDataUtils::getAttributeDom( $b, $attr2 ) )
				);
			}
			DOMDataUtils::removeAttributeDom( $p, $attr . '2' );
		}
		// Serialize and deserialize (both serializations)
		foreach ( [ true, false ] as $useFragmentBank ) {
			$html = DomPageBundle::fromLoadedDocument( $doc, [
				'useFragmentBank' => $useFragmentBank,
				'discardDataParsoid' => true,
				'siteConfig' => new MockSiteConfig( [] ),
			] )->toInlineAttributeHtml();
			$this->assertSame(
				$useFragmentBank ?
				"<!DOCTYPE html>\n<html><head>" .
				'<template data-tid="uOo/VU3m"><b>be bold</b></template>' .
				'<template data-tid="uOo/VU3m-1"><b>be bold</b></template>' .
				'<template data-tid="g/SsaX6L">This is pretty <b title="be bold" typeof="mw:ExpandedAttrs" data-mw=\'{"attribs":[["title",{"_t":"uOo/VU3m"}]]}\' data-mw-foo=\'{"_t":"uOo/VU3m-1"}\'>bold</b>!</template>' .
				'<template data-tid="uOo/VU3m-2"><b>be bold</b></template>' .
				'<template data-tid="uOo/VU3m-3"><b>be bold</b></template>' .
				'<template data-tid="g/SsaX6L-1">This is pretty <b title="be bold" typeof="mw:ExpandedAttrs" data-mw=\'{"attribs":[["title",{"_t":"uOo/VU3m-2"}]]}\' data-mw-foo=\'{"_t":"uOo/VU3m-3"}\'>bold</b>!</template>' .
				'</head><body><p ' .
				'title="This is pretty bold!" ' .
				'typeof="mw:ExpandedAttrs" ' .
				'data-mw=\'{"attribs":[["title",{"_t":"g/SsaX6L"}]]}\' ' .
				'data-mw-foo=\'{"_t":"g/SsaX6L-1"}\'>Hello, world</p>' .
				'</body></html>' :

				"<!DOCTYPE html>\n<html><head></head><body>" .

				'<p ' .
				'typeof="mw:ExpandedAttrs" ' .
				'title="This is pretty bold!" ' .
				'data-mw=\'{"attribs":[["title",{"_h":' .
				'"This is pretty &lt;b typeof=\"mw:ExpandedAttrs\" ' .
				'title=\"be bold\" ' .
				'data-mw=&apos;{\"attribs\":[[\"title\",{\"_h\":' .
				'\"&amp;lt;b>be bold&amp;lt;/b>\"}]]}&apos; ' .
				'data-mw-foo=&apos;{\"_h\":\"&amp;lt;b>be bold&amp;lt;/b>\"}&apos;>bold&lt;/b>!"}]]}\' ' .
				'data-mw-foo=\'{"_h":' .
				'"This is pretty &lt;b typeof=\"mw:ExpandedAttrs\" ' .
				'title=\"be bold\" ' .
				'data-mw=&apos;{\"attribs\":[[\"title\",{\"_h\":' .
				'\"&amp;lt;b>be bold&amp;lt;/b>\"}]]}&apos; ' .
				'data-mw-foo=&apos;{\"_h\":' .
				'\"&amp;lt;b>be bold&amp;lt;/b>\"}&apos;>bold&lt;/b>!"}\'>Hello, world</p>' .
				'</body></html>',
				$html
			);
			$doc = ContentUtils::createAndLoadDocument( $html );
			$p = DOMCompat::querySelector( $doc, 'p' );
			foreach ( $attrNames as $attr ) {
				$f = DOMDataUtils::getAttributeDOM( $p, $attr );
				$b = DOMCompat::querySelector( $f, 'b' );
				foreach ( $attrNames as $attr2 ) {
					$f2 = DOMDataUtils::getAttributeDOM( $b, $attr2 );
					$this->assertNotNull( $f2 );
					$this->assertSame( 1, preg_match(
						"|<b data-object-id=\"\\d+\">be bold</b>|",
						DOMUtils::getFragmentInnerHTML( $f2 )
					) );
				}
			}
		}
	}

	/**
	 * @covers ::getAttributeDom
	 * @covers ::getAttributeDomDefault
	 * @covers ::removeAttributeDom
	 * @dataProvider provideUseFragmentBank
	 */
	public function testRichAttributeDomPageBundle( bool $useFragmentBank ) {
		$env = new MockEnv( [] );
		$doc = ContentUtils::createAndLoadDocument(
			"<p>Hello, world</p>", [ 'markNew' => false, ]
		);
		$p = DOMCompat::querySelector( $doc, 'p' );
		$dp = DOMDataUtils::getDataParsoid( $p );
		$dp->src = "test1";
		$df = DOMDataUtils::getAttributeDomDefault( $p, 'title' );
		DOMUtils::setFragmentInnerHTML( $df, '<b>be bold</b>' );
		$b = DOMCompat::querySelector( $df, 'b' );
		$dp2 = DOMDataUtils::getDataParsoid( $b );
		$dp2->src = "test2";

		// Serialize
		$html = DomPageBundle::fromLoadedDocument( $doc, [
			'useFragmentBank' => $useFragmentBank,
			'siteConfig' => new MockSiteConfig( [] ),
		] )->toSingleDocumentHtml();
		$this->assertSame(
			$useFragmentBank ?
			"<!DOCTYPE html>\n<html><head>" .
			'<template data-tid="uOo/VU3m"><b id="mwAQ">be bold</b></template>' .
			'<script id="mw-pagebundle" type="application/x-mw-pagebundle">' .
			'{"parsoid":{"counter":2,"ids":{' .
			'"mwAA":{},' .
			'"mwAQ":{"src":"test2"},' .
			'"mwAg":{"src":"test1"}}' .
			'},"mw":{"ids":[]}}</script></head>' .
			'<body id="mwAA"><p ' .
			'title="be bold" ' .
			'typeof="mw:ExpandedAttrs" ' .
			'data-mw=\'{"attribs":[["title",{"_t":"uOo/VU3m"}]]}\' ' .
			'id="mwAg">Hello, world</p></body></html>'
			:
			"<!DOCTYPE html>\n<html><head>" .
			'<script id="mw-pagebundle" type="application/x-mw-pagebundle">' .
			'{"parsoid":{"counter":2,"ids":{' .
			'"mwAA":{},' .
			'"mwAQ":{"src":"test2"},' .
			'"mwAg":{"src":"test1"}}' .
			'},"mw":{"ids":[]}}</script></head>' .
			'<body id="mwAA"><p ' .
			'title="be bold" ' .
			'typeof="mw:ExpandedAttrs" ' .
			'data-mw=\'{"attribs":[["title",{"_h":"&lt;b id=\"mwAQ\">be bold&lt;/b>"}]]}\' ' .
			'id="mwAg">Hello, world</p></body></html>',
			$html
		);

		// Reload data parsoid from page bundle
		$pb = DomPageBundle::fromSingleDocument( DOMUtils::parseHTML( $html ) );
		$doc = $pb->toDom();
		$p = DOMCompat::querySelector( $doc, 'p' );
		$dp = DOMDataUtils::getDataParsoid( $p );
		$this->assertSame( 'test1', $dp->src );
		$df = DOMDataUtils::getAttributeDom( $p, 'title' );
		$b = DOMCompat::querySelector( $df, 'b' );
		$dp = DOMDataUtils::getDataParsoid( $b );
		$this->assertSame( 'test2', $dp->src );
	}

	public static function provideUseFragmentBank() {
		yield 'fragment bank serialization' => [ true ];
		yield 'compatible serialization' => [ false ];
	}

	/**
	 * @covers ::cloneDocument
	 */
	public function testCloneDocument() {
		// Create a document with some data-parsoid and rich attributes
		$doc = ContentUtils::createAndLoadDocument(
			"<p>Hello, world</p>", [ 'markNew' => false, ]
		);
		$p = DOMCompat::querySelector( $doc, 'p' );
		$p_dp = DOMDataUtils::getDataParsoid( $p );
		$p_dp->src = "test1";
		$df = DOMDataUtils::getAttributeDomDefault( $p, 'title' );
		$this->assertSame( $doc, $df->ownerDocument );
		DOMUtils::setFragmentInnerHTML( $df, '<b>be bold</b>' );
		$b = DOMCompat::querySelector( $df, 'b' );
		$b_dp = DOMDataUtils::getDataParsoid( $b );
		$b_dp->src = "test2";
		// Now give our rich attribute its own rich attribute
		$dff = DOMDataUtils::getAttributeDomDefault( $b, 'title' );
		$this->assertSame( $doc, $dff->ownerDocument );
		DOMUtils::setFragmentInnerHTML( $dff, '<i>nice!</i>' );

		// Now clone the document!
		$doc2 = DOMDataUtils::cloneDocument( $doc );

		// And verify that the info is the same, but not reference-equal
		$this->assertNotSame( $doc, $doc2 );
		$p2 = DOMCompat::querySelector( $doc2, 'p' );
		$this->assertNotSame( $p, $p2 );
		$p2_dp = DOMDataUtils::getDataParsoid( $p2 );
		$this->assertNotSame( $p_dp, $p2_dp );
		$this->assertSame( 'test1', $p2_dp->src );
		$df2 = DOMDataUtils::getAttributeDom( $p2, 'title' );
		$this->assertSame( $doc2, $df2->ownerDocument );
		$this->assertNotSame( $df, $df2 );
		$this->assertStringEndsWith( '>be bold</b>', DOMUtils::getFragmentInnerHTML( $df2 ) );
		$b2 = DOMCompat::querySelector( $df2, 'b' );
		$this->assertNotSame( $b, $b2 );
		$b2_dp = DOMDataUtils::getDataParsoid( $b2 );
		$this->assertNotSame( $b_dp, $b2_dp );
		$this->assertSame( 'test2', $b2_dp->src );
		$dff2 = DOMDataUtils::getAttributeDom( $b2, 'title' );
		$this->assertSame( $doc2, $dff2->ownerDocument );
		$this->assertNotSame( $dff, $dff2 );
		$this->assertSame( '<i>nice!</i>', DOMUtils::getFragmentInnerHTML( $dff2 ) );
	}
}
