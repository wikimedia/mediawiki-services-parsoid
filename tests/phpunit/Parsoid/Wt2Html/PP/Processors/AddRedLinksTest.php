<?php

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Wt2Html\PP\Processors\AddRedLinks
 */
class AddRedLinksTest extends TestCase {

	/**
	 * @covers ::run
	 * @dataProvider provideRedLinks
	 * @param string $html
	 * @param string $expected
	 * @param string $message
	 * @return void
	 */
	public function testRun( string $html, string $expected, string $message ) {
		$addRedLinks = new AddRedLinks();
		$env = new MockEnv( [] );
		$doc = ContentUtils::createAndLoadDocument( $html, [ 'markNew' => true ] );
		$body = DOMCompat::getBody( $doc );
		$addRedLinks->run( $env, $body, [], true );
		$actual = ContentUtils::ppToXML( $body, [ 'innerXML' => true ] );
		$this->assertEquals( $expected, $actual, $message );
	}

	public function provideRedLinks(): array {
		return [
			[
				'<a href="./Hello" title="Hello" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?action=edit&amp;redlink=1" title="Hello" rel="mw:WikiLink" ' .
					'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello"]}}\'>Hello</a>',
				'Simple redlink'
			],
			[
				'<a href="./Hello?param=p" title="Hello" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?param=p&amp;action=edit&amp;redlink=1" title="Hello" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello"]}}\'>Hello</a>',
				'Redlink with parameter and no fragment'
			],
			[
				'<a href="./Hello#frag" title="Hello#frag" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?action=edit&amp;redlink=1#frag" title="Hello#frag" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello#frag"]}}\'>Hello</a>',
				'Redlink with fragment and no query string'
			],
			[
				'<a href="./Hello?param=p#frag" title="Hello#frag" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?param=p&amp;action=edit&amp;redlink=1#frag" title="Hello#frag" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello#frag"]}}\'>Hello</a>',
				'Redlink with parameter and fragment'
			],
			[
				'<a href="./Hello?" title="Hello" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?action=edit&amp;redlink=1" title="Hello" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello"]}}\'>Hello</a>',
				'Redlink with empty query string and no fragment'
			],
			[
				'<a href="./Hello#" title="Hello#" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?action=edit&amp;redlink=1" title="Hello#" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello#"]}}\'>Hello</a>',
				'Redlink with empty fragment and no query string'
			],
			[
				'<a href="./Hello?#anchor" title="Hello#anchor" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?action=edit&amp;redlink=1#anchor" title="Hello#anchor" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello#anchor"]}}\'>' .
				'Hello</a>',
				'Redlink with empty query string and fragment'
			],
			[
				'<a href="./Hello?param=p#" title="Hello#" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?param=p&amp;action=edit&amp;redlink=1" title="Hello#" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello#"]}}\'>Hello</a>',
				'Redlink with query string and empty fragment'
			],
			[
				'<a href="./Hello#anchor?" title="Hello#anchor?" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?action=edit&amp;redlink=1#anchor?" title="Hello#anchor?" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello#anchor?"]}}\'>' .
				'Hello</a>',
				'Redlink with no query string and anchor containing a question mark'
			],
			[
				'<a href="./Hello?param=p#anchor?" title="Hello#anchor?" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?param=p&amp;action=edit&amp;redlink=1#anchor?" title="Hello#anchor?" ' .
				'rel="mw:WikiLink" class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello#anchor?"]}}\'>' .
				'Hello</a>',
				'Redlink with query string and anchor containing a question mark'
			],
			[
				'<a href="./Hello?#anchor?" title="Hello#anchor?" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?action=edit&amp;redlink=1#anchor?" title="Hello#anchor?" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello#anchor?"]}}\'>' .
				'Hello</a>',
				'Redlink with empty query string and anchor containing a question mark'
			],
			[
				'<a href="./Hello?param=p&amp;plop=c" title="Hello" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?param=p&amp;plop=c&amp;action=edit&amp;redlink=1" title="Hello" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello"]}}\'>Hello</a>',
				'Ampersand encodings in source url'
			],
			[
				'<a href="./Hello?param=p&plop=c" title="Hello" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello?param=p&amp;plop=c&amp;action=edit&amp;redlink=1" title="Hello" rel="mw:WikiLink" ' .
				'class="new" typeof="mw:LocalizedAttrs" ' .
				'data-mw-i18n=\'{"title":{"lang":"x-page","key":"red-link-title","params":["Hello"]}}\'>Hello</a>',
				'No ampersand encodings in source url'
			]
		];
	}
}
