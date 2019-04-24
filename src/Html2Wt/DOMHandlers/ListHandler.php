<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\WTUtils as WTUtils;

use Parsoid\DOMHandler as DOMHandler;

class ListHandler extends DOMHandler {
	public function __construct( $firstChildNames ) {
		parent::__construct( true );
		$this->firstChildNames = $firstChildNames;
	}
	public $firstChildNames;

	public function handleG( $node, $state, $wrapperUnmodified ) {
		// Disable single-line context here so that separators aren't
		// suppressed between nested list elements.
		$state->singleLineContext->disable();

		$firstChildElt = DOMUtils::firstNonSepChild( $node );

		// Skip builder-inserted wrappers
		// Ex: <ul><s auto-inserted-start-and-end-><li>..</li><li>..</li></s>...</ul>
		// output from: <s>\n*a\n*b\n*c</s>
		while ( $firstChildElt && $this->isBuilderInsertedElt( $firstChildElt ) ) {
			$firstChildElt = DOMUtils::firstNonSepChild( $firstChildElt );
		}

		if ( !$firstChildElt || !( isset( $this->firstChildNames[ $firstChildElt->nodeName ] ) )
|| WTUtils::isLiteralHTMLNode( $firstChildElt )
		) {
			$state->emitChunk( $this->getListBullets( $state, $node ), $node );
		}

		$liHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->liHandler( $node, $state, $text, $opts );
		};
		/* await */ $state->serializeChildren( $node, $liHandler );
		array_pop( $state->singleLineContext );
	}
	public function before( $node, $otherNode ) {
		if ( DOMUtils::isBody( $otherNode ) ) {
			return [ 'min' => 0, 'max' => 0 ];
		}

		// node is in a list & otherNode has the same list parent
		// => exactly 1 newline
		if ( DOMUtils::isListItem( $node->parentNode ) && $otherNode->parentNode === $node->parentNode ) {
			return [ 'min' => 1, 'max' => 1 ];
		}

		// A list in a block node (<div>, <td>, etc) doesn't need a leading empty line
		// if it is the first non-separator child (ex: <div><ul>...</div>)
		if ( DOMUtils::isBlockNode( $node->parentNode ) && DOMUtils::firstNonSepChild( $node->parentNode ) === $node ) {
			return [ 'min' => 1, 'max' => 2 ];
		} elseif ( DOMUtils::isFormattingElt( $otherNode ) ) {
			return [ 'min' => 1, 'max' => 1 ];
		} else {
			return [ 'min' => 2, 'max' => 2 ];
		}
	}
	public function after( ...$args ) {
		return $this->wtListEOL( ...$args );
	}
}

$module->exports = $ListHandler;
