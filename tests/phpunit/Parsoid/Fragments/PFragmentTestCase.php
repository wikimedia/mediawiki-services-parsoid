<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Fragments;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\StubMetadataCollector;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Fragments\WikitextPFragment;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;

abstract class PFragmentTestCase extends TestCase {

	/** Set up helper */
	protected function newExtensionAPI(): ParsoidExtensionAPI {
		$opts = [];
		$siteConfig = new MockSiteConfig( $opts );
		$dataAccess = new MockDataAccess( $siteConfig, $opts );
		$pageContent = new MockPageContent( [ 'main' => '' ] );
		$pageConfig = new MockPageConfig( $siteConfig, $opts, $pageContent );
		$metadata = new StubMetadataCollector( $siteConfig );
		$env = new Env( $siteConfig, $pageConfig, $dataAccess, $metadata, $opts );
		return new ParsoidExtensionAPI( $env, [
			'wt2html' => [
				'frame' => $env->topFrame,
			],
		] );
	}

	/** Create a new wikitext fragment with appropriate source range */
	protected function wtFragment( string $wt, int $offset = 0 ): WikitextPFragment {
		$dsr = new DomSourceRange( $offset, $offset + strlen( $wt ), null, null );
		return WikitextPFragment::newFromWt( $wt, $dsr );
	}

}
