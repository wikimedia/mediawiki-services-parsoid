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
<html><head><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"parsoid":{"counter":1,"ids":{"mwAA":{},"mwAQ":{"dsr":[0,12,0,0]}}},"mw":{"ids":[]}}</script></head><body id="mwAA">
  <p id="mwAQ">Hello, world</p>
 
</body></html>
EOF
			   , $html2 );
	}

}
