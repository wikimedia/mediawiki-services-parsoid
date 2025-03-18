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
		string $mode, array $updateData, string $expectedHTML
	) {
		$revData = new SelectiveUpdateData(
			$updateData['revText'], $updateData['revHTML'], $mode
		);

		if ( $mode === 'template' ) {
			$revData->templateTitle = $updateData['editedtemplatetitle'];
		}

		$opts = [];
		$siteConfig = new MockSiteConfig( $opts );

		$dataAccess = $this->createMock( MockDataAccess::class );
		$dataAccess
			->expects( $this->exactly( $updateData['preprocessCalls'] ?? 0 ) )
			->method( 'preprocessWikitext' )
			->willReturnCallback( static function (
				MockPageConfig $pageConfig, ContentMetadataCollector $metadata,
				$wikitext
			): string {
				if ( !is_string( $wikitext ) ) {
					$wikitext = $wikitext->killMarkers();
				}
				preg_match( '/{{1x\|(.*?)}}/s', $wikitext, $match );
				return str_repeat( $match[1] ?? '', 2 );
			} );

		$parsoid = new Parsoid( $siteConfig, $dataAccess );
		$pageContent = new MockPageContent( [ 'main' => $revData->revText ] );
		$pageConfig = new MockPageConfig( $siteConfig, $opts, $pageContent );

		$parserOpts = [
			'body_only' => true,
			'wrapSections' => false,
		];

		$out = $parsoid->wikitext2html( $pageConfig, $parserOpts, $header, null, $revData );
		$this->assertEquals( $expectedHTML, $out );
	}

	public function provideSelectiveUpdate() {
		// phpcs:disable Generic.Files.LineLength.TooLong
		return [
			[
				'template',
				[
					'editedtemplatetitle' => '1x',
					'revText' => '{{2x|456}} does not update',
					'preprocessCalls' => 0,
					'revHTML' => '<p data-parsoid=\'{"dsr":[0,26,0,0]}\'><span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[0,10,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"2x","href":"./Template:2x"},"params":{"1":{"wt":"456"}},"i":0}}]}\'>456456</span> does not update</p>',
				],
				'<p data-parsoid=\'{"dsr":[0,26,0,0]}\'><span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[0,10,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"2x","href":"./Template:2x"},"params":{"1":{"wt":"456"}},"i":0}}]}\'>456456</span> does not update</p>',
			],
			[
				'template',
				[
					'editedtemplatetitle' => '1x',
					'revText' => 'testing {{1x|123}} does not update {{2x|456}}',
					'preprocessCalls' => 1,
					'revHTML' => '<p data-parsoid=\'{"dsr":[0,45,0,0]}\'>testing <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[8,18,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"123"}},"i":0}}]}\'>123</span> does not update <span about="#mwt2" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[35,45,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"2x","href":"./Template:2x"},"params":{"1":{"wt":"456"}},"i":0}}]}\'>456456</span></p>',
				],
				'<p data-parsoid=\'{"dsr":[0,45,0,0]}\'>testing <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[8,18,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"123"}},"i":0}}]}\'>123123</span> does not update <span about="#mwt2" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[35,45,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"2x","href":"./Template:2x"},"params":{"1":{"wt":"456"}},"i":0}}]}\'>456456</span></p>',
			],
			[
				'template',
				[
					'editedtemplatetitle' => '1x',
					'preprocessCalls' => 2,
					'revText' => 'testing {{1x|123}} and {{1x|hiho}}',
					'revHTML' => '<p data-parsoid=\'{"dsr":[0,34,0,0]}\'>testing <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[8,18,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"123"}},"i":0}}]}\'>123</span> and <span about="#mwt2" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[23,34,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"hiho"}},"i":0}}]}\'>hiho</span></p>',
				],
				'<p data-parsoid=\'{"dsr":[0,34,0,0]}\'>testing <span about="#mwt1" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[8,18,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"123"}},"i":0}}]}\'>123123</span> and <span about="#mwt2" typeof="mw:Transclusion" data-parsoid=\'{"pi":[[{"k":"1"}]],"dsr":[23,34,null,null]}\' data-mw=\'{"parts":[{"template":{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"hiho"}},"i":0}}]}\'>hihohiho</span></p>',
			],
		];
		// phpcs:enable Generic.Files.LineLength.TooLong
	}

}
