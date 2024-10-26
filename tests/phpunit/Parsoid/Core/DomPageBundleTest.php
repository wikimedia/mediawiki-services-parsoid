<?php

namespace Test\Parsoid\Core;

use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\PageBundle;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;

/**
 * @coversDefaultClass  \Wikimedia\Parsoid\Core\DomPageBundle
 */
class DomPageBundleTest extends \PHPUnit\Framework\TestCase {
	/**
	 * @covers ::toSingleDocument
	 */
	public function testInjectPageBundle() {
		$dpb = DomPageBundle::fromPageBundle( new PageBundle(
			"Hello, world",
			[ 'counter' => -1, 'ids' => [], ],
			[ 'ids' => [], ],
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
		$pb = DomPageBundle::fromSingleDocument( $doc );
		self::assertIsArray( $pb->parsoid['ids'] );
	}

}
