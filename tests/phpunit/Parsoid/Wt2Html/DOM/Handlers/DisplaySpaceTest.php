<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Wt2Html\DOM\Handlers;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Core\DOMCompat;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMTraverser;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\DisplaySpace;

class DisplaySpaceTest extends TestCase {

	/**
	 * @dataProvider textHandlerProvider
	 * @covers \Wikimedia\Parsoid\Wt2Html\DOM\Handlers\DisplaySpace::textHandler
	 */
	public function testTextHandler( string $input, string $expected ): void {
		$traverser = new DOMTraverser();
		$traverser->addHandler( null, DisplaySpace::textHandler( ... ) );

		$siteConfig = new MockSiteConfig( [] );
		$doc = ContentUtils::createAndLoadDocument( $input, siteConfig: $siteConfig );
		$body = DOMCompat::getBody( $doc );
		$traverser->traverse( $siteConfig, $body );

		$innerHtml = DOMCompat::getInnerHTML( $body );
		$pattern = '/ ' . DOMDataUtils::DATA_OBJECT_ATTR_NAME . '="\d+"/';
		$actual = preg_replace( $pattern, '', $innerHtml );

		self::assertEquals( $expected, $actual );
	}

	public static function textHandlerProvider(): array {
		return [
			"svg content should not contain DisplaySpace" =>
			[
				"<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Hello %</text></svg>",
				"<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Hello %</text></svg>",
			],
		];
	}
}
