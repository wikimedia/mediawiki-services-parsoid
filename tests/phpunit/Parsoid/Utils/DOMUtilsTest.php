<?php
namespace spec\Parsoid\Utils;

use DOMDocument;
use DOMElement;
use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Html2Wt\DOMDiff;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;

/**
 * Based on tests/mocha/domdiff.js
 * @coversDefaultClass \Wikimedia\Parsoid\Utils\DOMUtils
 */
class DOMUtilsTest extends TestCase {

	/** @var DOMDocument[] */
	private $liveDocs = [];

	/**
	 * @covers ::isDiffMarker
	 */
	public function testIsDiffMarker_changingTextInNode() {
		$orig = '<p>a</p><p>b</p>';
		$edit = '<p>A</p><p>b</p>';

		$body = $this->parseAndDiff( $orig, $edit );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:first-child' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this->assertTrue( DOMUtils::isDiffMarker(
			$this->selectNode( $body, 'body > p:first-child > meta:first-child' ),
			'deleted'
		) );
	}

	/**
	 * @covers ::isDiffMarker
	 */
	public function testIsDiffMarker_deletingNode() {
		$orig = '<p>a</p><p>b</p>';
		$edit = '<p>a</p>';

		$body = $this->parseAndDiff( $orig, $edit );

		$this->checkMarkers( $body, [ 'children-changed' ] );

		$this->assertTrue( DOMUtils::isDiffMarker(
			$this->selectNode( $body, 'body > p + meta' ),
			'deleted'
		) );
	}

	/**
	 * @covers ::isDiffMarker
	 */
	public function testIsDiffMarker_reorderingNodes() {
		$orig = '<p>a</p><p>b</p>';
		$edit = '<p>b</p><p>a</p>';

		$body = $this->parseAndDiff( $orig, $edit );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this->assertTrue( DOMUtils::isDiffMarker(
			$this->selectNode( $body, 'body > p:nth-child(1) > meta' ),
			'deleted'
		) );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(2)' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this->assertTrue( DOMUtils::isDiffMarker(
			$this->selectNode( $body, 'body > p:nth-child(2) > meta' ),
			'deleted'
		) );
	}

	/**
	 * @covers ::isDiffMarker
	 */
	public function testIsDiffMarker_addingMultipleNodes() {
		$orig = '<p>a</p>';
		$edit = '<p>x</p><p>a</p><p>y</p>';

		$body = $this->parseAndDiff( $orig, $edit );

		$this->checkMarkers( $body, [ 'children-changed' ] );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this->assertTrue( DOMUtils::isDiffMarker(
			$this->selectNode( $body, 'body > p:nth-child(1) > meta' ),
			'deleted'
		) );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(2)' ),
			[ 'inserted' ]
		);

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(3)' ),
			[ 'inserted' ]
		);
	}

	/**
	 * @covers ::isDiffMarker
	 */
	public function testIsDiffMarker_addingAndDeletingNodes() {
		$orig = '<p>a</p><p>b</p><p>c</p>';
		$edit = '<p>x</p><p>b</p>';

		$body = $this->parseAndDiff( $orig, $edit );

		$this->checkMarkers( $body, [ 'children-changed' ] );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'children-changed', 'subtree-changed' ]
		);

		$this->assertTrue( DOMUtils::isDiffMarker(
			$this->selectNode( $body, 'body > p:nth-child(1) > meta' ),
			'deleted'
		) );

		$this->assertTrue( DOMUtils::isDiffMarker(
			$this->selectNode( $body, 'body > meta:nth-child(3)' ),
			'deleted'
		) );
	}

	/**
	 * @coversNothing
	 */
	public function testSomething_changingAttribute() {
		$orig = '<p class="a">a</p><p class="b">b</p>';
		$edit = '<p class="X">a</p><p class="b">b</p>';

		$body = $this->parseAndDiff( $orig, $edit );

		$this->checkMarkers( $body, [ 'children-changed' ] );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'modified-wrapper' ]
		);
	}

	/**
	 * @coversNothing
	 */
	public function testSomething_changingDataMwForTemplate() {
		$orig = '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":' .
			'{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"a"}},"i":0}}]}\'>a</p>';
		$edit = '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":' .
			'{"target":{"wt":"1x","href":"./Template:1x"},"params":{"1":{"wt":"foo"}},"i":0}}]}\'>foo</p>';

		$body = $this->parseAndDiff( $orig, $edit );

		$this->checkMarkers( $body, [ 'children-changed' ] );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'modified-wrapper' ]
		);
	}

	/**
	 * @coversNothing
	 * The additional subtrees added to the template's content should simply be ignored
	 */
	public function testSomething_addingAdditionalDomTreesToTemplatedContent() {
		$orig = '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":' .
			'{"target":{"wt":"1x","href":"./Template:1x"},"params":' .
			'{"1":{"wt":"a"}},"i":0}}]}\'>a</p>';
		$edit = '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":' .
			'{"target":{"wt":"1x","href":"./Template:1x"},"params":' .
			'{"1":{"wt":"foo\n\nbar\n\nbaz"}},"i":0}}]}\'>foo</p>' .
			'<p about="#mwt1">bar</p><p about="#mwt1">baz</p>';

		$body = $this->parseAndDiff( $orig, $edit );

		$this->checkMarkers( $body, [ 'children-changed' ] );

		$this->checkMarkers(
			$this->selectNode( $body, 'body > p:nth-child(1)' ),
			[ 'modified-wrapper' ]
		);
	}

	/**
	 * @param string $html1
	 * @param string $html2
	 * @return DOMElement
	 */
	private function parseAndDiff( string $html1, string $html2 ): DOMElement {
		$mockEnv = new MockEnv( [] );

		$doc1 = ContentUtils::createAndLoadDocument( $html1 );
		$doc2 = ContentUtils::createAndLoadDocument( $html2 );

		$body1 = DOMCompat::getBody( $doc1 );
		$body2 = DOMCompat::getBody( $doc2 );

		$domDiff = new DOMDiff( $mockEnv );
		$domDiff->diff( $body1, $body2 );

		// Prevent GC from reclaiming doc2 once we exit this function.
		// Necessary hack because we use PHPDOM which wraps libxml.
		$this->liveDocs[] = $doc2;

		return DOMCompat::getBody( $doc2 );
	}

	private function selectNode( DOMElement $body, string $selector ): DOMElement {
		$nodes = DOMCompat::querySelectorAll( $body, $selector );
		if ( count( $nodes ) !== 1 ) {
			$this->fail( 'It should be exactly one node for the selector' );
		}
		return $nodes[0];
	}

	private function checkMarkers( DOMElement $node, array $markers ): void {
		$data = DOMDataUtils::getNodeData( $node );
		$diff = $data->parsoid_diff->diff;
		if ( count( $markers ) !== count( $diff ) ) {
			var_dump( $markers );
			var_dump( $diff );
			$this->fail( 'Count of diff should be equal count of markers' );
		}
		foreach ( $markers as $key => $value ) {
			if ( $diff[$key] !== $value ) {
				$this->fail( 'Diff is not equal to the marker' );
			}
		}
	}

}
