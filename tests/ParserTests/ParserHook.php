<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

use DOMDocument;
use DOMElement;
use DOMNode;
use Error;

use Wikimedia\Parsoid\Ext\Extension;
use Wikimedia\Parsoid\Ext\ExtensionTag;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;

/**
 * See tests/parser/ParserTestParserHook.php in core.
 */
class ParserHook extends ExtensionTag implements Extension {
	public function staticTagPostProcessor( DOMNode $node, \stdClass $obj ): void {
		if ( $node instanceof DOMElement ) {
			$typeOf = $node->getAttribute( 'typeof' ) ?? '';
			if ( preg_match( '#(?:^|\s)mw:Extension/statictag(?=$|\s)#D', $typeOf ) ) {
				$dataMw = DOMDataUtils::getDataMw( $node );
				if ( ( $dataMw->attrs->action ?? null ) === 'flush' ) {
					$node->appendChild( $node->ownerDocument->createTextNode( $obj->buf ) );
					$obj->buf = '';
				} else {
					$obj->buf .= $dataMw->body->extsrc;
				}
			}
		}
	}

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param DOMElement $body
	 * @param array $options
	 * @param bool $atTopLevel
	 */
	public function run(
		ParsoidExtensionAPI $extApi, DOMElement $body, array $options, bool $atTopLevel
	): void {
		if ( $atTopLevel ) {
			// Pass an object since we want the data to be carried around across
			// nodes in the DOM. Passing an array won't work since visitDOM doesn't
			// use a reference on its end. Maybe we could fix that separately.
			DOMUtils::visitDOM( $body, [ $this, 'staticTagPostProcessor' ],
				PHPUtils::arrayToObject( [ 'buf' => '' ] ) );
		}
	}

	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $content, array $args ): DOMDocument {
		$extName = $extApi->getExtensionName();
		switch ( $extName ) {
			case 'tag':
			case 'tåg':
				return $extApi->parseHTML( '<pre />' );

			case 'statictag':
				// FIXME: Choose a better DOM representation that doesn't mess with
				// newline constraints.
				return $extApi->parseHTML( '<span />' );

			default:
				throw new Error( "Unexpected tag name: $extName in ParserHook" );
		}
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'tags' => [
				[ 'name' => 'tag', 'class' => self::class ],
				[ 'name' => 'tåg', 'class' => self::class ],
				[ 'name' => 'statictag', 'class' => self::class ],
			],
			'domProcessors' => [
				'wt2htmlPostProcessor' => self::class
			]
		];
	}
}
