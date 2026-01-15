<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Ext;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\StubMetadataCollector;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Html2Wt\WikitextSerializer;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\TestingAccessWrapper;

/** @coversDefaultClass \Wikimedia\Parsoid\Ext\ParsoidExtensionAPI */
class ParsoidExtensionAPITest extends TestCase {
	/** Set up helper */
	protected function newExtensionAPI( bool $isWt2Html ): ParsoidExtensionAPI {
		$opts = [];
		$siteConfig = new MockSiteConfig( $opts );
		$dataAccess = new MockDataAccess( $siteConfig, $opts );
		$pageContent = new MockPageContent( [ 'main' => '' ] );
		$pageConfig = new MockPageConfig( $siteConfig, $opts, $pageContent );
		$metadata = new StubMetadataCollector( $siteConfig );
		$env = new Env( $siteConfig, $pageConfig, $dataAccess, $metadata, $opts );
		if ( $isWt2Html ) {
			return new ParsoidExtensionAPI( $env, [
				'wt2html' => [
					'frame' => $env->topFrame,
				],
			] );
		} else {
			$serializer = new WikitextSerializer( $env, [
				// serializer options
			] );
			$state = TestingAccessWrapper::newFromObject( $serializer )->state;
			return $state->extApi;
		}
	}

	/** @covers ::domToWikitext */
	public function testDomToWikitext() {
		$extApi = $this->newExtensionAPI( false );
		$df = $extApi->getTopLevelDoc()->createDocumentFragment();
		DOMCompat::append( $df, 'hello, [[world]]' );
		$result = $extApi->domToWikitext( [], $df, true );
		$this->assertSame( 'hello, <nowiki>[[world]]</nowiki>', $result );
	}
}
