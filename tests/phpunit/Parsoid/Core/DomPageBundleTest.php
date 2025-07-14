<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Core;

use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\PageBundle;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;

/**
 * @coversDefaultClass  \Wikimedia\Parsoid\Core\DomPageBundle
 */
class DomPageBundleTest extends \PHPUnit\Framework\TestCase {
	/**
	 * @covers ::fromPageBundle
	 * @covers ::toSingleDocument
	 */
	public function testInjectPageBundle() {
		$dpb = DomPageBundle::fromPageBundle( PageBundle::newEmpty(
			"Hello, world"
		) );
		$doc = $dpb->toSingleDocument();
		// Note that we use the 'native' getElementById, not
		// DOMCompat::getElementById, in order to test T232390
		$el = $doc->getElementById( 'mw-pagebundle' );
		$this->assertNotNull( $el );
		$this->assertEquals( 'script', DOMCompat::nodeName( $el ) );
	}

	/**
	 * @covers ::fromSingleDocument
	 * @covers ::toInlineAttributeHtml
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
		$dpb = DomPageBundle::fromSingleDocument( $doc );
		self::assertIsArray( $dpb->parsoid['ids'] );
		$html2 = $dpb->toInlineAttributeHtml();
		$this->assertEquals( <<<'EOF'
<!DOCTYPE html>
<html><head>
    
  </head>
  <body><p id="mwAQ" data-parsoid='{"dsr":[0,12,0,0]}'>Hello, world</p></body></html>
EOF
			   , $html2 );
	}

	/**
	 * @covers ::fromLoadedDocument
	 * @covers ::toSingleDocumentHtml
	 */
	public function testFromLoadedDocument() {
		$html = <<<'EOF'
<!DOCTYPE html>
<html>
 <body>
  <p data-parsoid='{"dsr":[0,12,0,0]}'>Hello, world</p>
 </body>
</html>
EOF;
		$doc = ContentUtils::createAndLoadDocument( $html );
		$dpb = DomPageBundle::fromLoadedDocument( $doc );
		self::assertIsArray( $dpb->parsoid['ids'] );
		$html2 = $dpb->toSingleDocumentHtml();
		$this->assertEquals( <<<'EOF'
<!DOCTYPE html>
<html><head><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"parsoid":{"counter":0,"ids":{"mwAA":{"dsr":[0,12,0,0]}}},"mw":{"ids":[]}}</script></head><body>
  <p id="mwAA">Hello, world</p>
 
</body></html>
EOF
			   , $html2 );
	}

	/**
	 * @covers ::fromSingleDocument
	 * @covers ::fromLoadedDocument
	 * @dataProvider providePageBundleFragments
	 */
	public function testAddFragmentAndSerializeToPageBundle( $data ) {
		$dpb = DomPageBundle::fromSingleDocument(
			DOMUtils::parseHTML( $data['singleDocumentBefore'] )
		);
		self::assertIsArray( $dpb->parsoid['ids'] );
		$this->assertEquals( $data['pageBundleBefore'], $dpb->toJsonArray() );

		// Now create a new standalone fragment
		$doc = $dpb->toDom();
		$df = ContentUtils::createAndLoadDocumentFragment(
			$doc, $data['newFragment']
		);
		// Serialialize back to DomPageBundle.
		$dpb = DomPageBundle::fromLoadedDocument(
			$doc, fragments: [ 'hello' => $df ]
		);
		// And check that it looks right!
		$this->assertEquals( $data['pageBundleAfter'], $dpb->toJsonArray() );
	}

	/**
	 * @covers ::newFromJsonArray
	 * @covers ::toDom
	 * @covers ::toInlineAttributeHtml
	 * @dataProvider providePageBundleFragments
	 */
	public function testAddFragmentAndSerializeToInlineHtml( $data ) {
		$dpb = DomPageBundle::newFromJsonArray(
			$data['pageBundleAfter']
		);
		$html = $dpb->toInlineAttributeHtml( [], $fragments );
		$this->assertEquals( $data['inlineHtmlAfter'], $html );
		$this->assertEquals( $data['fragmentsAfter'], $fragments );
	}

	public static function providePageBundleFragments() {
		yield "basic" => [ [
			// An "single document pagebundle" format, with a DocumentFragment
			// embedded in the caption attribute.  Generated from
			// $ echo "[[File:Foobar.jpg|link=|'''bold stuff''': <span>x</span>]]"
			//   | php bin/parse.php --pageBundle --body_only=false
			'singleDocumentBefore' => <<<'EOF'
<!DOCTYPE html>
<html><head><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"parsoid":{"counter":6,"ids":{"mwAA":{"dsr":[0,59,0,0]},"mwAQ":{"dsr":[0,58,0,0]},"mwAg":{"dsr":[24,40,3,3]},"mwAw":{"stx":"html","dsr":[42,56,6,7]},"mwBA":{"optList":[{"ck":"link","ak":"link="},{"ck":"caption","ak":"'''bold stuff''': <span>x</span>"}],"dsr":[0,58,null,null]},"mwBQ":{},"mwBg":{"a":{"resource":"./File:Foobar.jpg","height":"28","width":"240"},"sa":{"resource":"File:Foobar.jpg"}}},"offsetType":"byte"},"mw":{"ids":[]}}</script></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}' id="mwBA"><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p>
EOF
	   ,
			'pageBundleBefore' => [
				'html' => <<<'HTML'
<!DOCTYPE html>
<html><head></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}' id="mwBA"><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p></body></html>
HTML
		  ,
				'parsoid' => [
					'counter' => 6,
					'ids' => [
						'mwAA' => [
							'dsr' => [ 0, 59, 0, 0 ],
						],
						'mwAQ' => [
							'dsr' => [ 0, 58, 0, 0 ],
						],
						'mwAg' => [
							'dsr' => [ 24, 40, 3, 3 ],
						],
						'mwAw' => [
							'stx' => 'html',
							'dsr' => [ 42, 56, 6, 7 ],
						],
						'mwBA' => [
							'optList' => [
								[
									'ck' => 'link',
									'ak' => 'link=',
								],
								[
									'ck' => 'caption',
									'ak' => '\'\'\'bold stuff\'\'\': <span>x</span>',
								],
							],
							'dsr' => [ 0, 58, null, null ],
						],
						'mwBQ' => [],
						'mwBg' => [
							'a' => [
								'resource' => './File:Foobar.jpg',
								'height' => '28',
								'width' => '240',
							],
							'sa' => [
								'resource' => 'File:Foobar.jpg',
							],
						],
					],
					'offsetType' => 'byte',
				],
				'mw' => [
					'ids' => [],
				],
				'version' => null,
				'headers' => null,
				'contentmodel' => null,
			],
			'newFragment' => '<p data-parsoid=\'{"dsr":[0,12,0,0]}\'>Hello, world</p>',
			'pageBundleAfter' => [
				'html' => <<<'HTML'
<!DOCTYPE html>
<html><head></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" id="mwBA" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}'><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p></body></html>
HTML
		  ,
				'parsoid' => [
					'counter' => 7,
					'ids' => [
						'mwAA' => [
							'dsr' => [ 0, 59, 0, 0 ],
						],
						'mwAQ' => [
							'dsr' => [ 0, 58, 0, 0 ],
						],
						'mwAg' => [
							'dsr' => [ 24, 40, 3, 3 ],
						],
						'mwAw' => [
							'stx' => 'html',
							'dsr' => [ 42, 56, 6, 7 ],
						],
						'mwBA' => [
							'optList' => [
								[
									'ck' => 'link',
									'ak' => 'link=',
								],
								[
									'ck' => 'caption',
									'ak' => '\'\'\'bold stuff\'\'\': <span>x</span>',
								],
							],
							'dsr' => [ 0, 58, null, null ],
						],
						'mwBQ' => (object)[],
						'mwBg' => [
							'a' => [
								'resource' => './File:Foobar.jpg',
								'height' => '28',
								'width' => '240',
							],
							'sa' => [
								'resource' => 'File:Foobar.jpg',
							],
						],
						'mwBw' => [
							'dsr' => [ 0, 12, 0, 0 ],
						],
					],
				],
				'mw' => [
					'ids' => [],
				],
				'version' => null,
				'headers' => null,
				'contentmodel' => null,
				'fragments' => [
					'hello' => '<p id="mwBw">Hello, world</p>',
				],
			],
			'inlineHtmlAfter' => <<<'HTML'
<!DOCTYPE html>
<html><head></head><body id="mwAA" data-parsoid='{"dsr":[0,59,0,0]}'><p id="mwAQ" data-parsoid='{"dsr":[0,58,0,0]}'><span class="mw-default-size" typeof="mw:File" id="mwBA" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}' data-parsoid='{"optList":[{"ck":"link","ak":"link="},{"ck":"caption","ak":"&apos;&apos;&apos;bold stuff&apos;&apos;&apos;: &lt;span>x&lt;/span>"}],"dsr":[0,58,null,null]}'><span title="bold stuff: x" id="mwBQ" data-parsoid="{}"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg" data-parsoid='{"a":{"resource":"./File:Foobar.jpg","height":"28","width":"240"},"sa":{"resource":"File:Foobar.jpg"}}'/></span></span></p></body></html>
HTML
	   ,
			'fragmentsAfter' => [
				'hello' => '<p id="mwBw" data-parsoid=\'{"dsr":[0,12,0,0]}\'>Hello, world</p>',
			],
		] ];
	}
}
