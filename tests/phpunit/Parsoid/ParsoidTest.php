<?php

namespace Test\Parsoid;

use Parsoid\PageBundle;
use Parsoid\Parsoid;

use Parsoid\Tests\MockDataAccess;
use Parsoid\Tests\MockPageConfig;
use Parsoid\Tests\MockPageContent;
use Parsoid\Tests\MockSiteConfig;

/**
 * Test the entrypoint to the library.
 *
 * @coversDefaultClass \Parsoid\Parsoid
 */
class ParsoidTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers ::wikitext2html
	 * @dataProvider provideWt2Html
	 */
	public function testWt2Html( $wt, $expected, $parserOpts = [] ) {
		$opts = [];

		$siteConfig = new MockSiteConfig( $opts );
		$dataAccess = new MockDataAccess( $opts );
		$parsoid = new Parsoid( $siteConfig, $dataAccess );

		$pageContent = new MockPageContent( [ 'main' => $wt ] );
		$pageConfig = new MockPageConfig( $opts, $pageContent );
		$pb = $parsoid->wikitext2html( $pageConfig, $parserOpts );
		$this->assertEquals( $expected, $pb->html );
	}

	public function provideWt2Html() {
		return [
			[
				"'''hi ho'''",
				"<p data-parsoid='{\"dsr\":[0,11,0,0]}'><b data-parsoid='{\"dsr\":[0,11,3,3]}'>hi ho</b></p>",
				[
					'body_only' => true,
				]
			]
		];
	}

	/**
	 * @covers ::html2wikitext
	 * @dataProvider provideHtml2Wt
	 */
	public function testHtml2Wt( $input, $expected, $parserOpts = [] ) {
		$opts = [];

		$siteConfig = new MockSiteConfig( $opts );
		$dataAccess = new MockDataAccess( $opts );
		$parsoid = new Parsoid( $siteConfig, $dataAccess );

		$pageContent = new MockPageContent( [ 'main' => '' ] );
		$pageConfig = new MockPageConfig( $opts, $pageContent );
		$pb = new PageBundle( $input );
		$wt = $parsoid->html2wikitext( $pageConfig, $pb, $parserOpts );
		$this->assertEquals( $expected, $wt );
	}

	public function provideHtml2Wt() {
		return [
			[
				"<pre>hi</pre>\n<div>ho</div>",
				" hi\n<div>ho</div>"
			],
			[
				"<h2></h2>",
				"==<nowiki/>==\n",
				[
					'scrubWikitext' => false,
				]
			],
			[
				"<h2></h2>",
				'',
				[
					'scrubWikitext' => true,
				]
			]
		];
	}

}
