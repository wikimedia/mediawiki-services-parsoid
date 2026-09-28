<?php
declare( strict_types = 1 );

namespace Test\Parsoid;

use Wikimedia\Assert\InvariantException;
use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\HtmlPageBundle;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Utils\ContentUtils;

/**
 * Test that selser accepts a prepared and loaded selserData->revDOM.
 *
 * @covers \Wikimedia\Parsoid\Wikitext\ContentModelHandler::setupSelser
 */
class SelserRevDomTest extends \PHPUnit\Framework\TestCase {
	private const WT = "* [[Foo]]--[[Bar]]";
	private const EDITED_WT = "* [[Foo]]..[[Bar]]";

	private MockSiteConfig $siteConfig;
	private Parsoid $parsoid;
	private MockPageConfig $pageConfig;

	protected function setUp(): void {
		$this->siteConfig = new MockSiteConfig( [] );
		$this->parsoid = new Parsoid(
			$this->siteConfig, new MockDataAccess( $this->siteConfig, [] )
		);
		$this->pageConfig = new MockPageConfig(
			$this->siteConfig, [], new MockPageContent( [ 'main' => self::WT ] )
		);
	}

	private function getPageBundle(): HtmlPageBundle {
		return $this->parsoid->wikitext2html(
			$this->pageConfig, [ 'wrapSections' => false, 'pageBundle' => true ]
		);
	}

	private function getEditedBundle( HtmlPageBundle $pb ): DomPageBundle {
		return DomPageBundle::fromHtmlPageBundle( new HtmlPageBundle(
			str_replace( '--', '..', $pb->html ),
			parsoid: $pb->parsoid, mw: $pb->mw, version: $pb->version,
		) );
	}

	private function getLoadedRevDom( HtmlPageBundle $pb ) {
		return DomPageBundle::fromHtmlPageBundle( $pb )
			->toDom( siteConfig: $this->siteConfig );
	}

	public function testLoadedRevDom(): void {
		$pb = $this->getPageBundle();
		$selserData = new SelectiveUpdateData( self::WT );
		$selserData->revDOM = $this->getLoadedRevDom( $pb );

		$wt = $this->parsoid->dom2wikitext(
			$this->pageConfig, $this->getEditedBundle( $pb ), [], $selserData
		);
		// The data-parsoid of the revision DOM is used: the space after
		// the bullet is not normalized.
		$this->assertSame( self::EDITED_WT, $wt );
	}

	public function testUneditedLoadedRevDomReusesSource(): void {
		$pb = $this->getPageBundle();
		$selserData = new SelectiveUpdateData( self::WT );
		$selserData->revDOM = $this->getLoadedRevDom( $pb );

		$unedited = DomPageBundle::fromHtmlPageBundle( $pb );
		$wt = $this->parsoid->dom2wikitext(
			$this->pageConfig, $unedited, [], $selserData
		);
		$this->assertSame( self::WT, $wt );
	}

	public function testRevDomMatchesRevHtml(): void {
		$pb = $this->getPageBundle();
		$revHtml = ContentUtils::toXML(
			DomPageBundle::fromHtmlPageBundle( $pb )
				->toInlineAttributeDocument( $this->siteConfig )
		);

		$viaHtml = $this->parsoid->dom2wikitext(
			$this->pageConfig, $this->getEditedBundle( $pb ), [],
			new SelectiveUpdateData( self::WT, $revHtml )
		);
		$selserData = new SelectiveUpdateData( self::WT );
		$selserData->revDOM = $this->getLoadedRevDom( $pb );
		$viaDom = $this->parsoid->dom2wikitext(
			$this->pageConfig, $this->getEditedBundle( $pb ), [], $selserData
		);
		$this->assertSame( $viaHtml, $viaDom );
	}

	public function testUnloadedRevDomIsRejected(): void {
		$pb = $this->getPageBundle();
		$selserData = new SelectiveUpdateData( self::WT );
		// Not prepared and loaded.
		$selserData->revDOM = DomPageBundle::fromHtmlPageBundle( $pb )->doc;

		$this->expectException( InvariantException::class );
		$this->parsoid->dom2wikitext(
			$this->pageConfig, $this->getEditedBundle( $pb ), [], $selserData
		);
	}

	/**
	 * @covers \Wikimedia\Parsoid\Wikitext\ContentModelHandler::toDOM
	 */
	public function testSelectiveUpdateWithLoadedRevDom(): void {
		$revText = '{{2x|456}} does not update';
		// phpcs:ignore Generic.Files.LineLength.TooLong
		$revHtml = '<p data-parsoid=\'{"dsr":[0,26,0,0]}\'><span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[0,10,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"2x","href":"./Template:2x"},"params":{"1":{"wt":"456"}},"i":0}}]}\'>456456</span> does not update</p>';
		$selparData = new SelectiveUpdateData( $revText, null, 'template' );
		$selparData->templateTitle = '1x';
		$selparData->revDOM = ContentUtils::createAndLoadDocument(
			$revHtml, siteConfig: $this->siteConfig
		);
		$pageConfig = new MockPageConfig(
			$this->siteConfig, [], new MockPageContent( [ 'main' => $revText ] )
		);

		$out = $this->parsoid->wikitext2html(
			$pageConfig, [ 'body_only' => true, 'wrapSections' => false ],
			$header, null, $selparData
		);
		$this->assertSame( $revHtml, $out );
	}
}
