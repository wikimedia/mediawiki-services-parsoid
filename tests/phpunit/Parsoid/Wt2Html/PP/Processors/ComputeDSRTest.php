<?php

namespace Test\Parsoid\Wt2Html\PP\Processors;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;

/**
 * based on tests/mocha/dsr.js
 * @coversDefaultClass \Wikimedia\Parsoid\Wt2Html\PP\Processors\ComputeDSR
 */
class ComputeDSRTest extends TestCase {
	/**
	 * @param string $wt
	 * @param Element $doc
	 * @param array $spec
	 */
	public function validateSpec( string $wt, Element $doc, array $spec ): void {
		$elts = DOMCompat::querySelectorAll( $doc, $spec['selector'] );
		$this->assertCount( 1, $elts,
				"Cannot match selector \"{$spec['selector']}\" in doc " .
				ContentUtils::toXML( $doc ) );

		$dp = DOMDataUtils::getDataParsoid( $elts[0] );
		$dsr = $dp->dsr;
		$this->assertTrue( !empty( $dsr ) );
		$this->assertInstanceOf( DomSourceRange::class, $dsr );

		$this->assertEquals( $spec['dsrContent'][0], $dsr->substr( $wt ),
			"dsr all actual mismatch: \n\"" .
			$dsr->substr( $wt ) . "\"\ndoes not match expected:\n\"" . $spec['dsrContent'][0] . "\"" );
		$this->assertEquals( $spec['dsrContent'][1], $dsr->openSubstr( $wt ),
			"dsr open actual mismatch: \n\"" .
			$dsr->openSubstr( $wt ) . "\"\ndoes not match expected:\n\"" . $spec['dsrContent'][1] . "\"" );
		$this->assertEquals( $spec['dsrContent'][2], $dsr->closeSubstr( $wt ),
			"dsr close actual mismatch: \n\"" .
			$dsr->closeSubstr( $wt ) . "\"\ndoes not match expected:\n\"" . $spec['dsrContent'][2] . "\"" );
	}

	/**
	 * For every test with a 'wt' property, provide the 'spec' property that is
	 * an array of DSR specs that need to be verified on the parsed output of 'wt'.
	 * Every spec should have:
	 *   selector: a CSS selector for picking a DOM node in the parsed output.
	 *   dsrContent: a 3-element array. The first element is the wikitext corresponding
	 *               to the wikitext substring between dsr[0]..dsr[1]. The second and
	 *               third elements are the opening/closing wikitext tag for that node.
	 * @covers ::computeNodeDSR
	 * @dataProvider provideComputeDSR
	 * @param string $wt
	 * @param array $specs
	 */
	public function testComputeDSR( string $wt, array $specs ): void {
		$siteConfig = new MockSiteConfig( [] );
		$dataAccess = new MockDataAccess( [] );
		$parsoid = new Parsoid( $siteConfig, $dataAccess );

		$content = new MockPageContent( [ 'main' => $wt ] );
		$pageConfig = new MockPageConfig( [], $content );
		$html = $parsoid->wikitext2html( $pageConfig, [ "wrapSections" => false ] );

		$doc = ContentUtils::createAndLoadDocument( $html );

		foreach ( $specs as $spec ) {
			$this->validateSpec( $wt, DOMCompat::getBody( $doc ), $spec );
		}
	}

	/**
	 * @return array
	 */
	public function provideComputeDSR(): array {
		return [
			// Paragraph wrapping
			'para 1' => [
				'wt' => 'a',    // disable first test so we can get to the juicy failure immediately.
				'specs' => [
					[ 'selector' => 'body > p', 'dsrContent' => [ 'a', '', '' ] ]
				]
			],
			'para 2' => [
				'wt' => "a\n\nb",
				'specs' => [
					[ 'selector' => 'body > p:nth-child(1)', 'dsrContent' => [ 'a', '', '' ] ],
					[ 'selector' => 'body > p:nth-child(2)', 'dsrContent' => [ 'b', '', '' ] ]
				]
			],

			// Lists
			'list 1' => [
				'wt' => "*a\n*b",
				'specs' => [
					[ 'selector' => 'ul', 'dsrContent' => [ "*a\n*b", '', '' ] ],
					[ 'selector' => 'ul > li:nth-child(1)', 'dsrContent' => [ '*a', '*', '' ] ],
					[ 'selector' => 'ul > li:nth-child(2)', 'dsrContent' => [ '*b', '*', '' ] ]
				]
			],
			'list 2' => [
				'wt' => "*a\n**b\n***c\n*d",
				'specs' => [
					[ 'selector' => 'body > ul', 'dsrContent' => [ "*a\n**b\n***c\n*d", '', '' ] ],
					[ 'selector' => 'body > ul > li:first-child', 'dsrContent' => [ "*a\n**b\n***c", '*', '' ] ],
					[ 'selector' => 'body > ul > li:first-child > ul', 'dsrContent' => [ "**b\n***c", '', '' ] ],
					[
						'selector' => 'body > ul > li:first-child > ul > li:first-child',
						'dsrContent' => [ "**b\n***c", '**', '' ]
					],
					[
						'selector' => 'body > ul > li:first-child > ul > li:first-child > ul > li',
						'dsrContent' => [ '***c', '***', '' ]
					],
					[ 'selector' => 'body > ul > li:nth-child(2)', 'dsrContent' => [ '*d', '*', '' ] ]
				]
			],

			// Headings
			'heading 1' => [
				'wt' => "=A=\n==B==\n===C===\n====D====",
				'specs' => [
					[ 'selector' => 'body > h1', 'dsrContent' => [ '=A=', '=', '=' ] ],
					[ 'selector' => 'body > h2', 'dsrContent' => [ '==B==', '==', '==' ] ],
					[ 'selector' => 'body > h3', 'dsrContent' => [ '===C===', '===', '===' ] ],
					[ 'selector' => 'body > h4', 'dsrContent' => [ '====D====', '====', '====' ] ]
				]
			],
			'heading 2' => [
				'wt' => "=A New Use for the = Sign=\n==The == Operator==",
				'specs' => [
					[
						'selector' => 'body > h1',
						'dsrContent' => [ '=A New Use for the = Sign=', '=', '=' ]
					],
					[ 'selector' => 'body > h2', 'dsrContent' => [ '==The == Operator==', '==', '==' ] ]
				]
			],

			// Quotes
			'quotes 1' => [
				'wt' => "''a''\n'''b'''",
				'specs' => [
					[ 'selector' => 'p > i', 'dsrContent' => [ "''a''", "''", "''" ] ],
					[ 'selector' => 'p > b', 'dsrContent' => [ "'''b'''", "'''", "'''" ] ]
				]
			],

			// Tables
			'tables 1' => [
				'wt' => "{|\n|-\n|A\n|}",
				'specs' => [
					[ 'selector' => 'body > table', 'dsrContent' => [ "{|\n|-\n|A\n|}", '{|', '|}' ] ],
					[ 'selector' => 'body > table > tbody > tr', 'dsrContent' => [ "|-\n|A", '|-', '' ] ],
					[ 'selector' => 'body > table > tbody > tr > td', 'dsrContent' => [ '|A', '|', '' ] ]
				]
			],

			// Pre
			'pre 1' => [
				'wt' => " Preformatted text ",
				'specs' => [
					[ 'selector' => 'body > pre', 'dsrContent' => [ " Preformatted text ", ' ', '' ] ]
				]
			],

			// Elements
			'elt 1' => [
				'wt' => "<small>'''bold'''</small>",
				'specs' => [
					[
						'selector' => 'body > p',
						'dsrContent' => [ "<small>'''bold'''</small>", '', '' ]
					],
					[
						'selector' => 'body > p > small',
						'dsrContent' => [ "<small>'''bold'''</small>", '<small>', '</small>' ]
					]
				]
			],
		];
	}
}
