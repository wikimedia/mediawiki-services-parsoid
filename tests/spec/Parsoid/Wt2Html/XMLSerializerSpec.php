<?php

namespace spec\Parsoid\Wt2Html;

use DOMDocument;
use PhpSpec\ObjectBehavior;
use PhpSpec\Wrapper\Subject;

class XMLSerializerSpec extends ObjectBehavior {

	public function it_should_serialize_to_valid_html() {
		$html = '<html><head><title>hi</title><body>'
			. '<div id="123">ok<div id="234">nope</div></div>'
			. "\n\n" . '<!--comment--><div id="345">end</div></body></html>';
		$expectedHtml = "<!DOCTYPE html>\n<html><head><title>hi</title></head><body>"
			. '<div id="123">ok<div id="234">nope</div></div>'
			. "\n\n" . '<!--comment--><div id="345">end</div></body></html>';
		$expectedInnerHtml = "<head><title>hi</title></head><body>"
			. '<div id="123">ok<div id="234">nope</div></div>'
			. "\n\n" . '<!--comment--><div id="345">end</div></body>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $expectedHtml );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'captureOffsets' => true ] );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $expectedHtml );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'innerXML' => true ] );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $expectedInnerHtml );
	}

	public function it_should_capture_html_offsets_while_serializing() {
		$html = '<html><head><title>hi</title><body>'
			. '<div id="123">ok<div id="234">nope</div></div>'
			. "\n\n" . '<!--comment--><div id="345">end</div></body></html>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'captureOffsets' => true ] );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'offsets' );
		$ret['offsets']->shouldHaveKey( '123' );
		$ret['offsets']['123']['html']->shouldEqual( [ 0, 62 ] );
		$ret['offsets']->shouldNotHaveKey( '234' );
		$ret['offsets']->shouldHaveKey( '345' );
		$ret['offsets']['345']['html']->shouldEqual( [ 62, 85 ] );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'captureOffsets' => true, 'innerXML' => true ] );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'offsets' );
		$ret['offsets']->shouldHaveKey( '123' );
		$ret['offsets']['123']['html']->shouldEqual( [ 0, 62 ] );
		$ret['offsets']->shouldNotHaveKey( '234' );
		$ret['offsets']->shouldHaveKey( '345' );
		$ret['offsets']['345']['html']->shouldEqual( [ 62, 85 ] );
	}

	public function it_should_handle_templates_properly_while_capturing_offsets() {
		$html = '<html><head><title>hi</title><body>'
			. '<p about="#mwt1" typeof="mw:Transclusion" id="mwAQ">a</p>'
			. '<p about="#mwt1" id="justhappenstobehere">b</p>'
			. '<p id="mwAg">c</p>'
			. '</body></html>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'captureOffsets' => true ] );
		$ret->shouldHaveKey( 'offsets' );
		$ret['offsets']->shouldHaveKey( 'mwAQ' );
		$ret['offsets']->shouldHaveKey( 'mwAg' );
		$ret['offsets']->shouldNotHaveKey( 'justhappenstobehere' );
		$ret['offsets']['mwAQ']['html']->shouldEqual( [ 0, 104 ] );
		$ret['offsets']['mwAg']['html']->shouldEqual( [ 104, 122 ] );
	}

	public function it_should_handle_expanded_attrs_properly_while_capturing_offsets() {
		//
		$html = '<html><head><title>hi</title><body>'
			// phpcs:ignore Generic.Files.LineLength.TooLong
			. '<div style="color:red" about="#mwt2" typeof="mw:ExpandedAttrs" id="mwAQ" data-mw=\'{"attribs":[[{"txt":"style"},{"html":"&lt;span about=\"#mwt1\" typeof=\"mw:Transclusion\" data-parsoid=\"{&amp;quot;pi&amp;quot;:[[{&amp;quot;k&amp;quot;:&amp;quot;1&amp;quot;}]],&amp;quot;dsr&amp;quot;:[12,30,null,null]}\" data-mw=\"{&amp;quot;parts&amp;quot;:[{&amp;quot;template&amp;quot;:{&amp;quot;target&amp;quot;:{&amp;quot;wt&amp;quot;:&amp;quot;echo&amp;quot;,&amp;quot;href&amp;quot;:&amp;quot;./Template:Echo&amp;quot;},&amp;quot;params&amp;quot;:{&amp;quot;1&amp;quot;:{&amp;quot;wt&amp;quot;:&amp;quot;color:red&amp;quot;}},&amp;quot;i&amp;quot;:0}}]}\">color:red&lt;/span>"}]]}\'>boo</div>'
			. '<p id="mwAg">next!</p>'
			. '</body></html>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'captureOffsets' => true ] );
		$ret->shouldHaveKey( 'offsets' );
		$ret['offsets']->shouldHaveKey( 'mwAQ' );
		$ret['offsets']['mwAQ']['html']->shouldEqual( [ 0, 684 ] );
		$ret['offsets']->shouldHaveKey( 'mwAg' );
		$ret['offsets']['mwAg']['html']->shouldEqual( [ 684, 706 ] );
	}

	public function it_should_handle_extension_content_nested_in_templates_while_capturing_offsets() {
		// Mostly scooped from, echo "{{Demografia/Apricale}}" | node tests/parse --prefix itwiki --dp
		$html = '<html><head><title>hi</title><body>'
				// phpcs:ignore Generic.Files.LineLength.TooLong
			. '<p about="#mwt1" typeof="mw:Transclusion" id="mwAQ" data-mw=\'{"parts":[{"template":{"target":{"wt":"Demografia/Apricale","href":"./Template:Demografia/Apricale"},"params":{},"i":0}}]}\'><i>Abitanti censiti</i></p>'
				// phpcs:ignore Generic.Files.LineLength.TooLong
			. '<map name="timeline" id="timeline" typeof="mw:Extension/timeline" data-mw=\'{"name":"timeline","attrs":{},"body":{"extsrc":"yadayadayada"}}\' about="#mwt1"></map>'
			. '</body></html>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'captureOffsets' => true ] );
		$ret->shouldHaveKey( 'offsets' );
		$ret['offsets']->shouldHaveKey( 'mwAQ' );
		$ret['offsets']->shouldNotHaveKey( 'timeline' );
		$ret['offsets']['mwAQ']['html']->shouldEqual( [ 0, 372 ] );
	}

	public function it_should_handle_uppercase_tagnames_correctly() {
		$html = '<HTML><HeAD><Title>hi</title><body>'
			. '<DIV ID="123">ok<div id="234">nope</DIV></div>'
			. "\n\n" . '<!--comment--><div id="345">end</div></Body></HTML>';
		$expectedHtml = "<!DOCTYPE html>\n<html><head><title>hi</title></head><body>"
			. '<div id="123">ok<div id="234">nope</div></div>'
			. "\n\n" . '<!--comment--><div id="345">end</div></body></html>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $expectedHtml );
	}

	public function it_should_handle_quotes_correctly() {
		$html = '<html><body>'
			. '<div attr="&quot;&apos;&quot;"></div>'
			. '<div attr=\'&quot;&apos;&quot;\'></div>'
			. '<div attr="&apos;&quot;&apos;"></div>'
			. '<div attr=\'&apos;&quot;&apos;\'></div>'
			. '</body></html>';
		$expectedNonSmart = "<!DOCTYPE html>\n<html><body>"
			. '<div attr="&quot;\'&quot;"></div>'
			. '<div attr="&quot;\'&quot;"></div>'
			. '<div attr="\'&quot;\'"></div>'
			. '<div attr="\'&quot;\'"></div>'
			. '</body></html>';
		$expectedSmart = "<!DOCTYPE html>\n<html><body>"
			. '<div attr=\'"&apos;"\'></div>'
			. '<div attr=\'"&apos;"\'></div>'
			. '<div attr="\'&quot;\'"></div>'
			. '<div attr="\'&quot;\'"></div>'
			. '</body></html>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'smartQuote' => false ] );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $expectedNonSmart );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc, [ 'smartQuote' => true ] );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $expectedSmart );
	}

	public function it_should_handle_empty_elements_correctly() {
		// Must have a single root node, otherwise libxml messes up parsing in NOIMPLIED mode.
		$html = '<div><span /><hr/></div>';
		$expectedHtml = '<div><span></span><hr/></div>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html, LIBXML_HTML_NOIMPLIED );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $expectedHtml );
	}

	public function it_should_handle_raw_content_correctly() {
		$html = '<script>x</script>';
		$doc = new DOMDocument();
		$doc->loadHTML( $html, LIBXML_HTML_NOIMPLIED );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $html );
	}

	public function it_should_handle_newline_stripping_elements_correctly() {
		// Must have a single root node, otherwise libxml messes up parsing in NOIMPLIED mode.
		// This test looks confusing because DOMDocument::loadHTML doesn't fully follow the spec;
		// it should strip the first newline within a pre block.
		$html = "<div><pre>\n</pre><div>\n</div></div>";
		$expectedHtml = "<div><pre>\n\n</pre><div>\n</div></div>";
		$doc = new DOMDocument();
		$doc->loadHTML( $html, LIBXML_HTML_NOIMPLIED );

		/** @var Subject $ret */
		$ret = $this::serialize( $doc );
		$ret->shouldBeArray();
		$ret->shouldHaveKey( 'html' );
		$ret['html']->shouldEqual( $expectedHtml );
	}

}
