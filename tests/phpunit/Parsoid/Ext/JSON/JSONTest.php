<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Ext\JSON;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Core\DOMCompat;
use Wikimedia\Parsoid\Ext\JSON\JSON;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMDataUtils;

class JSONTest extends TestCase {
	private static string $defaultContentVersion = Parsoid::AVAILABLE_VERSIONS[0];

	/**
	 * Create a DOM document using JSON to create the document body and verify correctness
	 * @covers \Wikimedia\Parsoid\Ext\JSON\JSON::toDOM
	 */
	public function testToDOM() {
		$json = new JSON();

		$pageContent = '{"1":2';    // malformed JSON example
		$opts = [ 'pageContent' => $pageContent ];

		// Test malformed JSON handler
		$env = new MockEnv( $opts );
		$API = new ParsoidExtensionAPI( $env );
		$parsoidVersion = Parsoid::version();

		$expected = # '<!DOCTYPE html>' . "\n" .
			'<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head><meta charset="utf-8"/><base href="//my.wiki.example/wikix/"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/></head><body data-parsoid="{}"><table typeof="mw:Error" data-mw=\'{"errors":[{"key":"bad-json"}]}\'></table></body></html>';

		$doc = $json->toDOM( $API );
		DOMDataUtils::visitAndStoreDataAttribs( DOMCompat::getBody( $doc ) );

		$response = DOMCompat::getOuterHTML( $doc->documentElement );
		$this->assertSame( $expected, $response );

		$pageContent =
			'{"array":[{"foo":"bar","key":["string1",null,false,true,0,1,123,456.789]}]}';
		$expected = # '<!DOCTYPE html>' . "\n" .
			'<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head><meta charset="utf-8"/><base href="//my.wiki.example/wikix/"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/></head><body data-parsoid="{}"><table class="mw-json mw-json-object"><tbody><tr><th>array</th><td><table class="mw-json mw-json-array"><tbody><tr><td><table class="mw-json mw-json-object"><tbody><tr><th>foo</th><td class="value mw-json-string">bar</td></tr><tr><th>key</th><td><table class="mw-json mw-json-array"><tbody><tr><td class="value mw-json-string">string1</td></tr><tr><td class="value mw-json-null">null</td></tr><tr><td class="value mw-json-boolean">false</td></tr><tr><td class="value mw-json-boolean">true</td></tr><tr><td class="value mw-json-number">0</td></tr><tr><td class="value mw-json-number">1</td></tr><tr><td class="value mw-json-number">123</td></tr><tr><td class="value mw-json-number">456.789</td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></body></html>';

		$opts = [ 'pageContent' => $pageContent ];

		// Test complex nested JSON object using string matching
		$env = new MockEnv( $opts );
		$API = new ParsoidExtensionAPI( $env );

		$doc = $json->toDOM( $API );
		DOMDataUtils::visitAndStoreDataAttribs( DOMCompat::getBody( $doc ) );
		$response = DOMCompat::getOuterHTML( $doc->documentElement );
		$this->assertSame( $expected, $response );
	}

	/**
	 * Create a DOM document using HTML and convert that to JSON and verify correctness
	 * @covers \Wikimedia\Parsoid\Ext\JSON\JSON::fromDOM
	 */
	public function testFromDOM() {
		$html = '<!DOCTYPE html>' . "\n" .
			'<html><head></head><body><table class="mw-json mw-json-object"><tbody><tr><th>' .
			'array</th><td><table class="mw-json mw-json-array"><tbody><tr><td>' .
			'<table class="mw-json mw-json-object"><tbody><tr><th>foo</th>' .
			'<td class="value mw-json-string">bar</td></tr><tr><th>key</th>' .
			'<td><table class="mw-json mw-json-array"><tbody><tr>' .
			'<td class="value mw-json-string">string1</td></tr><tr>' .
			'<td class="value mw-json-null">null</td></tr><tr>' .
			'<td class="value mw-json-boolean">false</td></tr><tr>' .
			'<td class="value mw-json-boolean">true</td></tr><tr>' .
			'<td class="value mw-json-number">0</td></tr><tr>' .
			'<td class="value mw-json-number">1</td></tr><tr>' .
			'<td class="value mw-json-number">123</td></tr><tr>' .
			'<td class="value mw-json-number">456.789</td></tr></tbody></table></td></tr>' .
			'</tbody></table></td></tr></tbody></table></td></tr></tbody></table></body></html>' .
			"\n";

		$siteConfig = new MockSiteConfig( [] );
		$doc = ContentUtils::createAndLoadDocument( $html, siteConfig: $siteConfig );

		$opts = [ 'topLevelDoc' => $doc, 'siteConfig' => $siteConfig, ];
		$env = new MockEnv( $opts );
		$API = new ParsoidExtensionAPI( $env );
		$json = new JSON();

		$expected = '{"array":[{"foo":"bar","key":["string1",null,false,true,0,1,123,456.789]}]}';

		$response = $json->fromDOM( $API );
		$this->assertSame( $expected, $response );
	}
}
