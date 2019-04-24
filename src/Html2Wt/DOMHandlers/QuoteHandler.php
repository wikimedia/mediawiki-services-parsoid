<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\WTSUtils as WTSUtils;

use Parsoid\DOMHandler as DOMHandler;

class QuoteHandler extends DOMHandler {
	public function __construct( $quotes ) {
		parent::__construct( false );
		$this->quotes = $quotes;
	}
	public $quotes;

	public function handleG( $node, $state, $wrapperUnmodified ) {
		if ( $this->precedingQuoteEltRequiresEscape( $node ) ) {
			WTSUtils::emitStartTag( '<nowiki/>', $node, $state );
		}
		WTSUtils::emitStartTag( $this->quotes, $node, $state );

		if ( !$node->hasChildNodes() ) {
			// Empty nodes like <i></i> or <b></b> need
			// a <nowiki/> in place of the empty content so that
			// they parse back identically.
			if ( WTSUtils::emitEndTag( $this->quotes, $node, $state, true ) ) {
				WTSUtils::emitStartTag( '<nowiki/>', $node, $state );
				WTSUtils::emitEndTag( $this->quotes, $node, $state );
			}
		} else {
			/* await */ $state->serializeChildren( $node );
			WTSUtils::emitEndTag( $this->quotes, $node, $state );
		}
	}

	public function precedingQuoteEltRequiresEscape( $node ) {
		// * <i> and <b> siblings don't need a <nowiki/> separation
		// as long as quote chars in text nodes are always
		// properly escaped -- which they are right now.
		//
		// * Adjacent quote siblings need a <nowiki/> separation
		// between them if either of them will individually
		// generate a sequence of quotes 4 or longer. That can
		// only happen when either prev or node is of the form:
		// <i><b>...</b></i>
		//
		// For new/edited DOMs, this can never happen because
		// wts.minimizeQuoteTags.js does quote tag minimization.
		//
		// For DOMs from existing wikitext, this can only happen
		// because of auto-inserted end/start tags. (Ex: ''a''' b ''c''')
		$prev = DOMUtils::previousNonDeletedSibling( $node );
		return $prev && DOMUtils::isQuoteElt( $prev )
&& DOMUtils::isQuoteElt( DOMUtils::lastNonDeletedChild( $prev ) )
|| DOMUtils::isQuoteElt( DOMUtils::firstNonDeletedChild( $node ) );
	}
}

$module->exports = $QuoteHandler;
