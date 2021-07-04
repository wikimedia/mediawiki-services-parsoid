<?php

namespace Test\Parsoid\Utils;

use stdClass;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMTraverser;

class DOMTraverserTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @dataProvider provideTraverse
	 * @covers \Wikimedia\Parsoid\Utils\DOMTraverser::addHandler
	 * @covers \Wikimedia\Parsoid\Utils\DOMTraverser::traverse
	 */
	public function testTraverse( callable $callback, ?string $nodeName, Env $env, array $expectedTrace ) {
		$html = <<<'HTML'
<html><body>
	<div id="x1">
		<div id="x1_1"></div>
		<blockquote id="x1_2">
			<div id="x1_2_1"></div>
			<div id="x1_2_2"></div>
		</blockquote>
		<div id="x1_3"></div>
	</div>
	<div id="x2">
		<div id="x2_1"></div>
	</div>
</body></html>
HTML;
		$doc = DOMCompat::newDocument( true );
		$doc->loadHTML( $html );

		$trace = [];
		$traverser = new DOMTraverser();
		$traverser->addHandler( $nodeName, $callback );
		$traverser->addHandler( null, static function (
			Node $node, Env $env, array $options, bool $atTopLevel, ?stdClass $tplInfo
		) use ( &$trace ) {
			if ( $node instanceof Element && $node->hasAttribute( 'id' ) ) {
				$trace[] = $node->getAttribute( 'id' );
			}
			return true;
		} );
		$traverser->traverse( $env, $doc->documentElement, [], true, null );
		$this->assertSame( $expectedTrace, $trace );
	}

	public function provideTraverse() {
		$basicEnv = new MockEnv( [] );

		$expectError = $this->getMockBuilder( MockEnv::class )
			->setConstructorArgs( [ [] ] )
			->onlyMethods( [ 'log' ] )
			->getMock();
		$expectError->expects( $this->atLeastOnce() )
			->method( 'log' )
			->willReturnCallback( function ( $prefix ) {
				$this->assertSame( 'error', $prefix );
			} );
		$dontExpectError = $this->getMockBuilder( MockEnv::class )
			->setConstructorArgs( [ [] ] )
			->onlyMethods( [ 'log' ] )
			->getMock();
		$dontExpectError->expects( $this->never() )
			->method( 'log' );

		return [
			'basic' => [
				'callback' => function (
					Node $node, Env $env, array $options, bool $atTopLevel,
					?stdClass $tplInfo
				) use ( $basicEnv ) {
					$this->assertSame( $basicEnv, $env );
					$this->assertTrue( $atTopLevel );
					return true;
				},
				'nodeName' => null,
				'env' => $basicEnv,
				'expectedTrace' => [ 'x1', 'x1_1', 'x1_2', 'x1_2_1', 'x1_2_2', 'x1_3', 'x2', 'x2_1' ],
			],
			'return true' => [
				'callback' => static function (
					Node $node, Env $env, array $options, bool $atTopLevel,
					?stdClass $tplInfo
				) {
					return true;
				},
				'nodeName' => null,
				'env' => $basicEnv,
				'expectedTrace' => [ 'x1', 'x1_1', 'x1_2', 'x1_2_1', 'x1_2_2', 'x1_3', 'x2', 'x2_1' ],
			],
			'return first child' => [
				'callback' => static function (
					Node $node, Env $env, array $options, bool $atTopLevel,
					?stdClass $tplInfo
				) {
					if ( $node instanceof Element && $node->getAttribute( 'id' ) === 'x1_2' ) {
						return $node->firstChild;
					}
					return true;
				},
				'nodeName' => null,
				'env' => $basicEnv,
				'expectedTrace' => [ 'x1', 'x1_1', 'x1_2_1', 'x1_2_2', 'x2', 'x2_1' ],
			],
			'return next sibling' => [
				'callback' => static function (
					Node $node, Env $env, array $options, bool $atTopLevel,
					?stdClass $tplInfo
				) {
					if ( $node instanceof Element && $node->getAttribute( 'id' ) === 'x1_2' ) {
						return $node->nextSibling;
					}
					return true;
				},
				'nodeName' => null,
				'env' => $basicEnv,
				'expectedTrace' => [ 'x1', 'x1_1', 'x1_3', 'x2', 'x2_1' ],
			],
			'return null' => [
				'callback' => static function (
					Node $node, Env $env, array $options, bool $atTopLevel,
					?stdClass $tplInfo
				) {
					if ( $node instanceof Element && $node->getAttribute( 'id' ) === 'x1_2' ) {
						return null;
					}
					return true;
				},
				'nodeName' => null,
				'env' => $basicEnv,
				'expectedTrace' => [ 'x1', 'x1_1', 'x2', 'x2_1' ],
			],
			'return another node' => [
				'callback' => static function (
					Node $node, Env $env, array $options, bool $atTopLevel,
					?stdClass $tplInfo
				) {
					if ( $node instanceof Element && $node->getAttribute( 'id' ) === 'x1_2' ) {
						$newNode = $node->ownerDocument->createElement( 'div' );
						$newNode->setAttribute( 'id', 'new' );
						return $newNode;
					}
					return true;
				},
				'nodeName' => null,
				'env' => $basicEnv,
				'expectedTrace' => [ 'x1', 'x1_1', 'new', 'x2', 'x2_1' ],
			],
			'name filter' => [
				'callback' => static function (
					Node $node, Env $env, array $options,
					bool $atTopLevel, ?stdClass $tplInfo
				) {
					if ( $node instanceof Element && $node->getAttribute( 'id' ) === 'x1_2' ) {
						return null;
					}
					return true;
				},
				'nodeName' => 'div',
				'env' => $basicEnv,
				'expectedTrace' => [ 'x1', 'x1_1', 'x1_2', 'x1_2_1', 'x1_2_2', 'x1_3', 'x2', 'x2_1' ],
			],
		];
	}

}
