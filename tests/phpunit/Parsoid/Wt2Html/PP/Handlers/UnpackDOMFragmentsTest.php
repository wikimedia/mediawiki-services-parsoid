<?php

namespace Test\Parsoid\Wt2Html\PP\Handlers;

use DOMElement;
use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;

class UnpackDOMFragmentsTest extends TestCase {
	/**
	 * @param array $wt
	 * @return DOMElement
	 */
	private function getOutput( string $wt ): DOMElement {
		$siteConfig = new MockSiteConfig( [] );
		$dataAccess = new MockDataAccess( [] );
		$parsoid = new Parsoid( $siteConfig, $dataAccess );

		$content = new MockPageContent( [ 'main' => $wt ] );
		$pageConfig = new MockPageConfig( [], $content );
		$html = $parsoid->wikitext2html( $pageConfig, [ "wrapSections" => false ] );

		$doc = ContentUtils::createAndLoadDocument( $html );

		// Prevent GC from reclaiming $doc once we exit this function.
		// Necessary hack because we use PHPDOM which wraps libxml.
		$this->liveDocs[] = $doc;

		return DOMCompat::getBody( $doc );
	}

	/**
	 * @param DOMElement $body
	 */
	private function validateFixedupDSR( DOMElement $body ) {
		$links = DOMCompat::querySelectorAll( $body, 'a' );
		foreach ( $links as $link ) {
			$dp = DOMDataUtils::getDataParsoid( $link );
			if ( $dp->misnested ?? false ) {
				$outerLink = $link->previousSibling;
				$outerLinkDSR = DOMDataUtils::getDataParsoid( $outerLink )->dsr ?? null;
				$linkDSR = $dp->dsr ?? null;
				$this->assertNotNull( $linkDSR );
				$this->assertNotNull( $outerLinkDSR );
				$this->assertSame( $outerLinkDSR->end, $linkDSR->start );
			}
		}
	}

	/**
	 * @covers \Wikimedia\Parsoid\Wt2Html\PP\Handlers\UnpackDOMFragments
	 * @dataProvider provideFixMisnestedTagDSRCases
	 * @param string $wt
	 */
	public function testFixMisnestedTagDSRCases( string $wt ): void {
		// Strictly speaking, *NOT* a unit test, but we are
		// abusing this notion for verification of properties
		// not easily verifiable via parser tests.
		$this->validateFixedupDSR( $this->getOutput( $wt ) );
	}

	/**
	 * @return array
	 */
	public function provideFixMisnestedTagDSRCases(): array {
		return [
			[ "[http://example.org Link with [[wikilink]] link in the label]" ],
			[ "[http://example.org <span>[[wikilink]]</span> link in the label]" ],
			[ "[http://example.org <div>[[wikilink]]</div> link in the label]" ]
		];
	}

}
