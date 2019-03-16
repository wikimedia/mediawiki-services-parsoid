<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

use DOMCharacterData;
use DOMDocument;
use DOMDocumentFragment;
use DOMElement;
use DOMNode;
use DOMNodeList;
use Parsoid\Utils\DOMCompat\TokenList;
use Parsoid\Wt2Html\XMLSerializer;
use RemexHtml\DOM\DOMBuilder;
use RemexHtml\HTMLData;
use RemexHtml\Tokenizer\Tokenizer;
use RemexHtml\TreeBuilder\Dispatcher;
use RemexHtml\TreeBuilder\TreeBuilder;
use Wikimedia\Assert\Assert;
use Wikimedia\Zest\Zest;

/**
 * Helper class that provides missing DOM level 3 methods for the PHP DOM classes.
 * For a DOM method $node->foo( $bar) the equivalent helper is DOMCompat::foo( $node, $bar ).
 * For a DOM property $node->foo there is a DOMCompat::getFoo( $node ) and
 * DOMCompat::setFoo( $node, $value ).
 * Only implements the methods that are actually used by Parsoid.
 */
class DOMCompat {

	/**
	 * Tab, LF, FF, CR, space
	 * @see https://infra.spec.whatwg.org/#ascii-whitespace
	 */
	private static $ASCII_WHITESPACE = "\t\r\f\n ";

	/**
	 * Get document body.
	 * Unlike the spec we return it as a native PHP DOM object.
	 * @param DOMDocument $document
	 * @return DOMElement|null
	 * @see https://html.spec.whatwg.org/multipage/dom.html#dom-document-body
	 */
	public static function getBody( DOMDocument $document ): ?DOMElement {
		foreach ( $document->documentElement->childNodes as $element ) {
			/** @var DOMElement $element */
			if ( $element->nodeName === 'body' || $element->nodeName === 'frameset' ) {
				return $element;
			}
		}
		return null;
	}

	/**
	 * Get document head.
	 * Unlike the spec we return it as a native PHP DOM object.
	 * @param DOMDocument $document
	 * @return DOMElement|null
	 * @see https://html.spec.whatwg.org/multipage/dom.html#dom-document-head
	 */
	public static function getHead( DOMDocument $document ): ?DOMElement {
		foreach ( $document->documentElement->childNodes as $element ) {
			/** @var DOMElement $element */
			if ( $element->nodeName === 'head' ) {
				return $element;
			}
		}
		return null;
	}

	/**
	 * Get document title.
	 * @param DOMDocument $document
	 * @return string
	 * @see https://html.spec.whatwg.org/multipage/dom.html#document.title
	 */
	public static function getTitle( DOMDocument $document ): string {
		$titleElement = self::querySelector( $document, 'title' );
		return $titleElement ? self::stripAndCollapseASCIIWhitespace( $titleElement->textContent ) : '';
	}

	/**
	 * Set document title.
	 * @param DOMDocument $document
	 * @param string $title
	 * @see https://html.spec.whatwg.org/multipage/dom.html#document.title
	 */
	public static function setTitle( DOMDocument $document, string $title ): void {
		$titleElement = self::querySelector( $document, 'title' );
		if ( !$titleElement ) {
			$headElement = self::getHead( $document );
			if ( $headElement ) {
				$titleElement = $document->createElement( 'title' );
				$headElement->appendChild( $titleElement );
			}
		}
		if ( $titleElement ) {
			$titleElement->textContent = $title;
		}
	}

	/**
	 * Return the parent element, or null if the parent is not an element.
	 * @param DOMNode $node
	 * @return DOMElement|null
	 * @see https://dom.spec.whatwg.org/#dom-node-parentelement
	 */
	public static function getParentElement( DOMNode $node ): ?DOMElement {
		$parent = $node->parentNode;
		if ( $parent && $parent->nodeType === XML_ELEMENT_NODE ) {
			/** @var DOMElement $parent */
			return $parent;
		}
		return null;
	}

	/**
	 * Return the descendant with the specified ID.
	 * Workaround for https://bugs.php.net/bug.php?id=77686 and other issues related to
	 * inconsistent indexing behavior.
	 * @param DOMDocument|DOMDocumentFragment $node
	 * @param string $id
	 * @return DOMElement|null
	 * @see https://dom.spec.whatwg.org/#dom-nonelementparentnode-getelementbyid
	 */
	public static function getElementById( DOMNode $node, string $id ): ?DOMElement {
		Assert::parameterType( 'DOMDocument|DOMDocumentFragment', $node, '$node' );
		$elements = Zest::getElementsById( $node, $id );
		return $elements[0] ?? null;
	}

	/**
	 * Return all descendants with the specified tag name.
	 * Workaround for PHP's getElementsByTagName being inexplicably slow in some situations
	 * and the lack of DOMElement::getElementsByTagName().
	 * @param DOMDocument|DOMElement $node
	 * @param string $tagName
	 * @return DOMElement[]
	 * @see https://dom.spec.whatwg.org/#dom-document-getelementsbytagname
	 * @see https://dom.spec.whatwg.org/#dom-element-getelementsbytagname
	 * @note Note that unlike the spec this method is not guaranteed to return a DOMNodeList
	 *   (which cannot be freely constructed in PHP), just a traversable containing DOMElements.
	 */
	public static function getElementsByTagName( DOMNode $node, string $tagName ): DOMNodeList {
		Assert::parameterType( 'DOMDocument|DOMElement', $node, '$node' );
		return Zest::getElementsByTagName( $node, $tagName );
	}

	/**
	 * Return the last child of the node that is an Element, or null otherwise.
	 * @param DOMDocument|DOMDocumentFragment|DOMElement $node
	 * @return DOMElement|null
	 * @see https://dom.spec.whatwg.org/#dom-parentnode-lastelementchild
	 */
	public static function getLastElementChild( DOMNode $node ): ?DOMElement {
		Assert::parameterType( 'DOMDocument|DOMDocumentFragment|DOMElement', $node, '$node' );
		$lastChild = $node->lastChild;
		while ( $lastChild && $lastChild->nodeType !== XML_ELEMENT_NODE ) {
			$lastChild = $lastChild->previousSibling;
		}
		return $lastChild;
	}

	/**
	 * @param DOMDocument|DOMDocumentFragment|DOMElement $node
	 * @param string $selector
	 * @return DOMElement|null
	 * @see https://dom.spec.whatwg.org/#dom-parentnode-queryselector
	 */
	public static function querySelector( DOMNode $node, string $selector ): ?DOMElement {
		return self::querySelectorAll( $node, $selector )[0] ?? null;
	}

	/**
	 * @param DOMDocument|DOMDocumentFragment|DOMElement $node
	 * @param string $selector
	 * @return DOMElement[]
	 * @see https://dom.spec.whatwg.org/#dom-parentnode-queryselectorall
	 * @note Note that unlike the spec this method is not guaranteed to return a DOMNodeList
	 *   (which cannot be freely constructed in PHP), just a traversable containing DOMElements.
	 */
	public static function querySelectorAll( DOMNode $node, string $selector ): array {
		Assert::parameterType( 'DOMDocument|DOMDocumentFragment|DOMElement', $node, '$node' );
		return Zest::find( $selector, $node );
	}

	/**
	 * Return the last preceding sibling of the node that is an element, or null otherwise.
	 * @param DOMElement|DOMCharacterData $node
	 * @return DOMElement|null
	 * @see https://dom.spec.whatwg.org/#dom-nondocumenttypechildnode-previouselementsibling
	 */
	public static function getPreviousElementSibling( DOMNode $node ): ?DOMElement {
		Assert::parameterType( 'DOMElement|DOMCharacterData', $node, '$node' );
		$previousSibling = $node->previousSibling;
		while ( $previousSibling && $previousSibling->nodeType !== XML_ELEMENT_NODE ) {
			$previousSibling = $previousSibling->previousSibling;
		}
		return $previousSibling;
	}

	/**
	 * Return the first following sibling of the node that is an element, or null otherwise.
	 * @param DOMElement|DOMCharacterData $node
	 * @return DOMElement|null
	 * @see https://dom.spec.whatwg.org/#dom-nondocumenttypechildnode-nextelementsibling
	 */
	public static function getNextElementSibling( DOMNode $node ): ?DOMElement {
		Assert::parameterType( 'DOMElement|DOMCharacterData', $node, '$node' );
		$nextSibling = $node->nextSibling;
		while ( $nextSibling && $nextSibling->nodeType !== XML_ELEMENT_NODE ) {
			$nextSibling = $nextSibling->nextSibling;
		}
		return $nextSibling;
	}

	/**
	 * Removes the node from the document.
	 * @param DOMElement|DOMCharacterData $node
	 * @see https://dom.spec.whatwg.org/#dom-childnode-remove
	 */
	public static function remove( DOMNode $node ): void {
		Assert::parameterType( 'DOMElement|DOMCharacterData', $node, '$node' );
		if ( $node->parentNode ) {
			$node->parentNode->removeChild( $node );
		}
	}

	/**
	 * Get innerHTML.
	 * @param DOMElement $element
	 * @return string
	 * @see https://w3c.github.io/DOM-Parsing/#dom-innerhtml-innerhtml
	 */
	public static function getInnerHTML( DOMElement $element ): string {
		return XMLSerializer::serialize( $element, [ 'innerXML' => true ] )['html'];
	}

	/**
	 * Set innerHTML.
	 * @see https://w3c.github.io/DOM-Parsing/#dom-innerhtml-innerhtml
	 * @param DOMElement $element
	 * @param string $html
	 */
	public static function setInnerHTML( DOMElement $element, string $html ): void {
		$domBuilder = new DOMBuilder( [ 'suppressHtmlNamespace' => true ] );
		$treeBuilder = new TreeBuilder( $domBuilder );
		$dispatcher = new Dispatcher( $treeBuilder );
		$tokenizer = new Tokenizer( $dispatcher, $html, [ 'ignoreErrors' => true ] );
		$tokenizer->execute( [
			'fragmentNamespace' => HTMLData::NS_HTML,
			'fragmentName' => $element->tagName,
		] );
		// Remex returns the document fragment wrapped into a DOMElement
		// because libxml fragment handling is not great.
		// FIXME life would be simpler if we could make DOMBuilder use an existing document
		$documentFragmentWrapper = $element->ownerDocument->importNode(
			$domBuilder->getFragment(), true );

		while ( $element->firstChild ) {
			$element->removeChild( $element->firstChild );
		}
		// Use an iteration method that's not affected by the tree being modified during iteration
		while ( $documentFragmentWrapper->firstChild ) {
			$element->appendChild( $documentFragmentWrapper->firstChild );
		}
	}

	/**
	 * Get outerHTML.
	 * @param DOMElement $element
	 * @return string
	 * @see https://w3c.github.io/DOM-Parsing/#dom-element-outerhtml
	 */
	public static function getOuterHTML( DOMElement $element ): string {
		return XMLSerializer::serialize( $element, [ 'addDoctype' => false ] )['html'];
	}

	/**
	 * Return the class list of this element.
	 * @param DOMElement $node
	 * @return TokenList
	 * @see https://dom.spec.whatwg.org/#dom-element-classlist
	 */
	public static function getClassList( DOMElement $node ): TokenList {
		return new TokenList( $node );
	}

	/**
	 * @param string $text
	 * @return string
	 * @see https://infra.spec.whatwg.org/#strip-and-collapse-ascii-whitespace
	 */
	private static function stripAndCollapseASCIIWhitespace( string $text ): string {
		$ws = self::$ASCII_WHITESPACE;
		return preg_replace( "/[$ws]+/", ' ', trim( $text, $ws ) );
	}

}
