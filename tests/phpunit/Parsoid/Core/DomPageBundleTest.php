<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Core;

use stdClass;
use Wikimedia\Parsoid\Core\BasePageBundle;
use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\HtmlPageBundle;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;

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

	public static function provideExtractPageBundle() {
		yield "simple" => [
			'input' => <<<'EOF'
<!DOCTYPE html>
<html>
  <head>
    <script id="mw-pagebundle" type="application/x-mw-pagebundle">
    {"v":2,"parsoid":{"ids":{"mwAA":{"dsr":[0,13,0,0]},"mwAQ":{"dsr":[0,12,0,0]}},"offsetType":"byte"},"mw":{"ids":[]},"counters":{"nodedata":1,"annotation":0,"transclusion":1}}
    </script>
  </head>
  <body><p id="mwAQ">Hello, world</p>
EOF
,
			'output' => <<<'EOF'
<!DOCTYPE html>
<html><head>
    
  </head>
  <body><p id="mwAQ" data-parsoid='{"dsr":[0,12,0,0]}'>Hello, world</p></body></html>
EOF
		];

		// The 'dummy' id ensures we are testing that a null data-parsoid blob translates
		// to inline-atribute-serialization without a data-parsoid object in the HTML for it.
		yield 'complex' => [
			'input' => <<< 'EOF'
<!DOCTYPE html>
<html>
	<head>
		<script id="mw-pagebundle" type="application/x-mw-pagebundle">
		{
			"v":2,
			"parsoid": {
				"ids":{
					"mwAA":{"dsr":[0,70,0,0]},
					"mwAQ":{"dsr":[0,69,0,0]},
					"mwAg":{"optList":[{"ck":"frameless","ak":"frameless"},{"ck":"width","ak":"12px"},{"ck":"class","ak":"class=skin-invert"},{"ck":"link","ak":"link=Love Symbol"}],"dsr":[0,69,null,null]},
					"mwAw":{},
					"mwBA":{"a":{"resource":"./File:Foobar.jpg","height":"1","width":"12"},"sa":{"resource":"File:Foobar.jpg"}},
					"dummy":null
				},
				"offsetType":"byte"
			},
			"mw":{"ids":[]},
			"counters":{"nodedata":4,"annotation":0,"transclusion":1}
		}
		</script>
		</head>
		<body><p id="mwAQ"><span class="skin-invert" typeof="mw:File/Frameless" id="mwAg"><a href="./Love_Symbol" title="Love Symbol" id="mwAw"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Foobar.jpg/20px-Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="1" width="12" class="mw-file-element" id="mwBA"/></a></span><span id="dummy"></span></p>
</body></html>
EOF
,
			'output' => <<<'EOF'
<!DOCTYPE html>
<html><head>
		
		</head>
		<body><p id="mwAQ" data-parsoid='{"dsr":[0,69,0,0]}'><span class="skin-invert" typeof="mw:File/Frameless" id="mwAg" data-parsoid='{"optList":[{"ck":"frameless","ak":"frameless"},{"ck":"width","ak":"12px"},{"ck":"class","ak":"class=skin-invert"},{"ck":"link","ak":"link=Love Symbol"}],"dsr":[0,69,null,null]}'><a href="./Love_Symbol" title="Love Symbol" id="mwAw" data-parsoid="{}"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Foobar.jpg/20px-Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="1" width="12" class="mw-file-element" id="mwBA" data-parsoid='{"a":{"resource":"./File:Foobar.jpg","height":"1","width":"12"},"sa":{"resource":"File:Foobar.jpg"}}'/></a></span><span id="dummy"></span></p>
</body></html>
EOF
		];
	}

	/**
	 * @covers ::fromSingleDocument
	 * @covers ::toInlineAttributeHtml
	 * @dataProvider provideExtractPageBundle
	 */
	public function testExtractPageBundle( $input, $output ) {
		$doc = DOMUtils::parseHTML( $input );
		$dpb = DomPageBundle::fromSingleDocument( $doc );
		self::assertIsArray( $dpb->parsoid['ids'] );
		// v2 pagebundle version + correct usedIdIndex
		$this->assertSame( 2, $dpb->pbVersion );
		$this->assertTrue( $dpb->hasUsedIds() );
		$html = $dpb->toInlineAttributeHtml( siteConfig: new MockSiteConfig( [] ) );
		$this->assertEquals( $output, $html );
	}

	/**
	 * Return the decoded JSON of the page bundle in a single document.
	 * Objects are decoded as stdClass, so that empty objects survive
	 * a round trip through PHPUtils::jsonEncode().
	 */
	private static function getPageBundleJson( Document $doc ): stdClass {
		$script = DOMCompat::getElementById( $doc, 'mw-pagebundle' );
		self::assertNotNull( $script );
		$json = PHPUtils::jsonDecode( $script->textContent, false );
		self::assertInstanceOf( stdClass::class, $json );
		return $json;
	}

	/**
	 * @covers ::fromSingleDocument
	 * @dataProvider provideExtractPageBundle
	 */
	public function testPageBundleVersionHandling( $input, $output ) {
		// Convert $input to versionless pagebundle
		$doc = DOMUtils::parseHTML( $input );
		$script = DOMCompat::getElementById( $doc, 'mw-pagebundle' );
		$json = self::getPageBundleJson( $doc );
		unset( $json->v );
		$script->textContent = PHPUtils::jsonEncode( $json );
		$dpb = DomPageBundle::fromSingleDocument( $doc );

		// No version, no usedIdIndex!
		$this->assertSame( BasePageBundle::VERSION_NO_USEDID, $dpb->pbVersion );
		$this->assertFalse( $dpb->hasUsedIds() );

		// The serialized pb keeps version 1, because the used ids
		// are not known.
		$html = $dpb->toSingleDocumentHtml();
		$this->assertSame( 1, self::getPageBundleJson( DOMUtils::parseHTML( $html ) )->v );
		$dpb = DomPageBundle::fromSingleDocument( DOMUtils::parseHTML( $html ) );
		$this->assertSame( BasePageBundle::VERSION_NO_USEDID, $dpb->pbVersion );

		// Store the document in a new pb, which has an entry for each
		// id. This changes the pb to version 2.
		$siteConfig = new MockSiteConfig( [] );
		$dpb = DomPageBundle::fromLoadedDocument(
			$dpb->toDom( siteConfig: $siteConfig ), $siteConfig
		);
		$this->assertTrue( $dpb->hasUsedIds() );
		$html = $dpb->toSingleDocumentHtml();
		$this->assertSame( 2, self::getPageBundleJson( DOMUtils::parseHTML( $html ) )->v );

		// When loaded back, the version 2 pb has valid used ids.
		$dpb = DomPageBundle::fromSingleDocument( DOMUtils::parseHTML( $html ) );
		self::assertIsArray( $dpb->parsoid['ids'] );
		$this->assertSame( BasePageBundle::VERSION_WITH_USEDID, $dpb->pbVersion );
		$this->assertArrayHasKey( 'mwAQ', $dpb->parsoid['ids'] );

		// An HtmlPageBundle keeps the version through a JSON round trip.
		$hpb = HtmlPageBundle::fromDomPageBundle( $dpb );
		$this->assertSame( BasePageBundle::VERSION_WITH_USEDID, $hpb->pbVersion );
		$hpb = HtmlPageBundle::newFromJsonArray( $hpb->toJsonArray() );
		$this->assertSame( BasePageBundle::VERSION_WITH_USEDID, $hpb->pbVersion );
		$this->assertArrayHasKey( 'mwAQ', $hpb->parsoid['ids'] );
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
		$siteConfig = new MockSiteConfig( [] );
		$doc = ContentUtils::createAndLoadDocument( $html, siteConfig: $siteConfig );
		$dpb = DomPageBundle::fromLoadedDocument(
			$doc, siteConfig: $siteConfig
		);
		self::assertIsArray( $dpb->parsoid['ids'] );
		$html2 = $dpb->toSingleDocumentHtml();
		$this->assertEquals( <<<'EOF'
<!DOCTYPE html>
<html><head><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"v":2,"parsoid":{"ids":{"mwAA":{"dsr":[0,12,0,0]}}},"mw":{"ids":[]},"counters":{"nodedata":0,"annotation":0,"transclusion":1}}</script></head><body>
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
		$siteConfig = new MockSiteConfig( [] );
		$doc = $dpb->toDom( siteConfig: $siteConfig );
		$df = ContentUtils::createAndLoadDocumentFragment(
			$doc, $data['newFragment']
		);
		// Serialialize back to DomPageBundle.
		$dpb = DomPageBundle::fromLoadedDocument(
			$doc,
			siteConfig: $siteConfig,
			fragments: [ 'hello' => $df ],
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
		$siteConfig = new MockSiteConfig( [] );
		$html = $dpb->toInlineAttributeHtml( siteConfig: $siteConfig, options: [], fragments: $fragments );
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
<html><head><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"v":2,"parsoid":{"ids":{"mwAA":{"dsr":[0,59,0,0]},"mwAQ":{"dsr":[0,58,0,0]},"mwAg":{"dsr":[24,40,3,3]},"mwAw":{"stx":"html","dsr":[42,56,6,7]},"mwBA":{"optList":[{"ck":"link","ak":"link="},{"ck":"caption","ak":"'''bold stuff''': <span>x</span>"}],"dsr":[0,58,null,null]},"mwBQ":{"_type_":"stdClass"},"mwBg":{"a":{"resource":"./File:Foobar.jpg","height":"28","width":"240"},"sa":{"resource":"File:Foobar.jpg"}}},"offsetType":"byte"},"mw":{"ids":[]},"counters":{"nodedata":6,"annotation":0,"transclusion":1}}</script></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}' id="mwBA"><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p>
EOF
	   ,
			'pageBundleBefore' => [
				"v" => 2,
				'html' => <<<'HTML'
<!DOCTYPE html>
<html><head></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}' id="mwBA"><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p></body></html>
HTML
		  ,
				'parsoid' => [
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
				'contentVersion' => null,
				'headers' => null,
				'contentmodel' => null,
				'counters' => [
					'nodedata' => 6,
					'annotation' => 0,
					'transclusion' => 1,
				],
			],
			'newFragment' => '<p data-parsoid=\'{"dsr":[0,12,0,0]}\'>Hello, world</p>',
			'pageBundleAfter' => [
				"v" => 2,
				'html' => <<<'HTML'
<!DOCTYPE html>
<html><head></head><body id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File" id="mwBA" data-mw='{"caption":"&lt;b id=\"mwAg\">bold stuff&lt;/b>: &lt;span id=\"mwAw\">x&lt;/span>"}'><span title="bold stuff: x" id="mwBQ"><img alt="bold stuff: x" resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBg"/></span></span></p></body></html>
HTML
		  ,
				'parsoid' => [
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
				'counters' => [ 'nodedata' => 7, 'annotation' => 0, 'transclusion' => 1 ],
				'contentVersion' => null,
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
<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head prefix="mwr: https://en.wikipedia.org/wiki/Special:Redirect/"><meta charset="utf-8"/><meta property="mw:pageId" content="15580374"/><meta property="mw:pageNamespace" content="0"/><meta property="isMainPage" content="true"/><meta property="mw:htmlVersion" content="2.8.0"/><meta property="mw:html:version" content="2.8.0"/><link rel="dc:isVersionOf" href="//en.wikipedia.org/wiki/Main_Page"/><base href="//en.wikipedia.org/wiki/"/><title>Main Page</title><link rel="stylesheet" href="//en.wikipedia.org/w/load.php?lang=en&amp;modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Csite.styles&amp;only=styles&amp;skin=vector"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/><script id="mw-pagebundle" type="application/x-mw-pagebundle">{"v":2,"parsoid":{"ids":{"mwAA":{"dsr":[0,29,0,0]},"mwAQ":{"dsr":[0,28,0,0]},"mwAg":{"pi":[[{"k":"1"}]],"dsr":[7,26,null,null]},"mwAw":{"optList":[],"dsr":[0,28,null,null]},"mwBA":{"_type_":"stdClass"},"mwBQ":{"a":{"resource":"./File:Foobar.jpg","height":"28","width":"240"},"sa":{"resource":"File:{{1x | Foobar.jpg}}"}}},"offsetType":"byte"},"mw":{"ids":[]},"counters":{"nodedata":5,"annotation":0,"transclusion":2}}</script></head><body lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body-content parsoid-body mediawiki mw-parser-output" dir="ltr" data-mw-parsoid-version="dev-master" data-mw-html-version="2.8.0" id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File mw:ExpandedAttrs" data-mw='{"attribs":[[{"txt":"href"},{"html":"File:&lt;span about=\"#mwt1\" typeof=\"mw:Transclusion\" data-mw=&apos;{\"parts\":[{\"template\":{\"target\":{\"wt\":\"1x \",\"href\":\"./Template:1x\"},\"params\":{\"1\":{\"wt\":\" Foobar.jpg\"}},\"i\":0}}]}&apos; id=\"mwAg\"> Foobar.jpg&lt;/span>"}]]}' id="mwAw"><a href="./File:Foobar.jpg" class="mw-file-description" id="mwBA"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBQ"/></a></span></p>
</body></html>
EOF
			,
			'pageBundleBefore' => [
				"v" => 2,
				'html' => <<<'HTML'
<!DOCTYPE html>
<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head prefix="mwr: https://en.wikipedia.org/wiki/Special:Redirect/"><meta charset="utf-8"/><meta property="mw:pageId" content="15580374"/><meta property="mw:pageNamespace" content="0"/><meta property="isMainPage" content="true"/><meta property="mw:htmlVersion" content="2.8.0"/><meta property="mw:html:version" content="2.8.0"/><link rel="dc:isVersionOf" href="//en.wikipedia.org/wiki/Main_Page"/><base href="//en.wikipedia.org/wiki/"/><title>Main Page</title><link rel="stylesheet" href="//en.wikipedia.org/w/load.php?lang=en&amp;modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Csite.styles&amp;only=styles&amp;skin=vector"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/></head><body lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body-content parsoid-body mediawiki mw-parser-output" dir="ltr" data-mw-parsoid-version="dev-master" data-mw-html-version="2.8.0" id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File mw:ExpandedAttrs" data-mw='{"attribs":[[{"txt":"href"},{"html":"File:&lt;span about=\"#mwt1\" typeof=\"mw:Transclusion\" data-mw=&apos;{\"parts\":[{\"template\":{\"target\":{\"wt\":\"1x \",\"href\":\"./Template:1x\"},\"params\":{\"1\":{\"wt\":\" Foobar.jpg\"}},\"i\":0}}]}&apos; id=\"mwAg\"> Foobar.jpg&lt;/span>"}]]}' id="mwAw"><a href="./File:Foobar.jpg" class="mw-file-description" id="mwBA"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBQ"/></a></span></p>
</body></html>
HTML
		  ,
				'parsoid' => [
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
				'counters' => [ 'nodedata' => 5, 'annotation' => 0, 'transclusion' => 2 ],
				'contentVersion' => null,
				'headers' => null,
				'contentmodel' => null,
			],
			'newFragment' => '<p data-parsoid=\'{"dsr":[0,12,0,0]}\'>Hello, world</p>',
			'pageBundleAfter' => [
				"v" => 2,
				'html' => <<<'HTML'
<!DOCTYPE html>
<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/"><head prefix="mwr: https://en.wikipedia.org/wiki/Special:Redirect/"><meta charset="utf-8"/><meta property="mw:pageId" content="15580374"/><meta property="mw:pageNamespace" content="0"/><meta property="isMainPage" content="true"/><meta property="mw:htmlVersion" content="2.8.0"/><meta property="mw:html:version" content="2.8.0"/><link rel="dc:isVersionOf" href="//en.wikipedia.org/wiki/Main_Page"/><base href="//en.wikipedia.org/wiki/"/><title>Main Page</title><link rel="stylesheet" href="//en.wikipedia.org/w/load.php?lang=en&amp;modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Csite.styles&amp;only=styles&amp;skin=vector"/><meta http-equiv="content-language" content="en"/><meta http-equiv="vary" content="Accept"/></head><body lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body-content parsoid-body mediawiki mw-parser-output" dir="ltr" data-mw-parsoid-version="dev-master" data-mw-html-version="2.8.0" id="mwAA"><p id="mwAQ"><span class="mw-default-size" typeof="mw:File mw:ExpandedAttrs" id="mwAw" data-mw='{"attribs":[[{"txt":"href"},{"html":"File:&lt;span about=\"#mwt1\" typeof=\"mw:Transclusion\" id=\"mwAg\" data-mw=&apos;{\"parts\":[{\"template\":{\"target\":{\"wt\":\"1x \",\"href\":\"./Template:1x\"},\"params\":{\"1\":{\"wt\":\" Foobar.jpg\"}},\"i\":0}}]}&apos;> Foobar.jpg&lt;/span>"}]]}'><a href="./File:Foobar.jpg" class="mw-file-description" id="mwBA"><img resource="./File:Foobar.jpg" src="//upload.wikimedia.org/wikipedia/commons/3/3a/Foobar.jpg" decoding="async" data-file-width="240" data-file-height="28" data-file-type="bitmap" height="28" width="240" class="mw-file-element" id="mwBQ"/></a></span></p>
</body></html>
HTML
		  ,
				'parsoid' => [
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
				'counters' => [ 'nodedata' => 6, 'annotation' => 0, 'transclusion' => 2 ],
				'contentVersion' => null,
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

	/**
	 * T415477: Load a document that has an element with the id "test".
	 * Add a new element with the same id. Each element must keep its own
	 * data-parsoid, and the ids in the output must be unique.
	 *
	 * @covers ::fromLoadedDocument
	 * @dataProvider provideDuplicateIdInAddedContent
	 */
	public function testDuplicateIdInAddedContent(
		bool $prepend, ?array $aDp, string $bHtml,
		string $expectedBody, string $expectedIds
	) {
		$siteConfig = new MockSiteConfig( [] );
		$pb = new HtmlPageBundle(
			html: '<!DOCTYPE html><html><head></head><body><div id="test">a</div></body></html>',
			parsoid: [ 'ids' => [ 'test' => $aDp ] ],
			mw: [ 'ids' => [] ],
			contentVersion: '999.0.0',
			pbVersion: BasePageBundle::VERSION_WITH_USEDID,
		);
		$doc = DomPageBundle::fromHtmlPageBundle( $pb )->toDom( siteConfig: $siteConfig );
		$body = DOMCompat::getBody( $doc );
		$frag = ContentUtils::createAndLoadDocumentFragment( $doc, $bHtml );
		if ( $prepend ) {
			$body->insertBefore( $frag, $body->firstChild );
		} else {
			$body->appendChild( $frag );
		}

		$out = HtmlPageBundle::fromDomPageBundle(
			DomPageBundle::fromLoadedDocument( $doc, $siteConfig, [ 'contentversion' => '999.0.0' ] )
		);
		$this->assertTrue( $out->hasUsedIds() );
		$this->assertStringContainsString( "<body>$expectedBody</body>", $out->html );
		$this->assertSame(
			PHPUtils::jsonDecode( $expectedIds ),
			$out->parsoid['ids']
		);
	}

	public static function provideDuplicateIdInAddedContent(): iterable {
		$aDp = [ 'stx' => 'html', 'dsr' => [ 0, 20, 13, 6 ] ];
		$bWithDp = '<div id="test" data-parsoid=\'{"stx":"html","dsr":[100,120,13,6]}\'>b</div>';
		$bNoDp = '<div id="test">b</div>';
		$aDpJson = '{"stx":"html","dsr":[0,20,13,6]}';
		$bDpJson = '{"stx":"html","dsr":[100,120,13,6]}';

		yield 'append, a has dp, b has dp' => [
			false, $aDp, $bWithDp,
			'<div id="test">a</div><div id="mwAA" data-x-id="test">b</div>',
			"{\"test\":$aDpJson,\"mwAA\":$bDpJson}",
		];
		yield 'append, a has no dp, b has dp' => [
			false, null, $bWithDp,
			'<div id="test">a</div><div id="mwAA" data-x-id="test">b</div>',
			"{\"test\":null,\"mwAA\":$bDpJson}",
		];
		yield 'append, a has no dp, b has no dp' => [
			false, null, $bNoDp,
			'<div id="test">a</div><div id="mwAA" data-x-id="test">b</div>',
			'{"test":null,"mwAA":null}',
		];
		yield 'prepend, a has dp, b has dp' => [
			true, $aDp, $bWithDp,
			'<div id="test">b</div><div id="mwAA" data-x-id="test">a</div>',
			"{\"test\":$bDpJson,\"mwAA\":$aDpJson}",
		];
		yield 'prepend, a has no dp, b has dp' => [
			true, null, $bWithDp,
			'<div id="test">b</div><div id="mwAA" data-x-id="test">a</div>',
			"{\"test\":$bDpJson,\"mwAA\":null}",
		];
		yield 'prepend, a has no dp, b has no dp' => [
			true, null, $bNoDp,
			'<div id="test">b</div><div id="mwAA" data-x-id="test">a</div>',
			'{"test":null,"mwAA":null}',
		];
	}
}
