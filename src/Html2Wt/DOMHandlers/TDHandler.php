<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\WTSUtils as WTSUtils;

use Parsoid\DOMHandler as DOMHandler;

class TDHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		$dp = DOMDataUtils::getDataParsoid( $node );
		$usableDP = $this->stxInfoValidForTableCell( $state, $node );
		$attrSepSrc = ( $usableDP ) ? ( $dp->attrSepSrc || null ) : null;
		$startTagSrc = ( $usableDP ) ? $dp->startTagSrc : '';
		if ( !$startTagSrc ) {
			$startTagSrc = ( $usableDP && $dp->stx === 'row' ) ? '||' : '|';
		}

		// T149209: Special case to deal with scenarios
		// where the previous sibling put us in a SOL state
		// (or will put in a SOL state when the separator is emitted)
		if ( $state->onSOL || $state->sep->constraints->min > 0 ) {
			$startTagSrc = preg_replace(
				'/{{!}}{{!}}/', '{{!}}', preg_replace( '/\|\|/', '|', $startTagSrc, 1 ), 1 );
		}

		// If the HTML for the first td is not enclosed in a tr-tag,
		// we start a new line.  If not, tr will have taken care of it.
		$tdTag = /* await */ $this->serializeTableTag(
			$startTagSrc, $attrSepSrc,
			$state, $node, $wrapperUnmodified
		);
		$inWideTD = preg_match( '/\|\||^{{!}}{{!}}/', $tdTag );
		$leadingSpace = $this->getLeadingSpace( $state, $node, '' );
		WTSUtils::emitStartTag( $tdTag + $leadingSpace, $node, $state );
		$tdHandler = function ( $state, $text, $opts ) use ( &$state, &$node, &$inWideTD ) {return $state->serializer->wteHandlers->tdHandler( $node, $inWideTD, $state, $text, $opts );
		};

		$nextTd = DOMUtils::nextNonSepSibling( $node );
		$nextUsesRowSyntax = DOMUtils::isElt( $nextTd ) && DOMDataUtils::getDataParsoid( $nextTd )->stx === 'row';

		// For empty cells, emit a single whitespace to make wikitext
		// more readable as well as to eliminate potential misparses.
		if ( $nextUsesRowSyntax && !DOMUtils::firstNonDeletedChild( $node ) ) {
			$state->serializer->emitWikitext( ' ', $node );
			return;
		}

		/* await */ $state->serializeChildren( $node, $tdHandler );

		if ( $nextUsesRowSyntax && !preg_match( '/\s$/', $state->currLine->text ) ) {
			$trailingSpace = $this->getTrailingSpace( $state, $node, '' );
			if ( $trailingSpace ) {
				$state->appendSep( $trailingSpace );
			}
		}
	}
	public function before( $node, $otherNode, $state ) {
		if ( $otherNode->nodeName === 'TD'
&& DOMDataUtils::getDataParsoid( $node )->stx === 'row'
		) {
			// force single line
			return [ 'min' => 0, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
		} else {
			return [ 'min' => 1, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
		}
	}
	public function after( $node, $otherNode ) {
		return [ 'min' => 0, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
	}
}

$module->exports = $TDHandler;
