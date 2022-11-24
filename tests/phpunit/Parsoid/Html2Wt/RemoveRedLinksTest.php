<?php

namespace Wikimedia\Parsoid\Html2Wt;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Html2Wt\RemoveRedLinks
 */
class RemoveRedLinksTest extends TestCase {

	/**
	 * @covers ::run
	 * @dataProvider provideRedLinks
	 * @param string $html
	 * @param string $expected
	 * @param string $message
	 * @return void
	 */
	public function testRun( string $html, string $expected, string $message ) {
		$removeRedLinks = new RemoveRedLinks();
		$doc = ContentUtils::createAndLoadDocument( $html, [ 'markNew' => true ] );
		$body = DOMCompat::getBody( $doc );
		$removeRedLinks->run( $body );
		$actual = ContentUtils::ppToXML( $body, [ 'discardDataParsoid' => true, 'innerXML' => true ] );
		$this->assertEquals( $expected, $actual, $message );
	}

	public function provideRedLinks(): array {
		return [
			[
				'<a href="./Hello" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello" rel="mw:WikiLink">Hello</a>',
				'No redlink'
			],
			[
				'<a href="./Hello?action=edit&redlink=1" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello" rel="mw:WikiLink">Hello</a>',
				'Redlink with ./ title syntax'
			],
			[
				'<a href="/w/index.php?title=Hello&action=edit&redlink=1" rel="mw:WikiLink">Hello</a>',
				'<a href="/w/index.php?title=Hello" rel="mw:WikiLink">Hello</a>',
				'Redlink with index.php? title syntax'
			],
			[
				'<a href="/w/index.php?action=edit&redlink=1&title=Hello" rel="mw:WikiLink">Hello</a>',
				'<a href="/w/index.php?title=Hello" rel="mw:WikiLink">Hello</a>',
				'Redlink with index.php? title syntax in another order' ],
			[
				'<a href="./Hello?action=edit&redlink=1" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello" rel="mw:WikiLink">Hello</a>',
				'Redlink with ./ title syntax'
			],
			[
				'<a href="./Hello?action=edit&amp;redlink=1">Hello</a>',
				'<a href="./Hello?action=edit&amp;redlink=1">Hello</a>',
				'Not a wikilink'
			],
			[
				'<p><a href="./Hello?action=edit&redlink=1" rel="mw:WikiLink">Hello</a></p>' .
				'<p><a href="./Hello2?action=edit&redlink=1" rel="mw:WikiLink">Hello2</a></p>',

				'<p><a href="./Hello" rel="mw:WikiLink">Hello</a></p>' .
				'<p><a href="./Hello2" rel="mw:WikiLink">Hello2</a></p>',
				'Two redlinks'
			],
			[
				// The code that allows for the creation of such an URL should be fixed; in the
				// meantime we still want to avoid breaking links.
				'<a href="./Hello#fragment?action=edit&redlink=1" rel="mw:WikiLink">Hello</a>',
				'<a href="./Hello#fragment" rel="mw:WikiLink">Hello</a>',
				'Redlink with buggy fragment'
			],
		];
	}
}
