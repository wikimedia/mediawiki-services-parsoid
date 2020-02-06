<?php

namespace Test\Parsoid\Ext\JSON;

use DOMDocument;
use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Ext\JSON\JSON;
use Wikimedia\Parsoid\Tests\MockEnv;

class JSONTest extends TestCase {
	/**
	 * Create a DOM document using JSON to create the document body and verify correctness
	 * @covers \Wikimedia\Parsoid\Ext\JSON\JSON::toDOM
	 */
	public function testToDOM() {
		$json = new JSON();

		// Test malformed JSON handler
		$opts = [];
		$opts['pageContent'] = '{"1":2';    // malformed JSON example
		$expected = '<!DOCTYPE html>' . "\n" .
			'<html><head></head><body><table data-mw=' .
			'\'{"errors":[{"key":"bad-json"}]}\'' .
			' typeof="mw:Error"></table></body></html>' .
			"\n";
		$env = new MockEnv( $opts );

		$doc = $json->toDOM( $env );
		$response = $doc->saveHTML();
		$this->assertSame( $expected, $response );

		// Test complex nested JSON object using string matching
		$opts['pageContent'] =
			'{"array":[{"foo":"bar","key":["string1",null,false,true,0,1,123,456.789]}]}';
		$expected = '<!DOCTYPE html>' . "\n" .
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
		$env = new MockEnv( $opts );

		$doc = $json->toDOM( $env );
		$response = $doc->saveHTML();
		$this->assertSame( $expected, $response );
	}

	/**
	 * Create a DOM document using HTML and convert that to JSON and verify correctness
	 * @covers \Wikimedia\Parsoid\Ext\JSON\JSON::fromDOM
	 */
	public function testFromDOM() {
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
		$opts = [];
		$env = new MockEnv( $opts );

		$doc = new DOMDocument();
		$doc->loadHTML( $html );
		$response = $json->fromDOM( $env, $doc );
		$this->assertSame( $expected, $response );
	}
}
