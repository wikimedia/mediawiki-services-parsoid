<?php
declare( strict_types = 1 );

namespace Parsoid\Html2Wt;

use DOMElement;
use DOMNode;
use LogicException;
use Parsoid\Config\Env;
use Parsoid\Tokens\Token;

/**
 * Wikitext to HTML serializer.
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 */
class WikitextSerializer {

	/** @var Env */
	public $env;

	/**
	 * @note Porting note: this replaces WikitextSerializer.wteHandlers.escapeWikiText
	 * @param SerializerState $state
	 * @param string $text
	 * @param array $opts
	 *   - node: (DOMNode)
	 *   - isLastChild: (bool)
	 * @return string
	 */
	public function escapeWikiText( SerializerState $state, string $text, array $opts ): string {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * Emit non-separator wikitext that does not need to be escaped.
	 * @param string $src
	 * @param DOMNode $node
	 */
	public function emitWikitext( string $src, DOMNode $node ): void {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * Internal worker. Recursively serialize a DOM subtree.
	 * @param DOMNode $child
	 * @return DOMNode|null
	 * @private
	 */
	public function serializeNode( DOMNode $child ): ?DOMNode {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMNode $node
	 * @param bool $wrapperUnmodified
	 * @return string
	 */
	public function serializeHTMLTag( DOMNode $node, bool $wrapperUnmodified ): string {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMNode $node
	 * @param bool $wrapperUnmodified
	 * @return string
	 */
	public function serializeHTMLEndTag( DOMNode $node, bool $wrapperUnmodified ): string {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMNode $node
	 * @param Token $token
	 * @return string
	 */
	public function serializeAttributes( DOMNode $node, Token $token ): string {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param SerializerState $state
	 * @param DOMNode $node
	 * @param array $parts
	 * @return string
	 */
	public function serializeFromParts( SerializerState $state, DOMNode $node, array $parts ): string {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMNode $node
	 * @param string $name
	 * @return array
	 */
	public function serializedAttrVal( DOMNode $node, string $name ): array {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * Emit a separator based on the collected (and merged) constraints
	 * and existing separator text. Called when new output is triggered.
	 * @param DOMNode $node
	 * @return string
	 */
	public function buildSep( DOMNode $node ): string {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMElement $node
	 */
	public function linkHandler( DOMElement $node ): void {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMElement $node
	 */
	public function figureHandler( DOMElement $node ): void {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMNode $node
	 * @param SerializerState $state
	 * @return string|null
	 */
	public function defaultExtensionHandler( DOMNode $node, SerializerState $state ): ?string {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMNode $node
	 * @return string|null
	 */
	public function languageVariantHandler( DOMNode $node ): ?string {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @param DOMElement $node
	 */
	public function handleLIHackIfApplicable( DOMElement $node ): void {
		throw new LogicException( 'Not ported yet' );
	}

	/**
	 * @note Porting note: this replaces the pattern $serializer->env->log( $serializer->logType, ... )
	 * @param mixed ...$args
	 * @deprecated Use PSR-3 logging instead
	 */
	public function trace( ...$args ) {
	}

}
