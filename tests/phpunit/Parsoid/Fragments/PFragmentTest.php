<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Fragments;

use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Fragments\HtmlPFragment;
use Wikimedia\Parsoid\Fragments\WikitextPFragment;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Fragments\PFragment
 */
class PFragmentTest extends PFragmentTestCase {

	/** @covers ::asHtmlString */
	public function testWtToDom() {
		$ext = $this->newExtensionAPI();
		$wt = "Hello, '''World'''";
		$dsr = new DomSourceRange( 0, strlen( $wt ), null, null );
		$pf = WikitextPFragment::newFromWt( $wt, $dsr );
		$html = $pf->asHtmlString( $ext );
		$this->assertSame( '<p data-parsoid=\'{"dsr":[0,18,0,0]}\'>Hello, <b data-parsoid=\'{"tsr":[7,10],"dsr":[7,18,3,3]}\'>World</b></p>', $html );
	}

	/** @covers ::asHtmlString */
	public function testWtToDom2() {
		$ext = $this->newExtensionAPI();
		$wt = "Hello, '''World'''";
		$dsr = new DomSourceRange( 0, strlen( $wt ), null, null );
		$pf = WikitextPFragment::newFromWt( $wt, $dsr );
		$pf = WikitextPFragment::concat(
			$pf,
			HtmlPFragment::newFromHtmlString( '<span>!', null )
		);
		$html = $pf->asHtmlString( $ext );
		$this->assertSame( '<p data-parsoid=\'{"dsr":[0,18,0,0]}\'>Hello, <b data-parsoid=\'{"tsr":[7,10],"dsr":[7,18,3,3]}\'>World</b><span data-parsoid="{}">!</span></p>', $html );
	}
}
