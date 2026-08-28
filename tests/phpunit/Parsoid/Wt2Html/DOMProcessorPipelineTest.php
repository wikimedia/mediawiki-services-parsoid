<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Wt2Html;

use Wikimedia\Parsoid\Core\DOMCompat;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\CleanUp;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\Normalize;
use Wikimedia\Parsoid\Wt2Html\DOMProcessorPipeline;
use Wikimedia\Parsoid\Wt2Html\ParserPipelineFactory;

class DOMProcessorPipelineTest extends \PHPUnit\Framework\TestCase {

	private static string $defaultContentVersion = Parsoid::AVAILABLE_VERSIONS[0];

	/**
	 * @covers \Wikimedia\Parsoid\Wt2Html\DOMProcessorPipeline
	 * @dataProvider provideDOMProcessorPipeline
	 */
	public function testDOMProcessorPipeline( bool $atTopLevel, array $processors, string $html, string $expected, $storeDataAttribs = false ) {
		// Use 'Test Page' to verify that dc:isVersionOf link in header uses underscores
		// but the user rendered version in <title> in header uses spaces.
		$mockEnv = new MockEnv( [ 'title' => 'Test Page' ] );
		$dpp = new DOMProcessorPipeline( $mockEnv, [ 'inTemplate' => false ] );
		$dpp->registerProcessors( $processors );
		$opts = [
			'toplevel' => $atTopLevel
		];
		$dpp->resetState( $opts );
		$dpp->setFrame( $mockEnv->topFrame );
		$document = ContentUtils::createAndLoadDocument( $html, [
			'serializeNewEmptyDp' => true,
		], siteConfig: $mockEnv->getSiteConfig() );
		$body = DOMCompat::getBody( $document );
		DOMUtils::visitDOM( $body, static function ( Node $node, array $options ) {
			// Force data-parsoid to be loaded since lazy-loading code won't
			// process data-parsoid always which fail test expectations.
			if ( $node instanceof Element ) {
				DOMDataUtils::getDataParsoid( $node );
			}
		}, [] );
		$dpp->doPostProcess( $body );
		if ( $storeDataAttribs ) {
			DOMDataUtils::visitAndStoreDataAttribs( $body );
		}
		$this->assertEquals( $expected, DOMCompat::getOuterHTML( $document->documentElement ) );
	}

	public static function provideDOMProcessorPipeline(): array {
		return [
			[
				false,
				ParserPipelineFactory::procNamesToProcs( ParserPipelineFactory::NESTED_PIPELINE_DOM_TRANSFORMS ),
				"<div>123</div>",
				'<html><head></head><body data-object-id="0"><div data-object-id="1">123</div></body></html>'
			],
			[
				true,
				ParserPipelineFactory::procNamesToProcs( array_merge(
					ParserPipelineFactory::NESTED_PIPELINE_DOM_TRANSFORMS,
					ParserPipelineFactory::FULL_PARSE_GLOBAL_DOM_TRANSFORMS
				) ),
				"<div>123</div>",
				'<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head><meta charset="utf-8"/><base href="//my.wiki.example/wikix/"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/></head><body data-parsoid=\'{"dsr":[0,39,0,0]}\'><section data-mw-section-id="0" data-parsoid="{}"><div data-parsoid=\'{"dsr":[null,39,null,null]}\'>123</div></section></body></html>',
				true
			],
			[
				false,
				[
					[ 'Processor' => Normalize::class ]
				],
				"<p>hi</p><p></p><p>ho</p>",
				'<html><head></head><body data-object-id="0"><p data-object-id="1">hi</p><p data-object-id="2"></p><p data-object-id="3">ho</p></body></html>'
			],
			[
				false,
				[
					[
						'name' => 'CleanUp-handleEmptyElts',
						'shortcut' => 'cleanup',
						'tplInfo' => true,
						'handlers' => [
							[
								'nodeName' => null,
								'action' => [ CleanUp::class, 'handleEmptyElements' ]
							]
						]
					]
				],
				"<p>hi</p><p></p><p>ho</p><p typeof='mw:Transclusion' about='#mwt1' data-mw='{}' data-parsoid='{}'></p>",
				'<html><head></head><body data-object-id="0"><p data-object-id="1">hi</p><p data-object-id="2" class="mw-empty-elt"></p><p data-object-id="3">ho</p><p typeof="mw:Transclusion" about="#mwt1" data-object-id="4" class="mw-empty-elt"></p></body></html>'
			]
		];
	}

}
