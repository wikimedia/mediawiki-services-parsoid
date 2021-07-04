<?php

namespace Test\Parsoid\Utils;

use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\WTUtils;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Utils\WTUtils
 */
class WTUtilsTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers ::encodeComment
	 * @covers ::decodeComment
	 * @covers ::decodedCommentLength
	 * @dataProvider provideCommentEncoding
	 */
	public function testCommentEncoding( string $wikitext, string $html, int $length ) {
		$actualHtml = WTUtils::encodeComment( $wikitext );
		$this->assertEquals( $html, $actualHtml );
		$actualWt = WTUtils::decodeComment( $html );
		$this->assertEquals( $wikitext, $actualWt );
		$doc = DOMCompat::newDocument( true );
		$doc->loadHTML( "<html><body><!--$html--></body></html>" );
		$body = $doc->getElementsByTagName( "body" )->item( 0 );
		$node = $body->childNodes->item( 0 );
		$actualLen = WTUtils::decodedCommentLength( $node );
		$this->assertEquals( $length, $actualLen );
	}

	public function provideCommentEncoding(): array {
		// length includes the length of the <!-- and --> delimiters
		return [
			[ 'abc', 'abc', 10 ],
			[ '& - >', '&#x26; &#x2D; &#x3E;', 12 ],
			[ 'Use &gt; here', 'Use &#x26;gt; here', 20 ],
			[ '--&gt;', '&#x2D;&#x2D;&#x3E;', 13 ],
			[ '--&amp;gt;', '&#x2D;&#x2D;&#x26;gt;', 17 ],
			[ '--&amp;amp;gt;','&#x2D;&#x2D;&#x26;amp;gt;', 21 ],
		];
	}
}
