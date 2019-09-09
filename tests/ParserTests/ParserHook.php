<?php
declare( strict_types = 1 );

namespace Parsoid\Tests\ParserTests;

use DOMDocument;
use DOMElement;
use DOMNode;
use Error;

use Parsoid\Config\Env;
use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PHPUtils;

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
	 * @param DOMElement $body
	 * @param Env $env
	 * @param array $options
	 * @param bool $atTopLevel
	 */
	public function run(
		DOMElement $body, Env $env, array $options = [], bool $atTopLevel = false
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
				return $extApi->getEnv()->createDocument( '<pre />' );

			case 'statictag':
				// FIXME: Choose a better DOM representation that doesn't mess with
				// newline constraints.
				return $extApi->getEnv()->createDocument( '<span />' );

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
