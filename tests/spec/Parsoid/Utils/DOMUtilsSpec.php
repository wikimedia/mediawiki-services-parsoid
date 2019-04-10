<?php
namespace spec\Parsoid\Utils;

use DOMNode;
use Parsoid\Html2Wt\DOMDiff;
use Parsoid\Tests\MockEnv;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use PhpSpec\Exception\Example\FailureException;
use PhpSpec\ObjectBehavior;

/**
 * Based on tests/mocha/domdiff.js
 * Class DOMUtilsSpec
 * @package spec\Parsoid\Utils
 */
class DOMUtilsSpec extends ObjectBehavior {

	public function it_is_initializable() {
		$this->shouldHaveType( DOMUtils::class );
	}

	/**
	 * @param string $html1
	 * @param string $html2
	 * @return DOMNode
	 */
	private function parseAndDiff( string $html1, string $html2 ): DOMNode {
		$mockEnv = new MockEnv( [] );
		$body1 = ContentUtils::ppToDOM( $mockEnv, $html1 );
		$body2 = ContentUtils::ppToDOM( $mockEnv, $html2 );

		$domDiff = new DOMDiff( $mockEnv );
		$domDiff->diff( $body1, $body2 );

		return $body2;
	}

	private static function selectNode( DOMNode $body, string $selector ): DOMNode {
		$nodes = DOMCompat::querySelectorAll( $body, $selector );
		if ( count( $nodes ) !== 1 ) {
			throw new FailureException( 'It should be exactly one node for the selector' );
		}
		return $nodes[0];
	}

	private static function checkMarkers( DOMNode $node, array $markers ): void {
		$data = DOMDataUtils::getNodeData( $node );
		$diff = $data->parsoid_diff->diff;
		if ( count( $markers ) !== count( $diff ) ) {
			var_dump( $markers );
			var_dump( $diff );
			throw new FailureException( 'Count of diff should be equal count of markers' );
		}
		foreach ( $markers as $key => $value ) {
			if ( $diff[$key] !== $value ) {
				throw new FailureException( 'Diff is not equal to the marker' );
			}
		}
	}

	public function it_should_find_diff_correctly_when_changing_text_in_a_node() {
		$orig = '<p>a</p><p>b</p>';
		$edit = '<p>A</p><p>b</p>';

		$body = self::parseAndDiff( $orig, $edit );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:first-child' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this::isDiffMarker(
			self::selectNode( $body, 'body > p:first-child > meta:first-child' ),
			'deleted'
		)->shouldBe( true );
	}

	public function it_should_find_diff_correctly_when_deleting_a_node() {
		$orig = '<p>a</p><p>b</p>';
		$edit = '<p>a</p>';

		$body = self::parseAndDiff( $orig, $edit );

		self::checkMarkers( $body, [ 'children-changed' ] );

		$this::isDiffMarker(
			self::selectNode( $body, 'body > p + meta' ),
			'deleted'
		)->shouldBe( true );
	}

	public function it_should_find_diff_correctly_when_reordering_nodes() {
		$orig = '<p>a</p><p>b</p>';
		$edit = '<p>b</p><p>a</p>';

		$body = self::parseAndDiff( $orig, $edit );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this::isDiffMarker(
			self::selectNode( $body, 'body > p:nth-child(1) > meta' ),
			'deleted'
		)->shouldBe( true );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(2)' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this::isDiffMarker(
			self::selectNode( $body, 'body > p:nth-child(2) > meta' ),
			'deleted'
		)->shouldBe( true );
	}

	public function it_should_find_diff_correctly_when_adding_multiple_nodes() {
		$orig = '<p>a</p>';
		$edit = '<p>x</p><p>a</p><p>y</p>';

		$body = self::parseAndDiff( $orig, $edit );

		self::checkMarkers( $body, [ 'children-changed' ] );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this::isDiffMarker(
			self::selectNode( $body, 'body > p:nth-child(1) > meta' ),
			'deleted'
		)->shouldBe( true );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(2)' ),
			[ 'inserted' ]
		);

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(3)' ),
			[ 'inserted' ]
		);
	}

	public function it_should_find_diff_correctly_when_adding_and_deleting_nodes() {
		$orig = '<p>a</p><p>b</p><p>c</p>';
		$edit = '<p>x</p><p>b</p>';

		$body = self::parseAndDiff( $orig, $edit );

		self::checkMarkers( $body, [ 'children-changed' ] );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this::isDiffMarker(
			self::selectNode( $body, 'body > p:nth-child(1) > meta' ),
			'deleted'
		)->shouldBe( true );

		$this::isDiffMarker(
			self::selectNode( $body, 'body > meta:nth-child(3)' ),
			'deleted'
		)->shouldBe( true );
	}

	public function it_should_find_diff_correctly_when_changing_an_attribute() {
		$orig = '<p class="a">a</p><p class="b">b</p>';
		$edit = '<p class="X">a</p><p class="b">b</p>';

		$body = self::parseAndDiff( $orig, $edit );

		self::checkMarkers( $body, [ 'children-changed' ] );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'modified-wrapper' ]
		);
	}

	public function it_should_find_diff_correctly_when_changing_data_mw_for_a_template() {
		$orig = '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":' .
			'{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"a"}},"i":0}}]}\'>a</p>';
		$edit = '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":' .
			'{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"foo"}},"i":0}}]}\'>foo</p>';

		$body = self::parseAndDiff( $orig, $edit );

		self::checkMarkers( $body, [ 'children-changed' ] );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'modified-wrapper' ]
		);
	}

	/**
	 * The additional subtrees added to the template's content should simply be ignored
	 */
	public function it_should_correctly_adding_additional_DOM_trees_to_templated_content() {
		$orig = '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":' .
			'{"target":{"wt":"1x","href":"./Template:1x"},"params":' .
			'{"1":{"wt":"a"}},"i":0}}]}\'>a</p>';
		$edit = '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":' .
			'{"target":{"wt":"1x","href":"./Template:1x"},"params":' .
			'{"1":{"wt":"foo\n\nbar\n\nbaz"}},"i":0}}]}\'>foo</p>' .
			'<p about="#mwt1">bar</p><p about="#mwt1">baz</p>';

		$body = self::parseAndDiff( $orig, $edit );

		self::checkMarkers( $body, [ 'children-changed' ] );

		self::checkMarkers(
			self::selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'modified-wrapper' ]
		);
	}

}
