<?php
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Ext\JSON;

use DOMDocument;
use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Config\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Ext\JSON\JSON;
use Wikimedia\Parsoid\Tests\MockEnv;

class JSONTest extends TestCase {
	/**
	 * Create a DOM document using JSON to create the document body and verify correctness
	 * @covers \Wikimedia\Parsoid\Ext\JSON\JSON::toDOM
	 */
	public function testToDOM() {
		// Test malformed JSON handler
		$opts = [];
		$env = new MockEnv( $opts );
		$API = new ParsoidExtensionAPI( $env );
		$json = new JSON();

		$pageContent = '{"1":2';    // malformed JSON example
		$expected = '<!DOCTYPE html>' . "\n" .
			'<html><head></head><body data-parsoid="{}"><table typeof="mw:Error" data-parsoid="{}" data-mw=\'{"errors":[{"key":"bad-json"}]}\'></table></body></html>' .
			"\n";

		$doc = $json->toDOM( $API, $pageContent );
		$response = $doc->saveHTML();
		$this->assertSame( $expected, $response );

		// Test complex nested JSON object using string matching
		$pageContent =
			'{"array":[{"foo":"bar","key":["string1",null,false,true,0,1,123,456.789]}]}';
		$expected = '<!DOCTYPE html>' . "\n" .
			'<html><head></head><body data-parsoid="{}"><table class="mw-json mw-json-object" data-parsoid="{}"><tbody data-parsoid="{}"><tr data-parsoid="{}"><th data-parsoid="{}">array</th><td data-parsoid="{}"><table class="mw-json mw-json-array" data-parsoid="{}"><tbody data-parsoid="{}"><tr data-parsoid="{}"><td data-parsoid="{}"><table class="mw-json mw-json-object" data-parsoid="{}"><tbody data-parsoid="{}"><tr data-parsoid="{}"><th data-parsoid="{}">foo</th><td class="value mw-json-string" data-parsoid="{}">bar</td></tr><tr data-parsoid="{}"><th data-parsoid="{}">key</th><td data-parsoid="{}"><table class="mw-json mw-json-array" data-parsoid="{}"><tbody data-parsoid="{}"><tr data-parsoid="{}"><td class="value mw-json-string" data-parsoid="{}">string1</td></tr><tr data-parsoid="{}"><td class="value mw-json-null" data-parsoid="{}">null</td></tr><tr data-parsoid="{}"><td class="value mw-json-boolean" data-parsoid="{}">false</td></tr><tr data-parsoid="{}"><td class="value mw-json-boolean" data-parsoid="{}">true</td></tr><tr data-parsoid="{}"><td class="value mw-json-number" data-parsoid="{}">0</td></tr><tr data-parsoid="{}"><td class="value mw-json-number" data-parsoid="{}">1</td></tr><tr data-parsoid="{}"><td class="value mw-json-number" data-parsoid="{}">123</td></tr><tr data-parsoid="{}"><td class="value mw-json-number" data-parsoid="{}">456.789</td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></body></html>' .
			"\n";

		$doc = $json->toDOM( $API, $pageContent );
		$response = $doc->saveHTML();
		$this->assertSame( $expected, $response );
	}

	/**
	 * Create a DOM document using HTML and convert that to JSON and verify correctness
	 * @covers \Wikimedia\Parsoid\Ext\JSON\JSON::fromDOM
	 */
	public function testFromDOM() {
		$opts = [];
		$env = new MockEnv( $opts );
		$API = new ParsoidExtensionAPI( $env );
		$json = new JSON();

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
		$expected = '{"array":[{"foo":"bar","key":["string1",null,false,true,0,1,123,456.789]}]}';

		$doc = new DOMDocument();
		$doc->loadHTML( $html );
		$response = $json->fromDOM( $API, $doc );
		$this->assertSame( $expected, $response );
	}
}
