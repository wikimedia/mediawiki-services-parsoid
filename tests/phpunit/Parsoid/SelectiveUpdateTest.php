<?php

namespace Test\Parsoid;

use Wikimedia\Parsoid\Core\ContentMetadataCollector;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Parsoid;

/**
 * Test selective updates
 */
class SelectiveUpdateTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers  \Wikimedia\Parsoid\Parsoid::wikitext2html
	 * @dataProvider provideSelectiveUpdate
	 */
	public function testSelectiveUpdate(
		$mode, $editedtemplatetitle, $revText, $revHTML, $updatedHTML, $parserOpts
	) {
		$revData = new SelectiveUpdateData( $revText, $revHTML, $mode );
		$revData->templateTitle = $editedtemplatetitle;

		$opts = [];
		$siteConfig = new MockSiteConfig( $opts );

		$dataAccess = $this->createMock( MockDataAccess::class );
		$dataAccess
			->expects( $this->once() )
			->method( 'preprocessWikitext' )
			->willReturnCallback( static function (
				MockPageConfig $pageConfig, ContentMetadataCollector $metadata,
				string $wikitext
			): string {
				preg_match( '/{{1x\|(.*?)}}/s', $wikitext, $match );
				return str_repeat( $match[1] ?? '', 2 );
			} );

		$parsoid = new Parsoid( $siteConfig, $dataAccess );
		$pageContent = new MockPageContent( [ 'main' => $revText ] );
		$pageConfig = new MockPageConfig( $siteConfig, $opts, $pageContent );

		$out = $parsoid->wikitext2html( $pageConfig, $parserOpts, $header, null, $revData );
		$this->assertEquals( $updatedHTML, $out );
	}

	public function provideSelectiveUpdate() {
		// phpcs:disable Generic.Files.LineLength.TooLong
		return [
			[
				'template',
				'1x',
				'testing {{1x|123}} does not update {{2x|456}}',
				'<p data-parsoid=\'{"dsr":[0,45,0,0]}\'>testing <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[8,18,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"123"}},"i":0}}]}\'>123</span> does not update <span about="#mwt2" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[35,45,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"2x","href":"./Template:2x"},"params":{"1":{"wt":"456"}},"i":0}}]}\'>456456</span></p>',
				'<p data-parsoid=\'{"dsr":[0,45,0,0]}\'>testing <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[8,18,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"123"}},"i":0}}]}\'>123123</span> does not update <span about="#mwt2" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[35,45,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"2x","href":"./Template:2x"},"params":{"1":{"wt":"456"}},"i":0}}]}\'>456456</span></p>',
				[
					'body_only' => true,
					'wrapSections' => false,
				],
			],
		];
		// phpcs:enable Generic.Files.LineLength.TooLong
	}

}
