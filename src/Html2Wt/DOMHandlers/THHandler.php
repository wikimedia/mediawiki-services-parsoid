<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\WTSUtils as WTSUtils;

use Parsoid\DOMHandler as DOMHandler;

class THHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		$dp = DOMDataUtils::getDataParsoid( $node );
		$usableDP = $this->stxInfoValidForTableCell( $state, $node );
		$attrSepSrc = ( $usableDP ) ? ( $dp->attrSepSrc || null ) : null;
		$startTagSrc = ( $usableDP ) ? $dp->startTagSrc : '';
		if ( !$startTagSrc ) {
			$startTagSrc = ( $usableDP && $dp->stx === 'row' ) ? '!!' : '!';
		}

		// T149209: Special case to deal with scenarios
		// where the previous sibling put us in a SOL state
		// (or will put in a SOL state when the separator is emitted)
		if ( $state->onSOL || $state->sep->constraints->min > 0 ) {
			// You can use both "!!" and "||" for same-row headings (ugh!)
			$startTagSrc = preg_replace(

				'/{{!}}{{!}}/', '{{!}}', preg_replace(
					'/\|\|/', '!', preg_replace( '/!!/', '!', $startTagSrc, 1 ), 1 ),
				 1
			);
		}

		$thTag = /* await */ $this->serializeTableTag( $startTagSrc, $attrSepSrc, $state, $node, $wrapperUnmodified );
		$leadingSpace = $this->getLeadingSpace( $state, $node, '' );
		// If the HTML for the first th is not enclosed in a tr-tag,
		// we start a new line.  If not, tr will have taken care of it.
		WTSUtils::emitStartTag( $thTag + $leadingSpace,
			$node,
			$state
		);
		$thHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->thHandler( $node, $state, $text, $opts );
		};

		$nextTh = DOMUtils::nextNonSepSibling( $node );
		$nextUsesRowSyntax = DOMUtils::isElt( $nextTh ) && DOMDataUtils::getDataParsoid( $nextTh )->stx === 'row';

		// For empty cells, emit a single whitespace to make wikitext
		// more readable as well as to eliminate potential misparses.
		if ( $nextUsesRowSyntax && !DOMUtils::firstNonDeletedChild( $node ) ) {
			$state->serializer->emitWikitext( ' ', $node );
			return;
		}

		/* await */ $state->serializeChildren( $node, $thHandler );

		if ( $nextUsesRowSyntax && !preg_match( '/\s$/', $state->currLine->text ) ) {
			$trailingSpace = $this->getTrailingSpace( $state, $node, '' );
			if ( $trailingSpace ) {
				$state->appendSep( $trailingSpace );
			}
		}
	}
	public function before( $node, $otherNode, $state ) {
		if ( $otherNode->nodeName === 'TH'
&& DOMDataUtils::getDataParsoid( $node )->stx === 'row'
		) {
			// force single line
			return [ 'min' => 0, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
		} else {
			return [ 'min' => 1, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
		}
	}
	public function after( $node, $otherNode ) {
		if ( $otherNode->nodeName === 'TD' ) {
			// Force a newline break
			return [ 'min' => 1, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
		} else {
			return [ 'min' => 0, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
		}
	}
}

$module->exports = $THHandler;
