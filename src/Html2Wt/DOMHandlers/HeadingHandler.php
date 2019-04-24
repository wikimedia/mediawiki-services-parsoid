<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\WTUtils as WTUtils;

use Parsoid\DOMHandler as DOMHandler;

class HeadingHandler extends DOMHandler {
	public function __construct( $headingWT ) {
		parent::__construct( true );
		$this->headingWT = $headingWT;
	}
	public $headingWT;

	public function handleG( $node, $state, $wrapperUnmodified ) {
		// For new elements, for prettier wikitext serialization,
		// emit a space after the last '=' char.
		$space = $this->getLeadingSpace( $state, $node, ' ' );
		$state->emitChunk( $this->headingWT + $space, $node );
		$state->singleLineContext->enforce();

		if ( $node->hasChildNodes() ) {
			/* await */ $state->serializeChildren( $node, null, DOMUtils::firstNonDeletedChild( $node ) );
		} else {
			// Deal with empty headings
			$state->emitChunk( '<nowiki/>', $node );
		}

		// For new elements, for prettier wikitext serialization,
		// emit a space before the first '=' char.
		$space = $this->getTrailingSpace( $state, $node, ' ' );
		$state->emitChunk( $space + $this->headingWT, $node ); // Why emitChunk here??
		array_pop( $state->singleLineContext );
	}
	public function before( $node, $otherNode ) {
		if ( WTUtils::isNewElt( $node ) && DOMUtils::previousNonSepSibling( $node ) ) {
			// Default to two preceding newlines for new content
			return [ 'min' => 2, 'max' => 2 ];
		} elseif ( WTUtils::isNewElt( $otherNode )
&& DOMUtils::previousNonSepSibling( $node ) === $otherNode
		) {
			// T72791: The previous node was newly inserted, separate
			// them for readability
			return [ 'min' => 2, 'max' => 2 ];
		} else {
			return [ 'min' => 1, 'max' => 2 ];
		}
	}
	public function after() {
		return [ 'min' => 1, 'max' => 2 ];
	}
}

$module->exports = $HeadingHandler;
