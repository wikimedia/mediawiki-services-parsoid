<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\WTUtils as WTUtils;
use Parsoid\WTSUtils as WTSUtils;

use Parsoid\DOMHandler as DOMHandler;

class TableHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		$dp = DOMDataUtils::getDataParsoid( $node );
		$wt = $dp->startTagSrc || '{|';
		$indentTable = $node->parentNode->nodeName === 'DD'
&& DOMUtils::previousNonSepSibling( $node ) === null;
		if ( $indentTable ) {
			$state->singleLineContext->disable();
		}
		$state->emitChunk(
			/* await */ $this->serializeTableTag( $wt, '', $state, $node, $wrapperUnmodified ),
			$node
		);
		if ( !WTUtils::isLiteralHTMLNode( $node ) ) {
			$state->wikiTableNesting++;
		}
		/* await */ $state->serializeChildren( $node );
		if ( !WTUtils::isLiteralHTMLNode( $node ) ) {
			$state->wikiTableNesting--;
		}
		if ( !$state->sep->constraints ) {
			// Special case hack for "{|\n|}" since state.sep is
			// cleared in SSP.emitSep after a separator is emitted.
			// However, for {|\n|}, the <table> tag has no element
			// children which means lastchild -> parent constraint
			// is never computed and set here.
			$state->sep->constraints = [ 'min' => 1, 'max' => 2 ];
		}
		WTSUtils::emitEndTag( $dp->endTagSrc || '|}', $node, $state );
		if ( $indentTable ) {
			array_pop( $state->singleLineContext );
		}
	}
	public function before( $node, $otherNode ) {
		// Handle special table indentation case!
		if ( $node->parentNode === $otherNode
&& $otherNode->nodeName === 'DD'
		) {
			return [ 'min' => 0, 'max' => 2 ];
		} else {
			return [ 'min' => 1, 'max' => 2 ];
		}
	}
	public function after( $node, $otherNode ) {
		if ( ( WTUtils::isNewElt( $node ) || WTUtils::isNewElt( $otherNode ) ) && !DOMUtils::isBody( $otherNode ) ) {
			return [ 'min' => 1, 'max' => 2 ];
		} else {
			return [ 'min' => 0, 'max' => 2 ];
		}
	}
	public function firstChild( $node, $otherNode ) {
		return [ 'min' => 1, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
	}
	public function lastChild( $node, $otherNode ) {
		return [ 'min' => 1, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
	}
}

$module->exports = $TableHandler;
