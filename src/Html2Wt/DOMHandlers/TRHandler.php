<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\WTSUtils as WTSUtils;

use Parsoid\DOMHandler as DOMHandler;

class TRHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		$dp = DOMDataUtils::getDataParsoid( $node );

		if ( $this->trWikitextNeeded( $node, $dp ) ) {
			WTSUtils::emitStartTag(
				/* await */ $this->serializeTableTag(
					$dp->startTagSrc || '|-', '', $state,
					$node, $wrapperUnmodified
				),
				$node, $state
			);
		}

		/* await */ $state->serializeChildren( $node );
	}
	public function before( $node, $otherNode ) {
		if ( $this->trWikitextNeeded( $node, DOMDataUtils::getDataParsoid( $node ) ) ) {
			return [ 'min' => 1, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
		} else {
			return [ 'min' => 0, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
		}
	}
	public function after( $node, $otherNode ) {
		return [ 'min' => 0, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
	}

	public function trWikitextNeeded( $node, $dp ) {
		// If the token has 'startTagSrc' set, it means that the tr
		// was present in the source wikitext and we emit it -- if not,
		// we ignore it.
		// ignore comments and ws
		if ( $dp->startTagSrc || DOMUtils::previousNonSepSibling( $node ) ) {
			return true;
		} else {
			// If parent has a thead/tbody previous sibling, then
			// we need the |- separation. But, a caption preceded
			// this node's parent, all is good.
			$parentSibling = DOMUtils::previousNonSepSibling( $node->parentNode );

			// thead/tbody/tfoot is always present around tr tags in the DOM.
			return $parentSibling && $parentSibling->nodeName !== 'CAPTION';
		}
	}
}

$module->exports = $TRHandler;
