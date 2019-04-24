<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\WTUtils as WTUtils;

use Parsoid\DOMHandler as DOMHandler;

class DDHandler extends DOMHandler {
	public function __construct( $stx ) {
		parent::__construct( $stx !== 'row' );
		$this->stx = $stx;
	}
	public $stx;

	public function handleG( $node, $state, $wrapperUnmodified ) {
		$firstChildElement = DOMUtils::firstNonSepChild( $node );
		$chunk = ( $this->stx === 'row' ) ? ':' : $this->getListBullets( $state, $node );
		if ( !DOMUtils::isList( $firstChildElement )
|| WTUtils::isLiteralHTMLNode( $firstChildElement )
		) {
			$state->emitChunk( $chunk, $node );
		}
		$liHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->liHandler( $node, $state, $text, $opts );
		};
		$state->singleLineContext->enforce();
		/* await */ $state->serializeChildren( $node, $liHandler );
		array_pop( $state->singleLineContext );
	}
	public function before( $node, $othernode ) {
		if ( $this->stx === 'row' ) {
			return [ 'min' => 0, 'max' => 0 ];
		} else {
			return [ 'min' => 1, 'max' => 2 ];
		}
	}
	public function after( ...$args ) {
		return $this->wtListEOL( ...$args );
	}
	public function firstChild( $node, $otherNode ) {
		if ( !DOMUtils::isList( $otherNode ) ) {
			return [ 'min' => 0, 'max' => 0 ];
		} else {
			return [];
		}
	}
}

$module->exports = $DDHandler;
