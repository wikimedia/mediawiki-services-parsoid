<?php
declare( strict_types = 1 );

namespace Test\Utils;

use Closure;
use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Ext\DOMDataUtils;
use Wikimedia\Parsoid\Ext\ExtensionTagHandler;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;

class ContentUtilsTest extends TestCase {

	/**
	 * @covers \Wikimedia\Parsoid\Utils\ContentUtils::processAttributeEmbeddedDom
	 */
	public function testProcessAttributeEmbeddedDomShouldNotAddDataParsoid() {
		// phpcs:ignore Generic.Files.LineLength.TooLong
		$html = '<sup typeof="mw:Extension/ref" class="mw-ref reference" about="#mwt1" id="cite_ref-1" rel="dc:references" data-mw=\'{"name":"ref","attrs":{},"body":{"id":"mw-reference-text-cite_note-1","html":"&lt;a href=\"./Not_exists\" rel=\"mw:WikiLink\" title=\"Not exists\" class=\"new\" typeof=\"mw:LocalizedAttrs\" data-mw-i18n=&apos;{\"title\":{\"lang\":\"x-page\",\"key\":\"red-link-title\",\"params\":[\"Not exists\"]}}&apos; id=\"mwDA\">Not exists&lt;/a>"}}\'><a href="./Refs#cite_note-1" id="mwAw"><span class="mw-reflink-text" id="mwBA"><span class="cite-bracket" id="mwBQ">[</span>1<span class="cite-bracket" id="mwBg">]</span></span></a></sup>';

		$siteConfig = new MockSiteConfig( [] );
		$siteConfig->registerExtensionModule( [
			'name' => 'cite',
			"tags" => [
				[
					"name" => "ref",
					"options" => [
						"wt2html" =>
							[
								"embedsHTMLInAttributes" => true,
							]
					],
					"handler" => [ "factory" => [ self::class, 'citeHtmlHandler' ] ]
				]
			] ] );

		$doc = ContentUtils::createAndLoadDocument( $html );
		ContentUtils::processAttributeEmbeddedDom( $siteConfig, DOMCompat::getBody( $doc )->firstChild,
			static function () {
				return true;
			}
		);
		$res = ContentUtils::ppToXML( $doc->body, [
			'innerXML' => true,
			'fragment' => true,
		] );

		// Adding data-parsoid which didn't exist in the original can cause bugs, see T411238
		self::assertEquals( $html, $res );
	}

	public static function citeHtmlHandler() {
		return new class extends ExtensionTagHandler {
			public function processAttributeEmbeddedHTML(
				ParsoidExtensionAPI $extApi, Element $elt, Closure $proc
			): void {
				$dataMw = DOMDataUtils::getDataMw( $elt );
				if ( isset( $dataMw->body->html ) ) {
					$dataMw->body->html = $proc( $dataMw->body->html );
				}
			}
		};
	}
}
