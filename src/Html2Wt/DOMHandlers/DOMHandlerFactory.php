<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt\DOMHandlers;

use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\WTUtils;

/**
 * Factory for picking the right DOMHandler for a DOM element.
 * FIXME: memoize handlers, maybe?
 */
class DOMHandlerFactory {

	/**
	 * Get the DOMHandler that's appropriate for serializing a HTML tag.
	 *
	 * Porting note: this is the equivalent of DOMHandlers.tagHandlers[tag].
	 * @param string $tag
	 * @return DOMHandler|null
	 */
	public function newFromTagHandler( string $tag ): ?DOMHandler {
		return match ( $tag ) {
			'a' => new AHandler(),
			'audio',
			'video' => new MediaHandler(),
			'b' => new QuoteHandler( "'''" ),
			'body' => new BodyHandler(),
			'br' => new BRHandler(),
			'caption' => new CaptionHandler(),
			'dd' => new DDHandler(), // multi-line dt/dd
			'dd_row' => new DDHandler( 'row' ), // single-line dt/dd
			'dl' => new ListHandler( [ 'dt', 'dd' ] ),
			'dt' => new DTHandler(),
			'figure' => new FigureHandler(),
			'hr' => new HRHandler(),
			'h1' => new HeadingHandler( '=' ),
			'h2' => new HeadingHandler( '==' ),
			'h3' => new HeadingHandler( '===' ),
			'h4' => new HeadingHandler( '====' ),
			'h5' => new HeadingHandler( '=====' ),
			'h6' => new HeadingHandler( '======' ),
			'i' => new QuoteHandler( "''" ),
			'img' => new ImgHandler(),
			'li' => new LIHandler(),
			'link' => new LinkHandler(),
			'meta' => new MetaHandler(),
			'ol',
			'ul' => new ListHandler( [ 'li' ] ),
			'p' => new PHandler(),
			'pre' => new PreHandler(), // Wikitext indent pre generated with leading space
			'pre_html' => new HTMLPreHandler(), // HTML pre
			'span' => new SpanHandler(),
			'table' => new TableHandler(),
			'thead',
			'tbody',
			'tfoot' => new JustChildrenHandler(),
			'td' => new TDHandler(),
			'th' => new THHandler(),
			'tr' => new TRHandler(),
			default => null
		};
	}

	/**
	 * Get a DOMHandler for an element node.
	 * @param ?Node $node
	 * @return DOMHandler
	 */
	public function getDOMHandler( ?Node $node ): DOMHandler {
		if ( $node instanceof DocumentFragment ) {
			return new BodyHandler();
		}

		if ( !( $node instanceof Element ) ) {
			return new DOMHandler();
		}
		'@phan-var Element $node';/** @var Element $node */

		if ( WTUtils::isFirstEncapsulationWrapperNode( $node ) ) {
			return new EncapsulatedContentHandler();
		}

		$dp = DOMDataUtils::getDataParsoid( $node );

		// If available, use a specialized handler for serializing
		// to the specialized syntactic form of the tag.
		$handler = $this->newFromTagHandler( DOMUtils::nodeName( $node ) . '_' . ( $dp->stx ?? null ) );

		// Unless a specialized handler is available, use the HTML handler
		// for html-stx tags. But, <a> tags should never serialize as HTML.
		if ( !$handler && ( $dp->stx ?? null ) === 'html' && DOMUtils::nodeName( $node ) !== 'a' ) {
			return new FallbackHTMLHandler();
		}

		// If in a HTML table tag, serialize table tags in the table
		// using HTML tags, instead of native wikitext tags.
		if ( WTUtils::serializeChildTableTagAsHTML( $node ) ) {
			return new FallbackHTMLHandler();
		}

		// If parent node is a list in html-syntax, then serialize
		// list content in html-syntax rather than wiki-syntax.
		if ( DOMUtils::isListItem( $node )
			 && DOMUtils::isList( $node->parentNode )
			 && WTUtils::isLiteralHTMLNode( $node->parentNode )
		) {
			return new FallbackHTMLHandler();
		}

		// Pick the best available handler
		return $handler ?: $this->newFromTagHandler( DOMUtils::nodeName( $node ) ) ?: new FallbackHTMLHandler();
	}

}
