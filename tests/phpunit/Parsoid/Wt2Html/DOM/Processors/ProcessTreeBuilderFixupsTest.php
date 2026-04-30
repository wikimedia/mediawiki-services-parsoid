<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Wt2Html\DOM\Processors;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Core\DOMCompat;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\ProcessTreeBuilderFixups;

// phpcs:disable Generic.Files.LineLength.TooLong

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Wt2Html\DOM\Processors\ProcessTreeBuilderFixups
 */
class ProcessTreeBuilderFixupsTest extends TestCase {
	/**
	 * @covers ::run
	 * @dataProvider provideFixups
	 */
	public function testRun( string $html, string $expected ) {
		$addRedLinks = new ProcessTreeBuilderFixups();
		$env = new MockEnv( [] );
		$doc = ContentUtils::createAndLoadDocument( $html, siteConfig: $env->getSiteConfig() );
		$body = DOMCompat::getBody( $doc );
		$addRedLinks->run( $env, $body, [], true );
		$actual = ContentUtils::ppToXML( $body, [ 'innerXML' => true ] );
		$this->assertEquals( $expected, $actual );
	}

	public static function provideFixups(): array {
		return [
			'empty elements should be stripped' => [
				'<span data-parsoid=\'{"autoInsertedStart":true,"autoInsertedEnd":true}\' data-mw=\'{"key":"value"}\'></span>',
				'',
			],
			'Seemingly empty elements with mw:DOMFragment typeof should not be stripped' => [
				'<span typeof="mw:DOMFragment" data-parsoid=\'{"autoInsertedStart":true,"autoInsertedEnd":true}\' data-mw=\'{"key":"value"}\'></span>',
				'<span typeof="mw:DOMFragment" data-parsoid=\'{"autoInsertedStart":true,"autoInsertedEnd":true}\' data-mw=\'{"key":"value"}\'></span>',
			],
		];
	}
}
