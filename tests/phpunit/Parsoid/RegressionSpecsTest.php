<?php
// phpcs:disable Generic.Files.LineLength.TooLong
declare( strict_types = 1 );

namespace Test\Parsoid;

use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Core\SelserData;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Utils\DiffDOMUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;

/**
 * Tests parsing for regressions against specific issues that have been resolved
 * based on tests/mocha/regression.specs.js
 */
class RegressionSpecsTest extends TestCase {
	/**
	 * @param string $wt
	 * @param array $opts
	 * @return Element
	 */
	private function parseWT( string $wt, array $opts = [] ): Element {
		$siteConfig = new MockSiteConfig( [] );
		$dataAccess = new MockDataAccess( [] );
		$parsoid = new Parsoid( $siteConfig, $dataAccess );

		$content = new MockPageContent( [ 'main' => $wt ] );
		$pageConfig = new MockPageConfig( $opts, $content );
		$html = $parsoid->wikitext2html( $pageConfig, [ "wrapSections" => false ] );

		$doc = DOMUtils::parseHTML( $html );

		$docBody = DOMCompat::getBody( $doc );

		return( $docBody );
	}

	/**
	 * @param string $description
	 * @param string $wt
	 * @param array $search
	 * @param array $replace
	 * @param string $withoutSelser
	 * @param string $withSelser
	 */
	private function sharedTest(
		string $description, string $wt, array $search, array $replace,
		string $withoutSelser, string $withSelser
	): void {
		$siteConfig = new MockSiteConfig( [] );
		$dataAccess = new MockDataAccess( [] );
		$parsoid = new Parsoid( $siteConfig, $dataAccess );

		$content = new MockPageContent( [ 'main' => $wt ] );
		$pageConfig = new MockPageConfig( [], $content );
		$html = $parsoid->wikitext2html( $pageConfig, [ "wrapSections" => false ] );

		// This is mimicking a copy/paste in an editor
		$editedHTML = str_replace( $search, $replace, $html );

		// Without selser
		$editedWT = $parsoid->html2wikitext( $pageConfig, $editedHTML, [], null );
		$this->assertEquals( $withoutSelser, $editedWT, $description );

		// With selser
		$selserData = new SelserData( $wt, $html );
		$editedWT = $parsoid->html2wikitext( $pageConfig, $editedHTML, [], $selserData );
		$this->assertEquals( $withSelser, $editedWT, $description );
	}

	/**
	 * Wikilinks use ./ prefixed urls. For reasons of consistency,
	 * we should use a similar format for internal cite urls.
	 * This spec ensures that we don't inadvertently break that requirement.
	 * should use ./ prefixed urls for cite links
	 * @covers \Wikimedia\Parsoid\Wt2Html\ParserPipeline
	 */
	public function testWikilinkUseDotSlashPrefix(): void {
		$description = "Regression Specs: should use ./ prefixed urls for cite links";
		$wt = "a [[Foo]] <ref>b</ref>";
		$docBody = $this->parseWT( $wt, [ 'title' => 'Main_Page' ] );

		$attrib = DOMCompat::querySelectorAll( $docBody, ".mw-ref a" )[0]->
			getAttribute( 'href' );
		$this->assertEquals( './Main_Page#cite_note-1', $attrib, $description );

		$attrib = DOMCompat::querySelectorAll( $docBody, "#cite_note-1 a" )[0]->
			getAttribute( 'href' );
		$this->assertEquals( './Main_Page#cite_ref-1', $attrib, $description );
	}

	/**
	 * should prevent regression of T153107
	 * @covers \Wikimedia\Parsoid\Wt2Html\ParserPipeline
	 */
	public function testPreventRegressionT153107(): void {
		$description = "Regression Specs: should prevent regression of T153107";
		$wt = "[[Foo|bar]]";
		$searchItems = [ 'bar' ];
		$replaceItems = [ 'Foo' ];
		$withoutSelser = "[[Foo|Foo]]";
		$withSelser = "[[Foo]]";

		$this->sharedTest( $description, $wt, $searchItems, $replaceItems,
			$withoutSelser, $withSelser );
	}

	/**
	 * should prevent regression of T268737
	 * @covers \Wikimedia\Parsoid\Html2Wt\Separators::recoverTrimmedWhitespace
	 */
	public function testPreventRegressionT268737(): void {
		$description = "Regression Specs: should prevent regression of T262737";
		$wt = "* [[Foo]]--[[Bar]]";
		$searchItems = [ '--' ];
		$replaceItems = [ '..' ];
		$withoutSelser = "*[[Foo]]..[[Bar]]";
		$withSelser = "* [[Foo]]..[[Bar]]";

		$this->sharedTest( $description, $wt, $searchItems, $replaceItems,
			$withoutSelser, $withSelser );
	}

	/**
	 * should ensure edited lists, headings, table cells preserve original
	 * whitespace in some scenarios
	 * @covers \Wikimedia\Parsoid\Wt2Html\ParserPipeline
	 */
	public function testPreserveWhitespace(): void {
		$description = "should ensure edited lists, headings, table cells preserve original " .
			"whitespace in some scenarios";

		$wt = implode( "\n", [
			"* item",
			"* <!--cmt--> item",
			"* <div>item</div>",
			"* [[Link|item]]",
			"* wrap",
			"== heading ==",
			"== <!--cmt--> heading ==",
			"== <div>heading</div> ==",
			"== [[Link|heading]] ==",
			"{|",
			"| cell",
			"| <!--cmt--> cell",
			"| <div>cell</div>",
			"| [[Link|cell]]",
			"|  unedited c1  || cell ||  unedited c3  || cell",
			"|  unedited c1  || cell ||  unedited c3  ||   unedited c4",
			"|}"
		] );

		$searchItems = [ 'item', 'heading', 'cell', 'wrap' ];
		$replaceItems = [ 'edited item', 'edited heading', 'edited cell', '<span>wrap</span>' ];

		// Without selser, we should see normalized wikitext
		$withoutSelser = implode( "\n", [
			"*edited item",
			"*<!--cmt-->edited item",
			"*<div>edited item</div>",
			"*[[Link|edited item]]",
			"*<span>wrap</span>",
			"==edited heading==",
			"==<!--cmt-->edited heading==",
			"==<div>edited heading</div>==",
			"==[[Link|edited heading]]==",
			"{|",
			"|edited cell",
			"|<!--cmt-->edited cell",
			"|<div>edited cell</div>",
			"|[[Link|edited cell]]",
			"|unedited c1||edited cell||unedited c3||edited cell",
			"|unedited c1||edited cell||unedited c3||unedited c4",
			"|}"
		] );

		// With selser, we should have whitespace heuristics applied
		$withSelser = implode( "\n", [
			"* edited item",
			"* <!--cmt-->edited item",
			"* <div>edited item</div>",
			"* [[Link|edited item]]",
			"* <span>wrap</span>",
			"== edited heading ==",
			"== <!--cmt-->edited heading ==",
			"== <div>edited heading</div> ==",
			"== [[Link|edited heading]] ==",
			"{|",
			"| edited cell",
			"| <!--cmt-->edited cell",
			"| <div>edited cell</div>",
			"| [[Link|edited cell]]",
			"|  unedited c1  || edited cell ||  unedited c3  || edited cell",
			"|  unedited c1  || edited cell ||  unedited c3  ||   unedited c4",
			"|}"
		] );

		$this->sharedTest( $description, $wt, $searchItems, $replaceItems,
			$withoutSelser, $withSelser );
	}

	/**
	 * should not apply whitespace heuristics for HTML versions older than 1.7.0
	 * @covers \Wikimedia\Parsoid\Wt2Html\ParserPipeline
	 */
	public function testNoWhitespaceHeuristics(): void {
		$description = "should not apply whitespace heuristics for HTML versions older than 1.7.0";
		$wt = implode( "\n", [
			"* item",
			"* <!--cmt--> item",
			"* <div>item</div>",
			"* [[Link|item]]",
			"* wrap",
			"== heading ==",
			"== <!--cmt--> heading ==",
			"== <div>heading</div> ==",
			"== [[Link|heading]] ==",
			"{|",
			"| cell",
			"| <!--cmt--> cell",
			"| <div>cell</div>",
			"| [[Link|cell]]",
			"|}"
		] );

		$siteConfig = new MockSiteConfig( [] );
		$dataAccess = new MockDataAccess( [] );
		$parsoid = new Parsoid( $siteConfig, $dataAccess );

		$content = new MockPageContent( [ 'main' => $wt ] );
		$pageConfig = new MockPageConfig( [], $content );

		$html = $parsoid->wikitext2html( $pageConfig, [ "wrapSections" => false ] );

		$search = [ 'item', 'heading', 'cell', 'wrap' ];
		$replace = [ 'edited item', 'edited heading', 'edited cell', '<span>wrap</span>' ];
		$editedBody = str_replace( $search, $replace, $html );

		// Whitespace heuristics are enabled
		$newVersion = implode( "\n", [
			"* edited item",
			"* <!--cmt-->edited item",
			"* <div>edited item</div>",
			"* [[Link|edited item]]",
			"* <span>wrap</span>",
			"== edited heading ==",
			"== <!--cmt-->edited heading ==",
			"== <div>edited heading</div> ==",
			"== [[Link|edited heading]] ==",
			"{|",
			"| edited cell",
			"| <!--cmt-->edited cell",
			"| <div>edited cell</div>",
			"| [[Link|edited cell]]",
			"|}"
		] );

		$selserData = new SelserData( $wt, $html );
		$editedWT = $parsoid->html2wikitext( $pageConfig, $editedBody, [], $selserData );
		$this->assertEquals( $newVersion, $editedWT, $description );

		// Whitespace heuristics are disabled, but selser's buildSep heuristics
		// will do the magic for old non-text and non-comment nodes.
		$oldVersion = implode( "\n", [
			"*edited item",
			"*<!--cmt-->edited item",
			"* <div>edited item</div>",
			"* [[Link|edited item]]",
			"*<span>wrap</span>",
			"==edited heading==",
			"==<!--cmt-->edited heading==",
			"== <div>edited heading</div> ==",
			"== [[Link|edited heading]] ==",
			"{|",
			"|edited cell",
			"|<!--cmt-->edited cell",
			"| <div>edited cell</div>",
			"| [[Link|edited cell]]",
			"|}"
		] );

		// Pretend we are in 1.6.1 version to disable whitespace heuristics
		$htmlVersion = '1.6.1';

		$selserData = new SelserData( $wt, $html );
		$editedWT = $parsoid->html2wikitext( $pageConfig, $editedBody,
			[ 'inputContentVersion' => $htmlVersion ], $selserData );
		$this->assertEquals( $oldVersion, $editedWT, $description );
	}

	/**
	 * should not wrap templatestyles style tags in p-wrappers
	 * @covers \Wikimedia\Parsoid\Wt2Html\TT\TemplateHandler
	 */
	public function testNoWrapTemplateStyles(): void {
		$description = "Regression Specs: should not wrap templatestyles style tags in p-wrappers";
		$wt = "<templatestyles src='Template:Quote/styles.css'/><div>foo</div>";
		$docBody = $this->parseWT( $wt );
		$node = DOMCompat::nodeName( $docBody->firstChild );

		$this->assertEquals( "style",  $node, $description );
	}

	/**
	 * For https://phabricator.wikimedia.org/T208901
	 * should not split p-wrappers around templatestyles
	 * @covers \Wikimedia\Parsoid\Wt2Html\TT\TemplateHandler
	 */
	public function testNoSplitPWrapper(): void {
		$description = "Regression Specs: should not split p-wrappers around templatestyles";
		$wt = 'abc {{1x|<templatestyles src="Template:Quote/styles.css" /> def}} ghi ' .
			'[[File:Thumb.png|thumb|250px]]';
		$docBody = $this->parseWT( $wt );

		$node = DOMCompat::nodeName( $docBody->firstChild );
		$this->assertEquals( "p",  $node, $description );

		$node = DOMCompat::nodeName( DiffDOMUtils::nextNonSepSibling( $docBody->firstChild ) );
		$this->assertEquals( "figure",  $node, $description );
	}

	/**
	 * Regression Specs: should deduplicate templatestyles style tags
	 * @covers \Wikimedia\Parsoid\Wt2Html\TT\TemplateHandler
	 */
	public function testNoDupTemplateStyleTags(): void {
		$description = "Regression Specs: should deduplicate templatestyles style tags";
		$wt = [
			'<templatestyles src="Template:Quote/styles.css" /><span>a</span>',
			'<templatestyles src="Template:Quote/styles.css" /><span>b</span>'
		];
		$wt = implode( "\n", $wt );
		$docBody = $this->parseWT( $wt );

		$firstStyle = $docBody->firstChild->firstChild;
		$this->assertEquals( "style",  DOMCompat::nodeName( $firstStyle ), $description );

		$secondStyle = $firstStyle->nextSibling->nextSibling->nextSibling;
		$this->assertEquals( "link",  DOMCompat::nodeName( $secondStyle ), $description );

		$this->assertEquals( "mw-deduplicated-inline-style",
			$secondStyle->getAttribute( 'rel' ), $description );

		$this->assertEquals( 'mw-data:' .
			$firstStyle->getAttribute( 'data-mw-deduplicate' ),
			$secondStyle->getAttribute( 'href' ), $description );

		$keys = [ 'about','typeof','data-mw','data-parsoid' ];
		foreach ( $keys as $key ) {
			$this->assertTrue( $secondStyle->hasAttribute( $key ), $description );
		}
	}

	/**
	 * I1f572f996a7c2b3b852752f5348ebb60d8e21c47 introduces a backwards
	 * incompatibility.  This test asserts that selser will restore content
	 * for invalid follows that would otherwise be dropped since it wasn't
	 * span wrapped.
	 * @covers \Wikimedia\Parsoid\Ext\Cite\Ref::domToWikitext
	 */
	public function testSelserFollowsWrap(): void {
		$wt = 'Hi ho <ref follow="123">hi ho</ref>';
		$html = <<<EOT
<p data-parsoid='{"dsr":[0,35,0,0]}'>Hi ho <sup about="#mwt2" class="mw-ref" id="cite_ref-1" rel="dc:references" typeof="mw:Extension/ref mw:Error" data-parsoid='{"dsr":[6,35,18,6]}' data-mw='{"name":"ref","attrs":{"follow":"123"},"body":{"id":"mw-reference-text-cite_note-1"},"errors":[{"key":"cite_error_references_missing_key","params":["123"]}]}'><a href="./Main_Page#cite_note-1" style="counter-reset: mw-Ref 1;" data-parsoid="{}"><span class="mw-reflink-text" data-parsoid="{}">[1]</span></a></sup></p>

<div class="mw-references-wrap" typeof="mw:Extension/references" about="#mwt3" data-parsoid='{"dsr":[36,36,0,0]}' data-mw='{"name":"references","attrs":{},"autoGenerated":true}'><ol class="mw-references references" data-parsoid="{}"><li about="#cite_note-1" id="cite_note-1" data-parsoid="{}"><a href="./Main_Page#cite_ref-1" rel="mw:referencedBy" data-parsoid="{}"><span class="mw-linkback-text" data-parsoid="{}">↑ </span></a> <span id="mw-reference-text-cite_note-1" class="mw-reference-text" data-parsoid="{}">hi ho</span></li></ol></div>
EOT;
		$editedHtml = <<<EOT
<p data-parsoid='{"dsr":[0,35,0,0]}'>Ha ha <sup about="#mwt2" class="mw-ref" id="cite_ref-1" rel="dc:references" typeof="mw:Extension/ref mw:Error" data-parsoid='{"dsr":[6,35,18,6]}' data-mw='{"name":"ref","attrs":{"follow":"123"},"body":{"id":"mw-reference-text-cite_note-1"},"errors":[{"key":"cite_error_references_missing_key","params":["123"]}]}'><a href="./Main_Page#cite_note-1" style="counter-reset: mw-Ref 1;" data-parsoid="{}"><span class="mw-reflink-text" data-parsoid="{}">[1]</span></a></sup></p>

<div class="mw-references-wrap" typeof="mw:Extension/references" about="#mwt3" data-parsoid='{"dsr":[36,36,0,0]}' data-mw='{"name":"references","attrs":{},"autoGenerated":true}'><ol class="mw-references references" data-parsoid="{}"><li about="#cite_note-1" id="cite_note-1" data-parsoid="{}"><a href="./Main_Page#cite_ref-1" rel="mw:referencedBy" data-parsoid="{}"><span class="mw-linkback-text" data-parsoid="{}">↑ </span></a> <span id="mw-reference-text-cite_note-1" class="mw-reference-text" data-parsoid="{}">hi ho</span></li></ol></div>
EOT;

		$siteConfig = new MockSiteConfig( [] );
		$dataAccess = new MockDataAccess( [] );
		$parsoid = new Parsoid( $siteConfig, $dataAccess );
		$content = new MockPageContent( [ 'main' => $wt ] );
		$pageConfig = new MockPageConfig( [], $content );

		// Without selser
		$editedWt = $parsoid->html2wikitext( $pageConfig, $editedHtml, [], null );
		$this->assertEquals( "Ha ha <ref follow=\"123\"></ref>\n\n<references />", $editedWt );

		// // With selser
		$selserData = new SelserData( $wt, $html );
		$editedWt = $parsoid->html2wikitext( $pageConfig, $editedHtml, [], $selserData );
		$this->assertEquals( "Ha ha <ref follow=\"123\">hi ho</ref>\n\n", $editedWt );
	}

}
