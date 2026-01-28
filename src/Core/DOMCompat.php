<?php
// phpcs:disable Universal.Operators.TypeSeparatorSpacing.UnionTypeSpacesAfter
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use DOMCharacterData;
use DOMDocument;
use DOMDocumentFragment;
use DOMElement;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Core\DOMCompatTokenList as TokenList;
use Wikimedia\Parsoid\DOM\CharacterData;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\DOMParser;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\HTMLDocument;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Wt2Html\TreeBuilder\ParsoidDOMFragmentBuilder;
use Wikimedia\Parsoid\Wt2Html\XHtmlSerializer;
use Wikimedia\RemexHtml\HTMLData;
use Wikimedia\RemexHtml\Tokenizer\Tokenizer;
use Wikimedia\RemexHtml\TreeBuilder\Dispatcher;
use Wikimedia\RemexHtml\TreeBuilder\TreeBuilder;
use Wikimedia\Zest\Zest;

/**
 * Helper class that provides missing DOM level 3 methods for the PHP DOM classes.
 * For a DOM method $node->foo( $bar) the equivalent helper is DOMCompat::foo( $node, $bar ).
 * For a DOM property $node->foo there is a DOMCompat::getFoo( $node ) and
 * DOMCompat::setFoo( $node, $value ).
 *
 * Only implements the methods that are actually used by Parsoid.
 *
 * Because this class may be used by code outside Parsoid, it tries to
 * be relatively tolerant of object types: you can call it either with
 * PHP's DOM* types or with a "proper" DOM implementation, and it will
 * attempt to Do The Right Thing regardless. As a result, there are
 * generally not parameter type hints for DOM object types, and the
 * return types will be broad enough to accomodate the value a "real"
 * DOM implementation would return, as well as the values our
 * thunk will return. (For instance, we can't create a "real" NodeList
 * in our compatibility thunk.)
 *
 * Exception to the above: ::nodeName method is not so much a DOM compatibility
 * method in the sense above, but a proxy to let us support multiple DOM libraries
 * against the Parsoid codebase that expects lower-case names. In this specific
 * instance the default behavior is tailored for performance vs. being
 * HTML-standards-compliant.
 */
class DOMCompat {
	/**
	 * Tab, LF, FF, CR, space
	 * @see https://infra.spec.whatwg.org/#ascii-whitespace
	 */
	private const ASCII_WHITESPACE = "\t\r\f\n ";

	/**
	 * @param Node|null $node If present, we'll use the type of the given node
	 *  to determine whether to use standards mode.
	 * @return bool When false, we'll use DOMDocument workarounds.
	 */
	public static function isStandardsMode( $node = null ): bool {
		if ( $node !== null ) {
			return !( $node instanceof \DOMNode );
		}
		return self::isUsingDodo() || self::isUsing84Dom();
	}

	private static function zestOptions(): array {
		if ( self::isUsing84Dom() ) {
			return [
				// Speed up getElementsById calls; this should use upstream
				// getElementsById once these two bugs are fixed:
				// https://github.com/php/php-src/issues/20281
				// https://github.com/php/php-src/issues/20282
				'getElementsById' => static function ( $context, $id ) {
					if ( is_a( $context, '\Dom\Document', false ) ) {
						'@phan-var Document $context';
						return [ $context->getElementById( $id ) ];
					}
					return iterator_to_array(
						$context->querySelectorAll( '#' . self::encodeCssId( $id ) )
					);
				},
			];
		} elseif ( self::isUsingDodo() ) {
			return [ 'standardsMode' => true, ];
		} else {
			return [];
		}
	}

	/**
	 * @param Node|null $node If present, we'll use the type of the given node
	 *   to determine whether we're using Dodo.
	 * @return bool When true, we're using the Dodo DOM implementation.
	 * @internal
	 */
	public static function isUsingDodo( $node = null ): bool {
		if ( $node !== null ) {
			return is_a( $node, '\Wikimedia\Dodo\Node', false );
		}
		// Change this to switch to using Dodo for Parsoid.
		return false;
	}

	/**
	 * @param Node|null $node If present, we'll use the type of the given node
	 *   to determine whether we're using the PHP 8.4 DOM implementation.
	 * @return bool When true, we're using the PHP 8.4 DOM implementation.
	 * @internal
	 */
	public static function isUsing84Dom( $node = null ): bool {
		if ( $node !== null ) {
			return is_a( $node, '\Dom\Node', false );
		}
		// Defaults to using \Dom\Document on PHP 8.4 (unless we're using Dodo)
		return !self::isUsingDodo() && class_exists( '\Dom\Document' );
	}

	/**
	 * Create a new empty HTML document using the preferred DOM
	 * implementation.
	 * @param bool $isHtml (optional) Should always be true.
	 * @return Document
	 */
	public static function newDocument( bool $isHtml = true ): Document {
		Assert::invariant( $isHtml, "only HTML documents are supported" );
		if ( self::isUsingDodo() ) {
			$doc = ( new DOMParser() )->parseFromString(
				'<div></div>', 'text/html'
			);
		} elseif ( self::isUsing84Dom() ) {
			$doc = HTMLDocument::createEmpty( "UTF-8" );
		} else {
			// @phan-suppress-next-line PhanParamTooMany,PhanTypeInstantiateInterface
			$doc = new Document( "1.0", "UTF-8" );
		}
		'@phan-var Document $doc';
		// Remove doctype, head, body, etc for compat w/ PHP
		while ( $doc->firstChild !== null ) {
			$doc->removeChild( $doc->firstChild );
		}
		return $doc;
	}

	/**
	 * Get document body.
	 * Unlike the spec we return it as a native PHP DOM object.
	 * @param Document $document
	 * @return Element|null
	 * @see https://html.spec.whatwg.org/multipage/dom.html#dom-document-body
	 */
	public static function getBody( $document ) {
		if ( self::isStandardsMode( $document ) ) {
			return $document->body;
		}
		// Use an undeclared dynamic property as a cache.
		// WARNING: this will not be updated if (for some reason) the
		// document body changes.
		if ( $document->body !== null ) {
			return $document->body;
		}
		if ( $document->documentElement === null ) {
			return null;
		}
		foreach ( DOMUtils::childNodes( $document->documentElement ) as $element ) {
			/** @var Element $element */
			$nodeName = DOMUtils::nodeName( $element );
			if ( $nodeName === 'body' || $nodeName === 'frameset' ) {
				// Caching!
				$document->body = $element;
				// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
				return $element;
			}
		}
		return null;
	}

	/**
	 * Get document head.
	 * Unlike the spec we return it as a native PHP DOM object.
	 * @param Document $document
	 * @return Element|null
	 * @see https://html.spec.whatwg.org/multipage/dom.html#dom-document-head
	 */
	public static function getHead( $document ) {
		if ( self::isStandardsMode( $document ) ) {
			return $document->head;
		}
		// Use an undeclared dynamic property as a cache.
		// WARNING: this will not be updated if (for some reason) the
		// document head changes.
		if ( isset( $document->head ) ) {
			return $document->head;
		}
		if ( $document->documentElement === null ) {
			return null;
		}
		foreach ( DOMUtils::childNodes( $document->documentElement ) as $element ) {
			/** @var Element $element */
			if ( DOMUtils::nodeName( $element ) === 'head' ) {
				$document->head = $element; // Caching!
				// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
				return $element;
			}
		}
		return null;
	}

	/**
	 * Get document title.
	 * @param Document $document
	 * @return string
	 * @see https://html.spec.whatwg.org/multipage/dom.html#document.title
	 */
	public static function getTitle( $document ): string {
		$titleElement = self::querySelector( $document, 'title' );
		return $titleElement ? self::stripAndCollapseASCIIWhitespace( $titleElement->textContent ) : '';
	}

	/**
	 * Set document title.
	 * @param Document $document
	 * @param string $title
	 * @see https://html.spec.whatwg.org/multipage/dom.html#document.title
	 */
	public static function setTitle( $document, string $title ): void {
		$titleElement = self::querySelector( $document, 'title' );
		if ( !$titleElement ) {
			$headElement = self::getHead( $document );
			if ( $headElement ) {
				$titleElement = DOMUtils::appendToHead( $document, 'title' );
			}
		}
		if ( $titleElement ) {
			$titleElement->textContent = $title;
		}
	}

	/**
	 * Return the parent element, or null if the parent is not an element.
	 * @param Node $node
	 * @return Element|null
	 * @see https://dom.spec.whatwg.org/#dom-node-parentelement
	 */
	public static function getParentElement( $node ) {
		$parent = $node->parentNode;
		if ( $parent && $parent->nodeType === XML_ELEMENT_NODE ) {
			/** @var Element $parent */
			// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
			return $parent;
		}
		return null;
	}

	/**
	 * Return the descendant with the specified ID.
	 * Workaround for https://bugs.php.net/bug.php?id=77686 and other issues related to
	 * inconsistent indexing behavior.
	 * XXX: 77686 is fixed in php 8.1.21
	 * @param Document|DocumentFragment $node
	 * @param string $id
	 * @return Element|null
	 * @see https://dom.spec.whatwg.org/#dom-nonelementparentnode-getelementbyid
	 */
	public static function getElementById(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMDocument|DOMDocumentFragment|
		Document|DocumentFragment $node,
		string $id
	) {
		// @phan-suppress-next-line PhanTypeMismatchArgument Zest is declared to take DOMDocument\DOMElement
		$elements = Zest::getElementsById( $node, $id, self::zestOptions() );
		// @phan-suppress-next-line PhanTypeMismatchReturn
		return $elements[0] ?? null;
	}

	/**
	 * Workaround bug in PHP's Document::getElementById() which doesn't
	 * actually index the 'id' attribute unless you use the non-standard
	 * `Element::setIdAttribute` method after the attribute is set;
	 * see https://www.php.net/manual/en/domdocument.getelementbyid.php
	 * for more details.
	 *
	 * @param Element $element
	 * @param string $id The desired value for the `id` attribute on $element.
	 * @see https://phabricator.wikimedia.org/T232390
	 */
	public static function setIdAttribute( $element, string $id ): void {
		$element->setAttribute( 'id', $id );
		$element->setIdAttribute( 'id', true );// phab:T232390
	}

	/**
	 * Return all descendants with the specified tag name.
	 * Workaround for PHP's getElementsByTagName being inexplicably slow in some situations
	 * and the lack of Element::getElementsByTagName().
	 * @param Document|Element $node
	 * @param string $tagName
	 * @return (iterable<Element>&\Countable)|array<Element> Either an array or an HTMLCollection object
	 * @see https://dom.spec.whatwg.org/#dom-document-getelementsbytagname
	 * @see https://dom.spec.whatwg.org/#dom-element-getelementsbytagname
	 * @note Note that unlike the spec this method is not guaranteed to return a NodeList
	 *   (which cannot be freely constructed in PHP), just a traversable containing Elements.
	 */
	public static function getElementsByTagName(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMDocument|DOMElement|
		Document|Element $node, string $tagName
	): iterable {
		// @phan-suppress-next-line PhanTypeMismatchArgument Zest is declared to take DOMDocument\DOMElement
		$result = Zest::getElementsByTagName( $node, $tagName, self::zestOptions() );
		'@phan-var array<Element> $result'; // @var array<Element> $result
		return $result;
	}

	/**
	 * Return the first child of the node that is an Element, or null
	 * otherwise.
	 * @param Document|DocumentFragment|Element $node
	 * @return Element|null
	 * @see https://dom.spec.whatwg.org/#dom-parentnode-firstelementchild
	 * @note This property was added to PHP in 8.0.0, and won't be needed
	 *  once our minimum required version >= 8.0.0
	 */
	public static function getFirstElementChild(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMDocument|DOMDocumentFragment|DOMElement|
		Document|DocumentFragment|Element $node
	) {
		$firstChild = $node->firstChild;
		while ( $firstChild && $firstChild->nodeType !== XML_ELEMENT_NODE ) {
			$firstChild = $firstChild->nextSibling;
		}
		// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
		return $firstChild;
	}

	/**
	 * Return the last child of the node that is an Element, or null otherwise.
	 * @param Document|DocumentFragment|Element $node
	 * @return Element|null
	 * @see https://dom.spec.whatwg.org/#dom-parentnode-lastelementchild
	 * @note This property was added to PHP in 8.0.0, and won't be needed
	 *  once our minimum required version >= 8.0.0
	 */
	public static function getLastElementChild(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMDocument|DOMDocumentFragment|DOMElement|
		Document|DocumentFragment|Element $node
	) {
		$lastChild = $node->lastChild;
		while ( $lastChild && $lastChild->nodeType !== XML_ELEMENT_NODE ) {
			$lastChild = $lastChild->previousSibling;
		}
		// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
		return $lastChild;
	}

	/**
	 * @param Document|DocumentFragment|Element $node
	 * @param string $selector
	 * @return Element|null
	 * @see https://dom.spec.whatwg.org/#dom-parentnode-queryselector
	 */
	public static function querySelector( $node, string $selector ) {
		if ( self::isUsingDodo( $node ) ) {
			return $node->querySelector( $selector );
		}
		foreach ( self::querySelectorAll( $node, $selector ) as $el ) {
			return $el;
		}
		return null;
	}

	/**
	 * @param Document|DocumentFragment|Element $node
	 * @param string $selector
	 * @return (iterable<Element>&\Countable)|array<Element> Either a NodeList or an array
	 * @see https://dom.spec.whatwg.org/#dom-parentnode-queryselectorall
	 * @note Note that unlike the spec this method is not guaranteed to return a NodeList
	 *   (which cannot be freely constructed in PHP), just a traversable containing Elements.
	 */
	public static function querySelectorAll(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMDocument|DOMDocumentFragment|DOMElement|
		Document|DocumentFragment|Element $node,
		string $selector
	): iterable {
		if ( self::isUsingDodo( $node ) ) {
			return $node->querySelectorAll( $selector );
		}
		// @phan-suppress-next-line PhanTypeMismatchArgument DOMNode
		return Zest::find( $selector, $node, self::zestOptions() );
	}

	/**
	 * Return the last preceding sibling of the node that is an element, or null otherwise.
	 * @param Element|CharacterData $node
	 * @return Element|null
	 * @see https://dom.spec.whatwg.org/#dom-nondocumenttypechildnode-previouselementsibling
	 */
	public static function getPreviousElementSibling(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMElement|DOMCharacterData|
		Element|CharacterData $node
	) {
		$previousSibling = $node->previousSibling;
		while ( $previousSibling && $previousSibling->nodeType !== XML_ELEMENT_NODE ) {
			$previousSibling = $previousSibling->previousSibling;
		}
		// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
		return $previousSibling;
	}

	/**
	 * Return the first following sibling of the node that is an element, or null otherwise.
	 * @param Element|CharacterData $node
	 * @return Element|null
	 * @see https://dom.spec.whatwg.org/#dom-nondocumenttypechildnode-nextelementsibling
	 */
	public static function getNextElementSibling(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMElement|DOMCharacterData|
		Element|CharacterData $node
	) {
		$nextSibling = $node->nextSibling;
		while ( $nextSibling && $nextSibling->nodeType !== XML_ELEMENT_NODE ) {
			$nextSibling = $nextSibling->nextSibling;
		}
		// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
		return $nextSibling;
	}

	/**
	 * Append the node to the parent node.
	 * @param Document|DocumentFragment|Element $parentNode
	 * @param Node|string ...$nodes
	 * @note This method was added in PHP 8.0.0
	 */
	public static function append(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMDocument|DOMDocumentFragment|DOMElement|
		Document|DocumentFragment|Element $parentNode,
		DOMNode|
		Node|string ...$nodes
	): void {
		foreach ( $nodes as $node ) {
			if ( is_string( $node ) ) {
				$node = $parentNode->ownerDocument->createTextNode( $node );
			}
			self::appendChild( $parentNode, $node );
		}
	}

	/**
	 * Append a child node to the parent node.
	 * @param Document|DocumentFragment|Element $parentNode
	 * @param Node $node
	 * @return Node
	 * @note From T411228 et al, appending an empty Document Fragment results
	 * in a PHP warning.  No longer necessary when isUsing84Dom is true.
	 */
	public static function appendChild(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMDocument|DOMDocumentFragment|DOMElement|
		Document|DocumentFragment|Element $parentNode,
		DOMNode|
		Node $node
	) {
		if ( !( $node instanceof DocumentFragment ) || $node->hasChildNodes() ) {
			$parentNode->appendChild( $node );
		}
		return $node;
	}

	/**
	 * Removes the node from the document.
	 * @param Element|CharacterData $node
	 * @see https://dom.spec.whatwg.org/#dom-childnode-remove
	 */
	public static function remove(
		// For compatibility with code which might call this from
		// outside Parsoid.
		DOMElement|DOMCharacterData|
		Element|CharacterData $node
	): void {
		if ( $node->parentNode ) {
			$node->parentNode->removeChild( $node );
		}
	}

	/**
	 * Get innerHTML.
	 * @see DOMUtils::getFragmentInnerHTML() for the fragment version
	 * @param Element $element
	 * @return string
	 * @see https://w3c.github.io/DOM-Parsing/#dom-innerhtml-innerhtml
	 */
	public static function getInnerHTML( $element ): string {
		// Always use Parsoid's serializer even in standards mode,
		// since the "standard" DOM spec isn't quite the same as Parsoid
		// expects w/r/t quoting etc.
		return XHtmlSerializer::serialize( $element, [ 'innerXML' => true ] )['html'];
	}

	/**
	 * Set innerHTML.
	 * @see https://w3c.github.io/DOM-Parsing/#dom-innerhtml-innerhtml
	 * @see DOMUtils::setFragmentInnerHTML() for the fragment version
	 * @param Element $element
	 * @param string $html
	 */
	public static function setInnerHTML( $element, string $html ): void {
		// Always use Remex for parsing, even in standards mode.
		$domBuilder = new ParsoidDOMFragmentBuilder( $element->ownerDocument );
		$treeBuilder = new TreeBuilder( $domBuilder );
		$dispatcher = new Dispatcher( $treeBuilder );
		$tokenizer = new Tokenizer( $dispatcher, $html, [ 'ignoreErrors' => true ] );

		$tokenizer->execute( [
			'fragmentNamespace' => HTMLData::NS_HTML,
			// Note that fragmentName *should* be lowercase.
			'fragmentName' => DOMUtils::nodeName( $element ),
		] );

		// Empty the element
		self::replaceChildren( $element );

		$frag = $domBuilder->getFragment();
		'@phan-var DocumentFragment $frag'; // @var DocumentFragment $frag
		DOMUtils::migrateChildren(
			$frag, $element
		);
	}

	/**
	 * Get outerHTML.
	 * @param Element $element
	 * @return string
	 * @see https://w3c.github.io/DOM-Parsing/#dom-element-outerhtml
	 */
	public static function getOuterHTML( $element ): string {
		return XHtmlSerializer::serialize( $element, [ 'addDoctype' => false ] )['html'];
	}

	/**
	 * Return the value of an element attribute.
	 *
	 * Unlike PHP's version, this is spec-compliant and returns `null` if
	 * the attribute is not present, allowing the caller to distinguish
	 * between "the attribute exists but has the empty string as its value"
	 * and "the attribute does not exist".
	 *
	 * @param Element $element
	 * @param string $attributeName
	 * @return ?string The attribute value, or `null` if the attribute does
	 *   not exist on the element.
	 * @see https://dom.spec.whatwg.org/#dom-element-getattribute
	 */
	public static function getAttribute( $element, string $attributeName ): ?string {
		if ( !$element->hasAttribute( $attributeName ) ) {
			return null;
		}
		return $element->getAttribute( $attributeName );
	}

	/**
	 * Get an associative array of attributes, suitable for serialization.
	 *
	 * Add the xmlns attribute if available, to workaround PHP's surprising
	 * behavior with the xmlns attribute: HTML is *not* an XML document,
	 * but various parts of PHP pretend that it is, sort of.
	 *
	 * @param Element $element
	 * @return array<string,string>
	 * @see https://phabricator.wikimedia.org/T235295
	 * @see https://developer.mozilla.org/en-US/docs/Web/API/Element/attributes
	 * @note Note that unlike the spec this method returns an associative
	 *  array, not a NamedNodeMap, and as such is not an exact replacement
	 *  for the DOM `attributes` property.
	 */
	public static function attributes( Element $element ): array {
		$result = [];
		if ( !self::isStandardsMode( $element ) ) {
			// The 'xmlns' attribute is "invisible" T235295
			$xmlns = self::getAttribute( $element, 'xmlns' );
			if ( $xmlns !== null ) {
				$result['xmlns'] = $xmlns;
			}
		}
		foreach ( $element->attributes as $attr ) {
			$result[$attr->name] = $attr->value;
		}
		return $result;
	}

	/**
	 * Return the class list of this element.
	 * @param Element $node
	 * @return TokenList
	 * @see https://dom.spec.whatwg.org/#dom-element-classlist
	 */
	public static function getClassList( $node ): TokenList {
		return new TokenList( $node );
	}

	/**
	 * @param string $text
	 * @return string
	 * @see https://infra.spec.whatwg.org/#strip-and-collapse-ascii-whitespace
	 */
	private static function stripAndCollapseASCIIWhitespace( string $text ): string {
		$ws = self::ASCII_WHITESPACE;
		return preg_replace( "/[$ws]+/", ' ', trim( $text, $ws ) );
	}

	/**
	 * @param Element|DocumentFragment $e
	 */
	private static function stripEmptyTextNodes( $e ): void {
		$c = $e->firstChild;
		while ( $c ) {
			$next = $c->nextSibling;
			if ( $c instanceof Text ) {
				if ( $c->nodeValue === '' ) {
					$e->removeChild( $c );
				}
			} elseif ( $c instanceof Element ) {
				self::stripEmptyTextNodes( $c );
			}
			$c = $next;
		}
	}

	/**
	 * @param Element|DocumentFragment $elt root of the DOM tree that
	 *   needs to be normalized
	 */
	public static function normalize( $elt ): void {
		$elt->normalize();

		// Now traverse the tree rooted at $elt and remove any stray empty text nodes
		// Unlike what https://www.w3.org/TR/DOM-Level-2-Core/core.html#ID-normalize says,
		// the PHP DOM's normalization leaves behind up to 1 empty text node.
		// See https://bugs.php.net/bug.php?id=78221
		self::stripEmptyTextNodes( $elt );
	}

	/**
	 * ParentNode.replaceChildren()
	 * https://developer.mozilla.org/en-US/docs/Web/API/ParentNode/replaceChildren
	 *
	 * @param Document|DocumentFragment|Element $parentNode
	 * @param Node|string ...$nodes
	 */
	public static function replaceChildren(
		// For compatibility with code which might call this from
		// outside Parsoid
		DOMDocument|DOMDocumentFragment|DOMElement|
		Document|DocumentFragment|Element $parentNode,
		DOMNode|
		Node|string ...$nodes
	): void {
		while ( $parentNode->firstChild ) {
			$parentNode->removeChild( $parentNode->firstChild );
		}
		foreach ( $nodes as $node ) {
			if ( is_string( $node ) ) {
				$node = $parentNode->ownerDocument->createTextNode( $node );
			}
			$parentNode->insertBefore( $node, null );
		}
	}

	/**
	 * Return HTMLTemplateElement#content
	 *
	 * In the PHP DOM, <template> elements do not have a dedicated
	 * DocumentFragment and children are stored directly under the
	 * Element.  In the HTML5 spec, the contents are stored in a
	 * DocumentFragment with a unique owner document.
	 *
	 * Bridge this gap by returning the <template> element for
	 * PHP's DOM, or the DocumentFragment for an HTML5-compliant DOM.
	 *
	 * @param Element $node A <template> element
	 * @return Element|DocumentFragment Either the element (for PHP compat)
	 *  or the DocumentFragment which is the template's "content"
	 */
	public static function getTemplateElementContent( $node ) {
		// @phan-suppress-next-line PhanUndeclaredProperty only in IDLeDOM
		if ( isset( $node->content ) ) {
			// @phan-suppress-next-line PhanUndeclaredProperty only in IDLeDOM
			return $node->content;
		}
		return $node;
	}

	/**
	 * Escape an identifier for CSS.
	 * This is equivalent to CSS.escape
	 * (https://drafts.csswg.org/cssom/#the-css.escape()-method)
	 * and is the opposite of self::decodeid().
	 * @note Borrowed from zest.php
	 */
	private static function encodeCssId( string $str ): string {
		// phpcs:ignore Generic.Files.LineLength.TooLong
		return preg_replace_callback( '/(\\x00)|([\\x01-\\x1F\\x7F])|(^[0-9])|(^-[0-9])|(^-$)|([^-A-Za-z0-9_\\x{80}-\\x{10FFFF}])/u', static function ( array $matches ) {
			if ( isset( $matches[1] ) ) {
				return "\u{FFFD}";
			} elseif ( isset( $matches[2] ) || isset( $matches[3] ) ) {
				$cp = mb_ord( $matches[0], "UTF-8" );
				return '\\' . dechex( $cp ) . ' ';
			} elseif ( isset( $matches[4] ) ) {
				$cp = mb_ord( $matches[0][1], "UTF-8" );
				return '-\\' . dechex( $cp ) . ' ';
			} else {
				return '\\' . $matches[0];
			}
		}, $str, -1, $ignore, PREG_UNMATCHED_AS_NULL );
	}
}
// This used to live in Utils.
class_alias( DOMCompat::class, 'Wikimedia\\Parsoid\\Utils\\DOMCompat' );
