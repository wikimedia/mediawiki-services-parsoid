<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt\DOMHandlers;

use Wikimedia\Parsoid\Core\MediaStructure;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Html2Wt\LinkHandlerUtils;
use Wikimedia\Parsoid\Html2Wt\SerializerState;

class ImgHandler extends DOMHandler {

	public function __construct() {
		parent::__construct( false );
	}

	/** @inheritDoc */
	public function handle(
		Element $node, SerializerState $state, bool $wrapperUnmodified = false
	): ?Node {
		if ( $node->getAttribute( 'rel' ) === 'mw:externalImage' ) {
			$state->serializer->emitWikitext( $node->getAttribute( 'src' ) ?? '', $node );
		} else {
			LinkHandlerUtils::figureHandler( $state, $node, new MediaStructure( $node ) );
		}
		return $node->nextSibling;
	}

}
