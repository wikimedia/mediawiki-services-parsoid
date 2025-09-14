<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Fragments;

use Wikimedia\Parsoid\Fragments\HtmlPFragment;
use Wikimedia\Parsoid\Fragments\WikitextPFragment;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Fragments\PFragment
 */
class PFragmentTest extends PFragmentTestCase {

	/** @covers ::asHtmlString */
	public function testWtToDom() {
		$ext = $this->newExtensionAPI();
		$pf = $this->wtFragment( "Hello, '''World'''" );
		$html = $pf->asHtmlString( $ext );
		$this->assertSame( '<p data-parsoid=\'{"dsr":[0,18,0,0]}\'>Hello, <b data-parsoid=\'{"tsr":[7,10],"dsr":[7,18,3,3]}\'>World</b></p>', $html );
	}

	/** @covers ::asHtmlString */
	public function testWtToDom2() {
		$ext = $this->newExtensionAPI();
		$pf = WikitextPFragment::concat(
			$this->wtFragment( "Hello, '''World'''" ),
			HtmlPFragment::newFromHtmlString( '<span>!', null )
		);
		$html = $pf->asHtmlString( $ext );
		$this->assertSame( '<p data-parsoid=\'{"dsr":[0,41,0,0]}\'>Hello, <b data-parsoid=\'{"tsr":[7,10],"dsr":[7,18,3,3]}\'>World</b><span data-parsoid="{}">!</span></p>', $html );
	}

	/** @covers ::markerSkipCallback */
	public function testMarkerSkipCallback() {
		$ext = $this->newExtensionAPI();
		$prefix = "Hello, '''World'''";
		$pf = WikitextPFragment::concat(
			$this->wtFragment( $prefix ),
			HtmlPFragment::newFromHtmlString( '<span>!o!', null ),
			$this->wtFragment( " and Good-bye!", strlen( $prefix ) + 4 ),
		);
		$result = $pf->markerSkipCallback(
			static fn ( string $s ): string => strtr( $s, 'o', 'x' )
		);
		$this->assertSame( '<p data-parsoid=\'{"dsr":[0,55,0,0]}\'>Hellx, <b data-parsoid=\'{"tsr":[7,10],"dsr":[7,18,3,3]}\'>Wxrld</b><span data-parsoid="{}">!o!</span> and Gxxd-bye!</p>', $result->asHtmlString( $ext ) );
	}

	/** @covers ::killMarkers */
	public function testKillMarkers() {
		$ext = $this->newExtensionAPI();
		$prefix = "Hello, '''World'''";
		$pf = WikitextPFragment::concat(
			$this->wtFragment( $prefix ),
			HtmlPFragment::newFromHtmlString( '<span>!', null ),
			$this->wtFragment( " and Good-bye!", strlen( $prefix ) + 4 ),
		);
		$result = $pf->killMarkers();
		$this->assertSame( "Hello, '''World''' and Good-bye!", $result );
	}
}
