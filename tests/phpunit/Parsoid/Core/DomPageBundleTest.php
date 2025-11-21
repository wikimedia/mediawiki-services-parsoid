<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Core;

use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\HtmlPageBundle;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;

/**
 * @coversDefaultClass  \Wikimedia\Parsoid\Core\DomPageBundle
 */
class DomPageBundleTest extends \PHPUnit\Framework\TestCase {
	/**
	 * @covers ::fromHtmlPageBundle
	 * @covers ::toSingleDocument
	 */
	public function testInjectPageBundle() {
		$dpb = DomPageBundle::fromHtmlPageBundle( HtmlPageBundle::newEmpty(
			"Hello, world"
		) );
		$doc = $dpb->toSingleDocument();
		// Note that we use the 'native' getElementById, not
		// DOMCompat::getElementById, in order to test T232390
		$el = $doc->getElementById( 'mw-pagebundle' );
		$this->assertNotNull( $el );
		$this->assertEquals( 'script', DOMUtils::nodeName( $el ) );
	}

	/**
	 * @covers ::fromSingleDocument
	 * @covers ::toInlineAttributeHtml
	 */
	public function testExtractPageBundle() {
		$html = <<<'EOF'
<html>
  <head>
    <script id="mw-pagebundle" type="application/x-mw-pagebundle">
      {"parsoid":
      {"counter":1,"ids":{"mwAA":{"dsr":[0,13,0,0]},
      "mwAQ":{"dsr":[0,12,0,0]}},"offsetType":"byte"},"mw":{"ids":[]}}
    </script>
  </head>
  <body><p id="mwAQ">Hello, world</p>
EOF;
		$doc = DOMUtils::parseHTML( $html );
		$dpb = DomPageBundle::fromSingleDocument( $doc );
		self::assertIsArray( $dpb->parsoid['ids'] );
		$html2 = $dpb->toInlineAttributeHtml( siteConfig: new MockSiteConfig( [] ) );
		$this->assertEquals( <<<'EOF'
<!DOCTYPE html>
<html><head>
    
  </head>
  <body><p id="mwAQ" data-parsoid='{"dsr":[0,12,0,0]}'>Hello, world</p></body></html>
EOF
			   , $html2 );
	}

	/**
	 * @covers ::fromLoadedDocument
	 * @covers ::toSingleDocumentHtml
	 */
	public function testFromLoadedDocument() {
		$html = <<<'EOF'
<!DOCTYPE html>
<html>
 <body>
  <p data-parsoid='{"dsr":[0,12,0,0]}'>Hello, world</p>
 </body>
</html>
EOF;
		$doc = ContentUtils::createAndLoadDocument( $html );
		$dpb = DomPageBundle::fromLoadedDocument(
			$doc, siteConfig: new MockSiteConfig( [] )
		);
		self::assertIsArray( $dpb->parsoid['ids'] );
		$html2 = $dpb->toSingleDocumentHtml();
		$this->assertEquals( <<<'EOF'
<!DOCTYPE html>
<html><head><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"parsoid":{"counter":0,"ids":{"mwAA":{"dsr":[0,12,0,0]}}},"mw":{"ids":[]}}</script></head><body>
  <p id="mwAA">Hello, world</p>
 
</body></html>
EOF
			   , $html2 );
	}

	/**
	 * @covers ::fromSingleDocument
	 * @covers ::fromLoadedDocument
	 * @dataProvider providePageBundleFragments
	 */
	public function testAddFragmentAndSerializeToPageBundle( $data ) {
		$dpb = DomPageBundle::fromSingleDocument(
			DOMUtils::parseHTML( $data['singleDocumentBefore'] )
		);
		self::assertIsArray( $dpb->parsoid['ids'] );
		$this->assertEquals( $data['pageBundleBefore'], $dpb->toJsonArray(), "pageBundleBefore" );

		// Now create a new standalone fragment
		$doc = $dpb->toDom();
		$df = ContentUtils::createAndLoadDocumentFragment(
			$doc, $data['newFragment']
		);
		// Serialialize back to DomPageBundle.
		$dpb = DomPageBundle::fromLoadedDocument(
			$doc, fragments: [ 'hello' => $df ],
			siteConfig: new MockSiteConfig( [] ),
		);
		// And check that it looks right!
		$this->assertEquals( $data['pageBundleAfter'], $dpb->toJsonArray(), "pageBundleAfter" );
	}

	/**
	 * @covers ::newFromJsonArray
	 * @covers ::toDom
	 * @covers ::toInlineAttributeHtml
	 * @dataProvider providePageBundleFragments
	 */
	public function testAddFragmentAndSerializeToInlineHtml( $data ) {
		$dpb = DomPageBundle::newFromJsonArray(
			$data['pageBundleAfter']
		);
		$html = $dpb->toInlineAttributeHtml( [], $fragments, siteConfig: new MockSiteConfig( [] ) );
		$this->assertEquals( $data['inlineHtmlAfter'], $html, "inlineHtmlAfter" );
		$this->assertEquals( $data['fragmentsAfter'], $fragments, "fragmentsAfter" );
	}

	public static function providePageBundleFragments() {
		yield "basic" => [ [
			// An "single document pagebundle" format, with a DocumentFragment
			// embedded in the caption attribute.  Generated from
			// $ echo "[[File:Foobar.jpg|link=|'''bold stuff''': <span>x</span>]]"
			//   | php bin/parse.php --pageBundle --body_only=false
			'singleDocumentBefore' => <<<'EOF'
<!DOCTYPE html>
<html><head><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"parsoid":{"counter":6,"ids":{"mwAA":{"dsr":[0,59,0,0]},"mwAQ":{"dsr":[0,58,0,0]},"mwAg":{"dsr":[24,40,3,3]},"mwAw":{"stx":"html","dsr":[42,56,6,7]},"mwBA":{"optList":[{"ck":"link","ak":"link="},{"ck":"caption","ak":"'''bold stuff''': <span>x</span>"}],"dsr":[0,58,null,null]},"mwBQ":{"_type_":"stdClass"},"mwBg":{"a":{"resource":"./File:Foobar.jpg","height":"28","width":"240"},"sa":{"resource":"File:Foobar.jpg"}}},"offsetType":"byte"},"mw":{"ids":[]}}</script></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}' id="mwBA"><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p>
EOF
	   ,
			'pageBundleBefore' => [
				'html' => <<<'HTML'
<!DOCTYPE html>
<html><head></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}' id="mwBA"><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p></body></html>
HTML
		  ,
				'parsoid' => [
					'counter' => 6,
					'ids' => [
						'mwAA' => [
							'dsr' => [ 0, 59, 0, 0 ],
						],
						'mwAQ' => [
							'dsr' => [ 0, 58, 0, 0 ],
						],
						'mwAg' => [
							'dsr' => [ 24, 40, 3, 3 ],
						],
						'mwAw' => [
							'stx' => 'html',
							'dsr' => [ 42, 56, 6, 7 ],
						],
						'mwBA' => [
							'optList' => [
								[
									'ck' => 'link',
									'ak' => 'link=',
								],
								[
									'ck' => 'caption',
									'ak' => '\'\'\'bold stuff\'\'\': <span>x</span>',
								],
							],
							'dsr' => [ 0, 58, null, null ],
						],
						'mwBQ' => (object)[],
						'mwBg' => [
							'a' => [
								'resource' => './File:Foobar.jpg',
								'height' => '28',
								'width' => '240',
							],
							'sa' => [
								'resource' => 'File:Foobar.jpg',
							],
						],
					],
					'offsetType' => 'byte',
				],
				'mw' => [
					'ids' => [],
				],
				'version' => null,
				'headers' => null,
				'contentmodel' => null,
			],
			'newFragment' => '<p data-parsoid=\'{"dsr":[0,12,0,0]}\'>Hello, world</p>',
			'pageBundleAfter' => [
				'html' => <<<'HTML'
<!DOCTYPE html>
<html><head></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" id="mwBA" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}'><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p></body></html>
HTML
		  ,
				'parsoid' => [
					'counter' => 7,
					'ids' => [
						'mwAA' => [
							'dsr' => [ 0, 59, 0, 0 ],
						],
						'mwAQ' => [
							'dsr' => [ 0, 58, 0, 0 ],
						],
						'mwAg' => [
							'dsr' => [ 24, 40, 3, 3 ],
						],
						'mwAw' => [
							'stx' => 'html',
							'dsr' => [ 42, 56, 6, 7 ],
						],
						'mwBA' => [
							'optList' => [
								[
									'ck' => 'link',
									'ak' => 'link=',
								],
								[
									'ck' => 'caption',
									'ak' => '\'\'\'bold stuff\'\'\': <span>x</span>',
								],
							],
							'dsr' => [ 0, 58, null, null ],
						],
						'mwBQ' => (object)[],
						'mwBg' => [
							'a' => [
								'resource' => './File:Foobar.jpg',
								'height' => '28',
								'width' => '240',
							],
							'sa' => [
								'resource' => 'File:Foobar.jpg',
							],
						],
						'mwBw' => [
							'dsr' => [ 0, 12, 0, 0 ],
						],
					],
				],
				'mw' => [
					'ids' => [],
				],
				'version' => null,
				'headers' => null,
				'contentmodel' => null,
				'fragments' => [
					'hello' => '<p id="mwBw">Hello, world</p>',
				],
			],
			'inlineHtmlAfter' => <<<'HTML'
<!DOCTYPE html>
<html><head></head><body id="mwAA" data-parsoid='{"dsr":[0,59,0,0]}'><p id="mwAQ" data-parsoid='{"dsr":[0,58,0,0]}'><span class="mw-default-size" typeof="mw:File" id="mwBA" data-parsoid='{"optList":[{"ck":"link","ak":"link="},{"ck":"caption","ak":"&apos;&apos;&apos;bold stuff&apos;&apos;&apos;: &lt;span>x&lt;/span>"}],"dsr":[0,58,null,null]}' data-mw='{"caption":"&lt;b id=\"mwAg\" data-parsoid=&apos;{\"dsr\":[24,40,3,3]}&apos;>bold stuff&lt;/b>: &lt;span id=\"mwAw\" data-parsoid=&apos;{\"stx\":\"html\",\"dsr\":[42,56,6,7]}&apos;>x&lt;/span>"}'><span title="bold stuff: x" id="mwBQ" data-parsoid="{}"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg" data-parsoid='{"a":{"resource":"./File:Foobar.jpg","height":"28","width":"240"},"sa":{"resource":"File:Foobar.jpg"}}'/></span></span></p></body></html>
HTML
	   ,
			'fragmentsAfter' => [
				'hello' => '<p id="mwBw" data-parsoid=\'{"dsr":[0,12,0,0]}\'>Hello, world</p>',
			],
		] ];

		yield "embedded" => [ [
			// A DocumentFragment embedded in data-mw.attrs
			// Generated from
			// $ echo "[[File:{{1x | Foobar.jpg}}]]"
			//   | php bin/parse.php --pageBundle --body_only=false
			'singleDocumentBefore' => <<<'EOF'
<!DOCTYPE html>
<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head prefix="mwr: https://en.wikipedia.org/wiki/Special:Redirect/"><meta charset="utf-8"/><meta property="mw:pageId" content="15580374"/><meta property="mw:pageNamespace" content="0"/><meta property="isMainPage" content="true"/><meta property="mw:htmlVersion" content="2.8.0"/><meta property="mw:html:version" content="2.8.0"/><link rel="dc:isVersionOf" href="//en.wikipedia.org/wiki/Main_Page"/><base href="//en.wikipedia.org/wiki/"/><title>Main Page</title><link rel="stylesheet" href="//en.wikipedia.org/w/load.php?lang=en&amp;modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Csite.styles&amp;only=styles&amp;skin=vector"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"parsoid":{"counter":5,"ids":{"mwAA":{"dsr":[0,29,0,0]},"mwAQ":{"dsr":[0,28,0,0]},"mwAg":{"pi":[[{"k":"1"}]],"dsr":[7,26,null,null]},"mwAw":{"optList":[],"dsr":[0,28,null,null]},"mwBA":{"_type_":"stdClass"},"mwBQ":{"a":{"resource":"./File:Foobar.jpg","height":"28","width":"240"},"sa":{"resource":"File:{{1x | Foobar.jpg}}"}}},"offsetType":"byte"},"mw":{"ids":[]}}</script></head><body lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body-content parsoid-body mediawiki mw-parser-output" dir="ltr" data-mw-parsoid-version="dev-master" data-mw-html-version="2.8.0" id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File mw:ExpandedAttrs" data-mw='{"attribs":[[{"txt":"href"},{"html":"File:&lt;span about=\"#mwt1\" typeof=\"mw:Transclusion\" data-mw=&apos;{\"parts\":[{\"template\":{\"target\":{\"wt\":\"1x \",\"href\":\"./Template:1x\"},\"params\":{\"1\":{\"wt\":\" Foobar.jpg\"}},\"i\":0}}]}&apos; id=\"mwAg\"> Foobar.jpg&lt;/span>"}]]}' id="mwAw"><a href="./File:Foobar.jpg" class="mw-file-description" id="mwBA"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBQ"/></a></span></p>
</body></html>
EOF
			,
			'pageBundleBefore' => [
				'html' => <<<'HTML'
<!DOCTYPE html>
<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head prefix="mwr: https://en.wikipedia.org/wiki/Special:Redirect/"><meta charset="utf-8"/><meta property="mw:pageId" content="15580374"/><meta property="mw:pageNamespace" content="0"/><meta property="isMainPage" content="true"/><meta property="mw:htmlVersion" content="2.8.0"/><meta property="mw:html:version" content="2.8.0"/><link rel="dc:isVersionOf" href="//en.wikipedia.org/wiki/Main_Page"/><base href="//en.wikipedia.org/wiki/"/><title>Main Page</title><link rel="stylesheet" href="//en.wikipedia.org/w/load.php?lang=en&amp;modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Csite.styles&amp;only=styles&amp;skin=vector"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/></head><body lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body-content parsoid-body mediawiki mw-parser-output" dir="ltr" data-mw-parsoid-version="dev-master" data-mw-html-version="2.8.0" id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File mw:ExpandedAttrs" data-mw='{"attribs":[[{"txt":"href"},{"html":"File:&lt;span about=\"#mwt1\" typeof=\"mw:Transclusion\" data-mw=&apos;{\"parts\":[{\"template\":{\"target\":{\"wt\":\"1x \",\"href\":\"./Template:1x\"},\"params\":{\"1\":{\"wt\":\" Foobar.jpg\"}},\"i\":0}}]}&apos; id=\"mwAg\"> Foobar.jpg&lt;/span>"}]]}' id="mwAw"><a href="./File:Foobar.jpg" class="mw-file-description" id="mwBA"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBQ"/></a></span></p>
</body></html>
HTML
		  ,
				'parsoid' => [
					'counter' => 5,
					'ids' => [
						'mwAA' => [
							'dsr' => [ 0, 29, 0, 0 ],
						],
						'mwAQ' => [
							'dsr' => [ 0, 28, 0, 0 ],
						],
						'mwAg' => [
							'pi' => [ [ [ 'k' => '1' ] ] ],
							'dsr' => [ 7, 26, null, null ],
						],
						'mwAw' => [
							'optList' => [],
							'dsr' => [ 0, 28, null, null ],
						],
						'mwBA' => (object)[],
						'mwBQ' => [
							'a' => [
								'resource' => './File:Foobar.jpg',
								'height' => '28',
								'width' => '240',
							],
							'sa' => [
								'resource' => 'File:{{1x | Foobar.jpg}}',
							],
						],
					],
					'offsetType' => 'byte',
				],
				'mw' => [
					'ids' => [],
				],
				'version' => null,
				'headers' => null,
				'contentmodel' => null,
			],
			'newFragment' => '<p data-parsoid=\'{"dsr":[0,12,0,0]}\'>Hello, world</p>',
			'pageBundleAfter' => [
				'html' => <<<'HTML'
<!DOCTYPE html>
<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head prefix="mwr: https://en.wikipedia.org/wiki/Special:Redirect/"><meta charset="utf-8"/><meta property="mw:pageId" content="15580374"/><meta property="mw:pageNamespace" content="0"/><meta property="isMainPage" content="true"/><meta property="mw:htmlVersion" content="2.8.0"/><meta property="mw:html:version" content="2.8.0"/><link rel="dc:isVersionOf" href="//en.wikipedia.org/wiki/Main_Page"/><base href="//en.wikipedia.org/wiki/"/><title>Main Page</title><link rel="stylesheet" href="//en.wikipedia.org/w/load.php?lang=en&amp;modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Csite.styles&amp;only=styles&amp;skin=vector"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/></head><body lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body-content parsoid-body mediawiki mw-parser-output" dir="ltr" data-mw-parsoid-version="dev-master" data-mw-html-version="2.8.0" id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File mw:ExpandedAttrs" id="mwAw" data-mw='{"attribs":[[{"txt":"href"},{"html":"File:&lt;span about=\"#mwt1\" typeof=\"mw:Transclusion\" id=\"mwAg\" data-mw=&apos;{\"parts\":[{\"template\":{\"target\":{\"wt\":\"1x \",\"href\":\"./Template:1x\"},\"params\":{\"1\":{\"wt\":\" Foobar.jpg\"}},\"i\":0}}]}&apos;> Foobar.jpg&lt;/span>"}]]}'><a href="./File:Foobar.jpg" class="mw-file-description" id="mwBA"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBQ"/></a></span></p>
</body></html>
HTML
		  ,
				'parsoid' => [
					'counter' => 6,
					'ids' => [
						'mwAA' => [
							'dsr' => [ 0, 29, 0, 0 ],
						],
						'mwAQ' => [
							'dsr' => [ 0, 28, 0, 0 ],
						],
						'mwAg' => [
							'pi' => [ [ [ 'k' => '1' ] ] ],
							'dsr' => [ 7, 26, null, null ],
						],
						'mwAw' => [
							'optList' => [],
							'dsr' => [ 0, 28, null, null ],
						],
						'mwBA' => (object)[],
						'mwBQ' => [
							'a' => [
								'resource' => './File:Foobar.jpg',
								'height' => '28',
								'width' => '240',
							],
							'sa' => [
								'resource' => 'File:{{1x | Foobar.jpg}}',
							],
						],
						'mwBg' => [
							'dsr' => [ 0, 12, 0, 0 ],
						],
					],
				],
				'mw' => [
					'ids' => [],
				],
				'version' => null,
				'headers' => null,
				'contentmodel' => null,
				'fragments' => [
					'hello' => '<p id="mwBg">Hello, world</p>',
				],
			],
			'inlineHtmlAfter' => <<<'HTML'
<!DOCTYPE html>
<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head prefix="mwr: https://en.wikipedia.org/wiki/Special:Redirect/"><meta charset="utf-8"/><meta property="mw:pageId" content="15580374"/><meta property="mw:pageNamespace" content="0"/><meta property="isMainPage" content="true"/><meta property="mw:htmlVersion" content="2.8.0"/><meta property="mw:html:version" content="2.8.0"/><link rel="dc:isVersionOf" href="//en.wikipedia.org/wiki/Main_Page"/><base href="//en.wikipedia.org/wiki/"/><title>Main Page</title><link rel="stylesheet" href="//en.wikipedia.org/w/load.php?lang=en&amp;modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Csite.styles&amp;only=styles&amp;skin=vector"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/></head><body lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body-content parsoid-body mediawiki mw-parser-output" dir="ltr" data-mw-parsoid-version="dev-master" data-mw-html-version="2.8.0" id="mwAA" data-parsoid='{"dsr":[0,29,0,0]}'><p id="mwAQ" data-parsoid='{"dsr":[0,28,0,0]}'><span class="mw-default-size" typeof="mw:File mw:ExpandedAttrs" id="mwAw" data-parsoid='{"optList":[],"dsr":[0,28,null,null]}' data-mw='{"attribs":[[{"txt":"href"},{"html":"File:&lt;span about=\"#mwt1\" typeof=\"mw:Transclusion\" id=\"mwAg\" data-parsoid=&apos;{\"pi\":[[{\"k\":\"1\"}]],\"dsr\":[7,26,null,null]}&apos; data-mw=&apos;{\"parts\":[{\"template\":{\"target\":{\"wt\":\"1x \",\"href\":\"./Template:1x\"},\"params\":{\"1\":{\"wt\":\" Foobar.jpg\"}},\"i\":0}}]}&apos;> Foobar.jpg&lt;/span>"}]]}'><a href="./File:Foobar.jpg" class="mw-file-description" id="mwBA" data-parsoid="{}"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBQ" data-parsoid='{"a":{"resource":"./File:Foobar.jpg","height":"28","width":"240"},"sa":{"resource":"File:{{1x | Foobar.jpg}}"}}'/></a></span></p>
</body></html>
HTML
	   ,
			'fragmentsAfter' => [
				'hello' => '<p id="mwBg" data-parsoid=\'{"dsr":[0,12,0,0]}\'>Hello, world</p>',
			],
		] ];
	}
}
