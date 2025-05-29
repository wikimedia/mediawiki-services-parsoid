<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

use stdClass;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Ext\DOMDataUtils;
use Wikimedia\Parsoid\Ext\DOMProcessor as ExtDOMProcessor;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\WTUtils;

/**
 * See tests/parser/ParserTestParserHook.php in core.
 */
class ParserHookProcessor extends ExtDOMProcessor {

	public function staticTagPostProcessor(
		Node $node, ParsoidExtensionAPI $extApi, stdClass $obj
	): void {
		if ( $node instanceof Element ) {
			if ( DOMUtils::hasTypeOf( $node, 'mw:Extension/statictag' ) ) {
				$dataMw = DOMDataUtils::getDataMw( $node );
				if ( $dataMw->getExtAttrib( 'action' ) === 'flush' ) {
					$node->appendChild( $node->ownerDocument->createTextNode( $obj->buf ) );
					$obj->buf = '';
				} else {
					$obj->buf .= $dataMw->body->extsrc;
				}
			} elseif ( WTUtils::isSealedFragmentOfType( $node, 'sealtag' ) ) {
				$dp = DOMDataUtils::getDataParsoid( $node );
				$contentId = $dp->html;
				$content = $extApi->getContentDOM( $contentId );
				$span = $content->firstChild;

				// In case it's templated
				DOMUtils::addAttributes( $span, [
					'typeof' => DOMCompat::getAttribute( $node, 'typeof' ),
					'about' => DOMCompat::getAttribute( $node, 'about' ) ??
						DOMCompat::getAttribute( $span, 'about' ),
				] );
				DOMDataUtils::setDataMw( $span, DOMDataUtils::getDataMw( $node ) );

				DOMUtils::removeTypeOf( $span, 'mw:DOMFragment/sealed/sealtag' );
				DOMUtils::addTypeOf( $span, 'mw:Extension/sealtag' );

				$node->parentNode->replaceChild( $span, $node );
				$extApi->clearContentDOM( $contentId );
			}
			$extApi->processAttributeEmbeddedDom(
				$node, function ( $domFragment ) use ( $extApi ) {
					$this->wtPostprocess( $extApi, $domFragment, [] );
					return true; // Conservatively say we changed things
				}
			);
		}
	}

	/**
	 * @inheritDoc
	 */
	public function wtPostprocess(
		ParsoidExtensionAPI $extApi, Node $root, array $options
	): void {
		// Pass an object since we want the data to be carried around across
		// nodes in the DOM. Passing an array won't work since visitDOM doesn't
		// use a reference on its end. Maybe we could fix that separately.
		DOMUtils::visitDOM(
			$root,
			[ $this, 'staticTagPostProcessor' ],
			$extApi,
			(object)[ 'buf' => '' ]
		);
	}
}
