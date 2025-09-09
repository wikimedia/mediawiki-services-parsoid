<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt\DOMHandlers;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Html2Wt\SerializerState;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;

/**
 * Used as a fallback in other tag handles.
 */
class FallbackHTMLHandler extends DOMHandler {

	public function __construct() {
		parent::__construct( false );
	}

	/** @inheritDoc */
	public function handle(
		Element $node, SerializerState $state, bool $wrapperUnmodified = false
	): ?Node {
		$serializer = $state->serializer;
		$tag = $serializer->serializeHTMLTag( $node, $wrapperUnmodified );
		$state->emitChunk( $tag, $node );

		if ( $node->hasChildNodes() ) {
			$inPHPBlock = $state->inPHPBlock;
			if (
				TokenUtils::tagOpensBlockScope( DOMUtils::nodeName( $node ) ) ||
				// Blockquote is special in that it doesn't suppress paragraphs
				// but does suppress pre wrapping
				DOMUtils::nodeName( $node ) === 'blockquote'
			) {
				$state->inPHPBlock = true;
			}
			$state->serializeChildren( $node );
			$state->inPHPBlock = $inPHPBlock;
		}

		$endTag = $serializer->serializeHTMLEndTag( $node, $wrapperUnmodified );
		$state->emitChunk( $endTag, $node );
		return $node->nextSibling;
	}
}
