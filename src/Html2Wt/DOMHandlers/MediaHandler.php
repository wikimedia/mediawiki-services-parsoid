<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt\DOMHandlers;

use DOMElement;
use DOMNode;
use Wikimedia\Parsoid\Core\MediaStructure;
use Wikimedia\Parsoid\Html2Wt\LinkHandlerUtils;
use Wikimedia\Parsoid\Html2Wt\SerializerState;

class MediaHandler extends DOMHandler {

	public function __construct() {
		parent::__construct( false );
	}

	/** @inheritDoc */
	public function handle(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified = false
	): ?DOMNode {
		if ( $node->nodeName === 'figure-inline' ) {
			$ms = MediaStructure::parse( $node );
		} else {
			$ms = new MediaStructure( $node );
		}
		LinkHandlerUtils::figureHandler( $state, $node, $ms );
		return $node->nextSibling;
	}

}
